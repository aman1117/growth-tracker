//! `CommentService` tests (port of `internal/services/comment_service_test.go`).

mod common;

use std::sync::Arc;

use chrono::{Duration, Utc};
use common::*;
use gt_comments::dto::{CommentDto, MentionDto};
use gt_comments::service::{hash_body, CommentRepositories, CommentSort};
use gt_comments::{CommentError, CommentService, CreateComment};
use gt_core::constants as c;
use gt_core::models::{
    User, NOTIF_TYPE_COMMENT_LIKED, NOTIF_TYPE_COMMENT_MENTION, NOTIF_TYPE_COMMENT_RECEIVED, NOTIF_TYPE_COMMENT_REPLY,
};
use gt_users::repository::{FollowRepository, UserRepository};

async fn create(
    svc: &CommentService,
    author: &User,
    owner: &User,
    body: &str,
    parent: Option<i64>,
    key: Option<&str>,
) -> Result<CommentDto, CommentError> {
    create_on(svc, author, owner, day(), body, parent, key).await
}

async fn create_on(
    svc: &CommentService,
    author: &User,
    owner: &User,
    day_date: chrono::NaiveDate,
    body: &str,
    parent: Option<i64>,
    key: Option<&str>,
) -> Result<CommentDto, CommentError> {
    svc.create_comment(CreateComment {
        author_id: author.id,
        author_username: &author.username,
        day_owner_id: owner.id,
        day_owner_username: &owner.username,
        day_date,
        body,
        parent_comment_id: parent,
        idempotency_key: key,
    })
    .await
}

#[track_caller]
fn assert_code<T: std::fmt::Debug>(result: Result<T, CommentError>, code: &str) {
    let err = result.expect_err("expected a validation error");
    assert_eq!(err.code(), Some(code), "{err}");
}

#[track_caller]
fn assert_db_error<T: std::fmt::Debug>(result: Result<T, CommentError>, context: &str) {
    match result {
        Err(err @ CommentError::Database { .. }) => assert!(err.to_string().starts_with(context), "{err}"),
        other => panic!("expected a database error, got {other:?}"),
    }
}

fn names(mentions: &[MentionDto]) -> Vec<&str> {
    mentions.iter().map(|m| m.username.as_str()).collect()
}

fn avatar(url: &'static str) -> UserOpts {
    UserOpts { avatar: Some(url), ..Default::default() }
}

#[tokio::test]
async fn create_top_level_comment() {
    let Some(db) = TestDb::new("svc_create_top").await else { return };
    let pool = &db.pool;
    let svc = service_with(pool, pool, Some(pool));
    let owner = create_user(pool, "owner").await;
    let author = create_user_with(
        pool,
        "author",
        UserOpts { verified: true, avatar: Some("https://img/author.jpg"), ..Default::default() },
    )
    .await;
    let friend = create_user(pool, "friend_1").await;

    let body = "  Great day @friend_1 and @friend_1! @nobody_here  ";
    let got = create(&svc, &author, &owner, body, None, None).await.unwrap();
    let trimmed = body.trim();

    assert!(got.id > 0);
    assert_eq!((got.day_owner_id, got.day_date.as_str(), got.author_id), (owner.id, DAY, author.id));
    assert_eq!(got.author_username, "author");
    assert_eq!(got.author_avatar, author.profile_pic);
    assert_eq!(got.author_avatar_thumb, author.profile_pic_thumb);
    assert!(got.author_verified);
    assert_eq!(got.body, trimmed);
    assert_eq!((got.parent_comment_id, got.root_comment_id, got.reply_to_username.as_deref()), (None, None, None));
    assert_eq!(
        got.mentions,
        vec![MentionDto { user_id: friend.id, username: "friend_1".into() }],
        "duplicate and unknown mentions are dropped"
    );
    assert!(chrono::NaiveDateTime::parse_from_str(&got.created_at, "%Y-%m-%dT%H:%M:%SZ").is_ok());

    let stored = load_comment(pool, got.id).await;
    assert_eq!((stored.body.as_str(), stored.day_date), (trimmed, day()));
    assert_eq!(got.created_at, gt_core::gojson::format_local_literal_z(&stored.created_at), "local clock, literal Z");
    assert_eq!(
        db.count(&format!(
            "SELECT count(*) FROM comment_mentions WHERE comment_id = {} AND mentioned_user_id = {}",
            got.id, friend.id
        ))
        .await,
        1
    );
    let (hash, key): (String, Option<String>) =
        sqlx::query_as("SELECT body_hash, idempotency_key FROM comment_dedupes WHERE comment_id = $1")
            .bind(got.id)
            .fetch_one(pool)
            .await
            .unwrap();
    assert_eq!((hash, key), (hash_body(trimmed), None));

    let meta = wait_notification(pool, owner.id, NOTIF_TYPE_COMMENT_RECEIVED).await;
    assert_eq!(meta["comment_id"], got.id);
    assert_eq!(meta["comment_preview"], trimmed);
    assert_eq!(meta["day_owner_username"], "owner");
    assert_eq!(meta["day_date"], DAY);
    assert_eq!(meta["author_avatar"], "https://img/author.jpg");
    wait_notification(pool, friend.id, NOTIF_TYPE_COMMENT_MENTION).await;
    wait_for_async().await;
    assert_eq!(notification_types(pool, owner.id).await.len(), 1);
    assert_eq!(notification_types(pool, friend.id).await, vec![NOTIF_TYPE_COMMENT_MENTION]);
    assert!(notifications_of(pool, author.id).await.is_empty(), "authors are never notified about their own comment");
    db.finish().await;
}

