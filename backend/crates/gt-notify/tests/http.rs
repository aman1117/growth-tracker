//! `/api/notifications` endpoints and route matching against PostgreSQL (and Redis when
//! reachable).

mod common;

use common::{core, parts, redis_ready, request, run, token, unique_user_id, TestDb};
use gt_notify::{routes, NewNotification, NotifyContext};
use serde_json::{json, Value};
use tower::ServiceExt;

#[test]
fn notification_endpoints_match_go() {
    run(async {
        let Some(db) = TestDb::new("http_notifications").await else { return };
        redis_ready().await;
        let core = core(&db.pool);
        let notify = NotifyContext::new(&core);
        let app = routes(&core, &notify);
        let (me, other) = (unique_user_id(), unique_user_id());
        let (tok, other_tok) = (token(&core, me), token(&core, other));
        let call =
            |method: &str, uri: &str, token: Option<&str>| app.clone().oneshot(request(method, uri, token, None));

        // Empty list.
        let (status, ctype, body) = parts(call("GET", "/api/notifications", Some(&tok)).await.unwrap()).await;
        assert_eq!((status, ctype.as_str()), (200, "application/json"));
        assert_eq!(body, r#"{"success":true,"notifications":[],"total":0,"page":1,"page_size":20,"has_more":false}"#);

        let svc = &notify.notification_service;
        let mut ids = Vec::new();
        for i in 0..3 {
            let metadata = (i == 0).then(|| json!({"liker_id": 5, "liker_username": "a<b"}));
            ids.push(
                svc.create(NewNotification::new(me, "like_received", format!("t{i}"), "b", metadata)).await.unwrap(),
            );
        }
        let (status, _, body) =
            parts(call("GET", "/api/notifications?page=1&page_size=2", Some(&tok)).await.unwrap()).await;
        assert_eq!(status, 200);
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(
            (v["total"].as_i64(), v["page_size"].as_i64(), v["has_more"].as_bool()),
            (Some(3), Some(2), Some(true))
        );
        assert_eq!(v["notifications"][0]["title"], "t2");
        let (_, _, body) = parts(call("GET", "/api/notifications?page=2&page_size=2", Some(&tok)).await.unwrap()).await;
        let first = &ids[0];
        assert_eq!(
            body,
            format!(
                r#"{{"success":true,"notifications":[{{"id":{},"type":"like_received","title":"t0","body":"b","metadata":{{"liker_id":5,"liker_username":"a\u003cb"}},"created_at":"{}"}}],"total":3,"page":2,"page_size":2,"has_more":false}}"#,
                first.id,
                gt_core::gojson::format_local_literal_z(&first.created_at)
            )
        );
        // Out-of-range paging values fall back like Go.
        for (query, page, size) in
            [("page=0&page_size=0", 1, 20), ("page=-3&page_size=500", 1, 50), ("page=x&page_size=y", 1, 20)]
        {
            let (_, _, body) =
                parts(call("GET", &format!("/api/notifications?{query}"), Some(&tok)).await.unwrap()).await;
            let v: Value = serde_json::from_str(&body).unwrap();
            assert_eq!((v["page"].as_i64(), v["page_size"].as_i64()), (Some(page), Some(size)), "{query}");
        }

        let (status, _, body) = parts(call("GET", "/api/notifications/unread-count", Some(&tok)).await.unwrap()).await;
        assert_eq!((status, body.as_str()), (200, r#"{"success":true,"unread_count":3}"#));

        // Mark one as read.
        let uri = format!("/api/notifications/{}/read", first.id);
        let (status, _, body) = parts(call("PATCH", &uri, Some(&tok)).await.unwrap()).await;
        assert_eq!((status, body.as_str()), (200, r#"{"success":true,"message":"Notification marked as read"}"#));
        let (_, _, body) = parts(call("GET", "/api/notifications/unread-count", Some(&tok)).await.unwrap()).await;
        assert_eq!(body, r#"{"success":true,"unread_count":2}"#);
        let (_, _, body) = parts(call("GET", "/api/notifications?page=2&page_size=2", Some(&tok)).await.unwrap()).await;
        assert!(body.contains(r#""read_at":""#), "{body}");

        for (method, uri) in [
            ("PATCH", "/api/notifications/abc/read"),
            ("PATCH", "/api/notifications/-1/read"),
            ("PATCH", "/api/notifications/4294967296/read"),
            ("PATCH", "/api/notifications/read-all/read"),
            ("PATCH", "/api/notifications/unread-count/read"),
            ("DELETE", "/api/notifications/read-all"),
            ("DELETE", "/api/notifications/unread-count"),
            ("DELETE", "/api/notifications/1x"),
        ] {
            let (status, _, body) = parts(call(method, uri, Some(&tok)).await.unwrap()).await;
            assert_eq!(status, 400, "{method} {uri}");
            assert_eq!(body, r#"{"success":false,"error":"Invalid notification ID","error_code":"INVALID_REQUEST"}"#);
        }

        // Delete: someone else's notification is not found.
        let uri = format!("/api/notifications/{}", ids[1].id);
        let (status, _, body) = parts(call("DELETE", &uri, Some(&other_tok)).await.unwrap()).await;
        assert_eq!(status, 404);
        assert_eq!(body, r#"{"success":false,"error":"Notification not found","error_code":"NOTIFICATION_NOT_FOUND"}"#);
        let (status, _, body) = parts(call("DELETE", &uri, Some(&tok)).await.unwrap()).await;
        assert_eq!((status, body.as_str()), (200, r#"{"success":true,"message":"Notification deleted"}"#));
        let (status, _, _) = parts(call("DELETE", &uri, Some(&tok)).await.unwrap()).await;
        assert_eq!(status, 404);

        let (status, _, body) = parts(call("PATCH", "/api/notifications/read-all", Some(&tok)).await.unwrap()).await;
        assert_eq!((status, body.as_str()), (200, r#"{"success":true,"message":"All notifications marked as read"}"#));
        let (_, _, body) = parts(call("GET", "/api/notifications/unread-count", Some(&tok)).await.unwrap()).await;
        assert_eq!(body, r#"{"success":true,"unread_count":0}"#);
        db.finish().await;
    });
}

#[test]
fn notification_group_routing_matches_fiber() {
    run(async {
        let Some(db) = TestDb::new("http_routing").await else { return };
        let core = core(&db.pool);
        let notify = NotifyContext::new(&core);
        let app = routes(&core, &notify);
        let tok = token(&core, unique_user_id());
        let call =
            |method: &str, uri: &str, token: Option<&str>| app.clone().oneshot(request(method, uri, token, None));

        // The group middleware (auth + API limiter) runs for every method and sub-path.
        for (method, uri) in [
            ("GET", "/api/notifications"),
            ("POST", "/api/notifications"),
            ("GET", "/api/notifications/5"),
            ("GET", "/api/notifications/a/b/c"),
            ("PUT", "/api/notifications/read-all"),
        ] {
            let (status, _, body) = parts(call(method, uri, None).await.unwrap()).await;
            assert_eq!(status, 401, "{method} {uri}");
            assert_eq!(
                body,
                r#"{"success":false,"error":"Missing Authorization Header","error_code":"MISSING_AUTH_HEADER"}"#
            );
        }

        // Then Fiber answers 405 when another method matches the path, else 404.
        for (method, uri) in [
            ("POST", "/api/notifications"),
            ("GET", "/api/notifications/5"),
            ("GET", "/api/notifications/read-all"),
            ("PATCH", "/api/notifications/unread-count"),
            ("GET", "/api/notifications/5/read"),
        ] {
            let resp = call(method, uri, Some(&tok)).await.unwrap();
            assert!(resp.headers().contains_key("x-ratelimit-limit"), "{method} {uri}: limiter ran");
            let (status, ctype, body) = parts(resp).await;
            assert_eq!((status, body.as_str()), (405, "Method Not Allowed"), "{method} {uri}");
            assert_eq!(ctype, "text/plain; charset=utf-8");
        }
        for (method, uri) in [
            ("GET", "/api/notifications/1/2"),
            ("POST", "/api/notifications/1/read/x"),
            ("GET", "/api/notifications/unread-count/x"),
            ("DELETE", "/api/notifications/read-all/x/y"),
            ("GET", "/api/notifications/%3Cb%3E/x"),
        ] {
            let (status, ctype, body) = parts(call(method, uri, Some(&tok)).await.unwrap()).await;
            assert_eq!((status, body), (404, format!("Cannot {method} {uri}")), "raw path, like Fiber's pathOriginal");
            assert_eq!(ctype, "text/plain; charset=utf-8");
        }
        db.finish().await;
    });
}
