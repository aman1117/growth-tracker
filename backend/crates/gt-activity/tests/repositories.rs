//! Repository tests (port of the activity and tile config parts of
//! `internal/repository/activity_streak_cron_tile_test.go` and the like parts of
//! `like_badge_repository_test.go`).

mod common;

use chrono::{TimeZone, Utc};
use common::{broken_pool, create_user, day, insert_activity, Stack, TestDb};
use gt_activity::{ActivityRepository, ActivityWriteError, LikeDeleteError, LikeRepository, TileConfigRepository};
use gt_core::gojson;
use gt_core::models::Activity;
use serde_json::{json, Map, Value};

const DAY: (i32, u32, u32) = (2026, 3, 9);

fn new_activity(user_id: i64, name: &str, hours: f32, date: chrono::NaiveDate, note: Option<&str>) -> Activity {
    Activity {
        id: 0,
        user_id,
        name: name.into(),
        duration_hours: hours,
        note: note.map(str::to_string),
        created_at: gojson::go_zero_time(),
        updated_at: gojson::go_zero_time(),
        activity_date: date,
    }
}

fn object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => panic!("not an object"),
    }
}

// ==================== Activities ====================

#[tokio::test]
async fn activity_create_and_find_by_user_and_date() {
    let Some(db) = TestDb::new("repo_activity_create").await else { return };
    let stack = Stack::new(&db.pool);
    let repo = ActivityRepository::new(db.pool.clone());
    let user = create_user(&stack, "user", false).await;
    let other = create_user(&stack, "other", false).await;
    let today = day(DAY.0, DAY.1, DAY.2);

    let mut study = new_activity(user.id, "study", 2.5, today, Some("Read 30 pages 📚"));
    repo.create(&mut study).await.unwrap();
    assert_ne!(study.id, 0);
    assert!(!gojson::is_go_zero_time(&study.created_at));
    repo.create(&mut new_activity(user.id, "sleep", 8.0, today, None)).await.unwrap();
    repo.create(&mut new_activity(user.id, "sleep", 7.0, day(2026, 3, 10), None)).await.unwrap();
    repo.create(&mut new_activity(other.id, "sleep", 6.0, today, None)).await.unwrap();

    let got = repo.find_by_user_and_date(user.id, today).await.unwrap();
    assert_eq!(got.len(), 2, "only this user's activities on this day");
    let study_row = got.iter().find(|a| a.name == "study").unwrap();
    assert_eq!(study_row.duration_hours, 2.5);
    assert_eq!(study_row.note.as_deref(), Some("Read 30 pages 📚"));
    assert_eq!(study_row.activity_date, today);
    assert_eq!(got.iter().find(|a| a.name == "sleep").unwrap().note, None);

    assert!(repo.find_by_user_and_date(user.id, day(2026, 3, 16)).await.unwrap().is_empty());
    db.finish().await;
}

#[tokio::test]
async fn activity_create_rejects_invalid_activities() {
    let Some(db) = TestDb::new("repo_activity_invalid").await else { return };
    let stack = Stack::new(&db.pool);
    let repo = ActivityRepository::new(db.pool.clone());
    let user = create_user(&stack, "user", false).await;
    let today = day(DAY.0, DAY.1, DAY.2);

    let err = repo.create(&mut new_activity(user.id, "swimming", 1.0, today, None)).await.unwrap_err();
    assert_eq!(err.to_string(), "invalid activity name: swimming");
    let err = repo.create(&mut new_activity(user.id, "study", 24.5, today, None)).await.unwrap_err();
    assert!(matches!(err, ActivityWriteError::Invalid(_)));
    assert_eq!(err.to_string(), "duration_hours must be between 0 and 24");
    assert_eq!(common::count(&db.pool, "SELECT count(*) FROM activities").await, 0);
    db.finish().await;
}

#[tokio::test]
async fn activity_update() {
    let Some(db) = TestDb::new("repo_activity_update").await else { return };
    let stack = Stack::new(&db.pool);
    let repo = ActivityRepository::new(db.pool.clone());
    let user = create_user(&stack, "user", false).await;
    let today = day(DAY.0, DAY.1, DAY.2);
    let id = insert_activity(&db.pool, user.id, "workout", 1.0, today).await;
    let mut activity = repo.find_by_user_and_date(user.id, today).await.unwrap().remove(0);
    assert_eq!(activity.id, id);

    activity.duration_hours = 1.75;
    let before = activity.updated_at;
    repo.update(&mut activity).await.unwrap();
    assert!(activity.updated_at >= before);

    activity.duration_hours = 30.0;
    assert!(repo.update(&mut activity).await.is_err(), "updates are validated too");

    let got = repo.find_by_user_and_date(user.id, today).await.unwrap();
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].id, id);
    assert_eq!(got[0].duration_hours, 1.75);
    db.finish().await;
}

