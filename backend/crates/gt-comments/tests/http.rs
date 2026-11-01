//! HTTP tests of the comment routes (port of `internal/handlers/comment_test.go`), through the
//! real router, guards and database.

mod common;

use axum::Router;
use chrono::{Duration, Utc};
use common::*;
use gt_core::constants as c;
use gt_core::models::{
    User, NOTIF_TYPE_COMMENT_LIKED, NOTIF_TYPE_COMMENT_MENTION, NOTIF_TYPE_COMMENT_RECEIVED, NOTIF_TYPE_COMMENT_REPLY,
};
use serde_json::{json, Value};

fn day_path(owner: &str, date: &str) -> String {
    format!("/api/days/{owner}/{date}/comments")
}

fn replies_path(owner: &str, parent_id: impl std::fmt::Display) -> String {
    format!("{}/{parent_id}/replies", day_path(owner, DAY))
}

fn comment_path(id: impl std::fmt::Display) -> String {
    format!("/api/comments/{id}")
}

/// A router plus tokens for the test users.
struct Client {
    stack: Stack,
    router: Router,
}

impl Client {
    fn new(pool: &sqlx::PgPool) -> Self {
        let stack = Stack::new(pool);
        let router = stack.router();
        Self { stack, router }
    }

    async fn call(&self, user: &User, method: &str, uri: &str, body: Option<&str>) -> Res {
        send(&self.router, method, uri, Some(&self.stack.token(user)), body).await
    }

    async fn call_with(
        &self,
        user: &User,
        method: &str,
        uri: &str,
        body: Option<&str>,
        headers: &[(&str, &str)],
    ) -> Res {
        send_with(&self.router, method, uri, Some(&self.stack.token(user)), body, headers).await
    }
}

#[track_caller]
fn decode(res: &Res, status: u16) -> Value {
    assert_eq!(res.status, status, "body: {}", res.body);
    assert_eq!(res.content_type, "application/json");
    res.json()
}

#[tokio::test]
async fn day_endpoints_validate_the_day() {
    let Some(db) = TestDb::new("http_validate_day").await else { return };
    let pool = &db.pool;
    let client = Client::new(pool);
    let owner = create_user(pool, "owner").await;
    let viewer = create_user(pool, "viewer").await;
    let hidden = create_user_with(pool, "hidden", UserOpts { private: true, ..Default::default() }).await;
    let root = seed_comment(pool, &owner, &owner, "root", None, day()).await;
    let body = body_json("hi");

    let endpoints = |owner: &str, date: &str| {
        vec![
            ("POST", day_path(owner, date)),
            ("POST", format!("{}/{}/replies", day_path(owner, date), root.id)),
            ("GET", day_path(owner, date)),
            ("GET", format!("{}/count", day_path(owner, date))),
        ]
    };
    for (i, (method, _)) in endpoints("owner", DAY).iter().enumerate() {
        let path = |owner: &str, date: &str| endpoints(owner, date)[i].1.clone();
        let res = client.call(&viewer, method, &path("owner", "09-03-2026"), Some(&body)).await;
        res.assert_error(400, c::ERR_CODE_INVALID_DATE, "Invalid date format (use YYYY-MM-DD)");
        let res = client.call(&viewer, method, &path("nobody", DAY), Some(&body)).await;
        res.assert_error(404, c::ERR_CODE_USER_NOT_FOUND, "User not found");
        let res = client.call(&viewer, method, &path(&hidden.username, DAY), Some(&body)).await;
        res.assert_error(403, c::ERR_CODE_ACCOUNT_PRIVATE, "This account is private");
    }

    let res = client.call(&viewer, "POST", &replies_path("owner", "abc"), Some(&body)).await;
    res.assert_error(400, c::ERR_CODE_INVALID_REQUEST, "Invalid comment ID");
    db.finish().await;
}

