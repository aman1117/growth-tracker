//! Notification repository and service against PostgreSQL (and Redis when reachable).

mod common;

use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use common::{redis_ready, run, unique_user_id, TestDb};
use gt_core::gojson;
use gt_core::models::NOTIF_TYPE_LIKE_RECEIVED;
use gt_notify::service::decode_notification;
use gt_notify::{
    NewNotification, NewNotificationDedupe, NotificationError, NotificationRepository, NotificationService,
};
use redis::AsyncCommands;
use serde_json::json;

fn note(user_id: i64, title: &str) -> NewNotification {
    NewNotification::new(user_id, "system_announcement", title, "body", Some(json!({"b": 2, "a": "x"})))
}

async fn set_created_days_ago(repo: &NotificationRepository, id: i64, days: i64) {
    sqlx::query("UPDATE notifications SET created_at = $1 WHERE id = $2")
        .bind(Utc::now() - chrono::Duration::days(days))
        .bind(id)
        .execute(repo.pool())
        .await
        .unwrap();
}

#[test]
fn repository_crud_and_queries() {
    run(async {
        let Some(db) = TestDb::new("repo_crud").await else { return };
        let repo = NotificationRepository::new(db.pool.clone());
        let (me, other) = (unique_user_id(), unique_user_id());

        let first = repo.create(&note(me, "one")).await.unwrap();
        assert!(first.id > 0);
        assert_eq!(first.read_at, None);
        assert_eq!(first.metadata, Some(json!({"a": "x", "b": 2})));
        repo.create(&note(me, "two")).await.unwrap();
        repo.create(&note(me, "three")).await.unwrap();
        // One timestamp per batch, like GORM's CreateInBatches.
        let batch = repo.create_batch(&[note(other, "theirs"), note(other, "theirs too")]).await.unwrap();
        assert_eq!(batch.len(), 2);
        assert!(batch[0].id < batch[1].id);
        assert!(repo.create_batch(&[]).await.unwrap().is_empty());
        let no_meta = repo.create(&NewNotification::new(me, "system_announcement", "four", "", None)).await.unwrap();
        assert_eq!(repo.get_by_id(no_meta.id).await.unwrap().unwrap().metadata, None);

        let page: Vec<String> = repo.get_by_user_id(me, 2, 0).await.unwrap().into_iter().map(|n| n.title).collect();
        assert_eq!(page, ["four", "three"], "newest first");
        let page: Vec<String> = repo.get_by_user_id(me, 2, 2).await.unwrap().into_iter().map(|n| n.title).collect();
        assert_eq!(page, ["two", "one"]);
        assert_eq!(repo.get_by_user_id(me, -1, -5).await.unwrap().len(), 4, "GORM: negative limit/offset ignored");
        assert_eq!(repo.count_by_user_id(me).await.unwrap(), 4);
        assert_eq!(repo.get_unread_count(me).await.unwrap(), 4);

        // Only the owner can mark/delete.
        repo.mark_as_read(first.id, other).await.unwrap();
        assert_eq!(repo.get_unread_count(me).await.unwrap(), 4);
        repo.mark_as_read(first.id, me).await.unwrap();
        let read = repo.get_by_id(first.id).await.unwrap().unwrap();
        assert!(read.read_at.is_some());
        assert_eq!(repo.get_unread_by_user_id(me, 10).await.unwrap().len(), 3);
        repo.mark_all_as_read(me).await.unwrap();
        assert_eq!(repo.get_unread_count(me).await.unwrap(), 0);
        assert_eq!(repo.get_unread_count(other).await.unwrap(), 2);
        repo.delete(no_meta.id, other).await.unwrap();
        assert!(repo.get_by_id(no_meta.id).await.unwrap().is_some());
        repo.delete(no_meta.id, me).await.unwrap();
        assert!(repo.get_by_id(no_meta.id).await.unwrap().is_none());

        assert!(repo
            .exists_by_type_and_metadata(me, "system_announcement", "b", 2, Duration::from_secs(60))
            .await
            .unwrap());
        assert!(!repo
            .exists_by_type_and_metadata(me, "system_announcement", "b", 3, Duration::from_secs(60))
            .await
            .unwrap());
        set_created_days_ago(&repo, first.id, 2).await;
        sqlx::query("UPDATE notifications SET created_at = now() - interval '2 days' WHERE user_id = $1")
            .bind(me)
            .execute(&db.pool)
            .await
            .unwrap();
        assert!(!repo
            .exists_by_type_and_metadata(me, "system_announcement", "a", "x", Duration::from_secs(3600))
            .await
            .unwrap());

        let dedupe = NewNotificationDedupe::new(me, other, "like_received", "day_like", format!("{me}:2026-01-05"));
        assert!(repo.create_dedupe_record(&dedupe).await.unwrap());
        assert!(!repo.create_dedupe_record(&dedupe).await.unwrap(), "ON CONFLICT DO NOTHING");
        let found = repo.find_dedupe_by_actor(other, "like_received", &dedupe.entity_key).await.unwrap().unwrap();
        assert_eq!((found.user_id, found.actor_id), (me, other));
        assert!(repo.find_dedupe_by_actor(me, "like_received", &dedupe.entity_key).await.unwrap().is_none());

        db.finish().await;
    });
}