/// Go handed `float32` hours to the driver as `float64`, which rounds into `numeric(4,2)`
/// differently from `float4` (observed on the Go server: 2.675 is stored as 2.67).
#[tokio::test]
async fn activity_hours_round_like_go() {
    let Some(db) = TestDb::new("repo_activity_rounding").await else { return };
    let stack = Stack::new(&db.pool);
    let repo = ActivityRepository::new(db.pool.clone());
    let user = create_user(&stack, "user", false).await;
    repo.create(&mut new_activity(user.id, "study", 2.675, day(2026, 3, 9), None)).await.unwrap();
    let stored: String =
        sqlx::query_scalar("SELECT duration_hours::text FROM activities").fetch_one(&db.pool).await.unwrap();
    assert_eq!(stored, "2.67");
    db.finish().await;
}

#[tokio::test]
async fn activity_find_by_user_and_date_range() {
    let Some(db) = TestDb::new("repo_activity_range").await else { return };
    let stack = Stack::new(&db.pool);
    let repo = ActivityRepository::new(db.pool.clone());
    let user = create_user(&stack, "user", false).await;
    let other = create_user(&stack, "other", false).await;
    for d in [1, 5, 8, 10, 11] {
        insert_activity(&db.pool, user.id, "study", 1.0, day(2026, 3, d)).await;
    }
    insert_activity(&db.pool, other.id, "study", 1.0, day(2026, 3, 6)).await;

    let got = repo.find_by_user_and_date_range(user.id, day(2026, 3, 5), day(2026, 3, 10)).await.unwrap();
    let mut dates: Vec<_> = got.iter().map(|a| a.activity_date.to_string()).collect();
    dates.sort();
    assert_eq!(dates, vec!["2026-03-05", "2026-03-08", "2026-03-10"], "bounds are inclusive");
    db.finish().await;
}

#[tokio::test]
async fn activity_database_errors() {
    let repo = ActivityRepository::new(broken_pool().await);
    let today = day(DAY.0, DAY.1, DAY.2);
    assert!(matches!(
        repo.create(&mut new_activity(1, "sleep", 8.0, today, None)).await,
        Err(ActivityWriteError::Database(_))
    ));
    let mut existing = new_activity(1, "sleep", 8.0, today, None);
    existing.id = 1;
    assert!(repo.update(&mut existing).await.is_err());
    assert!(repo.find_by_user_and_date(1, today).await.is_err());
    assert!(repo.find_by_user_and_date_range(1, today, today).await.is_err());
}

// ==================== Tile configs ====================

#[tokio::test]
async fn tile_config_save_creates_then_updates() {
    let Some(db) = TestDb::new("repo_tile_config").await else { return };
    let stack = Stack::new(&db.pool);
    let repo = TileConfigRepository::new(db.pool.clone());
    let user = create_user(&stack, "user", false).await;
    let other = create_user(&stack, "other", false).await;

    assert_eq!(repo.find_by_user_id(user.id).await.unwrap(), None, "no config yet");

    repo.save(user.id, Some(&object(json!({"order": ["sleep", "study"]})))).await.unwrap();
    let created = repo.find_by_user_id(user.id).await.unwrap().unwrap();
    assert_eq!(created.config, Some(json!({"order": ["sleep", "study"]})));

    repo.save(user.id, Some(&object(json!({"order": ["study"], "sizes": {"study": "large"}})))).await.unwrap();
    let updated = repo.find_by_user_id(user.id).await.unwrap().unwrap();
    assert_eq!(updated.id, created.id, "the existing row is updated");
    assert_eq!(updated.created_at, created.created_at);
    assert_eq!(updated.config, Some(json!({"order": ["study"], "sizes": {"study": "large"}})));
    assert_eq!(updated.config_data().unwrap().order, Some(vec!["study".to_string()]));
    assert_eq!(common::count(&db.pool, "SELECT count(*) FROM tile_configs").await, 1);

    repo.save(user.id, None).await.unwrap();
    assert_eq!(repo.find_by_user_id(user.id).await.unwrap().unwrap().config, None, "a nil config is stored as NULL");

    assert_eq!(repo.find_by_user_id(other.id).await.unwrap(), None);
    db.finish().await;
}

