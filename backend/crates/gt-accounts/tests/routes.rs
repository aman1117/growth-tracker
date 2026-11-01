//! Route table, guards, Fiber routing quirks and path parameter parsing.

mod common;

use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::Request;
use axum::routing::post;
use axum::Router;
use common::{request, run, send, Env, UserOpts};
use std::net::SocketAddr;

/// The server adds this fallback; mirror it so unmatched methods answer like Fiber.
fn with_server_fallbacks(app: Router) -> Router {
    app.method_not_allowed_fallback(|| async {
        gt_core::response::text(axum::http::StatusCode::METHOD_NOT_ALLOWED, "Method Not Allowed")
    })
}

#[test]
fn guards_and_fiber_routing() {
    run(async {
        let Some(env) = Env::new("routes_guards").await else { return };
        let app = with_server_fallbacks(env.app.clone());
        let me = env.plain_user().await;
        let call = |method: &str, uri: &str, token: Option<&str>| send(&app, request(method, uri, token, None));

        // Every guarded route rejects anonymous callers before running the handler.
        for (method, uri) in [
            ("POST", "/api/auth/resend-verification"),
            ("POST", "/api/users"),
            ("GET", "/api/autocomplete/users?q=a"),
            ("GET", "/api/search/suggestions"),
            ("DELETE", "/api/search/recent/2"),
            ("DELETE", "/api/search/recent"),
            ("POST", "/api/update-username"),
            ("POST", "/api/update-privacy"),
            ("GET", "/api/get-privacy"),
            ("POST", "/api/update-bio"),
            ("GET", "/api/get-bio"),
            ("POST", "/api/change-password"),
            ("GET", "/api/profile"),
            ("POST", "/api/users/2/follow"),
            ("DELETE", "/api/users/2/follow"),
            ("POST", "/api/follow-requests/2/cancel"),
            ("GET", "/api/me/follow-requests/incoming"),
            ("POST", "/api/me/follow-requests/2/accept"),
            ("POST", "/api/me/follow-requests/2/decline"),
            ("DELETE", "/api/me/followers/2"),
            ("GET", "/api/users/2/followers"),
            ("GET", "/api/users/2/following"),
            ("GET", "/api/users/2/mutuals"),
            ("GET", "/api/users/2/follow-counts"),
            ("POST", "/api/me/follow-counts/reconcile"),
            ("GET", "/api/users/2/profile"),
            ("POST", "/api/relationships/lookup"),
        ] {
            let resp = call(method, uri, None).await;
            resp.assert_error(401, "MISSING_AUTH_HEADER", "Missing Authorization Header");
        }
        call("GET", "/api/profile", Some("garbage")).await.assert_error(401, "INVALID_TOKEN", "Invalid token");

        // Public routes need no token.
        call("POST", "/api/login", None).await.assert_error(400, "INVALID_REQUEST", "Invalid request body");
        call("POST", "/api/auth/verify-email", None).await.assert_error(400, "INVALID_REQUEST", "Invalid request body");
        let resp = call("GET", "/api/auth/reset-password/validate", None).await;
        assert_eq!((resp.status, resp.body.as_str()), (200, r#"{"success":true,"valid":false}"#));

        // Per-route middleware only runs for a matching method (Fiber: 405 straight away).
        for (method, uri) in [("GET", "/api/register"), ("GET", "/api/users/2/follow"), ("PUT", "/api/get-bio")] {
            let resp = call(method, uri, None).await;
            assert_eq!((resp.status, resp.body.as_str()), (405, "Method Not Allowed"), "{method} {uri}");
        }

        // The `/api/profile` group runs its auth middleware before routing.
        call("POST", "/api/profile", None).await.assert_error(
            401,
            "MISSING_AUTH_HEADER",
            "Missing Authorization Header",
        );
        let resp = call("POST", "/api/profile", Some(&me.token)).await;
        assert_eq!((resp.status, resp.body.as_str()), (405, "Method Not Allowed"));
        assert_eq!(resp.header("content-type"), "text/plain; charset=utf-8");
        assert!(resp.header("x-ratelimit-limit").is_empty(), "the API limiter only guards GET");
        let resp = call("GET", "/api/profile", Some(&me.token)).await;
        assert_eq!((resp.status, resp.header("x-ratelimit-limit")), (200, "200"));
        let resp = call("GET", "/api/profile/whatever", None).await;
        resp.assert_error(401, "MISSING_AUTH_HEADER", "Missing Authorization Header");
        let resp = call("DELETE", "/api/profile/a&'b", Some(&me.token)).await;
        assert_eq!((resp.status, resp.body.as_str()), (404, "Cannot DELETE /api/profile/a&amp;&#39;b"));

        // Static segments win over parameters, with backtracking like Fiber.
        let resp = call("POST", "/api/me/follow-requests/incoming/accept", Some(&me.token)).await;
        resp.assert_error(400, "INVALID_REQUEST", "Invalid requester ID");

        // Path parameters are not percent-decoded (Fiber `UnescapePath: false`).
        let resp = call("GET", &format!("/api/users/{}/profile", me.id), Some(&me.token)).await;
        assert_eq!(resp.status, 200);
        let encoded: String = me.id.to_string().bytes().map(|b| format!("%{b:02X}")).collect();
        let resp = call("GET", &format!("/api/users/{encoded}/profile"), Some(&me.token)).await;
        resp.assert_error(400, "INVALID_REQUEST", "Invalid user ID");
        let resp = call("GET", "/api/users/%FF/profile", Some(&me.token)).await;
        resp.assert_error(400, "INVALID_REQUEST", "Invalid user ID");

        env.finish().await;
    });
}

#[test]
fn other_crates_can_add_profile_subroutes() {
    run(async {
        let Some(env) = Env::new("routes_merge").await else { return };
        let photos = Router::new().route("/api/profile/upload-picture", post(|| async { "uploaded" }));
        let app = env.app.clone().merge(photos);
        let me = env.plain_user().await;

        let resp = send(&app, request("POST", "/api/profile/upload-picture", None, None)).await;
        assert_eq!((resp.status, resp.body.as_str()), (200, "uploaded"));
        let resp = send(&app, request("POST", "/api/profile/other", Some(&me.token), None)).await;
        assert_eq!(resp.status, 404);
        env.finish().await;
    });
}

#[test]
fn tokens_without_a_user_id() {
    run(async {
        let Some(env) = Env::new("routes_user_zero").await else { return };
        let zero = env.token(0, "nobody");
        let call = |method: &str, uri: &str| send(&env.app, request(method, uri, Some(&zero), None));

        // Follow handlers reject a missing user id before parsing anything else.
        for (method, uri) in [
            ("POST", "/api/users/abc/follow"),
            ("DELETE", "/api/users/2/follow"),
            ("POST", "/api/follow-requests/2/cancel"),
            ("GET", "/api/me/follow-requests/incoming"),
            ("POST", "/api/me/follow-requests/2/accept"),
            ("POST", "/api/me/follow-requests/2/decline"),
            ("DELETE", "/api/me/followers/2"),
            ("GET", "/api/users/2/followers"),
            ("GET", "/api/users/2/following"),
            ("GET", "/api/users/2/mutuals"),
            ("GET", "/api/users/2/follow-counts"),
            ("POST", "/api/me/follow-counts/reconcile"),
            ("POST", "/api/relationships/lookup"),
        ] {
            call(method, uri).await.assert_error(401, "UNAUTHORIZED", "Authentication required");
        }
        for (method, uri) in
            [("GET", "/api/search/suggestions"), ("DELETE", "/api/search/recent/2"), ("DELETE", "/api/search/recent")]
        {
            call(method, uri).await.assert_error(400, "INVALID_REQUEST", "Invalid user context");
        }
        call("GET", "/api/profile").await.assert_error(404, "USER_NOT_FOUND", "User not found");
        call("POST", "/api/auth/resend-verification").await.assert_error(400, "USER_NOT_FOUND", "User not found");
        env.finish().await;
    });
}

#[test]
fn invalid_path_ids() {
    run(async {
        let Some(env) = Env::new("routes_invalid_ids").await else { return };
        let me = env.user(UserOpts::default()).await;
        for (method, uri, message) in [
            ("POST", "/api/users/abc/follow", "Invalid target user ID"),
            ("DELETE", "/api/users/abc/follow", "Invalid target user ID"),
            ("POST", "/api/follow-requests/-1/cancel", "Invalid target user ID"),
            ("POST", "/api/me/follow-requests/abc/accept", "Invalid requester ID"),
            ("POST", "/api/me/follow-requests/1.5/decline", "Invalid requester ID"),
            ("DELETE", "/api/me/followers/abc", "Invalid follower ID"),
            ("GET", "/api/users/abc/followers", "Invalid user ID"),
            ("GET", "/api/users/abc/following", "Invalid user ID"),
            ("GET", "/api/users/abc/mutuals", "Invalid user ID"),
            ("GET", "/api/users/99999999999/follow-counts", "Invalid user ID"),
            ("GET", "/api/users/4294967296/profile", "Invalid user ID"),
            ("GET", "/api/users/+1/profile", "Invalid user ID"),
            ("DELETE", "/api/search/recent/abc", "Invalid user ID"),
            ("DELETE", "/api/search/recent/0", "Invalid user ID"),
            ("DELETE", "/api/search/recent/-5", "Invalid user ID"),
        ] {
            env.call(method, uri, Some(&me), None).await.assert_error(400, "INVALID_REQUEST", message);
        }
        // The largest Go uint32 parses; there is no such user.
        let resp = env.call("GET", "/api/users/4294967295/profile", Some(&me), None).await;
        resp.assert_error(404, "USER_NOT_FOUND", "User not found");
        env.finish().await;
    });
}

#[test]
fn auth_rate_limit_is_per_ip_and_shared() {
    run(async {
        let Some(env) = Env::new("routes_rate_limit").await else { return };
        let ip: SocketAddr = "192.0.2.7:5000".parse().unwrap();
        let from_ip = |method: &str, uri: &str| {
            let mut req: Request<Body> = request(method, uri, None, Some("{}"));
            req.extensions_mut().insert(ConnectInfo(ip));
            req
        };

        for remaining in ["4", "3", "2"] {
            let resp = send(&env.app, from_ip("POST", "/api/login")).await;
            assert_eq!(resp.status, 400);
            assert_eq!((resp.header("x-ratelimit-limit"), resp.header("x-ratelimit-remaining")), ("5", remaining));
        }
        // `/api/register` shares the limiter instance with `/api/login`.
        assert_eq!(send(&env.app, from_ip("POST", "/api/register")).await.header("x-ratelimit-remaining"), "1");
        assert_eq!(send(&env.app, from_ip("POST", "/api/register")).await.header("x-ratelimit-remaining"), "0");
        let resp = send(&env.app, from_ip("POST", "/api/login")).await;
        resp.assert_error(429, "RATE_LIMIT_EXCEEDED", "Too many attempts. Please wait a minute before trying again.");
        assert!(!resp.header("retry-after").is_empty());
        // Another address is unaffected; verify-email has no limiter.
        assert_eq!(send(&env.app, request("POST", "/api/login", None, Some("{}"))).await.status, 400);
        assert_eq!(send(&env.app, from_ip("POST", "/api/auth/verify-email")).await.status, 400);
        env.finish().await;
    });
}
