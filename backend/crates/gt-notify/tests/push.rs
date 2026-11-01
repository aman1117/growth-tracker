//! Push repository and the `/api/push` endpoints against PostgreSQL.

mod common;

use chrono::Utc;
use common::{core, parts, request, run, token, unique_user_id, TestDb, MAINTENANCE_KEY, VAPID_PUBLIC_KEY};
use gt_core::models::{PushPreference, PushSubscription};
use gt_notify::repository::{NewPushDeliveryLog, NewPushSubscription, PushRepository, UpsertSubscriptionError};
use gt_notify::{routes, NotifyContext};
use tower::ServiceExt;

fn subscription(user_id: i64, endpoint: &str) -> NewPushSubscription {
    NewPushSubscription {
        user_id,
        endpoint: endpoint.into(),
        p256dh: "p256dh-key".into(),
        auth: "auth-secret".into(),
        vapid_key_id: "v1".into(),
        status: String::new(),
        failure_count: 0,
        user_agent: "UA".into(),
        platform: "web".into(),
        browser: "firefox".into(),
    }
}

async fn by_endpoint(repo: &PushRepository, endpoint: &str) -> PushSubscription {
    repo.get_subscription_by_endpoint(endpoint).await.unwrap().expect("subscription exists")
}

fn delivery(user_id: i64, subscription_id: i64, message_id: &str, status_code: i64) -> NewPushDeliveryLog {
    NewPushDeliveryLog {
        user_id,
        subscription_id,
        notification_type: "like_received".into(),
        dedupe_key: "like:1:2026-01-05".into(),
        message_id: message_id.into(),
        status_code,
        error: String::new(),
        duration_ms: 12,
    }
}

#[test]
fn subscriptions_lifecycle() {
    run(async {
        let Some(db) = TestDb::new("push_subscriptions").await else { return };
        let repo = PushRepository::new(db.pool.clone());
        let (me, other) = (unique_user_id(), unique_user_id());
        let endpoint = "https://push.example.com/send/device-1";

        let created = repo.upsert_subscription(&subscription(me, endpoint)).await.unwrap();
        assert_eq!(created.status, "active");
        repo.update_subscription_success(created.id).await.unwrap();
        let mut again = subscription(me, endpoint);
        again.p256dh = "rotated".into();
        let updated = repo.upsert_subscription(&again).await.unwrap();
        assert_eq!(updated.id, created.id);
        assert_eq!(updated.p256dh, "rotated");
        assert_eq!(updated.created_at, created.created_at);
        assert!(updated.last_success_at.is_some(), "delivery history survives re-registration");
        assert!(matches!(
            repo.upsert_subscription(&subscription(other, endpoint)).await,
            Err(UpsertSubscriptionError::EndpointConflict)
        ));

        let second =
            repo.upsert_subscription(&subscription(me, "https://push.example.com/send/device-2")).await.unwrap();
        assert_eq!(repo.get_active_subscriptions_by_user_id(me).await.unwrap().len(), 2);
        repo.delete_subscription(endpoint, other).await.unwrap();
        assert_eq!(by_endpoint(&repo, endpoint).await.status, "active", "only the owner can unregister");
        repo.delete_subscription(endpoint, me).await.unwrap();
        assert_eq!(by_endpoint(&repo, endpoint).await.status, "expired");
        assert_eq!(repo.get_active_subscriptions_by_user_id(me).await.unwrap().len(), 1);

        for _ in 0..4 {
            repo.increment_subscription_failure(second.id, 5).await.unwrap();
        }
        let failing = by_endpoint(&repo, &second.endpoint).await;
        assert_eq!((failing.failure_count, failing.status.as_str()), (4, "active"));
        repo.update_subscription_success(second.id).await.unwrap();
        assert_eq!(by_endpoint(&repo, &second.endpoint).await.failure_count, 0);
        for _ in 0..5 {
            repo.increment_subscription_failure(second.id, 5).await.unwrap();
        }
        assert_eq!(by_endpoint(&repo, &second.endpoint).await.status, "expired");

        // Stale and gone subscriptions.
        let stale = repo.upsert_subscription(&subscription(other, "https://push.example.com/stale")).await.unwrap();
        let gone = repo.upsert_subscription(&subscription(other, "https://push.example.com/gone")).await.unwrap();
        let fresh = repo.upsert_subscription(&subscription(other, "https://push.example.com/fresh")).await.unwrap();
        sqlx::query("UPDATE push_subscriptions SET created_at = now() - interval '100 days' WHERE id = $1")
            .bind(stale.id)
            .execute(&db.pool)
            .await
            .unwrap();
        repo.mark_subscription_gone(gone.id).await.unwrap();
        sqlx::query("UPDATE push_subscriptions SET updated_at = now() - interval '8 days' WHERE id = $1")
            .bind(gone.id)
            .execute(&db.pool)
            .await
            .unwrap();
        assert_eq!(repo.cleanup_stale_subscriptions(90).await.unwrap(), 1);
        assert_eq!(by_endpoint(&repo, &stale.endpoint).await.status, "expired");
        assert_eq!(by_endpoint(&repo, &fresh.endpoint).await.status, "active");
        assert_eq!(repo.cleanup_gone_subscriptions(7).await.unwrap(), 1);
        assert!(repo.get_subscription_by_endpoint(&gone.endpoint).await.unwrap().is_none());

        repo.delete_subscriptions_by_user_id(other).await.unwrap();
        assert!(repo.get_subscription_by_endpoint(&fresh.endpoint).await.unwrap().is_none());
        db.finish().await;
    });
}