/// The stored JSON is what Go's `json.Marshal` wrote (sorted keys, `<`/`&` escaped), which the
/// jsonb column normalizes.
#[tokio::test]
async fn tile_config_is_stored_like_go() {
    let Some(db) = TestDb::new("repo_tile_config_json").await else { return };
    let stack = Stack::new(&db.pool);
    let repo = TileConfigRepository::new(db.pool.clone());
    let user = create_user(&stack, "user", false).await;
    let config =
        gt_activity::dto::go_interface_map(object(json!({"e": 1e21, "big": 12345678901234567890u64, "s": "<&>"})));
    repo.save(user.id, Some(&config)).await.unwrap();
    let stored: String = sqlx::query_scalar("SELECT config::text FROM tile_configs").fetch_one(&db.pool).await.unwrap();
    assert_eq!(stored, r#"{"e": 1000000000000000000000, "s": "<&>", "big": 12345678901234567000}"#);
    db.finish().await;
}

#[tokio::test]
async fn tile_config_rejects_non_object_rows_like_go() {
    let Some(db) = TestDb::new("repo_tile_config_scan").await else { return };
    let stack = Stack::new(&db.pool);
    let repo = TileConfigRepository::new(db.pool.clone());
    let user = create_user(&stack, "user", false).await;
    sqlx::query("INSERT INTO tile_configs (user_id, config) VALUES ($1, '[1]'::jsonb)")
        .bind(user.id)
        .execute(&db.pool)
        .await
        .unwrap();
    assert!(repo.find_by_user_id(user.id).await.is_err(), "Go's JSONB map could not scan an array");
    assert!(repo.save(user.id, None).await.is_err(), "Go then tried to insert a second row");
    db.finish().await;
}

#[tokio::test]
async fn tile_config_database_errors() {
    let repo = TileConfigRepository::new(broken_pool().await);
    assert!(repo.find_by_user_id(1).await.is_err());
    assert!(repo.save(1, Some(&object(json!({"order": []})))).await.is_err());
}

// ==================== Day likes ====================

#[tokio::test]
async fn like_create_and_has_liked() {
    let Some(db) = TestDb::new("repo_like_create").await else { return };
    let stack = Stack::new(&db.pool);
    let repo = LikeRepository::new(db.pool.clone());
    let liker = create_user(&stack, "liker", false).await;
    let owner = create_user(&stack, "owner", false).await;
    let today = day(DAY.0, DAY.1, DAY.2);

    repo.create(liker.id, owner.id, today).await.unwrap();
    repo.create(liker.id, owner.id, today).await.expect("liking twice is idempotent");

    assert!(repo.has_liked(liker.id, owner.id, today).await.unwrap(), "liked day");
    assert!(!repo.has_liked(liker.id, owner.id, day(2026, 3, 10)).await.unwrap(), "another day");
    assert!(!repo.has_liked(owner.id, liker.id, today).await.unwrap(), "reverse direction");
    assert_eq!(repo.count_likes_for_day(owner.id, today).await.unwrap(), 1);
    db.finish().await;
}

#[tokio::test]
async fn like_create_unknown_user() {
    let Some(db) = TestDb::new("repo_like_unknown").await else { return };
    let stack = Stack::new(&db.pool);
    let repo = LikeRepository::new(db.pool.clone());
    let liker = create_user(&stack, "liker", false).await;
    assert!(repo.create(liker.id, 9999, day(2026, 3, 9)).await.is_err(), "only duplicate likes are swallowed");
    db.finish().await;
}

#[tokio::test]
async fn like_delete() {
    let Some(db) = TestDb::new("repo_like_delete").await else { return };
    let stack = Stack::new(&db.pool);
    let repo = LikeRepository::new(db.pool.clone());
    let liker = create_user(&stack, "liker", false).await;
    let owner = create_user(&stack, "owner", false).await;
    let today = day(DAY.0, DAY.1, DAY.2);
    repo.create(liker.id, owner.id, today).await.unwrap();
    repo.create(liker.id, owner.id, day(2026, 3, 10)).await.unwrap();

    repo.delete(liker.id, owner.id, today).await.unwrap();
    assert!(!repo.has_liked(liker.id, owner.id, today).await.unwrap());
    assert!(repo.has_liked(liker.id, owner.id, day(2026, 3, 10)).await.unwrap(), "likes on other days are kept");

    let err = repo.delete(liker.id, owner.id, today).await.unwrap_err();
    assert!(matches!(err, LikeDeleteError::NotFound));
    assert_eq!(err.to_string(), "like not found");
    db.finish().await;
}

#[tokio::test]
async fn like_get_likes_for_day() {
    let Some(db) = TestDb::new("repo_like_list").await else { return };
    let stack = Stack::new(&db.pool);
    let repo = LikeRepository::new(db.pool.clone());
    let owner = create_user(&stack, "owner", false).await;
    let alice = create_user(&stack, "alice", false).await;
    let bob = create_user(&stack, "bob", false).await;
    let carol = create_user(&stack, "carol", false).await;
    sqlx::query(
        "UPDATE users SET is_verified = true, profile_pic = 'a.jpg', profile_pic_thumb = 'a_t.jpg' WHERE id = $1",
    )
    .bind(alice.id)
    .execute(&db.pool)
    .await
    .unwrap();
    let today = day(DAY.0, DAY.1, DAY.2);
    repo.create(alice.id, owner.id, today).await.unwrap();
    repo.create(bob.id, owner.id, today).await.unwrap();
    repo.create(carol.id, owner.id, day(2026, 3, 8)).await.unwrap();
    repo.create(alice.id, bob.id, today).await.unwrap();
    let t0 = Utc.with_ymd_and_hms(2026, 3, 9, 10, 0, 0).unwrap();
    for (liker, minutes) in [(alice.id, 2), (bob.id, 1)] {
        sqlx::query("UPDATE likes SET created_at = $1 WHERE liker_id = $2 AND liked_user_id = $3")
            .bind(t0 + chrono::Duration::minutes(minutes))
            .bind(liker)
            .bind(owner.id)
            .execute(&db.pool)
            .await
            .unwrap();
    }

    let likes = repo.get_likes_for_day(owner.id, today).await.unwrap();
    assert_eq!(likes.len(), 2);
    assert_eq!(likes[0].liker_id, alice.id, "most recent first");
    assert_eq!(likes[0].username, "alice");
    assert_eq!(likes[0].profile_pic.as_deref(), Some("a.jpg"));
    assert_eq!(likes[0].profile_pic_thumb.as_deref(), Some("a_t.jpg"));
    assert!(likes[0].is_verified);
    assert_ne!(likes[0].id, 0);
    assert_eq!(likes[0].created_at, t0 + chrono::Duration::minutes(2));
    assert_eq!(likes[1].liker_id, bob.id);
    assert!(!likes[1].is_verified);

    assert_eq!(repo.count_likes_for_day(owner.id, today).await.unwrap(), 2);
    assert!(repo.get_likes_for_day(owner.id, day(2026, 3, 14)).await.unwrap().is_empty());
    db.finish().await;
}

#[tokio::test]
async fn like_get_likes_by_user() {
    let Some(db) = TestDb::new("repo_like_by_user").await else { return };
    let stack = Stack::new(&db.pool);
    let repo = LikeRepository::new(db.pool.clone());
    let liker = create_user(&stack, "liker", false).await;
    let owner = create_user(&stack, "owner", false).await;
    let other = create_user(&stack, "other", false).await;
    let t0 = Utc.with_ymd_and_hms(2026, 3, 9, 10, 0, 0).unwrap();
    for i in 1..=3 {
        let date = day(2026, 3, 9 + i);
        repo.create(liker.id, owner.id, date).await.unwrap();
        sqlx::query("UPDATE likes SET created_at = $1 WHERE liker_id = $2 AND liked_date = $3")
            .bind(t0 + chrono::Duration::minutes(i64::from(i)))
            .bind(liker.id)
            .bind(date)
            .execute(&db.pool)
            .await
            .unwrap();
    }
    repo.create(other.id, owner.id, day(2026, 3, 9)).await.unwrap();

    let likes = repo.get_likes_by_user(liker.id, 2).await.unwrap();
    assert_eq!(likes.len(), 2);
    assert_eq!(likes[0].liked_date, day(2026, 3, 12), "most recent first");
    assert_eq!(likes[1].liked_date, day(2026, 3, 11));
    assert!(likes.iter().all(|l| l.liker_id == liker.id));
    assert_eq!(repo.get_likes_by_user(liker.id, -1).await.unwrap().len(), 3, "negative limits mean no limit");
    db.finish().await;
}

#[tokio::test]
async fn like_database_errors() {
    let repo = LikeRepository::new(broken_pool().await);
    let today = day(DAY.0, DAY.1, DAY.2);
    let err = repo.delete(1, 2, today).await.unwrap_err();
    assert!(matches!(err, LikeDeleteError::Database(_)), "database errors are not reported as missing likes");
    assert!(repo.create(1, 2, today).await.is_err());
    assert!(repo.has_liked(1, 2, today).await.is_err());
    assert!(repo.get_likes_for_day(2, today).await.is_err());
    assert!(repo.count_likes_for_day(2, today).await.is_err());
    assert!(repo.get_likes_by_user(1, 10).await.is_err());
}