#[tokio::test]
async fn create_comment_validation() {
    let Some(db) = TestDb::new("svc_create_validation").await else { return };
    let pool = &db.pool;
    let svc = service_with(pool, pool, None);
    let owner = create_user(pool, "owner").await;
    let author = create_user(pool, "author").await;

    assert_code(create(&svc, &author, &owner, "   ", None, None).await, c::ERR_CODE_COMMENT_EMPTY);
    assert_code(create(&svc, &author, &owner, &"a".repeat(201), None, None).await, c::ERR_CODE_COMMENT_TOO_LONG);
    let many: Vec<String> = (0..=10).map(|i| format!("@user_{i:02}")).collect();
    assert_code(create(&svc, &author, &owner, &many.join(" "), None, None).await, c::ERR_CODE_TOO_MANY_MENTIONS);
    assert_eq!(db.count("SELECT count(*) FROM comments").await, 0);

    let longest = create(&svc, &author, &owner, &"b".repeat(200), None, None).await.unwrap();
    assert_eq!(longest.body.len(), 200);
    assert!(longest.mentions.is_empty());

    let ghost = create(&svc, &author, &owner, "hello @ghost_user", None, None).await.unwrap();
    assert!(ghost.mentions.is_empty(), "mentions of unknown users are dropped");
    assert_eq!(db.count("SELECT count(*) FROM comment_mentions").await, 0);

    let text = "streak 🔥 día — ¡bien!";
    let unicode = create(&svc, &author, &owner, text, None, None).await.unwrap();
    assert_eq!(load_comment(pool, unicode.id).await.body, text);
    assert_code(create(&svc, &author, &owner, text, None, None).await, c::ERR_CODE_DUPLICATE_COMMENT);

    let next_day = day().succ_opt().unwrap();
    let other_day =
        create_on(&svc, &author, &owner, next_day, text, None, None).await.expect("not a duplicate on another day");
    assert_eq!(other_day.day_date, "2026-03-10");

    assert_code(create(&svc, &author, &owner, "reply", Some(999_999), None).await, c::ERR_CODE_PARENT_NOT_FOUND);
    db.finish().await;
}

#[tokio::test]
async fn create_comment_idempotency() {
    let Some(db) = TestDb::new("svc_idempotency").await else { return };
    let pool = &db.pool;
    let svc = service_with(pool, pool, None);
    let owner = create_user(pool, "owner").await;
    let author = create_user(pool, "author").await;
    let key = Some("client-key-1");

    let first = create(&svc, &author, &owner, "hello", None, key).await.unwrap();
    let again = create(&svc, &author, &owner, "different text", None, key).await.unwrap();
    assert_eq!(again.id, first.id, "a retried request returns the original comment");
    assert_eq!(again.body, "hello");
    assert_eq!(db.count("SELECT count(*) FROM comments").await, 1);

    create(&svc, &author, &owner, "empty key is ignored", None, Some("")).await.unwrap();

    // The key of a vanished comment does not block a new one.
    db.exec(&format!("DELETE FROM comments WHERE id = {}", first.id)).await;
    let created =
        create(&svc, &author, &owner, "brand new", None, key).await.expect("dedupe storage failure is only logged");
    assert_ne!(created.id, first.id);
    assert_eq!(load_comment(pool, created.id).await.body, "brand new");
    db.finish().await;
}