#[test]
fn preferences_and_delivery_logs() {
    run(async {
        let Some(db) = TestDb::new("push_prefs_logs").await else { return };
        let repo = PushRepository::new(db.pool.clone());
        let user = unique_user_id();

        let pref = repo.get_or_create_preference(user).await.unwrap();
        assert!(pref.id > 0);
        assert!(pref.push_enabled);
        assert_eq!(pref.timezone, "Asia/Kolkata");
        assert_eq!(repo.get_or_create_preference(user).await.unwrap().id, pref.id);
        let mut changed = pref.clone();
        changed.push_enabled = false;
        changed.quiet_hours_enabled = true;
        changed.quiet_start = "22:00".into();
        changed.quiet_end = "07:00".into();
        changed.preferences = Some([("like_received".to_string(), false)].into());
        let saved = repo.update_preference(&changed).await.unwrap();
        assert_eq!(saved.id, pref.id);
        assert!(saved.updated_at >= pref.updated_at);
        let reloaded = repo.get_or_create_preference(user).await.unwrap();
        assert_eq!((reloaded.push_enabled, reloaded.quiet_start.as_str()), (false, "22:00"));
        assert!(!reloaded.is_type_enabled("like_received"));
        let other = unique_user_id();
        let inserted = repo.update_preference(&PushPreference::default_for(other)).await.unwrap();
        assert!(inserted.id > 0, "id 0 inserts");
        repo.delete_preference_by_user_id(user).await.unwrap();
        assert_ne!(repo.get_or_create_preference(user).await.unwrap().id, pref.id);

        let ok = repo.create_delivery_log(&delivery(user, 7, "push-1", 201)).await.unwrap();
        assert!(ok > 0);
        assert!(repo.check_idempotency("push-1", 7).await.unwrap());
        assert!(!repo.check_idempotency("push-1", 8).await.unwrap());
        assert!(repo.check_dedupe_window(user, "like:1:2026-01-05", 60).await.unwrap());
        assert!(!repo.check_dedupe_window(user, "", 60).await.unwrap());
        assert!(!repo.check_dedupe_window(user, "other", 60).await.unwrap());
        let failed_user = unique_user_id();
        repo.create_delivery_log(&delivery(failed_user, 9, "push-2", 500)).await.unwrap();
        assert!(
            !repo.check_dedupe_window(failed_user, "like:1:2026-01-05", 60).await.unwrap(),
            "failures do not dedupe"
        );
        sqlx::query("UPDATE push_delivery_logs SET created_at = $1 WHERE id = $2")
            .bind(Utc::now() - chrono::Duration::days(31))
            .bind(ok)
            .execute(&db.pool)
            .await
            .unwrap();
        assert!(!repo.check_dedupe_window(user, "like:1:2026-01-05", 60).await.unwrap());
        assert_eq!(repo.cleanup_old_delivery_logs(30).await.unwrap(), 1);
        assert!(!repo.check_idempotency("push-1", 7).await.unwrap());
        db.finish().await;
    });
}