#[test]
fn cleanup_removes_old_notifications() {
    run(async {
        let Some(db) = TestDb::new("svc_cleanup").await else { return };
        redis_ready().await;
        let repo = Arc::new(NotificationRepository::new(db.pool.clone()));
        let svc = NotificationService::new(repo.clone());
        let user = unique_user_id();

        let old_read = repo.create(&note(user, "old read")).await.unwrap();
        repo.mark_as_read(old_read.id, user).await.unwrap();
        set_created_days_ago(&repo, old_read.id, 31).await;
        let recent_read = repo.create(&note(user, "recent read")).await.unwrap();
        repo.mark_as_read(recent_read.id, user).await.unwrap();
        set_created_days_ago(&repo, recent_read.id, 29).await;
        let old_unread = repo.create(&note(user, "old unread")).await.unwrap();
        set_created_days_ago(&repo, old_unread.id, 91).await;
        let kept_unread = repo.create(&note(user, "kept unread")).await.unwrap();
        set_created_days_ago(&repo, kept_unread.id, 60).await;

        assert_eq!(svc.cleanup_old_notifications().await.unwrap(), 2);
        let left: Vec<String> = repo.get_by_user_id(user, 10, 0).await.unwrap().into_iter().map(|n| n.title).collect();
        assert_eq!(left, ["recent read", "kept unread"]);
        assert_eq!(svc.cleanup_old_notifications().await.unwrap(), 0);
        db.finish().await;
    });
}

#[test]
fn service_create_list_read_delete_and_unread_cache() {
    run(async {
        let Some(db) = TestDb::new("svc_crud").await else { return };
        let has_redis = redis_ready().await;
        let svc = NotificationService::new(Arc::new(NotificationRepository::new(db.pool.clone())));
        let (me, other) = (unique_user_id(), unique_user_id());

        let mut ids = Vec::new();
        for i in 0..5 {
            ids.push(svc.create(note(me, &format!("n{i}"))).await.unwrap().id);
        }
        let (page, total) = svc.get_by_user_id(me, 2, 2).await.unwrap();
        assert_eq!(total, 5);
        assert_eq!(page.iter().map(|n| n.title.as_str()).collect::<Vec<_>>(), ["n2", "n1"]);
        let (page, _) = svc.get_by_user_id(me, 3, 2).await.unwrap();
        assert_eq!(page.len(), 1);

        assert_eq!(svc.get_unread_count(me).await.unwrap(), 5);
        if has_redis {
            let mut conn = gt_core::redis::conn().unwrap();
            let cached: String = conn.get(format!("notif:unread:{me}")).await.unwrap();
            assert_eq!(cached, "5");
            let ttl: i64 = conn.ttl(format!("notif:unread:{me}")).await.unwrap();
            assert!((290..=300).contains(&ttl), "{ttl}");
            // Served from the cache until invalidated.
            let _: () = conn.set(format!("notif:unread:{me}"), "42").await.unwrap();
            assert_eq!(svc.get_unread_count(me).await.unwrap(), 42);
            svc.invalidate_unread_cache(me).await;
        }

        svc.mark_as_read(ids[0], me).await.unwrap();
        assert_eq!(svc.get_unread_count(me).await.unwrap(), 4);
        svc.create(note(me, "n5")).await.unwrap();
        assert_eq!(svc.get_unread_count(me).await.unwrap(), 5, "create invalidates the cache");

        assert!(matches!(svc.delete(ids[1], other).await, Err(NotificationError::NotFound)));
        assert!(matches!(svc.delete(999_999_999, me).await, Err(NotificationError::NotFound)));
        svc.delete(ids[1], me).await.unwrap();
        assert_eq!(svc.get_unread_count(me).await.unwrap(), 4);
        svc.delete(ids[0], me).await.unwrap();

        svc.mark_all_as_read(me).await.unwrap();
        assert_eq!(svc.get_unread_count(me).await.unwrap(), 0);
        let (_, total) = svc.get_by_user_id(me, 1, 20).await.unwrap();
        assert_eq!(total, 4);
        db.finish().await;
    });
}