#[tokio::test]
async fn create_replies() {
    let Some(db) = TestDb::new("svc_replies").await else { return };
    let pool = &db.pool;
    let svc = service_with(pool, pool, Some(pool));
    let owner = create_user(pool, "owner").await;
    let alice = create_user(pool, "alice").await;
    let bob = create_user(pool, "bob").await;

    let top = create(&svc, &alice, &owner, "top level", None, None).await.unwrap();
    let reply = create(&svc, &bob, &owner, "first reply", Some(top.id), None).await.unwrap();
    assert_eq!(
        (reply.parent_comment_id, reply.root_comment_id, reply.reply_to_user_id),
        (Some(top.id), Some(top.id), Some(alice.id))
    );
    assert_eq!(reply.reply_to_username.as_deref(), Some("alice"));

    let nested = create(&svc, &alice, &owner, "nested reply", Some(reply.id), None).await.unwrap();
    assert_eq!(nested.parent_comment_id, Some(reply.id));
    assert_eq!(nested.root_comment_id, Some(top.id), "replies to replies keep the thread root");
    assert_eq!(nested.reply_to_user_id, Some(bob.id));

    assert_eq!(load_comment(pool, top.id).await.reply_count, 2, "every ancestor counts the reply");
    assert_eq!(load_comment(pool, reply.id).await.reply_count, 1);
    assert_eq!(load_comment(pool, nested.id).await.reply_count, 0);

    wait_notification(pool, bob.id, NOTIF_TYPE_COMMENT_REPLY).await;
    wait_notification(pool, alice.id, NOTIF_TYPE_COMMENT_REPLY).await;
    wait_for_async().await;
    assert_eq!(
        notification_types(pool, owner.id).await,
        vec![NOTIF_TYPE_COMMENT_RECEIVED; 3],
        "the day owner hears about every comment"
    );
    assert_eq!(notification_types(pool, alice.id).await, vec![NOTIF_TYPE_COMMENT_REPLY]);
    assert_eq!(notification_types(pool, bob.id).await, vec![NOTIF_TYPE_COMMENT_REPLY]);
    db.finish().await;
}

#[tokio::test]
async fn create_comment_with_degraded_dependencies() {
    let Some(db) = TestDb::new("svc_degraded").await else { return };
    let pool = &db.pool;
    let svc = service_with(pool, pool, None);
    let broken = broken_pool().await;
    let owner = create_user(pool, "owner").await;
    let author = create_user_with(pool, "author", avatar("https://img/a.jpg")).await;
    let friend = create_user(pool, "friend").await;

    // Dedupe lookups failing do not block commenting.
    db.hide("comment_dedupes").await;
    let got = create(&svc, &author, &owner, "dedupe down", None, Some("key-degraded")).await.unwrap();
    assert_eq!(load_comment(pool, got.id).await.body, "dedupe down");
    db.restore("comment_dedupes").await;

    // Comment insert failure.
    db.fail_statements("comments", "INSERT").await;
    assert_db_error(create(&svc, &author, &owner, "will fail", None, None).await, "failed to create comment");
    db.heal("comments").await;

    // A reply counter failure keeps the reply.
    let parent = seed_comment(pool, &owner, &friend, "parent", None, day()).await;
    db.fail_updates_when("comments", "NEW.reply_count <> OLD.reply_count").await;
    let reply = create(&svc, &author, &owner, "reply", Some(parent.id), None).await.unwrap();
    assert_eq!(reply.parent_comment_id, Some(parent.id));
    assert_eq!(load_comment(pool, parent.id).await.reply_count, 0);
    db.heal("comments").await;

    // User lookups failing drop mentions and author details.
    let no_users = service_with(pool, &broken, None);
    let got = create(&no_users, &author, &owner, "hi @friend", None, None).await.unwrap();
    assert!(got.mentions.is_empty());
    assert_eq!((got.author_avatar, got.author_username.as_str()), (None, "author"));

    // Mention storage failure still reports resolved mentions.
    db.fail_statements("comment_mentions", "INSERT").await;
    let got = create(&svc, &author, &owner, "hey @friend", None, None).await.unwrap();
    assert_eq!(names(&got.mentions), vec!["friend"]);
    assert_eq!(db.count(&format!("SELECT count(*) FROM comment_mentions WHERE comment_id = {}", got.id)).await, 0);
    db.heal("comment_mentions").await;
    db.finish().await;
}