#[test]
fn push_endpoints_match_go() {
    run(async {
        let Some(db) = TestDb::new("push_http").await else { return };
        let core = core(&db.pool);
        let notify = NotifyContext::new(&core);
        let app = routes(&core, &notify);
        let (me, other) = (unique_user_id(), unique_user_id());
        let (tok, other_tok) = (token(&core, me), token(&core, other));
        let call = |method: &str, uri: &str, token: Option<&str>, body: Option<&str>| {
            app.clone().oneshot(request(method, uri, token, body))
        };

        // Public VAPID key.
        let (status, ctype, body) = parts(call("GET", "/api/push/vapid-public-key", None, None).await.unwrap()).await;
        assert_eq!((status, ctype.as_str()), (200, "application/json"));
        assert_eq!(body, format!(r#"{{"success":true,"keyId":"v1","publicKey":"{VAPID_PUBLIC_KEY}"}}"#));
        let (status, _, body) = parts(call("POST", "/api/push/vapid-public-key", None, None).await.unwrap()).await;
        assert_eq!((status, body.as_str()), (405, "Method Not Allowed"));

        // Authentication runs before validation.
        let (status, _, body) = parts(call("POST", "/api/push/subscriptions", None, Some("{}")).await.unwrap()).await;
        assert_eq!(status, 401);
        assert_eq!(
            body,
            r#"{"success":false,"error":"Missing Authorization Header","error_code":"MISSING_AUTH_HEADER"}"#
        );

        let register = |endpoint: &str| {
            format!(
                r#"{{"keyId":"old","subscription":{{"endpoint":"{endpoint}","keys":{{"p256dh":"pk","auth":"au"}}}},"device":{{"userAgent":"{}","platform":"web","browser":"chrome"}}}}"#,
                "U".repeat(600)
            )
        };
        let endpoint = "https://fcm.googleapis.com/fcm/send/abc";
        for (body, message) in [
            ("{", "Invalid request body"),
            (r#"{"subscription":{"endpoint":""}}"#, "Endpoint is required"),
            (
                r#"{"subscription":{"endpoint":"https://x.example","keys":{"p256dh":"pk"}}}"#,
                "Keys (p256dh and auth) are required",
            ),
            (
                &format!(
                    r#"{{"subscription":{{"endpoint":"https://{}","keys":{{"p256dh":"pk","auth":"au"}}}}}}"#,
                    "a".repeat(2050)
                ),
                "Endpoint too long",
            ),
            (
                r#"{"subscription":{"endpoint":"http://push.example.com/x","keys":{"p256dh":"pk","auth":"au"}}}"#,
                "Invalid push endpoint URL",
            ),
        ] {
            let (status, _, resp) =
                parts(call("POST", "/api/push/subscriptions", Some(&tok), Some(body)).await.unwrap()).await;
            assert_eq!(status, 400, "{body}");
            assert_eq!(resp, format!(r#"{{"success":false,"error":"{message}","error_code":"INVALID_INPUT"}}"#));
        }
        let (status, _, body) =
            parts(call("POST", "/api/push/subscriptions", Some(&tok), Some(&register(endpoint))).await.unwrap()).await;
        assert_eq!(
            (status, body.as_str()),
            (200, r#"{"success":true,"message":"Subscription registered successfully"}"#)
        );
        let stored = notify.push_repo.get_subscription_by_endpoint(endpoint).await.unwrap().unwrap();
        assert_eq!((stored.vapid_key_id.as_str(), stored.user_agent.len()), ("v1", 500));
        let (status, _, body) =
            parts(call("POST", "/api/push/subscriptions", Some(&other_tok), Some(&register(endpoint))).await.unwrap())
                .await;
        assert_eq!(status, 409);
        assert_eq!(
            body,
            r#"{"success":false,"error":"Endpoint already registered to another user","error_code":"CONFLICT"}"#
        );

        // Preferences were created on registration.
        let (status, _, body) = parts(call("GET", "/api/push/preferences", Some(&tok), None).await.unwrap()).await;
        assert_eq!(status, 200);
        assert_eq!(
            body,
            r#"{"success":true,"preferences":{"push_enabled":true,"preferences":{},"quiet_hours_enabled":false,"timezone":"Asia/Kolkata"}}"#
        );
        let update = r#"{"push_enabled":false,"preferences":{"streak_at_risk":false,"like_received":true},"quiet_hours_enabled":true,"quiet_start":"22:30","quiet_end":"06:45","timezone":"Europe/Berlin"}"#;
        let (status, _, body) =
            parts(call("PUT", "/api/push/preferences", Some(&tok), Some(update)).await.unwrap()).await;
        assert_eq!(status, 200);
        assert_eq!(
            body,
            r#"{"success":true,"preferences":{"push_enabled":false,"preferences":{"like_received":true,"streak_at_risk":false},"quiet_hours_enabled":true,"quiet_start":"22:30","quiet_end":"06:45","timezone":"Europe/Berlin"}}"#
        );
        let (status, _, body) =
            parts(call("PUT", "/api/push/preferences", Some(&tok), Some(r#"{"quiet_start":"25:00"}"#)).await.unwrap())
                .await;
        assert_eq!(status, 400);
        assert_eq!(
            body,
            r#"{"success":false,"error":"Invalid quiet_start format (expected HH:MM)","error_code":"INVALID_INPUT"}"#
        );
        let (_, _, body) = parts(call("GET", "/api/push/preferences", Some(&tok), None).await.unwrap()).await;
        assert!(body.contains(r#""quiet_start":"22:30""#), "rejected updates are not saved: {body}");
        let (status, _, _) = parts(call("PATCH", "/api/push/preferences", None, None).await.unwrap()).await;
        assert_eq!(status, 405, "wrong methods are rejected before authentication");

        // Unregister.
        let (status, _, body) =
            parts(call("DELETE", "/api/push/subscriptions", Some(&tok), Some(r#"{"endpoint":""}"#)).await.unwrap())
                .await;
        assert_eq!(
            (status, body.as_str()),
            (400, r#"{"success":false,"error":"Endpoint is required","error_code":"INVALID_INPUT"}"#)
        );
        let unregister = format!(r#"{{"endpoint":"{endpoint}"}}"#);
        let (status, _, body) =
            parts(call("DELETE", "/api/push/subscriptions", Some(&tok), Some(&unregister)).await.unwrap()).await;
        assert_eq!((status, body.as_str()), (200, r#"{"success":true,"message":"Subscription removed"}"#));
        assert_eq!(notify.push_repo.get_subscription_by_endpoint(endpoint).await.unwrap().unwrap().status, "expired");

        // Maintenance cleanup needs a user token and the maintenance key.
        let (status, _, _) = parts(call("POST", "/api/push/cleanup", None, None).await.unwrap()).await;
        assert_eq!(status, 401);
        let (status, _, body) = parts(call("POST", "/api/push/cleanup", Some(&tok), None).await.unwrap()).await;
        assert_eq!(
            (status, body.as_str()),
            (403, r#"{"success":false,"error":"Invalid maintenance key","error_code":"NOT_AUTHORIZED"}"#)
        );
        let mut req = request("POST", "/api/push/cleanup", Some(&tok), None);
        req.headers_mut().insert("X-Maintenance-Key", MAINTENANCE_KEY.parse().unwrap());
        let (status, _, body) = parts(app.clone().oneshot(req).await.unwrap()).await;
        assert_eq!(status, 200);
        assert_eq!(
            body,
            r#"{"gone_subscriptions_deleted":0,"old_logs_deleted":0,"stale_subscriptions_cleaned":0,"success":true}"#
        );

        let mut cfg = common::config();
        cfg.maintenance_api_key = String::new();
        cfg.web_push.vapid_public_key = String::new();
        let core = gt_core::CoreContext::new(std::sync::Arc::new(cfg), db.pool.clone());
        let app = routes(&core, &NotifyContext::new(&core));
        let mut req = request("POST", "/api/push/cleanup", Some(&tok), None);
        req.headers_mut().insert("X-Maintenance-Key", "".parse().unwrap());
        let (status, _, body) = parts(app.clone().oneshot(req).await.unwrap()).await;
        assert_eq!(
            (status, body.as_str()),
            (403, r#"{"success":false,"error":"Maintenance endpoints are disabled","error_code":"NOT_AUTHORIZED"}"#)
        );
        let (status, _, body) =
            parts(app.oneshot(request("GET", "/api/push/vapid-public-key", None, None)).await.unwrap()).await;
        assert_eq!(
            (status, body.as_str()),
            (500, r#"{"success":false,"error":"Push notifications not configured","error_code":"CONFIG_ERROR"}"#)
        );
        db.finish().await;
    });
}