#[test]
fn triggers_dedupe_like_go() {
    run(async {
        let Some(db) = TestDb::new("svc_dedupe").await else { return };
        redis_ready().await;
        let repo = Arc::new(NotificationRepository::new(db.pool.clone()));
        let svc = NotificationService::new(repo.clone());
        let (owner, liker, follower_a, follower_b) =
            (unique_user_id(), unique_user_id(), unique_user_id(), unique_user_id());

        // A like notifies once per (recipient, liker, day), also after unlike + like.
        for _ in 0..2 {
            svc.notify_like_received(owner, liker, "liker", "https://img/a.png", "2026-01-05").await.unwrap();
        }
        svc.notify_like_received(owner, liker, "liker", "", "2026-01-06").await.unwrap();
        let likes = repo.get_by_user_id(owner, 10, 0).await.unwrap();
        assert_eq!(likes.len(), 2);
        let first_like = likes.last().unwrap();
        assert_eq!(first_like.notif_type, NOTIF_TYPE_LIKE_RECEIVED);
        assert_eq!(first_like.title, "New Like!");
        assert_eq!(first_like.body, "liker liked your 5 Jan, 2026 activities");
        assert_eq!(
            gojson::to_string(&first_like.metadata).unwrap(),
            format!(
                r#"{{"liked_date":"2026-01-05","liker_avatar":"https://img/a.png","liker_id":{liker},"liker_username":"liker"}}"#
            )
        );

        // New followers dedupe; accepted follow requests do not.
        for _ in 0..2 {
            svc.notify_new_follower(owner, follower_a, "fa", "").await.unwrap();
            svc.notify_follow_accepted(follower_a, owner, "owner", "").await.unwrap();
        }
        assert_eq!(repo.count_by_user_id(owner).await.unwrap(), 3);
        assert_eq!(repo.count_by_user_id(follower_a).await.unwrap(), 2);

        // Day completed: once per follower and day.
        for _ in 0..2 {
            svc.notify_day_completed(owner, "owner", "", "2026-01-05", &[follower_a, follower_b]).await.unwrap();
        }
        svc.notify_day_completed(owner, "owner", "", "2026-01-05", &[]).await.unwrap();
        assert_eq!(repo.count_by_user_id(follower_a).await.unwrap(), 3);
        assert_eq!(repo.count_by_user_id(follower_b).await.unwrap(), 1);

        // store_once has no side effects and reports duplicates.
        let dedupe = NewNotificationDedupe::new(follower_b, owner, "story_like", "story", "photo:1");
        assert!(svc.store_once(&dedupe, &note(follower_b, "story")).await.unwrap().is_some());
        assert!(svc.store_once(&dedupe, &note(follower_b, "story")).await.unwrap().is_none());
        assert_eq!(repo.count_by_user_id(follower_b).await.unwrap(), 2);
        db.finish().await;
    });
}

#[test]
fn realtime_pubsub_pending_queue_and_connection_tracking() {
    run(async {
        let Some(db) = TestDb::new("svc_realtime").await else { return };
        if !redis_ready().await {
            db.finish().await;
            return;
        }
        let svc = NotificationService::new(Arc::new(NotificationRepository::new(db.pool.clone())));
        let user = unique_user_id();

        // Published notifications reach subscribers as the model's Go JSON.
        let mut sub = svc.subscribe_to_notifications(user).expect("redis available");
        tokio::time::timeout(Duration::from_secs(5), async {
            while !sub.is_subscribed() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let created = svc.create(note(user, "live")).await.unwrap();
        let payload = tokio::time::timeout(Duration::from_secs(5), sub.recv()).await.unwrap().unwrap();
        let text = String::from_utf8(payload.clone()).unwrap();
        assert!(text.contains(r#""read_at":null"#), "{text}");
        assert!(text.contains(r#""metadata":{"a":"x","b":2}"#), "{text}");
        assert_eq!(decode_notification(&payload).unwrap(), created);
        drop(sub);

        // The pending queue is drained oldest first; undecodable entries are skipped.
        let mut conn = gt_core::redis::conn().unwrap();
        let key = format!("notif:pending:{user}");
        let older = gojson::to_vec(&created).unwrap();
        let mut newer = created.clone();
        newer.id += 1000;
        let _: () = conn.lpush(&key, older).await.unwrap();
        let _: () = conn.lpush(&key, "not json").await.unwrap();
        let _: () = conn.lpush(&key, gojson::to_vec(&newer).unwrap()).await.unwrap();
        let pending = svc.get_pending_notifications(user).await;
        assert_eq!(pending.iter().map(|n| n.id).collect::<Vec<_>>(), [created.id, newer.id]);
        assert!(svc.get_pending_notifications(user).await.is_empty());

        // At most five tracked connections per user, with a 45 s TTL.
        for i in 0..5 {
            assert!(svc.track_ws_connection(user, &format!("conn-{i}")).await.unwrap());
        }
        assert!(!svc.track_ws_connection(user, "conn-5").await.unwrap());
        assert_eq!(svc.get_ws_connection_count(user).await.unwrap(), 5);
        let ttl: i64 = conn.ttl(format!("notif:ws:conn:{user}")).await.unwrap();
        assert!((40..=45).contains(&ttl), "{ttl}");
        svc.remove_ws_connection(user, "conn-0").await;
        assert!(svc.track_ws_connection(user, "conn-5").await.unwrap());
        svc.refresh_ws_connection(user).await;
        for i in 1..=5 {
            svc.remove_ws_connection(user, &format!("conn-{i}")).await;
        }
        assert_eq!(svc.get_ws_connection_count(user).await.unwrap(), 0);
        db.finish().await;
    });
}