#[tokio::test]
async fn comment_notifications() {
    let Some(db) = TestDb::new("svc_notifications").await else { return };
    let pool = &db.pool;
    let broken = broken_pool().await;
    let svc = service_with(pool, pool, Some(pool));
    let owner = create_user(pool, "owner").await;
    let alice = create_user_with(pool, "alice", avatar("https://img/alice.jpg")).await;
    let bob = create_user(pool, "bob").await;
    let public = create_user(pool, "public").await;
    let private = UserOpts { private: true, ..Default::default() };
    let private_followed = create_user_with(pool, "followed", private.clone()).await;
    let private_stranger = create_user_with(pool, "stranger", private).await;
    follow(pool, &alice, &private_followed).await;

    // Own top-level comment notifies nobody.
    create(&svc, &owner, &owner, "my day", None, None).await.unwrap();
    wait_for_async().await;
    assert_eq!(db.count("SELECT count(*) FROM notifications").await, 0);

    // Mentions respect privacy and are not repeated.
    create(&svc, &alice, &owner, "@owner @alice @public @followed @stranger @ghost", None, None).await.unwrap();
    wait_notification(pool, public.id, NOTIF_TYPE_COMMENT_MENTION).await;
    wait_notification(pool, private_followed.id, NOTIF_TYPE_COMMENT_MENTION).await;
    wait_for_async().await;
    assert_eq!(
        notification_types(pool, owner.id).await,
        vec![NOTIF_TYPE_COMMENT_RECEIVED],
        "one notification even when mentioned"
    );
    assert!(notifications_of(pool, alice.id).await.is_empty());
    assert_eq!(notification_types(pool, public.id).await, vec![NOTIF_TYPE_COMMENT_MENTION]);
    assert_eq!(notification_types(pool, private_followed.id).await, vec![NOTIF_TYPE_COMMENT_MENTION]);
    assert!(
        notifications_of(pool, private_stranger.id).await.is_empty(),
        "private users only hear from people they let follow them"
    );
    assert_eq!(notifications_of(pool, public.id).await[0].2["author_avatar"], "https://img/alice.jpg");

    // A reply to one's own comment only notifies the day owner.
    let own = create(&svc, &bob, &owner, "bob's comment", None, None).await.unwrap();
    let reply = create(&svc, &bob, &owner, "bob again", Some(own.id), None).await.unwrap();
    wait_for_async().await;
    assert!(notifications_of(pool, bob.id).await.is_empty());
    let owner_notifs = notifications_of(pool, owner.id).await;
    assert_eq!(owner_notifs.len(), 3);
    assert_eq!(owner_notifs[2].2["comment_id"], reply.id);
    assert_eq!(owner_notifs[2].2["author_avatar"], "");

    // A reply to the day owner is a single reply notification.
    let owners = create(&svc, &owner, &owner, "owner's comment", None, None).await.unwrap();
    create(&svc, &bob, &owner, "hi owner", Some(owners.id), None).await.unwrap();
    wait_for_async().await;
    let types = notification_types(pool, owner.id).await;
    assert_eq!(types.len(), 4);
    assert_eq!(types[3], NOTIF_TYPE_COMMENT_REPLY);

    let notifications = || {
        Some(Arc::new(gt_notify::NotificationService::new(Arc::new(gt_notify::NotificationRepository::new(
            pool.clone(),
        )))))
    };
    let users = Arc::new(UserRepository::new(pool.clone()));

    // Without a follow repository private mentions are notified.
    let no_follows = CommentService::new(CommentRepositories::new(pool.clone()), users.clone(), None, notifications());
    create(&no_follows, &bob, &owner, "hey @stranger", None, None).await.unwrap();
    wait_notification(pool, private_stranger.id, NOTIF_TYPE_COMMENT_MENTION).await;

    // A follow lookup failure skips private mentions.
    let broken_follows = CommentService::new(
        CommentRepositories::new(pool.clone()),
        users.clone(),
        Some(Arc::new(FollowRepository::new(broken.clone()))),
        notifications(),
    );
    let before = notifications_of(pool, private_followed.id).await.len();
    create(&broken_follows, &alice, &owner, "again @followed", None, None).await.unwrap();
    wait_for_async().await;
    assert_eq!(notifications_of(pool, private_followed.id).await.len(), before);

    // Notification failures are only logged; without a notification service nothing is sent.
    let before = db.count("SELECT count(*) FROM notifications").await;
    let failing = service_with(pool, pool, Some(&broken));
    create(&failing, &bob, &owner, "hello @public", None, None).await.unwrap();
    let silent = service_with(pool, pool, None);
    create(&silent, &bob, &owner, "quiet @public", None, None).await.unwrap();
    wait_for_async().await;
    assert_eq!(db.count("SELECT count(*) FROM notifications").await, before);
    db.finish().await;
}

#[tokio::test]
async fn notification_preview_keeps_whole_characters() {
    let Some(db) = TestDb::new("svc_preview").await else { return };
    let pool = &db.pool;
    let svc = service_with(pool, pool, Some(pool));
    let owner = create_user(pool, "owner").await;
    let author = create_user(pool, "author").await;
    let ascii = "a".repeat(95);
    // 105 characters; byte 100 falls inside an "é".
    create(&svc, &author, &owner, &format!("{ascii}{}", "é".repeat(10)), None, None).await.unwrap();

    let meta = wait_notification(pool, owner.id, NOTIF_TYPE_COMMENT_RECEIVED).await;
    assert_eq!(meta["comment_preview"], format!("{ascii}{}...", "é".repeat(5)));
    db.finish().await;
}

