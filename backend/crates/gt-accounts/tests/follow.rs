//! Follow endpoints (port of `follow_test.go`). Authentication and malformed ids are covered in
//! `routes.rs`. This binary never connects Redis, like the Go tests (no cached counts).

mod common;

use chrono::{DateTime, Duration, TimeZone, Utc};
use common::{config, eventually, run, Broken, Env, Resp, TestUser, UserOpts};
use gt_core::gojson::format_rfc3339_local;
use gt_users::FollowListCursor;
use serde_json::{json, Value};

fn follow_base() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 3, 9, 10, 0, 0).unwrap()
}

/// A user id without a users row (edges have no foreign keys).
fn deleted_id(env_user: &TestUser) -> i64 {
    env_user.id + 400
}

fn private() -> UserOpts {
    UserOpts { private: true, ..UserOpts::default() }
}

fn query_escape(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

fn cursor(at: DateTime<Utc>, user_id: i64) -> String {
    FollowListCursor::new(at, user_id).encode()
}

fn usernames(list: &Value) -> Vec<String> {
    list.as_array().unwrap().iter().map(|u| u["username"].as_str().unwrap().to_string()).collect()
}

fn names(users: &[&TestUser]) -> Vec<String> {
    users.iter().map(|u| u.username.clone()).collect()
}

fn ok_json(resp: &Resp) -> Value {
    assert_eq!(resp.status, 200, "body: {}", resp.body);
    assert_eq!(resp.header("content-type"), "application/json");
    resp.json()
}

async fn follow_at(env: &Env, follower_id: i64, followee_id: i64, state: &str, at: DateTime<Utc>) {
    env.follow(follower_id, followee_id, state).await;
    env.set_edge_time(follower_id, followee_id, at).await;
}

async fn follow_counts(env: &Env, viewer: &TestUser, target: &TestUser) -> Resp {
    env.call("GET", &format!("/api/users/{}/follow-counts", target.id), Some(viewer), None).await
}

#[test]
fn follow_and_unfollow() {
    run(async {
        let Some(env) = Env::new("follow_basic").await else { return };
        let viewer = env.plain_user().await;
        let public = env.plain_user().await;
        let hidden = env.user(private()).await;
        let follow = |target: i64| env.call("POST", &format!("/api/users/{target}/follow"), Some(&viewer), None);
        let unfollow = |target: i64| env.call("DELETE", &format!("/api/users/{target}/follow"), Some(&viewer), None);
        let expect = |resp: Resp, state: &str, message: &str| {
            assert_eq!(resp.status, 200, "body: {}", resp.body);
            assert_eq!(resp.body, format!(r#"{{"success":true,"state":"{state}","message":"{message}"}}"#));
        };

        // Public account.
        expect(follow(public.id).await, "ACTIVE", "Now following");
        assert_eq!(env.edge_state(viewer.id, public.id).await.as_deref(), Some("ACTIVE"));
        assert_eq!(ok_json(&follow_counts(&env, &viewer, &public).await)["counts"]["followers_count"], 1);
        expect(follow(public.id).await, "ACTIVE", "Already following");

        // Private account.
        expect(follow(hidden.id).await, "PENDING", "Follow request sent");
        assert_eq!(env.edge_state(viewer.id, hidden.id).await.as_deref(), Some("PENDING"));
        expect(follow(hidden.id).await, "PENDING", "Follow request already pending");

        // Unfollow.
        unfollow(public.id).await.assert_success(200, "Unfollowed successfully");
        assert_eq!(env.edge_state(viewer.id, public.id).await.as_deref(), Some("REMOVED"));
        assert_eq!(ok_json(&follow_counts(&env, &viewer, &public).await)["counts"]["followers_count"], 0);
        unfollow(public.id).await.assert_error(400, "NOT_FOLLOWING", "Not following this user");
        unfollow(deleted_id(&viewer)).await.assert_error(400, "NOT_FOLLOWING", "Not following this user");

        // Follow again after unfollowing.
        expect(follow(public.id).await, "ACTIVE", "Now following");

        follow(viewer.id).await.assert_error(400, "CANNOT_FOLLOW_SELF", "Cannot follow yourself");
        follow(deleted_id(&viewer)).await.assert_error(404, "USER_NOT_FOUND", "User not found");
        env.finish().await;
    });
}

#[test]
fn follow_limits() {
    run(async {
        let mut cfg = config();
        cfg.follow.max_total_following = 1;
        let Some(env) = Env::with("follow_total_limit", cfg, Default::default()).await else { return };
        let (viewer, first, second) = (env.plain_user().await, env.plain_user().await, env.plain_user().await);
        assert_eq!(env.call("POST", &format!("/api/users/{}/follow", first.id), Some(&viewer), None).await.status, 200);
        let resp = env.call("POST", &format!("/api/users/{}/follow", second.id), Some(&viewer), None).await;
        resp.assert_error(
            400,
            "FOLLOW_LIMIT_EXCEEDED",
            "FOLLOW_LIMIT_EXCEEDED: you have reached the maximum following limit of 1",
        );
        assert_eq!(env.edge_state(viewer.id, second.id).await, None);
        env.finish().await;

        let mut cfg = config();
        cfg.follow.max_follows_per_day = 1;
        let Some(env) = Env::with("follow_daily_limit", cfg, Default::default()).await else { return };
        let (viewer, first, second) = (env.plain_user().await, env.plain_user().await, env.plain_user().await);
        assert_eq!(env.call("POST", &format!("/api/users/{}/follow", first.id), Some(&viewer), None).await.status, 200);
        let resp = env.call("POST", &format!("/api/users/{}/follow", second.id), Some(&viewer), None).await;
        resp.assert_error(
            400,
            "DAILY_LIMIT_EXCEEDED",
            "DAILY_LIMIT_EXCEEDED: you have reached the daily follow limit of 1",
        );
        env.finish().await;
    });
}

#[test]
fn follow_requests() {
    run(async {
        let Some(env) = Env::new("follow_requests").await else { return };
        let owner = env.user(private()).await;
        let early = env
            .user(UserOpts {
                bio: Some("early bio".into()),
                picture: Some("http://pics.example/early.jpg".into()),
                verified: true,
                ..UserOpts::default()
            })
            .await;
        let late = env.plain_user().await;
        let stranger = env.plain_user().await;
        let deleted = deleted_id(&owner);
        let base = follow_base();
        follow_at(&env, deleted, owner.id, "PENDING", base - Duration::hours(1)).await;
        follow_at(&env, early.id, owner.id, "PENDING", base).await;
        follow_at(&env, late.id, owner.id, "PENDING", base + Duration::hours(1)).await;
        let incoming = |query: &str| {
            let resp = env.call("GET", &format!("/api/me/follow-requests/incoming{query}"), Some(&owner), None);
            async move { ok_json(&resp.await) }
        };
        let act = |requester: &TestUser, action: &str| {
            env.call("POST", &format!("/api/me/follow-requests/{}/{action}", requester.id), Some(&owner), None)
        };

        // Newest first; requests from deleted accounts are skipped.
        let resp = env.call("GET", "/api/me/follow-requests/incoming", Some(&owner), None).await;
        assert_eq!(resp.status, 200);
        assert_eq!(
            resp.body,
            format!(
                concat!(
                    r#"{{"success":true,"requests":[{{"id":{},"username":"{}","is_verified":false,"requested_at":"{}"}},"#,
                    r#"{{"id":{},"username":"{}","profile_pic":"http://pics.example/early.jpg","#,
                    r#""profile_pic_thumb":"http://pics.example/early.jpg?thumb","bio":"early bio","is_verified":true,"#,
                    r#""requested_at":"{}"}}],"has_more":false}}"#
                ),
                late.id,
                late.username,
                format_rfc3339_local(&(base + Duration::hours(1))),
                early.id,
                early.username,
                format_rfc3339_local(&base),
            )
        );

        // Pages with a cursor.
        let first = incoming("?limit=1").await;
        assert_eq!(first["requests"].as_array().unwrap().len(), 1);
        assert_eq!(first["requests"][0]["id"], late.id);
        assert_eq!(first["has_more"], true);
        assert_eq!(first["next_cursor"], cursor(base + Duration::hours(1), late.id));
        let second =
            incoming(&format!("?limit=1&cursor={}", query_escape(first["next_cursor"].as_str().unwrap()))).await;
        assert_eq!(second["requests"][0]["id"], early.id);
        assert_eq!(second["has_more"], true);
        let last =
            incoming(&format!("?limit=1&cursor={}", query_escape(second["next_cursor"].as_str().unwrap()))).await;
        assert_eq!(last, json!({"success": true, "requests": [], "has_more": false}));

        // Decline.
        act(&late, "decline").await.assert_success(200, "Follow request declined");
        assert_eq!(env.edge_state(late.id, owner.id).await.as_deref(), Some("REMOVED"));

        // Accept.
        act(&early, "accept").await.assert_success(200, "Follow request accepted");
        assert_eq!(env.edge_state(early.id, owner.id).await.as_deref(), Some("ACTIVE"));
        let counts = ok_json(&follow_counts(&env, &owner, &owner).await);
        assert_eq!(
            counts,
            json!({"success": true, "counts": {"followers_count": 1, "following_count": 0, "pending_requests_count": 1}}),
            "only the deleted account's request is left"
        );

        // No pending request.
        for action in ["accept", "decline"] {
            act(&stranger, action).await.assert_error(400, "NO_FOLLOW_REQUEST", "No pending request found");
        }
        act(&early, "accept").await.assert_error(400, "NO_FOLLOW_REQUEST", "No pending request found");

        // Cancel an outgoing request.
        let sent = env.call("POST", &format!("/api/users/{}/follow", owner.id), Some(&stranger), None).await;
        assert_eq!(ok_json(&sent)["state"], "PENDING");
        let cancel = format!("/api/follow-requests/{}/cancel", owner.id);
        env.call("POST", &cancel, Some(&stranger), None).await.assert_success(200, "Follow request cancelled");
        assert_eq!(env.edge_state(stranger.id, owner.id).await.as_deref(), Some("REMOVED"));
        let resp = env.call("POST", &cancel, Some(&stranger), None).await;
        resp.assert_error(400, "NO_FOLLOW_REQUEST", "No pending request found");
        env.finish().await;
    });
}

#[test]
fn remove_follower() {
    run(async {
        let Some(env) = Env::new("follow_remove").await else { return };
        let (owner, fan, stranger) = (env.plain_user().await, env.plain_user().await, env.plain_user().await);
        env.follow(fan.id, owner.id, "ACTIVE").await;

        let resp = env.call("DELETE", &format!("/api/me/followers/{}", fan.id), Some(&owner), None).await;
        resp.assert_success(200, "Follower removed");
        assert_eq!(env.edge_state(fan.id, owner.id).await.as_deref(), Some("REMOVED"));

        for user in [&fan, &stranger] {
            let resp = env.call("DELETE", &format!("/api/me/followers/{}", user.id), Some(&owner), None).await;
            resp.assert_error(400, "NOT_FOLLOWING", "User is not following you");
        }
        env.finish().await;
    });
}

#[test]
fn follow_lists() {
    run(async {
        let Some(env) = Env::new("follow_lists").await else { return };
        let viewer = env.plain_user().await;
        let star = env.plain_user().await;
        let hidden = env.user(private()).await;
        let fan = env
            .user(UserOpts {
                bio: Some("fan bio".into()),
                picture: Some("http://pics.example/fan.jpg".into()),
                verified: true,
                ..UserOpts::default()
            })
            .await;
        let shy = env.user(UserOpts { private: true, bio: Some("shy bio".into()), ..UserOpts::default() }).await;
        let deleted = deleted_id(&viewer);
        let base = follow_base();
        let hour = Duration::hours(1);
        follow_at(&env, deleted, star.id, "ACTIVE", base - hour).await;
        follow_at(&env, fan.id, star.id, "ACTIVE", base).await;
        follow_at(&env, shy.id, star.id, "ACTIVE", base + hour).await;
        follow_at(&env, star.id, fan.id, "ACTIVE", base).await;
        follow_at(&env, star.id, deleted, "ACTIVE", base + hour).await;
        follow_at(&env, fan.id, hidden.id, "ACTIVE", base).await;
        let list = |user: &TestUser, target: &TestUser, kind: &str, query: &str| {
            let resp = env.call("GET", &format!("/api/users/{}/{kind}{query}", target.id), Some(user), None);
            async move { ok_json(&resp.await) }
        };

        // Followers, newest first; deleted accounts are skipped.
        let resp = env.call("GET", &format!("/api/users/{}/followers", star.id), Some(&viewer), None).await;
        assert_eq!(resp.status, 200);
        assert_eq!(
            resp.body,
            format!(
                concat!(
                    r#"{{"success":true,"users":[{{"id":{},"username":"{}","bio":"shy bio","is_private":true,"#,
                    r#""is_verified":false,"followed_at":"{}"}},{{"id":{},"username":"{}","#,
                    r#""profile_pic":"http://pics.example/fan.jpg","profile_pic_thumb":"http://pics.example/fan.jpg?thumb","#,
                    r#""bio":"fan bio","is_private":false,"is_verified":true,"followed_at":"{}"}}],"has_more":false}}"#
                ),
                shy.id,
                shy.username,
                format_rfc3339_local(&(base + hour)),
                fan.id,
                fan.username,
                format_rfc3339_local(&base),
            )
        );

        // Followers pages.
        let first = list(&viewer, &star, "followers", "?limit=1").await;
        assert_eq!(usernames(&first["users"]), names(&[&shy]));
        assert_eq!(first["has_more"], true);
        assert_eq!(first["next_cursor"], cursor(base + hour, shy.id));
        let next = |page: &Value| format!("?limit=1&cursor={}", query_escape(page["next_cursor"].as_str().unwrap()));
        let second = list(&viewer, &star, "followers", &next(&first)).await;
        assert_eq!(usernames(&second["users"]), names(&[&fan]));
        let last = list(&viewer, &star, "followers", &next(&second)).await;
        assert_eq!(last, json!({"success": true, "users": [], "has_more": false}));

        // Following; the newest edge points to a deleted account.
        assert_eq!(usernames(&list(&viewer, &star, "following", "").await["users"]), names(&[&fan]));
        let first = list(&viewer, &star, "following", "?limit=1").await;
        assert_eq!(first["users"], json!([]));
        assert_eq!(first["has_more"], true);
        assert_eq!(first["next_cursor"], cursor(base + hour, deleted));
        let second = list(&viewer, &star, "following", &next(&first)).await;
        assert_eq!(usernames(&second["users"]), names(&[&fan]));
        assert_eq!(second["has_more"], false);

        // Invalid cursors and limits fall back to the first page / default limit.
        let not_json = "bm90IGpzb24="; // base64url("not json")
        for query in ["?cursor=%25%25%25", &format!("?cursor={not_json}"), "?limit=0", "?limit=1000", "?limit=abc"] {
            let got = list(&viewer, &star, "followers", query).await;
            assert_eq!(usernames(&got["users"]), names(&[&shy, &fan]), "{query}");
        }

        // Private accounts.
        for kind in ["followers", "following"] {
            let resp = env.call("GET", &format!("/api/users/{}/{kind}", hidden.id), Some(&viewer), None).await;
            resp.assert_error(403, "ACCOUNT_PRIVATE", "This account is private");
        }
        // ... are visible to their followers and owner.
        assert_eq!(usernames(&list(&fan, &hidden, "followers", "").await["users"]), names(&[&fan]));
        assert_eq!(usernames(&list(&hidden, &hidden, "followers", "").await["users"]), names(&[&fan]));

        // Unknown user.
        for kind in ["followers", "following"] {
            let resp = env.call("GET", &format!("/api/users/{}/{kind}", deleted - 1), Some(&viewer), None).await;
            resp.assert_error(404, "USER_NOT_FOUND", "User not found");
        }
        env.finish().await;
    });
}

#[test]
fn mutuals() {
    run(async {
        let Some(env) = Env::new("follow_mutuals").await else { return };
        let viewer = env.plain_user().await;
        let target = env.user(private()).await;
        let a = env.plain_user().await;
        let b = env
            .user(UserOpts {
                bio: Some("b bio".into()),
                picture: Some("http://pics.example/b.jpg".into()),
                ..UserOpts::default()
            })
            .await;
        let c = env.plain_user().await;
        let deleted = deleted_id(&viewer);
        let base = follow_base();
        follow_at(&env, viewer.id, a.id, "ACTIVE", base).await;
        follow_at(&env, viewer.id, b.id, "ACTIVE", base + Duration::hours(1)).await;
        follow_at(&env, viewer.id, c.id, "ACTIVE", base + Duration::hours(2)).await;
        follow_at(&env, viewer.id, deleted, "ACTIVE", base - Duration::hours(1)).await;
        for id in [a.id, b.id, deleted] {
            env.follow(id, target.id, "ACTIVE").await;
        }
        let mutuals =
            |query: &str| env.call("GET", &format!("/api/users/{}/mutuals{query}", target.id), Some(&viewer), None);

        // People you follow who follow the target, even when it is private; no thumbnails.
        let resp = mutuals("").await;
        assert_eq!(resp.status, 200);
        assert_eq!(
            resp.body,
            format!(
                concat!(
                    r#"{{"success":true,"users":[{{"id":{},"username":"{}","profile_pic":"http://pics.example/b.jpg","#,
                    r#""bio":"b bio","is_private":false,"is_verified":false,"followed_at":"{}"}},"#,
                    r#"{{"id":{},"username":"{}","is_private":false,"is_verified":false,"followed_at":"{}"}}],"#,
                    r#""has_more":false}}"#
                ),
                b.id,
                b.username,
                format_rfc3339_local(&(base + Duration::hours(1))),
                a.id,
                a.username,
                format_rfc3339_local(&base),
            )
        );

        // Pages.
        let first = ok_json(&mutuals("?limit=2").await);
        assert_eq!(usernames(&first["users"]), names(&[&b, &a]));
        assert_eq!(first["has_more"], true);
        assert_eq!(first["next_cursor"], cursor(base, a.id));
        let next = format!("?limit=2&cursor={}", query_escape(first["next_cursor"].as_str().unwrap()));
        let last = ok_json(&mutuals(&next).await);
        assert_eq!(last, json!({"success": true, "users": [], "has_more": false}), "only the deleted account is left");
        env.finish().await;
    });
}

#[test]
fn lookup_relationships() {
    run(async {
        let Some(env) = Env::new("follow_lookup").await else { return };
        let viewer = env.plain_user().await;
        let (followed, requested, requester, stranger) =
            (env.plain_user().await, env.plain_user().await, env.plain_user().await, env.plain_user().await);
        env.follow(viewer.id, followed.id, "ACTIVE").await;
        env.follow(viewer.id, requested.id, "PENDING").await;
        env.follow(requester.id, viewer.id, "PENDING").await;
        let lookup = |body: String| env.call("POST", "/api/relationships/lookup", Some(&viewer), Some(&body));

        lookup(r#"{"target_ids":"#.into()).await.assert_error(400, "INVALID_REQUEST", "Invalid request body");
        let resp = lookup(r#"{"target_ids":[]}"#.into()).await;
        assert_eq!((resp.status, resp.body.as_str()), (200, r#"{"success":true,"relationships":{}}"#));

        let deleted = deleted_id(&viewer);
        let body = json!({"target_ids": [followed.id, requested.id, requester.id, stranger.id, deleted]});
        let got = ok_json(&lookup(body.to_string()).await);
        let mut want = serde_json::Map::new();
        for (id, state) in [
            (followed.id, "FOLLOWING"),
            (requested.id, "REQUESTED"),
            (requester.id, "INCOMING_PENDING"),
            (stranger.id, "NONE"),
            (deleted, "NONE"),
        ] {
            want.insert(id.to_string(), json!(state));
        }
        assert_eq!(got, json!({"success": true, "relationships": want}));

        // At most 100 ids are looked up.
        let ids: Vec<i64> = (1000..1150).collect();
        let got = ok_json(&lookup(json!({ "target_ids": ids }).to_string()).await);
        let relationships = got["relationships"].as_object().unwrap();
        assert_eq!(relationships.len(), 100);
        assert!(relationships.contains_key("1099"));
        assert!(!relationships.contains_key("1100"));
        env.finish().await;
    });
}

#[test]
fn follow_counts_and_reconcile() {
    run(async {
        let Some(env) = Env::new("follow_counts").await else { return };
        let owner = env.user(private()).await;
        let (fan, requester, other) = (env.plain_user().await, env.plain_user().await, env.plain_user().await);
        env.follow(fan.id, owner.id, "ACTIVE").await;
        env.follow(requester.id, owner.id, "PENDING").await;
        env.follow(owner.id, other.id, "ACTIVE").await;

        // Pending requests are private.
        let resp = follow_counts(&env, &fan, &owner).await;
        assert_eq!(
            (resp.status, resp.body.as_str()),
            (200, r#"{"success":true,"counts":{"followers_count":1,"following_count":1}}"#)
        );

        // Own counts include pending requests.
        let resp = follow_counts(&env, &owner, &owner).await;
        assert_eq!(
            resp.body,
            r#"{"success":true,"counts":{"followers_count":1,"following_count":1,"pending_requests_count":1}}"#
        );

        // Reconcile repairs drifted counters.
        sqlx::query("UPDATE follow_counters SET followers_count = 42, following_count = -3 WHERE user_id = $1")
            .bind(owner.id)
            .execute(env.pool())
            .await
            .unwrap();
        assert_eq!(ok_json(&follow_counts(&env, &fan, &owner).await)["counts"]["followers_count"], 42);
        let resp = env.call("POST", "/api/me/follow-counts/reconcile", Some(&owner), None).await;
        resp.assert_success(200, "Follow counts reconciled");
        let resp = follow_counts(&env, &fan, &owner).await;
        assert_eq!(resp.body, r#"{"success":true,"counts":{"followers_count":1,"following_count":1}}"#);
        env.finish().await;
    });
}

#[test]
fn database_failures() {
    run(async {
        let broken = Broken::new();
        let lookup = r#"{"target_ids":[2]}"#;
        for (method, uri, body, message) in [
            ("POST", "/api/users/2/follow", None, "Failed to follow user"),
            ("DELETE", "/api/users/2/follow", None, "Failed to unfollow user"),
            ("POST", "/api/follow-requests/2/cancel", None, "Failed to cancel request"),
            ("GET", "/api/me/follow-requests/incoming", None, "Failed to get requests"),
            ("POST", "/api/me/follow-requests/2/accept", None, "Failed to accept request"),
            ("POST", "/api/me/follow-requests/2/decline", None, "Failed to decline request"),
            ("DELETE", "/api/me/followers/2", None, "Failed to remove follower"),
            ("GET", "/api/users/2/followers", None, "Failed to get followers"),
            ("GET", "/api/users/2/following", None, "Failed to get following"),
            ("GET", "/api/users/2/mutuals", None, "Failed to get mutuals"),
            ("GET", "/api/users/2/follow-counts", None, "Failed to get counts"),
            ("POST", "/api/me/follow-counts/reconcile", None, "Failed to reconcile counts"),
            ("POST", "/api/relationships/lookup", Some(lookup), "Failed to lookup relationships"),
        ] {
            broken.call(method, uri, Some(9999), body).await.assert_error(500, "SERVER_ERROR", message);
        }
    });
}

async fn notification(env: &Env, user_id: i64, kind: &str) -> Option<(String, Option<String>)> {
    sqlx::query_as("SELECT body, metadata->>'actor_avatar' FROM notifications WHERE user_id = $1 AND type = $2")
        .bind(user_id)
        .bind(kind)
        .fetch_optional(env.pool())
        .await
        .unwrap()
}

async fn wait_notification(env: &Env, user_id: i64, kind: &str) -> (String, Option<String>) {
    eventually(&format!("{kind} notification for {user_id}"), || async {
        notification(env, user_id, kind).await.is_some()
    })
    .await;
    notification(env, user_id, kind).await.unwrap()
}

#[test]
fn notifications() {
    run(async {
        let Some(env) = Env::new("follow_notifications").await else { return };
        let fan =
            env.user(UserOpts { picture: Some("http://pics.example/fan.jpg".into()), ..UserOpts::default() }).await;
        let public = env.plain_user().await;
        let hidden = env
            .user(UserOpts {
                private: true,
                picture: Some("http://pics.example/hidden.jpg".into()),
                ..UserOpts::default()
            })
            .await;

        // New follower.
        assert_eq!(env.call("POST", &format!("/api/users/{}/follow", public.id), Some(&fan), None).await.status, 200);
        let (body, avatar) = wait_notification(&env, public.id, "new_follower").await;
        assert_eq!(body, format!("{} started following you", fan.username));
        assert_eq!(avatar.as_deref(), Some("http://pics.example/fan.jpg"));

        // Follow request.
        assert_eq!(env.call("POST", &format!("/api/users/{}/follow", hidden.id), Some(&fan), None).await.status, 200);
        let (body, _) = wait_notification(&env, hidden.id, "follow_request").await;
        assert_eq!(body, format!("{} wants to follow you", fan.username));

        // Request accepted.
        let uri = format!("/api/me/follow-requests/{}/accept", fan.id);
        assert_eq!(env.call("POST", &uri, Some(&hidden), None).await.status, 200);
        let (body, avatar) = wait_notification(&env, fan.id, "follow_accepted").await;
        assert_eq!(body, format!("{} accepted your follow request", hidden.username));
        assert_eq!(avatar.as_deref(), Some("http://pics.example/hidden.jpg"));
        env.finish().await;
    });
}

#[test]
fn notifications_skip_missing_users() {
    run(async {
        let Some(env) = Env::new("follow_notify_missing").await else { return };
        let target = env.plain_user().await;
        let user = env.plain_user().await;
        // A token whose account no longer exists can still follow and accept, but nobody is
        // notified.
        let ghost =
            TestUser { id: deleted_id(&target), token: env.token(deleted_id(&target), "ghost"), ..user.clone() };
        env.follow(user.id, ghost.id, "PENDING").await;

        let resp = env.call("POST", &format!("/api/users/{}/follow", target.id), Some(&ghost), None).await;
        assert_eq!(ok_json(&resp)["state"], "ACTIVE");
        let resp = env.call("POST", &format!("/api/me/follow-requests/{}/accept", user.id), Some(&ghost), None).await;
        resp.assert_success(200, "Follow request accepted");

        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        assert_eq!(env.count("SELECT COUNT(*) FROM notifications").await, 0);
        env.finish().await;
    });
}