#[tokio::test]
async fn routes_apply_the_go_guards() {
    let Some(db) = TestDb::new("http_guards").await else { return };
    let pool = &db.pool;
    let client = Client::new(pool);
    let user = create_user(pool, "user").await;

    let cases = [
        ("POST", day_path("user", DAY), "15"),
        ("GET", day_path("user", DAY), "200"),
        ("GET", format!("{}/count", day_path("user", DAY)), "200"),
        ("POST", replies_path("user", 1), "15"),
        ("DELETE", comment_path(1), "200"),
        ("PUT", comment_path(1), "15"),
        ("POST", format!("{}/like", comment_path(1)), "60"),
        ("DELETE", format!("{}/like", comment_path(1)), "60"),
        ("GET", format!("{}/replies", comment_path(1)), "200"),
    ];
    for (method, uri, limit) in &cases {
        let res = send(&client.router, method, uri, None, None).await;
        res.assert_error(401, c::ERR_CODE_MISSING_AUTH_HEADER, "Missing Authorization Header");

        let mut req = axum::http::Request::builder()
            .method(*method)
            .uri(uri)
            .header("Authorization", format!("Bearer {}", client.stack.token(&user)))
            .body(axum::body::Body::empty())
            .unwrap();
        req.extensions_mut().insert(axum::extract::ConnectInfo(std::net::SocketAddr::from(([127, 0, 0, 1], 1))));
        let resp = tower::ServiceExt::oneshot(client.router.clone(), req).await.unwrap();
        assert_eq!(resp.headers()["x-ratelimit-limit"], *limit, "{method} {uri}");
    }

    // Other methods on these paths are not guarded: no authentication, just 405.
    let res = send(&client.router, "PATCH", &comment_path(1), None, None).await;
    assert_eq!(res.status, 405);

    // The comment limiter allows 15 writes per minute and user, shared by comment and reply
    // creation and edits (3 used above).
    for _ in 0..12 {
        assert_eq!(client.call(&user, "PUT", &comment_path(1), Some(&body_json("x"))).await.status, 404);
    }
    let res = client.call(&user, "PUT", &comment_path(1), Some(&body_json("x"))).await;
    res.assert_error(429, c::ERR_CODE_RATE_LIMIT_EXCEEDED, c::MSG_RATE_LIMIT_COMMENT);
    db.finish().await;
}