#[tokio::test]
async fn delete_comment() {
    let Some(db) = TestDb::new("svc_delete").await else { return };
    let pool = &db.pool;
    let svc = service_with(pool, pool, None);
    let owner = create_user(pool, "owner").await;
    let alice = create_user(pool, "alice").await;
    let bob = create_user(pool, "bob").await;

    // The author deletes their comment.
    let mine = seed_comment(pool, &owner, &alice, "mine", None, day()).await;
    svc.delete_comment(mine.id, alice.id, owner.id).await.unwrap();
    let stored = load_comment(pool, mine.id).await;
    assert!(stored.is_deleted && stored.deleted_at.is_some());
    assert_eq!(stored.body, "[Deleted]");
    assert_code(svc.delete_comment(mine.id, alice.id, owner.id).await, c::ERR_CODE_COMMENT_DELETED);

    // The day owner may delete comments on their day (owner taken from the comment).
    let moderated = seed_comment(pool, &owner, &alice, "moderated", None, day()).await;
    svc.delete_comment(moderated.id, owner.id, 0).await.unwrap();
    assert!(load_comment(pool, moderated.id).await.is_deleted);

    // Others may not.
    let not_yours = seed_comment(pool, &owner, &alice, "not yours", None, day()).await;
    assert_code(svc.delete_comment(not_yours.id, bob.id, 0).await, c::ERR_CODE_COMMENT_FORBIDDEN);
    assert!(!load_comment(pool, not_yours.id).await.is_deleted);
    assert_code(svc.delete_comment(999_999, bob.id, 0).await, c::ERR_CODE_COMMENT_NOT_FOUND);

    // A leaf reply decrements every ancestor; a reply with children stays as a placeholder.
    let top = seed_comment(pool, &owner, &alice, "top", None, day()).await;
    let mid = seed_comment(pool, &owner, &bob, "mid", Some(&top), day()).await;
    let leaf = seed_comment(pool, &owner, &alice, "leaf", Some(&mid), day()).await;
    set_comment(pool, top.id, "reply_count", 2i64).await;
    set_comment(pool, mid.id, "reply_count", 1i64).await;
    svc.delete_comment(mid.id, bob.id, 0).await.unwrap();
    assert_eq!(load_comment(pool, top.id).await.reply_count, 2);
    svc.delete_comment(leaf.id, alice.id, 0).await.unwrap();
    assert_eq!(load_comment(pool, top.id).await.reply_count, 1);
    assert_eq!(load_comment(pool, mid.id).await.reply_count, 0);

    // Soft delete failure.
    let sticky = seed_comment(pool, &owner, &alice, "sticky", None, day()).await;
    db.fail_updates_when("comments", "NEW.is_deleted AND NOT OLD.is_deleted").await;
    assert_db_error(svc.delete_comment(sticky.id, alice.id, 0).await, "failed to delete comment");
    assert!(!load_comment(pool, sticky.id).await.is_deleted);
    db.heal("comments").await;

    // A reply counter failure is only logged.
    let top = seed_comment(pool, &owner, &alice, "top 2", None, day()).await;
    let reply = seed_comment(pool, &owner, &bob, "reply", Some(&top), day()).await;
    set_comment(pool, top.id, "reply_count", 1i64).await;
    db.fail_updates_when("comments", "NEW.reply_count < OLD.reply_count").await;
    svc.delete_comment(reply.id, bob.id, 0).await.unwrap();
    assert!(load_comment(pool, reply.id).await.is_deleted);
    assert_eq!(load_comment(pool, top.id).await.reply_count, 1);
    db.heal("comments").await;
    db.finish().await;
}

#[tokio::test]
async fn likes() {
    let Some(db) = TestDb::new("svc_likes").await else { return };
    let pool = &db.pool;
    let svc = service_with(pool, pool, Some(pool));
    let owner = create_user(pool, "owner").await;
    let author = create_user(pool, "author").await;
    let liker = create_user_with(pool, "liker", avatar("https://img/liker.jpg")).await;
    let comment = seed_comment(pool, &owner, &author, &"x".repeat(150), None, day()).await;

    assert_eq!(svc.like_comment(comment.id, liker.id, "liker").await.unwrap(), (true, 1));
    assert_eq!(load_comment(pool, comment.id).await.like_count, 1);
    assert_eq!(svc.like_comment(comment.id, liker.id, "liker").await.unwrap(), (true, 1), "liking twice is idempotent");
    assert_eq!(load_comment(pool, comment.id).await.like_count, 1);
    assert_eq!(svc.like_comment(comment.id, author.id, "author").await.unwrap(), (true, 2));

    wait_notification(pool, author.id, NOTIF_TYPE_COMMENT_LIKED).await;
    wait_for_async().await;
    let notifs = notifications_of(pool, author.id).await;
    assert_eq!(notifs.len(), 1, "one notification for the first like, none for self-likes");
    let (kind, body, meta) = &notifs[0];
    assert_eq!(kind, NOTIF_TYPE_COMMENT_LIKED);
    assert_eq!(body, "liker liked your comment");
    assert_eq!(meta["comment_preview"], format!("{}...", "x".repeat(100)));
    assert_eq!(meta["day_owner_username"], "owner");
    assert_eq!(meta["author_avatar"], "https://img/liker.jpg");

    assert_eq!(svc.unlike_comment(comment.id, liker.id).await.unwrap(), (false, 1));
    assert_eq!(load_comment(pool, comment.id).await.like_count, 1);
    assert_eq!(svc.unlike_comment(comment.id, liker.id).await.unwrap(), (false, 1), "unliking twice is a no-op");

    assert_code(svc.like_comment(999_999, liker.id, "liker").await, c::ERR_CODE_COMMENT_NOT_FOUND);
    assert_code(svc.unlike_comment(999_999, liker.id).await, c::ERR_CODE_COMMENT_NOT_FOUND);
    let gone = seed_comment(pool, &owner, &author, "gone", None, day()).await;
    set_comment(pool, gone.id, "is_deleted", true).await;
    assert_code(svc.like_comment(gone.id, liker.id, "liker").await, c::ERR_CODE_COMMENT_DELETED);

    // Without a notification service.
    let quiet = service_with(pool, pool, None);
    let other = seed_comment(pool, &owner, &author, "quiet", None, day()).await;
    assert_eq!(quiet.like_comment(other.id, liker.id, "liker").await.unwrap(), (true, 1));
    wait_for_async().await;
    assert_eq!(notifications_of(pool, author.id).await.len(), 1);

    // Storage failures.
    let target = seed_comment(pool, &owner, &author, "fragile", None, day()).await;
    set_comment(pool, target.id, "like_count", 3i64).await;
    db.fail_statements("comment_likes", "INSERT").await;
    assert_db_error(svc.like_comment(target.id, liker.id, "liker").await, "failed to like comment");
    db.heal("comment_likes").await;

    db.fail_updates_when("comments", "NEW.like_count <> OLD.like_count").await;
    assert_eq!(
        svc.like_comment(target.id, liker.id, "liker").await.unwrap(),
        (true, 4),
        "the like is stored even if the counter fails"
    );
    assert_eq!(load_comment(pool, target.id).await.like_count, 3);
    assert_eq!(svc.unlike_comment(target.id, liker.id).await.unwrap(), (false, 2));
    db.heal("comments").await;

    db.fail_statements("comment_likes", "DELETE").await;
    assert_db_error(svc.unlike_comment(target.id, liker.id).await, "failed to unlike comment");
    db.heal("comment_likes").await;
    db.finish().await;
}

