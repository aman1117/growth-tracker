//! Behaviour without Redis (this binary never connects it, like Go with a nil client) and with
//! failing database queries (Go tests: `brokenStack`, `faultyDB`).

mod common;

use std::time::Duration;

use common::{request, run, send, Broken, Env, UserOpts};
use serde_json::json;

const SERVER_ERROR: &str = "An error occurred. Please try again.";

#[test]
fn password_reset_without_redis() {
    run(async {
        let Some(env) = Env::new("noredis_reset").await else { return };
        let user = env.plain_user().await;

        // The token cannot be stored: same generic answer, no email.
        let body = json!({ "email": user.email }).to_string();
        let resp = env.call("POST", "/api/auth/forgot-password", None, Some(&body)).await;
        assert_eq!(resp.status, 200);
        assert_eq!(
            resp.body,
            r#"{"message":"If an account exists with this email, a password reset link has been sent.","success":true}"#
        );
        assert!(env.mail.sent().is_empty());

        let body = json!({ "token": "abc", "new_password": "Fresh1234", "confirm_password": "Fresh1234" }).to_string();
        let resp = env.call("POST", "/api/auth/reset-password", None, Some(&body)).await;
        resp.assert_error(500, "SERVER_ERROR", SERVER_ERROR);

        let resp = env.call("GET", "/api/auth/reset-password/validate?token=abc", None, None).await;
        assert_eq!((resp.status, resp.body.as_str()), (200, r#"{"success":true,"valid":false}"#));
        env.finish().await;
    });
}

#[test]
fn verification_without_redis() {
    run(async {
        let Some(env) = Env::new("noredis_verify").await else { return };
        let unverified = env.user(UserOpts { email_verified: false, ..UserOpts::default() }).await;

        let resp = env.call("POST", "/api/auth/verify-email", None, Some(r#"{"token":"abc"}"#)).await;
        resp.assert_error(500, "SERVER_ERROR", SERVER_ERROR);

        // The cooldown check fails open, then the token cannot be stored.
        let resp = env.call("POST", "/api/auth/resend-verification", Some(&unverified), None).await;
        resp.assert_error(500, "SERVER_ERROR", SERVER_ERROR);
        assert!(env.mail.sent().is_empty());
        env.finish().await;
    });
}

#[test]
fn registration_without_redis_sends_no_email() {
    run(async {
        let Some(env) = Env::new("noredis_register").await else { return };
        let body =
            json!({ "email": "noredis@example.com", "username": "no_redis", "password": "Secret123" }).to_string();

        let resp = env.call("POST", "/api/register", None, Some(&body)).await;

        resp.assert_success(201, "User created successfully.");
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(env.mail.sent().is_empty());
        env.finish().await;
    });
}

#[test]
fn autocomplete_without_redis_uses_the_database() {
    run(async {
        let Some(env) = Env::new("noredis_autocomplete").await else { return };
        let viewer = env.plain_user().await;
        env.user(UserOpts { username: Some("gopher".into()), ..UserOpts::default() }).await;

        for _ in 0..2 {
            let resp = env.call("GET", "/api/autocomplete/users?q=goph", Some(&viewer), None).await;
            assert_eq!(resp.status, 200, "body: {}", resp.body);
            let v = resp.json();
            assert_eq!(v["query"], "goph");
            assert_eq!(v["suggestions"][0]["text"], "gopher");
        }
        env.finish().await;
    });
}

#[test]
fn partial_query_failures() {
    run(async {
        let Some(env) = Env::new("noredis_partial").await else { return };
        let viewer = env.plain_user().await;
        let target = env.plain_user().await;
        let friend = env
            .user(UserOpts {
                username: Some("gopher_friend".into()),
                private: true,
                bio: Some("friend bio".into()),
                ..UserOpts::default()
            })
            .await;
        env.follow(viewer.id, friend.id, "ACTIVE").await;

        // Saving the recent search fails in the background; the profile is still served.
        sqlx::query("ALTER TABLE recent_searches RENAME TO recent_searches_down").execute(env.pool()).await.unwrap();
        let resp = env.call("GET", &format!("/api/users/{}/profile", target.id), Some(&viewer), None).await;
        assert_eq!(resp.status, 200, "body: {}", resp.body);

        // A failed relationship lookup hides private bios, even from followers.
        let search = || env.call("POST", "/api/users", Some(&viewer), Some(r#"{"username":"gopher_friend"}"#));
        assert_eq!(search().await.json()["data"][0]["bio"], "friend bio");
        sqlx::query("ALTER TABLE follow_edges_by_follower RENAME TO follow_edges_down")
            .execute(env.pool())
            .await
            .unwrap();
        let resp = search().await;
        assert_eq!(resp.status, 200);
        assert_eq!(
            resp.json()["data"],
            json!([{"id": friend.id, "username": "gopher_friend", "profile_pic": null, "is_private": true, "is_verified": false}])
        );
        env.finish().await;
    });
}

#[test]
fn database_failures() {
    run(async {
        let broken = Broken::new();
        let call = |method: &str, uri: &str, body: Option<&str>| broken.call(method, uri, Some(9999), body);

        let resp =
            broken.call("POST", "/api/login", None, Some(r#"{"identifier":"someone","password":"Secret123"}"#)).await;
        resp.assert_error(400, "INVALID_PASSWORD", "Invalid password");

        let resp = call("POST", "/api/update-privacy", Some(r#"{"is_private":true}"#)).await;
        resp.assert_error(500, "UPDATE_FAILED", "Failed to update privacy setting");
        let resp = call("POST", "/api/update-bio", Some(r#"{"bio":"hello"}"#)).await;
        resp.assert_error(500, "UPDATE_FAILED", "Failed to update bio");

        let resp = call("POST", "/api/users", Some(r#"{"username":"a"}"#)).await;
        resp.assert_error(400, "FETCH_FAILED", "Failed to find users");
        // Blank searches never reach the database.
        for body in [r#"{"username":""}"#, r#"{"username":"   "}"#, r#"{"username":"\t\n"}"#, "{}"] {
            let resp = call("POST", "/api/users", Some(body)).await;
            assert_eq!((resp.status, resp.body.as_str()), (200, r#"{"success":true,"data":[]}"#), "{body}");
        }

        let resp = call("GET", "/api/autocomplete/users?q=abc", None).await;
        resp.assert_error(500, "FETCH_FAILED", "Failed to search users");

        // Search suggestions degrade to empty lists.
        let resp = call("GET", "/api/search/suggestions", None).await;
        assert_eq!((resp.status, resp.body.as_str()), (200, r#"{"recent":[],"trending":[]}"#));
        let resp = call("DELETE", "/api/search/recent/5", None).await;
        resp.assert_error(500, "DELETE_FAILED", "Failed to delete recent search");
        let resp = call("DELETE", "/api/search/recent", None).await;
        resp.assert_error(500, "DELETE_FAILED", "Failed to clear recent searches");

        // Forgot-password never reveals failures.
        let resp =
            send(&broken.app, request("POST", "/api/auth/forgot-password", None, Some(r#"{"email":"a@b.co"}"#))).await;
        assert_eq!(resp.status, 200);
        assert!(resp.body.contains(r#""success":true"#));
    });
}