#[tokio::test]
async fn create_comment() {
    let Some(db) = TestDb::new("http_create").await else { return };
    let pool = &db.pool;
    let client = Client::new(pool);
    let owner = create_user_with(pool, "owner", UserOpts { private: true, ..Default::default() }).await;
    let author = create_user_with(
        pool,
        "author",
        UserOpts { verified: true, avatar: Some("http://pics.example/author.jpg"), ..Default::default() },
    )
    .await;
    let friend = create_user(pool, "friend_1").await;
    follow(pool, &author, &owner).await;
    let path = day_path("owner", DAY);

    let validation = [
        (r#"{"body":"#.to_string(), c::ERR_CODE_INVALID_REQUEST, "Invalid request body"),
        (body_json("   "), c::ERR_CODE_COMMENT_EMPTY, "Comment cannot be empty"),
        (body_json(&"x".repeat(201)), c::ERR_CODE_COMMENT_TOO_LONG, "Comment must be 200 characters or less"),
        (
            body_json("@aaa @bbb @ccc @ddd @eee @fff @ggg @hhh @iii @jjj @kkk"),
            c::ERR_CODE_TOO_MANY_MENTIONS,
            "Too many mentions (max 10 per comment)",
        ),
    ];
    for (body, code, message) in &validation {
        client.call(&author, "POST", &path, Some(body)).await.assert_error(400, code, message);
    }
    assert_eq!(db.count("SELECT count(*) FROM comments").await, 0);

    // A follower comments on a private day.
    let res = client.call(&author, "POST", &path, Some(&body_json("  Great day @friend_1 and @nobody_here  "))).await;
    let got = decode(&res, 201);
    assert!(res.body.starts_with(r#"{"success":true,"comment":{"id":"#), "{}", res.body);
    assert!(res.body.ends_with(r#""},"message":"Comment created successfully"}"#), "{}", res.body);
    let mut comment = got["comment"].clone();
    assert!(comment["id"].as_i64().unwrap() > 0);
    assert!(!comment["created_at"].as_str().unwrap().is_empty());
    comment.as_object_mut().unwrap().retain(|k, _| k != "id" && k != "created_at");
    assert_eq!(
        comment,
        json!({
            "day_owner_id": owner.id,
            "day_date": DAY,
            "author_id": author.id,
            "author_username": "author",
            "author_avatar": "http://pics.example/author.jpg",
            "author_avatar_thumb": "http://pics.example/author.jpg?thumb",
            "author_verified": true,
            "body": "Great day @friend_1 and @nobody_here",
            "like_count": 0,
            "reply_count": 0,
            "is_edited": false,
            "is_deleted": false,
            "liked_by_me": false,
            "mentions": [{"user_id": friend.id, "username": "friend_1"}],
        })
    );
    assert_eq!(
        db.count(&format!("SELECT count(*) FROM comment_mentions WHERE mentioned_user_id = {}", friend.id)).await,
        1
    );

    // The same text again is a duplicate.
    let res = client.call(&author, "POST", &path, Some(&body_json("Great day @friend_1 and @nobody_here"))).await;
    res.assert_error(
        409,
        c::ERR_CODE_DUPLICATE_COMMENT,
        "Duplicate comment detected. Please wait before posting again.",
    );

    // A repeated idempotency key returns the first comment.
    let key = [("X-Idempotency-Key", "retry-key-1")];
    let first = decode(&client.call_with(&author, "POST", &path, Some(&body_json("first attempt")), &key).await, 201);
    let retry = decode(&client.call_with(&author, "POST", &path, Some(&body_json("second attempt")), &key).await, 201);
    assert_eq!(first["comment"]["id"], retry["comment"]["id"]);
    assert_eq!(retry["comment"]["body"], "first attempt");
    assert_eq!(db.count("SELECT count(*) FROM comments WHERE body = 'second attempt'").await, 0);
    db.finish().await;
}

#[tokio::test]
async fn create_reply() {
    let Some(db) = TestDb::new("http_reply").await else { return };
    let pool = &db.pool;
    let client = Client::new(pool);
    let owner = create_user(pool, "owner").await;
    let author = create_user(pool, "author").await;
    let other = create_user(pool, "other").await;
    let root = seed_comment(pool, &owner, &author, "root comment", None, day()).await;

    // Reply to a top-level comment.
    let res = client.call(&owner, "POST", &replies_path("owner", root.id), Some(&body_json("thanks!"))).await;
    let first = decode(&res, 201)["comment"].clone();
    assert_eq!(first["parent_comment_id"], root.id);
    assert_eq!(first["root_comment_id"], root.id);
    assert_eq!(first["reply_to_user_id"], author.id);
    assert_eq!(first["reply_to_username"], "author");
    assert_eq!(first["mentions"], json!([]));
    let first_id = first["id"].as_i64().unwrap();

    // Replies to replies stay in the root thread.
    let res = client.call(&other, "POST", &replies_path("owner", first_id), Some(&body_json("me too"))).await;
    let nested = decode(&res, 201)["comment"].clone();
    assert_eq!(nested["parent_comment_id"], first_id);
    assert_eq!(nested["root_comment_id"], root.id);
    assert_eq!(nested["reply_to_username"], "owner");
    assert_eq!(load_comment(pool, root.id).await.reply_count, 2);
    assert_eq!(load_comment(pool, first_id).await.reply_count, 1);

    // A repeated idempotency key returns the first reply.
    let key = [("X-Idempotency-Key", "reply-retry-key")];
    let target = replies_path("owner", root.id);
    let got = decode(&client.call_with(&other, "POST", &target, Some(&body_json("first try")), &key).await, 201);
    let retry = decode(&client.call_with(&other, "POST", &target, Some(&body_json("second try")), &key).await, 201);
    assert_eq!(got["comment"]["id"], retry["comment"]["id"]);
    assert_eq!(retry["comment"]["body"], "first try");
    assert_eq!(db.count("SELECT count(*) FROM comments WHERE body = 'second try'").await, 0);
    assert_eq!(load_comment(pool, root.id).await.reply_count, 3);

    // Errors.
    let errors = [
        (
            replies_path("owner", 999_999),
            body_json("hello"),
            404,
            c::ERR_CODE_PARENT_NOT_FOUND,
            "Parent comment not found",
        ),
        (target.clone(), r#"{"body":"#.to_string(), 400, c::ERR_CODE_INVALID_REQUEST, "Invalid request body"),
        (target.clone(), body_json(""), 400, c::ERR_CODE_COMMENT_EMPTY, "Comment cannot be empty"),
        (
            target.clone(),
            body_json("thanks!"),
            409,
            c::ERR_CODE_DUPLICATE_COMMENT,
            "Duplicate comment detected. Please wait before posting again.",
        ),
    ];
    for (uri, body, status, code, message) in &errors {
        client.call(&owner, "POST", uri, Some(body)).await.assert_error(*status, code, message);
    }
    db.finish().await;
}

#[tokio::test]
async fn reply_parent_must_belong_to_the_day() {
    let Some(db) = TestDb::new("http_reply_parent").await else { return };
    let pool = &db.pool;
    let client = Client::new(pool);
    let hidden = create_user_with(pool, "hidden", UserOpts { private: true, ..Default::default() }).await;
    let public = create_user(pool, "public").await;
    let stranger = create_user(pool, "stranger").await;
    let secret = seed_comment(pool, &hidden, &hidden, "private thread", None, day()).await;
    let yesterday = seed_comment(pool, &public, &public, "yesterday", None, day().pred_opt().unwrap()).await;
    let today = seed_comment(pool, &public, &public, "today", None, day()).await;
    let reply = |owner: &'static str, parent: i64| {
        let client = &client;
        let stranger = &stranger;
        async move { client.call(stranger, "POST", &replies_path(owner, parent), Some(&body_json("sneaky"))).await }
    };

    // A parent outside the URL's day is indistinguishable from a missing one.
    for parent in [secret.id, yesterday.id, 999_999] {
        reply("public", parent).await.assert_error(404, c::ERR_CODE_PARENT_NOT_FOUND, "Parent comment not found");
    }
    reply("hidden", secret.id).await.assert_error(403, c::ERR_CODE_ACCOUNT_PRIVATE, "This account is private");
    assert_eq!(db.count("SELECT count(*) FROM comments").await, 3, "no reply was stored");

    let got = decode(&reply("public", today.id).await, 201)["comment"].clone();
    assert_eq!(got["parent_comment_id"], today.id);
    assert_eq!(got["day_owner_id"], public.id);
    assert_eq!(got["day_date"], DAY);
    db.finish().await;
}

#[tokio::test]
async fn create_comment_database_failures() {
    let Some(db) = TestDb::new("http_create_failures").await else { return };
    let pool = &db.pool;
    let client = Client::new(pool);
    let owner = create_user(pool, "owner").await;
    let author = create_user(pool, "author").await;
    let root = seed_comment(pool, &owner, &owner, "root", None, day()).await;
    db.fail_statements("comments", "INSERT").await;

    let res = client.call(&author, "POST", &day_path("owner", DAY), Some(&body_json("hello"))).await;
    res.assert_error(500, c::ERR_CODE_CREATE_FAILED, "Failed to create comment");
    let res = client.call(&author, "POST", &replies_path("owner", root.id), Some(&body_json("hello"))).await;
    res.assert_error(500, c::ERR_CODE_CREATE_FAILED, "Failed to create reply");
    assert_eq!(db.count("SELECT count(*) FROM comments").await, 1);
    db.finish().await;
}

#[tokio::test]
async fn get_comments() {
    let Some(db) = TestDb::new("http_get_comments").await else { return };
    let pool = &db.pool;
    let client = Client::new(pool);
    let owner = create_user(pool, "owner").await;
    let viewer = create_user(pool, "viewer").await;
    let now = Utc::now();
    let oldest = seed_comment(pool, &owner, &viewer, "oldest", None, day()).await;
    set_created_at(pool, oldest.id, now - Duration::hours(3)).await;
    let liked = seed_comment(pool, &owner, &owner, "liked", None, day()).await;
    set_created_at(pool, liked.id, now - Duration::hours(2)).await;
    let newest = seed_comment(pool, &owner, &viewer, "newest", None, day()).await;
    set_created_at(pool, newest.id, now - Duration::hours(1)).await;
    seed_comment(pool, &owner, &owner, "a reply", Some(&oldest), day()).await;
    set_comment(pool, oldest.id, "reply_count", 1i64).await;
    set_comment(pool, liked.id, "like_count", 3i64).await;
    db.exec(&format!("INSERT INTO comment_likes (comment_id, user_id) VALUES ({}, {})", liked.id, viewer.id)).await;
    let list = |query: String| {
        let (client, viewer) = (&client, &viewer);
        async move { decode(&client.call(viewer, "GET", &format!("{}{query}", day_path("owner", DAY)), None).await, 200) }
    };
    let ranked = vec![liked.id, newest.id, oldest.id];

    // Top comments by default.
    let got = list(String::new()).await;
    assert_eq!(got["success"], true);
    assert_eq!(ids(&got), ranked, "likes first, then recency; replies are not listed");
    assert_eq!(got["comments"][0]["liked_by_me"], true);
    assert_eq!(got["comments"][2]["reply_count"], 1);
    assert_eq!(got["has_more"], false);
    assert!(got.get("next_cursor").is_none());
    let stored = load_comment(pool, liked.id).await.created_at;
    assert_eq!(got["comments"][0]["created_at"], gt_core::gojson::format_local_literal_z(&stored));

    // Newest first with a cursor.
    let first = list("?sort=newest&limit=2".into()).await;
    assert_eq!(ids(&first), vec![newest.id, liked.id]);
    assert_eq!((first["has_more"].clone(), first["next_cursor"].clone()), (json!(true), json!(liked.id)));
    let second = list(format!("?sort=newest&limit=2&cursor={}", liked.id)).await;
    assert_eq!(ids(&second), vec![oldest.id]);
    assert_eq!(second["has_more"], false);

    // Top comments with a cursor.
    assert_eq!(ids(&list(format!("?cursor={}", liked.id)).await), vec![newest.id, oldest.id]);
    assert!(ids(&list(format!("?cursor={}", oldest.id)).await).is_empty(), "nothing after the last ranked comment");
    assert_eq!(ids(&list("?cursor=999999".into()).await).len(), 3, "unknown cursors are ignored");

    // Invalid parameters fall back to the defaults.
    for query in ["?sort=random", "?cursor=abc", "?limit=0", "?limit=500", "?limit=abc"] {
        assert_eq!(ids(&list(query.into()).await), ranked, "{query}");
    }

    // A day without comments.
    let res = client.call(&viewer, "GET", &day_path("owner", "2026-03-10"), None).await;
    assert_eq!((res.status, res.body.as_str()), (200, r#"{"success":true,"comments":[],"has_more":false}"#));
    db.finish().await;
}

#[tokio::test]
async fn get_replies() {
    let Some(db) = TestDb::new("http_get_replies").await else { return };
    let pool = &db.pool;
    let client = Client::new(pool);
    let owner = create_user(pool, "owner").await;
    let viewer = create_user(pool, "viewer").await;
    let hidden = create_user_with(pool, "hidden", UserOpts { private: true, ..Default::default() }).await;
    let now = Utc::now();
    let root = seed_comment(pool, &owner, &viewer, "root", None, day()).await;
    let r1 = seed_comment(pool, &owner, &owner, "first", Some(&root), day()).await;
    let r2 = seed_comment(pool, &owner, &viewer, "second", Some(&r1), day()).await;
    let r3 = seed_comment(pool, &owner, &owner, "third", Some(&root), day()).await;
    for (comment, hours) in [(&root, 4), (&r1, 3), (&r2, 2), (&r3, 1)] {
        set_created_at(pool, comment.id, now - Duration::hours(hours)).await;
    }
    let secret = seed_comment(pool, &hidden, &hidden, "secret", None, day()).await;
    let replies = |query: &'static str| {
        let (client, viewer) = (&client, &viewer);
        let uri = format!("{}/replies{query}", comment_path(root.id));
        async move { decode(&client.call(viewer, "GET", &uri, None).await, 200) }
    };

    // Oldest first.
    let got = replies("").await;
    assert_eq!(ids(&got), vec![r1.id, r2.id, r3.id]);
    assert_eq!(got["comments"][1]["reply_to_username"], "owner");

    // Pages.
    let first = replies("?limit=2").await;
    assert_eq!(ids(&first), vec![r1.id, r2.id]);
    assert_eq!((first["has_more"].clone(), first["next_cursor"].clone()), (json!(true), json!(r2.id)));
    let uri = format!("{}/replies?limit=2&cursor={}", comment_path(root.id), r2.id);
    let second = decode(&client.call(&viewer, "GET", &uri, None).await, 200);
    assert_eq!(ids(&second), vec![r3.id]);
    assert_eq!(second["has_more"], false);
    assert_eq!(ids(&replies("?limit=0&cursor=abc").await).len(), 3, "invalid parameters fall back to the defaults");

    // Errors.
    let res = client.call(&viewer, "GET", "/api/comments/abc/replies", None).await;
    res.assert_error(400, c::ERR_CODE_INVALID_REQUEST, "Invalid comment ID");
    let res = client.call(&viewer, "GET", &format!("{}/replies", comment_path(999_999)), None).await;
    res.assert_error(404, c::ERR_CODE_COMMENT_NOT_FOUND, "Comment not found");
    let res = client.call(&viewer, "GET", &format!("{}/replies", comment_path(secret.id)), None).await;
    res.assert_error(403, c::ERR_CODE_ACCOUNT_PRIVATE, "This account is private");

    // Database failure while listing (the thread lookup itself succeeds).
    db.hide("users").await;
    let res = client.call(&viewer, "GET", &format!("{}/replies", comment_path(root.id)), None).await;
    res.assert_error(500, c::ERR_CODE_FETCH_FAILED, "Failed to get replies");
    db.restore("users").await;
    db.finish().await;
}

#[tokio::test]
async fn get_comment_count() {
    let Some(db) = TestDb::new("http_count").await else { return };
    let pool = &db.pool;
    let client = Client::new(pool);
    let owner = create_user(pool, "owner").await;
    let viewer = create_user(pool, "viewer").await;
    let root = seed_comment(pool, &owner, &viewer, "one", None, day()).await;
    seed_comment(pool, &owner, &owner, "two", Some(&root), day()).await;
    let gone = seed_comment(pool, &owner, &viewer, "three", None, day()).await;
    set_comment(pool, gone.id, "is_deleted", true).await;
    seed_comment(pool, &owner, &viewer, "other day", None, day().succ_opt().unwrap()).await;

    let res = client.call(&viewer, "GET", &format!("{}/count", day_path("owner", DAY)), None).await;
    assert_eq!(
        (res.status, res.body.as_str()),
        (200, r#"{"success":true,"count":2}"#),
        "replies count, deleted comments do not"
    );
    db.finish().await;
}

#[tokio::test]
async fn day_queries_database_failure() {
    let Some(db) = TestDb::new("http_day_failures").await else { return };
    let pool = &db.pool;
    let stack = Stack::new(pool);
    let broken = Stack::new(&broken_pool().await);
    let router = stack.router_with_comments_of(&broken);
    let owner = create_user(pool, "owner").await;
    let token = stack.token(&owner);

    let res = send(&router, "GET", &day_path("owner", DAY), Some(&token), None).await;
    res.assert_error(500, c::ERR_CODE_FETCH_FAILED, "Failed to get comments");
    let res = send(&router, "GET", &format!("{}/count", day_path("owner", DAY)), Some(&token), None).await;
    res.assert_error(500, c::ERR_CODE_FETCH_FAILED, "Failed to get comment count");
    db.finish().await;
}

#[tokio::test]
async fn delete_comment() {
    let Some(db) = TestDb::new("http_delete").await else { return };
    let pool = &db.pool;
    let client = Client::new(pool);
    let owner = create_user(pool, "owner").await;
    let author = create_user(pool, "author").await;
    let stranger = create_user(pool, "stranger").await;
    let mine = seed_comment(pool, &owner, &author, "mine", None, day()).await;
    let moderated = seed_comment(pool, &owner, &author, "rude", None, day()).await;

    client.call(&author, "DELETE", "/api/comments/abc", None).await.assert_error(
        400,
        c::ERR_CODE_INVALID_REQUEST,
        "Invalid comment ID",
    );
    client.call(&author, "DELETE", &comment_path(999_999), None).await.assert_error(
        404,
        c::ERR_CODE_COMMENT_NOT_FOUND,
        "Comment not found",
    );

    let res = client.call(&stranger, "DELETE", &comment_path(mine.id), None).await;
    res.assert_error(403, c::ERR_CODE_COMMENT_FORBIDDEN, "Not authorized to delete this comment");
    assert!(!load_comment(pool, mine.id).await.is_deleted);

    let res = client.call(&author, "DELETE", &comment_path(mine.id), None).await;
    assert_eq!((res.status, res.body.as_str()), (200, r#"{"success":true,"message":"Comment deleted successfully"}"#));
    let stored = load_comment(pool, mine.id).await;
    assert!(stored.is_deleted);
    assert_eq!(stored.body, "[Deleted]");

    let res = client.call(&author, "DELETE", &comment_path(mine.id), None).await;
    res.assert_error(404, c::ERR_CODE_COMMENT_DELETED, "Comment already deleted");

    let res = client.call(&owner, "DELETE", &comment_path(moderated.id), None).await;
    assert_eq!(res.status, 200, "the day owner moderates");
    assert!(load_comment(pool, moderated.id).await.is_deleted);

    let kept = seed_comment(pool, &owner, &author, "kept", None, day()).await;
    db.fail_statements("comments", "UPDATE").await;
    let res = client.call(&author, "DELETE", &comment_path(kept.id), None).await;
    res.assert_error(500, c::ERR_CODE_DELETE_FAILED, "Failed to delete comment");
    assert!(!load_comment(pool, kept.id).await.is_deleted);
    db.finish().await;
}

#[tokio::test]
async fn edit_comment() {
    let Some(db) = TestDb::new("http_edit").await else { return };
    let pool = &db.pool;
    let client = Client::new(pool);
    let owner = create_user(pool, "owner").await;
    let author = create_user(pool, "author").await;
    let friend = create_user(pool, "pal_99").await;
    let fresh = seed_comment(pool, &owner, &author, "typo", None, day()).await;
    let reply = seed_comment(pool, &owner, &author, "reply", Some(&fresh), day()).await;
    let stale = seed_comment(pool, &owner, &author, "old", None, day()).await;
    set_created_at(pool, stale.id, Utc::now() - Duration::hours(2)).await;
    let gone = seed_comment(pool, &owner, &author, "gone", None, day()).await;
    set_comment(pool, gone.id, "is_deleted", true).await;

    let x = body_json("x");
    let errors = [
        (&author, "abc".to_string(), x.clone(), 400, c::ERR_CODE_INVALID_REQUEST, "Invalid comment ID"),
        (
            &author,
            fresh.id.to_string(),
            r#"{"body":"#.to_string(),
            400,
            c::ERR_CODE_INVALID_REQUEST,
            "Invalid request body",
        ),
        (&author, "999999".to_string(), x.clone(), 404, c::ERR_CODE_COMMENT_NOT_FOUND, "Comment not found"),
        (
            &owner,
            fresh.id.to_string(),
            x.clone(),
            403,
            c::ERR_CODE_COMMENT_FORBIDDEN,
            "Not authorized to edit this comment",
        ),
        (&author, gone.id.to_string(), x.clone(), 400, c::ERR_CODE_COMMENT_DELETED, "Cannot edit a deleted comment"),
        (&author, stale.id.to_string(), x.clone(), 400, c::ERR_CODE_COMMENT_EDIT_EXPIRED, "Edit window has expired"),
        (&author, fresh.id.to_string(), body_json("  "), 400, c::ERR_CODE_COMMENT_EMPTY, "Comment cannot be empty"),
    ];
    for (user, id, body, status, code, message) in &errors {
        client.call(user, "PUT", &comment_path(id), Some(body)).await.assert_error(*status, code, message);
    }
    assert_eq!(load_comment(pool, fresh.id).await.body, "typo");

    // The author edits within the window.
    let res = client.call(&author, "PUT", &comment_path(fresh.id), Some(&body_json(" fixed, thanks @pal_99 "))).await;
    let got = decode(&res, 200);
    assert_eq!((got["success"].clone(), got["message"].clone()), (json!(true), json!("Comment edited successfully")));
    assert_eq!(got["comment"]["body"], "fixed, thanks @pal_99");
    assert_eq!(got["comment"]["is_edited"], true);
    assert_eq!(got["comment"]["mentions"], json!([{"user_id": friend.id, "username": "pal_99"}]));
    assert!(load_comment(pool, fresh.id).await.is_edited);

    // Editing a reply keeps its reply-to user.
    let got =
        decode(&client.call(&author, "PUT", &comment_path(reply.id), Some(&body_json("edited reply"))).await, 200);
    assert_eq!(got["comment"]["reply_to_username"], "author");

    db.fail_statements("comments", "UPDATE").await;
    let res = client.call(&author, "PUT", &comment_path(fresh.id), Some(&body_json("again"))).await;
    res.assert_error(500, c::ERR_CODE_UPDATE_FAILED, "Failed to edit comment");
    db.finish().await;
}

#[tokio::test]
async fn edit_with_rejected_mentions_leaves_the_comment_unchanged() {
    let Some(db) = TestDb::new("http_edit_mentions").await else { return };
    let pool = &db.pool;
    let client = Client::new(pool);
    let owner = create_user(pool, "owner").await;
    let author = create_user(pool, "author").await;
    let comment = seed_comment(pool, &owner, &author, "original", None, day()).await;

    let body = body_json("@aaa @bbb @ccc @ddd @eee @fff @ggg @hhh @iii @jjj @kkk");
    let res = client.call(&author, "PUT", &comment_path(comment.id), Some(&body)).await;
    res.assert_error(400, c::ERR_CODE_TOO_MANY_MENTIONS, "Too many mentions (max 10 per comment)");
    assert_eq!(load_comment(pool, comment.id).await.body, "original");
    db.finish().await;
}

#[tokio::test]
async fn like_and_unlike() {
    let Some(db) = TestDb::new("http_like").await else { return };
    let pool = &db.pool;
    let client = Client::new(pool);
    let owner = create_user(pool, "owner").await;
    let fan = create_user(pool, "fan").await;
    let comment = seed_comment(pool, &owner, &owner, "like me", None, day()).await;
    let gone = seed_comment(pool, &owner, &owner, "gone", None, day()).await;
    set_comment(pool, gone.id, "is_deleted", true).await;
    let like_path = |id: &str| format!("/api/comments/{id}/like");

    for method in ["POST", "DELETE"] {
        client.call(&fan, method, &like_path("abc"), None).await.assert_error(
            400,
            c::ERR_CODE_INVALID_REQUEST,
            "Invalid comment ID",
        );
        client.call(&fan, method, &like_path("999999"), None).await.assert_error(
            400,
            c::ERR_CODE_COMMENT_NOT_FOUND,
            "Comment not found",
        );
    }

    let steps = [
        ("POST", r#"{"success":true,"liked":true,"new_count":1}"#, 1),
        ("POST", r#"{"success":true,"liked":true,"new_count":1}"#, 1),
        ("DELETE", r#"{"success":true,"liked":false,"new_count":0}"#, 0),
        ("DELETE", r#"{"success":true,"liked":false,"new_count":0}"#, 0),
    ];
    for (method, expected, stored) in steps {
        let res = client.call(&fan, method, &like_path(&comment.id.to_string()), None).await;
        assert_eq!((res.status, res.body.as_str()), (200, expected), "{method}");
        assert_eq!(load_comment(pool, comment.id).await.like_count, stored);
    }

    let res = client.call(&fan, "POST", &like_path(&gone.id.to_string()), None).await;
    res.assert_error(400, c::ERR_CODE_COMMENT_DELETED, "Cannot like a deleted comment");

    db.fail_statements("comment_likes", "INSERT OR DELETE").await;
    let res = client.call(&fan, "POST", &like_path(&comment.id.to_string()), None).await;
    res.assert_error(500, c::ERR_CODE_CREATE_FAILED, "Failed to like comment");
    let res = client.call(&fan, "DELETE", &like_path(&comment.id.to_string()), None).await;
    res.assert_error(500, c::ERR_CODE_DELETE_FAILED, "Failed to unlike comment");
    db.finish().await;
}

#[tokio::test]
async fn notifications() {
    let Some(db) = TestDb::new("http_notifications").await else { return };
    let pool = &db.pool;
    let client = Client::new(pool);
    let owner = create_user(pool, "owner").await;
    let author = create_user_with(
        pool,
        "author",
        UserOpts { avatar: Some("http://pics.example/author.jpg"), ..Default::default() },
    )
    .await;
    let friend = create_user(pool, "buddy_7").await;

    let res = client.call(&author, "POST", &day_path("owner", DAY), Some(&body_json("well done @buddy_7"))).await;
    let comment_id = decode(&res, 201)["comment"]["id"].as_i64().unwrap();
    let received = wait_notification(pool, owner.id, NOTIF_TYPE_COMMENT_RECEIVED).await;
    assert_eq!(received["author_avatar"], "http://pics.example/author.jpg");
    wait_notification(pool, friend.id, NOTIF_TYPE_COMMENT_MENTION).await;

    let res = client.call(&owner, "POST", &replies_path("owner", comment_id), Some(&body_json("thanks"))).await;
    assert_eq!(res.status, 201);
    wait_notification(pool, author.id, NOTIF_TYPE_COMMENT_REPLY).await;

    let res = client.call(&friend, "POST", &format!("{}/like", comment_path(comment_id)), None).await;
    assert_eq!(res.status, 200);
    wait_notification(pool, author.id, NOTIF_TYPE_COMMENT_LIKED).await;
    db.finish().await;
}