#[tokio::test]
async fn top_level_comments() {
    let Some(db) = TestDb::new("svc_top_level").await else { return };
    let pool = &db.pool;
    let svc = service_with(pool, pool, None);
    let owner = create_user(pool, "owner").await;
    let viewer = create_user(pool, "viewer").await;
    let writer = create_user(pool, "writer").await;
    let verified = create_user_with(pool, "verified", UserOpts { verified: true, ..Default::default() }).await;
    let now = Utc::now();

    let old = seed_comment(pool, &owner, &writer, "old", None, day()).await;
    set_created_at(pool, old.id, now - Duration::hours(48)).await;
    let popular = seed_comment(pool, &owner, &writer, "popular @viewer", None, day()).await;
    set_created_at(pool, popular.id, now - Duration::hours(48)).await;
    set_comment(pool, popular.id, "like_count", 7i64).await;
    let fresh = seed_comment(pool, &owner, &writer, "fresh", None, day()).await;
    set_created_at(pool, fresh.id, now - Duration::minutes(2)).await;
    let star = seed_comment(pool, &owner, &verified, "verified", None, day()).await;
    set_created_at(pool, star.id, now - Duration::minutes(1)).await;
    seed_comment(pool, &owner, &writer, "reply", Some(&old), day()).await;
    seed_comment(pool, &owner, &writer, "other day", None, day().succ_opt().unwrap()).await;
    db.exec(&format!("INSERT INTO comment_likes (comment_id, user_id) VALUES ({}, {})", popular.id, viewer.id)).await;
    db.exec(&format!(
        "INSERT INTO comment_mentions (comment_id, mentioned_user_id, username) VALUES ({}, {}, 'viewer')",
        popular.id, viewer.id
    ))
    .await;
    let ids = |page: &gt_comments::dto::CommentsListResponse| page.comments.iter().map(|c| c.id).collect::<Vec<_>>();
    let list = |sort, cursor, limit| svc.get_top_level_comments(owner.id, viewer.id, day(), sort, cursor, limit);

    // Newest first with cursor pagination.
    let page = list(CommentSort::Newest, None, 2).await.unwrap();
    assert!(page.success);
    assert_eq!(ids(&page), vec![star.id, fresh.id]);
    assert!(page.has_more);
    assert_eq!(page.next_cursor, Some(fresh.id));
    let rest = list(CommentSort::Newest, page.next_cursor, 2).await.unwrap();
    assert_eq!(ids(&rest), vec![popular.id, old.id]);
    assert!(!rest.has_more);
    assert_eq!(rest.next_cursor, None);
    let popular_dto = &rest.comments[0];
    assert!(popular_dto.liked_by_me);
    assert_eq!(popular_dto.mentions, vec![MentionDto { user_id: viewer.id, username: "viewer".into() }]);
    assert_eq!(popular_dto.like_count, 7);
    assert!(!rest.comments[1].liked_by_me);
    assert!(rest.comments[1].mentions.is_empty());

    // Top ranks likes, recency and verified authors.
    let page = list(CommentSort::Top, None, 2).await.unwrap();
    assert_eq!(ids(&page), vec![popular.id, star.id]);
    assert!(page.has_more);
    let rest = list(CommentSort::Top, page.next_cursor, 2).await.unwrap();
    assert_eq!(ids(&rest), vec![fresh.id, old.id]);
    assert!(!rest.has_more);
    let end = list(CommentSort::Top, Some(old.id), 2).await.unwrap();
    assert!(end.comments.is_empty() && !end.has_more);
    let all = list(CommentSort::Top, Some(999_999), 10).await.unwrap();
    assert_eq!(ids(&all), vec![popular.id, star.id, fresh.id, old.id], "an unknown cursor restarts the ranking");

    // The limit is clamped.
    for limit in [0, -5, c::COMMENT_LIST_MAX_LIMIT + 1] {
        assert_eq!(list(CommentSort::Newest, None, limit).await.unwrap().comments.len(), 4);
    }

    // Empty day.
    let empty = svc.get_top_level_comments(viewer.id, viewer.id, day(), CommentSort::Newest, None, 10).await.unwrap();
    assert!(empty.comments.is_empty() && !empty.has_more);
    assert_eq!(gt_core::gojson::to_string(&empty).unwrap(), r#"{"success":true,"comments":[],"has_more":false}"#);

    // Enrichment failures degrade gracefully.
    db.hide("comment_likes").await;
    db.hide("comment_mentions").await;
    let page = list(CommentSort::Newest, None, 10).await.unwrap();
    assert_eq!(page.comments.len(), 4);
    assert!(page.comments.iter().all(|c| !c.liked_by_me && c.mentions.is_empty()));
    db.restore("comment_likes").await;
    db.restore("comment_mentions").await;

    // Database failure.
    let broken = service_with(&broken_pool().await, pool, None);
    for sort in [CommentSort::Newest, CommentSort::Top] {
        let result = broken.get_top_level_comments(owner.id, viewer.id, day(), sort, None, 10).await;
        assert_db_error(result, "failed to get comments");
    }
    db.finish().await;
}

#[tokio::test]
async fn replies() {
    let Some(db) = TestDb::new("svc_get_replies").await else { return };
    let pool = &db.pool;
    let svc = service_with(pool, pool, None);
    let owner = create_user(pool, "owner").await;
    let alice = create_user(pool, "alice").await;
    let bob = create_user(pool, "bob").await;
    let base = Utc::now() - Duration::hours(1);

    let root = seed_comment(pool, &owner, &alice, "root", None, day()).await;
    let mut replies = Vec::new();
    for i in 0..3 {
        let r = seed_comment(pool, &owner, &bob, &format!("reply {i}"), Some(&root), day()).await;
        set_created_at(pool, r.id, base + Duration::minutes(i)).await;
        replies.push(r.id);
    }

    let page = svc.get_replies(root.id, alice.id, None, 2).await.unwrap();
    assert_eq!(page.comments.iter().map(|c| c.id).collect::<Vec<_>>(), replies[..2], "oldest first");
    assert!(page.has_more);
    assert_eq!(page.next_cursor, Some(replies[1]));
    assert_eq!(page.comments[0].reply_to_username.as_deref(), Some("alice"));

    let rest = svc.get_replies(root.id, alice.id, page.next_cursor, 2).await.unwrap();
    assert_eq!(rest.comments.iter().map(|c| c.id).collect::<Vec<_>>(), vec![replies[2]]);
    assert!(!rest.has_more);
    assert_eq!(rest.next_cursor, None);

    for limit in [0, c::COMMENT_REPLY_MAX_LIMIT + 1] {
        assert_eq!(svc.get_replies(root.id, alice.id, None, limit).await.unwrap().comments.len(), 3);
    }
    assert!(svc.get_replies(replies[0], alice.id, None, 10).await.unwrap().comments.is_empty());

    let broken = service_with(&broken_pool().await, pool, None);
    assert_db_error(broken.get_replies(root.id, alice.id, None, 10).await, "failed to get replies");
    db.finish().await;
}

#[tokio::test]
async fn comment_count_and_lookup() {
    let Some(db) = TestDb::new("svc_count").await else { return };
    let pool = &db.pool;
    let svc = service_with(pool, pool, None);
    let owner = create_user(pool, "owner").await;
    let alice = create_user(pool, "alice").await;
    let top = seed_comment(pool, &owner, &alice, "one", None, day()).await;
    seed_comment(pool, &owner, &alice, "two", Some(&top), day()).await;
    let deleted = seed_comment(pool, &owner, &alice, "deleted", None, day()).await;
    set_comment(pool, deleted.id, "is_deleted", true).await;
    seed_comment(pool, &owner, &alice, "other day", None, day().pred_opt().unwrap()).await;

    assert_eq!(svc.get_comment_count(owner.id, day()).await.unwrap(), 2, "replies count, deleted comments do not");
    let broken = service_with(&broken_pool().await, pool, None);
    assert!(broken.get_comment_count(owner.id, day()).await.is_err());

    assert_eq!(svc.get_comment_by_id(top.id).await.unwrap().unwrap().body, "one");
    assert!(svc.get_comment_by_id(999_999).await.unwrap().is_none());
    db.finish().await;
}

#[tokio::test]
async fn edit_comment() {
    let Some(db) = TestDb::new("svc_edit").await else { return };
    let pool = &db.pool;
    let svc = service_with(pool, pool, Some(pool));
    let owner = create_user(pool, "owner").await;
    let alice = create_user(pool, "alice").await;
    let bob = create_user(pool, "bob").await;
    let carol = create_user(pool, "carol").await;

    // The author edits within the window and mentions are replaced.
    let top = seed_comment(pool, &owner, &bob, "top", None, day()).await;
    let reply = seed_comment(pool, &owner, &alice, "hi @bob", Some(&top), day()).await;
    db.exec(&format!(
        "INSERT INTO comment_mentions (comment_id, mentioned_user_id, username) VALUES ({}, {}, 'bob')",
        reply.id, bob.id
    ))
    .await;
    db.exec(&format!("INSERT INTO comment_likes (comment_id, user_id) VALUES ({}, {})", reply.id, alice.id)).await;

    let got = svc.edit_comment(reply.id, alice.id, "  hello @carol  ").await.unwrap();
    assert_eq!(got.body, "hello @carol");
    assert!(got.is_edited && got.liked_by_me);
    assert_eq!(names(&got.mentions), vec!["carol"]);
    assert_eq!(got.reply_to_username.as_deref(), Some("bob"));
    let stored = load_comment(pool, reply.id).await;
    assert_eq!((stored.body.as_str(), stored.is_edited), ("hello @carol", true));
    let mentioned: Vec<i64> =
        sqlx::query_scalar("SELECT mentioned_user_id FROM comment_mentions WHERE comment_id = $1")
            .bind(reply.id)
            .fetch_all(pool)
            .await
            .unwrap();
    assert_eq!(mentioned, vec![carol.id]);
    wait_for_async().await;
    assert!(notifications_of(pool, carol.id).await.is_empty(), "edits never notify");

    // Rules.
    let original = seed_comment(pool, &owner, &alice, "original", None, day()).await;
    assert_code(svc.edit_comment(original.id, bob.id, "hijack").await, c::ERR_CODE_COMMENT_FORBIDDEN);
    assert_code(svc.edit_comment(original.id, alice.id, "   ").await, c::ERR_CODE_COMMENT_EMPTY);
    assert_code(svc.edit_comment(original.id, alice.id, &"z".repeat(201)).await, c::ERR_CODE_COMMENT_TOO_LONG);
    let many: Vec<String> = (0..=10).map(|i| format!("@user_{i:02}")).collect();
    assert_code(svc.edit_comment(original.id, alice.id, &many.join(" ")).await, c::ERR_CODE_TOO_MANY_MENTIONS);
    let stored = load_comment(pool, original.id).await;
    assert_eq!(
        (stored.body.as_str(), stored.is_edited),
        ("original", false),
        "rejected edits leave the comment unchanged"
    );
    assert_code(svc.edit_comment(999_999, alice.id, "x").await, c::ERR_CODE_COMMENT_NOT_FOUND);
    let gone = seed_comment(pool, &owner, &alice, "gone", None, day()).await;
    set_comment(pool, gone.id, "is_deleted", true).await;
    assert_code(svc.edit_comment(gone.id, alice.id, "x").await, c::ERR_CODE_COMMENT_DELETED);
    let stale = seed_comment(pool, &owner, &alice, "stale", None, day()).await;
    set_created_at(pool, stale.id, Utc::now() - Duration::minutes(61)).await;
    assert_code(svc.edit_comment(stale.id, alice.id, "too late").await, c::ERR_CODE_COMMENT_EDIT_EXPIRED);

    // Update failure.
    let keep = seed_comment(pool, &owner, &alice, "keep me", None, day()).await;
    db.fail_statements("comments", "UPDATE").await;
    assert_db_error(svc.edit_comment(keep.id, alice.id, "changed").await, "failed to update comment");
    assert_eq!(load_comment(pool, keep.id).await.body, "keep me");
    db.heal("comments").await;

    // Old mentions that cannot be removed are only logged.
    let plain = seed_comment(pool, &owner, &alice, "plain", None, day()).await;
    db.fail_statements("comment_mentions", "DELETE").await;
    let got = svc.edit_comment(plain.id, alice.id, "edited").await.unwrap();
    assert_eq!((got.body.as_str(), got.reply_to_username), ("edited", None));
    db.heal("comment_mentions").await;

    // Reload failure.
    let before = seed_comment(pool, &owner, &alice, "before", None, day()).await;
    db.hide("users").await;
    assert_db_error(svc.edit_comment(before.id, alice.id, "after").await, "failed to fetch updated comment");
    db.restore("users").await;
    db.finish().await;
}
