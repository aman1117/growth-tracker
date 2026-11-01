//! Push worker processing rules with a fake queue and push service, against PostgreSQL.

mod common;

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use chrono::Utc;
use common::{parts, run, unique_user_id, TestDb};
use gt_core::config::PushWorkerConfig;
use gt_core::models::PushSubscription;
use gt_notify::push::webpush::WebPushError;
use gt_notify::push::{PushMessage, ReceivedMessage, ServiceBusError};
use gt_notify::repository::{NewPushSubscription, PushRepository};
use gt_notify::worker::{build_push_payload, health_router, PushSender, QueueReceiver, Worker};
use serde_json::json;
use tower::ServiceExt;

#[derive(Default)]
struct FakeQueue {
    pending: Mutex<VecDeque<ReceivedMessage>>,
    settled: Mutex<Vec<(String, &'static str)>>,
}

impl FakeQueue {
    fn settled(&self) -> Vec<(String, &'static str)> {
        self.settled.lock().unwrap().clone()
    }
}

#[async_trait]
impl QueueReceiver for FakeQueue {
    async fn receive(&self) -> Result<Option<ReceivedMessage>, ServiceBusError> {
        let next = self.pending.lock().unwrap().pop_front();
        if next.is_none() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        Ok(next)
    }

    async fn complete(&self, message: &ReceivedMessage) -> Result<(), ServiceBusError> {
        self.settled.lock().unwrap().push((message.message_id.clone(), "complete"));
        Ok(())
    }

    async fn abandon(&self, message: &ReceivedMessage) -> Result<(), ServiceBusError> {
        self.settled.lock().unwrap().push((message.message_id.clone(), "abandon"));
        Ok(())
    }
}

/// Answers per endpoint (`Err` = network failure) and records every send.
#[derive(Default)]
struct FakePushService {
    answers: Mutex<HashMap<String, Result<u16, String>>>,
    sent: Mutex<Vec<(String, Vec<u8>, i64)>>,
}

impl FakePushService {
    fn answer(&self, endpoint: &str, answer: Result<u16, &str>) {
        self.answers.lock().unwrap().insert(endpoint.into(), answer.map_err(str::to_string));
    }

    fn sent_endpoints(&self) -> Vec<String> {
        let mut endpoints: Vec<String> = self.sent.lock().unwrap().iter().map(|(e, _, _)| e.clone()).collect();
        endpoints.sort();
        endpoints
    }
}

#[async_trait]
impl PushSender for FakePushService {
    async fn send(&self, payload: &[u8], sub: &PushSubscription, ttl_seconds: i64) -> Result<u16, WebPushError> {
        self.sent.lock().unwrap().push((sub.endpoint.clone(), payload.to_vec(), ttl_seconds));
        self.answers.lock().unwrap().get(&sub.endpoint).cloned().unwrap_or(Ok(201)).map_err(WebPushError)
    }
}

fn worker_config(rate: i64) -> PushWorkerConfig {
    PushWorkerConfig { send_rate_limit: rate, max_concurrent: 2, dedupe_window_seconds: 60 }
}

fn received(msg: &PushMessage, delivery_count: u32) -> ReceivedMessage {
    ReceivedMessage {
        body: msg.to_json().unwrap(),
        message_id: msg.message_id.clone(),
        delivery_count,
        sequence_number: 1,
        lock_token: "lock".into(),
        subject: Some(msg.notification_type.clone()),
        location: "https://example.invalid/lock".into(),
    }
}

fn push_message(id: &str, user_id: i64, dedupe_key: &str) -> PushMessage {
    PushMessage {
        message_id: id.into(),
        user_id,
        notification_type: "like_received".into(),
        title: "New Like!".into(),
        body: "amy liked your day".into(),
        dedupe_key: dedupe_key.into(),
        deep_link: "/?date=2026-01-05".into(),
        tag: dedupe_key.into(),
        data: json!({"notification_id": 5}).as_object().cloned(),
        ttl_seconds: 3600,
        created_at: Utc::now(),
    }
}

async fn subscribe(repo: &PushRepository, user_id: i64, endpoint: &str) -> PushSubscription {
    repo.upsert_subscription(&NewPushSubscription {
        user_id,
        endpoint: endpoint.into(),
        p256dh: "pk".into(),
        auth: "au".into(),
        vapid_key_id: "v1".into(),
        ..Default::default()
    })
    .await
    .unwrap()
}

async fn logs(db: &TestDb, message_id: &str) -> Vec<(i64, i64, String)> {
    sqlx::query_as("SELECT subscription_id, status_code, COALESCE(error, '') FROM push_delivery_logs WHERE message_id = $1 ORDER BY subscription_id")
        .bind(message_id)
        .fetch_all(&db.pool)
        .await
        .unwrap()
}

#[test]
fn process_message_follows_go_rules() {
    run(async {
        let Some(db) = TestDb::new("worker_rules").await else { return };
        let repo = Arc::new(PushRepository::new(db.pool.clone()));
        let queue = Arc::new(FakeQueue::default());
        let push = Arc::new(FakePushService::default());
        let worker = Worker::new(worker_config(1000), repo.clone(), queue.clone(), push.clone());
        let user = unique_user_id();

        // Undecodable and over-delivered messages are completed without sending.
        let mut garbage = received(&push_message("bad", user, ""), 1);
        garbage.body = b"{not json".to_vec();
        worker.process_message(&garbage).await;
        worker.process_message(&received(&push_message("tired", user, ""), 6)).await;
        // No subscriptions: completed, and default preferences now exist.
        worker.process_message(&received(&push_message("nobody", user, ""), 1)).await;
        assert!(repo.get_or_create_preference(user).await.unwrap().push_enabled);
        assert_eq!(
            queue.settled(),
            [("bad".into(), "complete"), ("tired".into(), "complete"), ("nobody".into(), "complete")]
        );
        assert!(push.sent_endpoints().is_empty());

        let ok = subscribe(&repo, user, "https://push.example.com/ok").await;
        let gone = subscribe(&repo, user, "https://push.example.com/gone").await;
        let rejected = subscribe(&repo, user, "https://push.example.com/rejected").await;
        let broken = subscribe(&repo, user, "https://push.example.com/broken").await;
        push.answer(&gone.endpoint, Ok(410));
        push.answer(&rejected.endpoint, Ok(400));
        push.answer(&broken.endpoint, Err("connection refused"));

        // Quiet hours: abandoned untouched.
        let mut pref = repo.get_or_create_preference(user).await.unwrap();
        let now = Utc::now();
        pref.quiet_hours_enabled = true;
        pref.quiet_start = (now - chrono::Duration::hours(1)).format("%H:%M").to_string();
        pref.quiet_end = (now + chrono::Duration::hours(1)).format("%H:%M").to_string();
        pref.timezone = "UTC".into();
        let pref = repo.update_preference(&pref).await.unwrap();
        worker.process_message(&received(&push_message("quiet", user, ""), 1)).await;
        assert_eq!(queue.settled().last().unwrap(), &("quiet".to_string(), "abandon"));
        assert!(push.sent_endpoints().is_empty());
        let mut pref = pref;
        pref.quiet_hours_enabled = false;
        repo.update_preference(&pref).await.unwrap();

        // One retryable failure abandons the message; every attempt is logged.
        let msg = push_message("m1", user, "like:1:2026-01-05");
        worker.process_message(&received(&msg, 1)).await;
        assert_eq!(queue.settled().last().unwrap(), &("m1".to_string(), "abandon"));
        assert_eq!(push.sent_endpoints().len(), 4);
        {
            let sent = push.sent.lock().unwrap();
            assert!(sent.iter().all(|(_, payload, ttl)| *payload == build_push_payload(&msg) && *ttl == 3600));
        }
        let mut expected = vec![
            (ok.id, 201, String::new()),
            (gone.id, 410, "subscription_gone".to_string()),
            (rejected.id, 400, "client_error_400".to_string()),
            (broken.id, 0, "connection refused".to_string()),
        ];
        expected.sort();
        assert_eq!(logs(&db, "m1").await, expected);
        let status = |endpoint: String| {
            let repo = repo.clone();
            async move { repo.get_subscription_by_endpoint(&endpoint).await.unwrap().unwrap() }
        };
        assert!(status(ok.endpoint.clone()).await.last_success_at.is_some());
        assert_eq!(status(gone.endpoint.clone()).await.status, "gone");
        assert_eq!(status(rejected.endpoint.clone()).await.failure_count, 1);
        assert_eq!(status(broken.endpoint.clone()).await.failure_count, 1);

        // The redelivery hits the dedupe window (a successful push with the same key).
        worker.process_message(&received(&msg, 2)).await;
        assert_eq!(queue.settled().last().unwrap(), &("m1".to_string(), "complete"));
        assert_eq!(push.sent_endpoints().len(), 4);

        // Without a dedupe key, redeliveries skip subscriptions already attempted.
        push.answer(&broken.endpoint, Ok(429));
        push.answer(&rejected.endpoint, Ok(503));
        let msg = push_message("m2", user, "");
        worker.process_message(&received(&msg, 1)).await;
        assert_eq!(queue.settled().last().unwrap(), &("m2".to_string(), "abandon"));
        let mut logged: Vec<String> = logs(&db, "m2").await.into_iter().map(|(_, _, e)| e).collect();
        logged.sort();
        assert_eq!(logged, ["", "rate_limited", "server_error_503"]);
        let before = push.sent.lock().unwrap().len();
        worker.process_message(&received(&msg, 2)).await;
        assert_eq!(queue.settled().last().unwrap(), &("m2".to_string(), "complete"));
        assert_eq!(push.sent.lock().unwrap().len(), before, "idempotent per subscription");

        // A non-positive rate limit refuses every send (x/time/rate burst 0).
        let blocked = Worker::new(worker_config(0), repo.clone(), queue.clone(), push.clone());
        blocked.process_message(&received(&push_message("m3", user, ""), 1)).await;
        assert_eq!(queue.settled().last().unwrap(), &("m3".to_string(), "abandon"));
        assert_eq!(push.sent.lock().unwrap().len(), before);
        assert!(logs(&db, "m3").await.is_empty());
        db.finish().await;
    });
}

#[test]
fn worker_runs_until_stopped_and_reports_health() {
    run(async {
        let Some(db) = TestDb::new("worker_lifecycle").await else { return };
        let repo = Arc::new(PushRepository::new(db.pool.clone()));
        let queue = Arc::new(FakeQueue::default());
        let push = Arc::new(FakePushService::default());
        let user = unique_user_id();
        subscribe(&repo, user, "https://push.example.com/device").await;
        for i in 0..20 {
            queue.pending.lock().unwrap().push_back(received(&push_message(&format!("bulk-{i}"), user, ""), 1));
        }
        let worker = Arc::new(Worker::new(worker_config(1000), repo.clone(), queue.clone(), push.clone()));
        let health = health_router(worker.clone());
        let get = |uri: &str| health.clone().oneshot(common::request("GET", uri, None, None));

        let (status, ctype, body) = parts(get("/readyz").await.unwrap()).await;
        assert_eq!((status, ctype.as_str(), body.as_str()), (503, "text/plain; charset=utf-8", "Not Ready"));
        worker.start();
        assert!(worker.is_ready());
        for _ in 0..500 {
            if queue.settled().len() == 20 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(queue.settled().len(), 20);
        assert!(queue.settled().iter().all(|(_, s)| *s == "complete"));
        assert_eq!(push.sent.lock().unwrap().len(), 20);

        assert_eq!(parts(get("/healthz").await.unwrap()).await, (200, "text/plain; charset=utf-8".into(), "OK".into()));
        assert_eq!(parts(get("/readyz").await.unwrap()).await.2, "OK");
        assert_eq!(parts(get("/nope").await.unwrap()).await.2, "Cannot GET /nope");
        let resp = health.clone().oneshot(common::request("POST", "/healthz", None, None)).await.unwrap();
        assert_eq!(parts(resp).await.2, "Method Not Allowed");

        worker.stop(Duration::from_secs(5)).await;
        assert!(!worker.is_ready());
        assert_eq!(parts(get("/readyz").await.unwrap()).await.0, 503);
        db.finish().await;
    });
}
