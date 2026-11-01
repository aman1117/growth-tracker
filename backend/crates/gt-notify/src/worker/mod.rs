//! The push worker (port of `cmd/pushworker/main.go`): consumes [`PushMessage`]s from the
//! Service Bus queue and delivers them as Web Push notifications to every active subscription of
//! the user, honouring quiet hours, the dedupe window, a global send rate limit and per-message
//! idempotency, and recording every attempt in `push_delivery_logs`.
//!
//! Queue access and push delivery sit behind [`QueueReceiver`] and [`PushSender`] so the
//! processing rules can be tested without Azure or a push service.

mod ratelimit;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use axum::http::{Method, StatusCode, Uri};
use axum::routing::get;
use axum::Router;
use gt_core::config::{PushWorkerConfig, WebPushConfig};
use gt_core::gojson;
use gt_core::models::{PushPreference, PushSubscription, NOTIF_TYPE_FOLLOW_REQUEST};
use gt_core::response;
use serde::Serialize;
use serde_json::{Map, Value};
use tokio::sync::{mpsc, watch, Mutex};
use tokio::task::JoinHandle;
use tracing::Instrument;

pub use ratelimit::{RateLimitError, RateLimiter};

use crate::push::webpush::{self, WebPushError};
use crate::push::{PushMessage, ReceivedMessage, ServiceBusClient, ServiceBusError};
use crate::repository::{NewPushDeliveryLog, PushRepository};

/// Messages delivered more often than this are completed (dropped) without processing.
pub const MAX_DELIVERY_ATTEMPTS: u32 = 5;
/// Failures after which a subscription is expired.
pub const MAX_SUBSCRIPTION_FAILURES: i64 = 5;
/// Concurrent receive requests (the Go worker receives batches of up to 10 messages).
pub const RECEIVE_CONCURRENCY: usize = 10;
/// How long one receive request waits for a message.
pub const RECEIVE_WAIT: Duration = Duration::from_secs(30);
/// Pause after a failed receive.
const RECEIVE_ERROR_BACKOFF: Duration = Duration::from_secs(1);

/// Source of queue messages in peek-lock mode.
#[async_trait]
pub trait QueueReceiver: Send + Sync + 'static {
    /// The next locked message, or `None` when none arrived in time.
    async fn receive(&self) -> Result<Option<ReceivedMessage>, ServiceBusError>;
    /// Removes the message from the queue.
    async fn complete(&self, message: &ReceivedMessage) -> Result<(), ServiceBusError>;
    /// Releases the lock so the message is redelivered.
    async fn abandon(&self, message: &ReceivedMessage) -> Result<(), ServiceBusError>;
}

#[async_trait]
impl QueueReceiver for ServiceBusClient {
    async fn receive(&self) -> Result<Option<ReceivedMessage>, ServiceBusError> {
        ServiceBusClient::receive(self, RECEIVE_WAIT).await
    }

    async fn complete(&self, message: &ReceivedMessage) -> Result<(), ServiceBusError> {
        ServiceBusClient::complete(self, message).await
    }

    async fn abandon(&self, message: &ReceivedMessage) -> Result<(), ServiceBusError> {
        ServiceBusClient::abandon(self, message).await
    }
}

/// Delivers one encrypted push message; returns the push service's HTTP status.
#[async_trait]
pub trait PushSender: Send + Sync + 'static {
    async fn send(
        &self,
        payload: &[u8],
        subscription: &PushSubscription,
        ttl_seconds: i64,
    ) -> Result<u16, WebPushError>;
}

/// [`PushSender`] using Web Push with the configured VAPID keys.
pub struct WebPushSender {
    client: reqwest::Client,
    subscriber: String,
    public_key: String,
    private_key: String,
}

impl WebPushSender {
    pub fn new(cfg: &WebPushConfig) -> Self {
        Self {
            client: webpush::http_client(),
            subscriber: cfg.vapid_subject.clone(),
            public_key: cfg.vapid_public_key.clone(),
            private_key: cfg.vapid_private_key.clone(),
        }
    }
}

#[async_trait]
impl PushSender for WebPushSender {
    async fn send(&self, payload: &[u8], sub: &PushSubscription, ttl_seconds: i64) -> Result<u16, WebPushError> {
        let subscription = webpush::Subscription { endpoint: &sub.endpoint, p256dh: &sub.p256dh, auth: &sub.auth };
        let options = webpush::Options {
            subscriber: &self.subscriber,
            vapid_public_key: &self.public_key,
            vapid_private_key: &self.private_key,
            ttl: ttl_seconds,
        };
        webpush::send_notification(&self.client, payload, &subscription, &options).await
    }
}

#[derive(Serialize)]
struct PushAction {
    action: &'static str,
    title: &'static str,
}

/// The JSON the service worker receives (Go: `buildPushPayload`, a map, hence sorted keys).
#[derive(Serialize)]
struct PushPayload<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    actions: Option<[PushAction; 2]>,
    body: &'a str,
    data: Option<&'a Map<String, Value>>,
    #[serde(rename = "deepLink")]
    deep_link: &'a str,
    #[serde(rename = "requireInteraction", skip_serializing_if = "Option::is_none")]
    require_interaction: Option<bool>,
    tag: &'a str,
    title: &'a str,
    #[serde(rename = "type")]
    notif_type: &'a str,
}

/// Encodes the notification shown by the browser; follow requests get Accept/Decline actions.
pub fn build_push_payload(msg: &PushMessage) -> Vec<u8> {
    let follow_request = msg.notification_type == NOTIF_TYPE_FOLLOW_REQUEST;
    let payload = PushPayload {
        actions: follow_request.then_some([
            PushAction { action: "accept", title: "Accept" },
            PushAction { action: "decline", title: "Decline" },
        ]),
        body: &msg.body,
        data: msg.data.as_ref(),
        deep_link: &msg.deep_link,
        require_interaction: follow_request.then_some(true),
        tag: &msg.tag,
        title: &msg.title,
        notif_type: &msg.notification_type,
    };
    gojson::to_vec(&payload).unwrap_or_default()
}

/// How a processed message is settled.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Settlement {
    Complete,
    Abandon,
}

struct WorkerInner {
    cfg: PushWorkerConfig,
    push_repo: Arc<PushRepository>,
    receiver: Arc<dyn QueueReceiver>,
    sender: Arc<dyn PushSender>,
    limiter: RateLimiter,
    ready: AtomicBool,
    stop_tx: watch::Sender<bool>,
    /// When a receive failure was last logged (the receivers share one warning per second).
    last_receive_warning: std::sync::Mutex<Option<Instant>>,
}

/// Push notification worker (Go: `Worker`).
pub struct Worker {
    inner: Arc<WorkerInner>,
    tasks: std::sync::Mutex<Vec<JoinHandle<()>>>,
}

impl Worker {
    /// Go: `NewWorker` (the Service Bus client and Web Push sender are created by the caller).
    pub fn new(
        cfg: PushWorkerConfig,
        push_repo: Arc<PushRepository>,
        receiver: Arc<dyn QueueReceiver>,
        sender: Arc<dyn PushSender>,
    ) -> Self {
        let limiter = RateLimiter::new(cfg.send_rate_limit);
        let (stop_tx, _) = watch::channel(false);
        Self {
            inner: Arc::new(WorkerInner {
                cfg,
                push_repo,
                receiver,
                sender,
                limiter,
                ready: AtomicBool::new(false),
                stop_tx,
                last_receive_warning: std::sync::Mutex::new(None),
            }),
            tasks: std::sync::Mutex::new(Vec::new()),
        }
    }

    /// Marks the worker ready and starts the receivers and `max_concurrent` processing tasks,
    /// connected by a channel holding `2 * max_concurrent` messages.
    pub fn start(&self) {
        tracing::info!("Starting push worker...");
        self.inner.ready.store(true, Ordering::Release);
        let workers = usize::try_from(self.inner.cfg.max_concurrent).unwrap_or(0);
        let (tx, rx) = mpsc::channel::<ReceivedMessage>((workers * 2).max(1));
        let rx = Arc::new(Mutex::new(rx));

        let mut tasks = self.tasks.lock().unwrap_or_else(|e| e.into_inner());
        let receiver_span = tracing::info_span!("receiver", component = "receiver");
        tracing::info!(parent: &receiver_span, "Message receiver started");
        for _ in 0..RECEIVE_CONCURRENCY {
            let inner = self.inner.clone();
            let stop = self.inner.stop_tx.subscribe();
            tasks.push(tokio::spawn(receive_loop(inner, tx.clone(), stop).instrument(receiver_span.clone())));
        }
        drop(tx);
        for worker_id in 0..workers {
            let inner = self.inner.clone();
            let stop = self.inner.stop_tx.subscribe();
            let span = tracing::info_span!("worker", worker_id);
            tasks.push(tokio::spawn(process_loop(inner, rx.clone(), stop).instrument(span)));
        }
        tracing::info!(
            concurrent_workers = self.inner.cfg.max_concurrent,
            rate_limit = self.inner.cfg.send_rate_limit,
            "Push worker started"
        );
    }

    /// Stops receiving, waits up to `timeout` for in-flight messages, then marks the worker not
    /// ready (Go: `Stop`).
    pub async fn stop(&self, timeout: Duration) {
        tracing::info!("Stopping push worker...");
        self.inner.stop_tx.send_replace(true);
        let tasks: Vec<_> = std::mem::take(&mut *self.tasks.lock().unwrap_or_else(|e| e.into_inner()));
        match tokio::time::timeout(timeout, futures::future::join_all(tasks)).await {
            Ok(_) => tracing::info!("All workers stopped gracefully"),
            Err(_) => tracing::warn!("Shutdown timeout, some workers may not have finished"),
        }
        self.inner.ready.store(false, Ordering::Release);
    }

    /// Whether the worker is processing messages (Go: `IsReady`).
    pub fn is_ready(&self) -> bool {
        self.inner.ready.load(Ordering::Acquire)
    }

    /// Processes and settles one message (Go: `processMessage`).
    pub async fn process_message(&self, msg: &ReceivedMessage) {
        self.inner.process_message(msg).await;
    }
}

async fn stopped(stop: &mut watch::Receiver<bool>) {
    if stop.wait_for(|stopped| *stopped).await.is_err() {
        std::future::pending::<()>().await;
    }
}

async fn receive_loop(inner: Arc<WorkerInner>, tx: mpsc::Sender<ReceivedMessage>, mut stop: watch::Receiver<bool>) {
    loop {
        let received = tokio::select! {
            biased;
            _ = stopped(&mut stop) => {
                tracing::info!("Receiver stopping");
                return;
            }
            received = inner.receiver.receive() => received,
        };
        match received {
            Err(err) => {
                if inner.should_log_receive_failure() {
                    tracing::warn!(error = %err, "Failed to receive messages");
                }
                tokio::select! {
                    _ = stopped(&mut stop) => return,
                    _ = tokio::time::sleep(RECEIVE_ERROR_BACKOFF) => {}
                }
            }
            Ok(None) => {}
            Ok(Some(msg)) => {
                tokio::select! {
                    _ = stopped(&mut stop) => return,
                    sent = tx.send(msg) => if sent.is_err() { return },
                }
            }
        }
    }
}

async fn process_loop(
    inner: Arc<WorkerInner>,
    rx: Arc<Mutex<mpsc::Receiver<ReceivedMessage>>>,
    mut stop: watch::Receiver<bool>,
) {
    tracing::info!("Worker started");
    loop {
        let msg = tokio::select! {
            biased;
            _ = stopped(&mut stop) => {
                tracing::info!("Worker stopping");
                return;
            }
            msg = async { rx.lock().await.recv().await } => msg,
        };
        let Some(msg) = msg else {
            tracing::info!("Message channel closed, worker exiting");
            return;
        };
        inner.process_message(&msg).await;
    }
}

impl WorkerInner {
    /// Rate-limits the receive failure warning to one per backoff period across receivers.
    fn should_log_receive_failure(&self) -> bool {
        let mut last = self.last_receive_warning.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        if last.is_some_and(|at| now.duration_since(at) < RECEIVE_ERROR_BACKOFF) {
            return false;
        }
        *last = Some(now);
        true
    }

    async fn process_message(&self, msg: &ReceivedMessage) {
        let push_msg = match PushMessage::from_json(&msg.body) {
            Ok(push_msg) => push_msg,
            Err(err) => {
                // Invalid messages can never be processed: remove them.
                tracing::error!(error = %err, "Failed to unmarshal message");
                self.settle(msg, Settlement::Complete).await;
                return;
            }
        };
        if msg.delivery_count > MAX_DELIVERY_ATTEMPTS {
            tracing::warn!(
                message_id = %push_msg.message_id,
                delivery_count = msg.delivery_count,
                "Message exceeded max delivery attempts, dead-lettering"
            );
            self.settle(msg, Settlement::Complete).await;
            return;
        }
        let span = tracing::info_span!(
            "push_message",
            message_id = %push_msg.message_id,
            user_id = push_msg.user_id,
            notif_type = %push_msg.notification_type,
            delivery_count = msg.delivery_count
        );
        async {
            tracing::info!("Processing push message");
            let settlement = self.deliver(&push_msg).await;
            self.settle(msg, settlement).await;
        }
        .instrument(span)
        .await;
    }

    async fn deliver(&self, msg: &PushMessage) -> Settlement {
        // Per-type preferences are intentionally not checked (as in Go): every push goes to users
        // with push enabled.
        let pref = match self.push_repo.get_or_create_preference(msg.user_id).await {
            Ok(pref) => pref,
            Err(err) => {
                tracing::error!(error = %err, "Failed to get user preferences");
                return Settlement::Abandon;
            }
        };
        if in_quiet_hours(&pref, chrono::Utc::now()) {
            tracing::info!(reason = "quiet_hours", "Push skipped");
            return Settlement::Abandon;
        }
        if !msg.dedupe_key.is_empty() {
            match self.push_repo.check_dedupe_window(msg.user_id, &msg.dedupe_key, self.cfg.dedupe_window_seconds).await
            {
                Err(err) => tracing::warn!(error = %err, "Dedupe check failed"),
                Ok(true) => {
                    tracing::info!(reason = "dedupe", "Push skipped");
                    return Settlement::Complete;
                }
                Ok(false) => {}
            }
        }
        let subscriptions = match self.push_repo.get_active_subscriptions_by_user_id(msg.user_id).await {
            Ok(subscriptions) => subscriptions,
            Err(err) => {
                tracing::error!(error = %err, "Failed to get subscriptions");
                return Settlement::Abandon;
            }
        };
        if subscriptions.is_empty() {
            tracing::info!("No active subscriptions for user");
            return Settlement::Complete;
        }
        tracing::info!(count = subscriptions.len(), "Sending to subscriptions");
        let mut all_succeeded = true;
        for sub in &subscriptions {
            let span = tracing::info_span!("subscription", subscription_id = sub.id);
            all_succeeded &= self.send_to_subscription(msg, sub).instrument(span).await;
        }
        if all_succeeded {
            Settlement::Complete
        } else {
            Settlement::Abandon
        }
    }

    /// Sends to one subscription; `false` when the message should be retried for it.
    async fn send_to_subscription(&self, msg: &PushMessage, sub: &PushSubscription) -> bool {
        let mut stop = self.stop_tx.subscribe();
        if let Err(err) = self.limiter.wait(&mut stop).await {
            tracing::warn!(error = %err, "Rate limiter cancelled");
            return false;
        }
        match self.push_repo.check_idempotency(&msg.message_id, sub.id).await {
            Err(err) => tracing::warn!(error = %err, "Idempotency check failed"),
            Ok(true) => {
                tracing::debug!("Already sent to this subscription, skipping");
                return true;
            }
            Ok(false) => {}
        }

        let payload = build_push_payload(msg);
        let start = Instant::now();
        let result = self.sender.send(&payload, sub, msg.ttl_seconds).await;
        let mut log = NewPushDeliveryLog {
            user_id: msg.user_id,
            subscription_id: sub.id,
            notification_type: msg.notification_type.clone(),
            dedupe_key: msg.dedupe_key.clone(),
            message_id: msg.message_id.clone(),
            duration_ms: i64::try_from(start.elapsed().as_millis()).unwrap_or(i64::MAX),
            ..Default::default()
        };

        let status = match result {
            Ok(status) => status,
            Err(err) => {
                tracing::error!(error = %err, "Failed to send push notification");
                log.status_code = 0;
                log.error = err.to_string();
                self.record(&log).await;
                self.increment_failure(sub.id).await;
                return false;
            }
        };
        log.status_code = i64::from(status);
        tracing::info!(status_code = status, duration_ms = log.duration_ms, "Push response received");
        match status {
            200..=299 => {
                if let Err(err) = self.push_repo.update_subscription_success(sub.id).await {
                    tracing::warn!(error = %err, "Failed to record subscription success");
                }
                self.record(&log).await;
                true
            }
            404 | 410 => {
                tracing::info!("Subscription gone, marking as dead");
                if let Err(err) = self.push_repo.mark_subscription_gone(sub.id).await {
                    tracing::warn!(error = %err, "Failed to mark subscription gone");
                }
                log.error = "subscription_gone".into();
                self.record(&log).await;
                true
            }
            429 => {
                tracing::warn!("Rate limited by push service");
                log.error = "rate_limited".into();
                self.record(&log).await;
                false
            }
            500.. => {
                tracing::warn!(status_code = status, "Push service server error");
                log.error = format!("server_error_{status}");
                self.record(&log).await;
                false
            }
            _ => {
                // Other client errors (400, 401, 403, ...) are not retried: likely auth/encryption.
                tracing::error!(status_code = status, "Push client error");
                log.error = format!("client_error_{status}");
                self.record(&log).await;
                self.increment_failure(sub.id).await;
                true
            }
        }
    }

    async fn record(&self, log: &NewPushDeliveryLog) {
        if let Err(err) = self.push_repo.create_delivery_log(log).await {
            tracing::warn!(error = %err, "Failed to create delivery log");
        }
    }

    async fn increment_failure(&self, subscription_id: i64) {
        if let Err(err) =
            self.push_repo.increment_subscription_failure(subscription_id, MAX_SUBSCRIPTION_FAILURES).await
        {
            tracing::warn!(error = %err, "Failed to increment subscription failures");
        }
    }

    async fn settle(&self, msg: &ReceivedMessage, settlement: Settlement) {
        let result = match settlement {
            Settlement::Complete => self.receiver.complete(msg).await,
            Settlement::Abandon => self.receiver.abandon(msg).await,
        };
        if let Err(err) = result {
            tracing::warn!(settlement = ?settlement, error = %err, "Failed to settle message");
        }
    }
}

/// Go `pref.IsInQuietHours(time.Now())`. Go's `time.LoadLocation("Local")` is the process time
/// zone (the API accepts `Local` as a timezone), so that case is evaluated on the local wall
/// clock; every other zone is handled by the model.
fn in_quiet_hours(pref: &PushPreference, now: chrono::DateTime<chrono::Utc>) -> bool {
    if pref.timezone != "Local" {
        return pref.is_in_quiet_hours(now);
    }
    let offset = now.with_timezone(&chrono::Local).offset().local_minus_utc();
    let mut on_local_clock = pref.clone();
    on_local_clock.timezone = "UTC".into();
    on_local_clock.is_in_quiet_hours(now + chrono::Duration::seconds(i64::from(offset)))
}
// ==================== Health server ====================

/// `GET /healthz` ("OK") and `GET /readyz` ("OK", or 503 "Not Ready" while the worker is not
/// running), with Fiber's 404/405 answers for anything else.
pub fn health_router(worker: Arc<Worker>) -> Router {
    Router::new()
        .route(
            "/healthz",
            get(|| async { response::text(StatusCode::OK, "OK") }).fallback(crate::handlers::fiber::method_not_allowed),
        )
        .route(
            "/readyz",
            get(move || async move {
                if worker.is_ready() {
                    response::text(StatusCode::OK, "OK")
                } else {
                    response::text(StatusCode::SERVICE_UNAVAILABLE, "Not Ready")
                }
            })
            .fallback(crate::handlers::fiber::method_not_allowed),
        )
        .fallback(|method: Method, uri: Uri| async move { crate::handlers::fiber::not_found(&method, &uri) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn message(notification_type: &str, data: Option<Value>) -> PushMessage {
        PushMessage {
            message_id: "push-1-2".into(),
            user_id: 7,
            notification_type: notification_type.into(),
            title: "New follower".into(),
            body: "amy <3 started following you".into(),
            dedupe_key: "follow:7:9".into(),
            deep_link: "/profile/amy".into(),
            tag: "follow:7:9".into(),
            data: data.map(|d| d.as_object().unwrap().clone()),
            ttl_seconds: 3600,
            ..Default::default()
        }
    }

    #[test]
    fn quiet_hours_in_the_local_zone() {
        use chrono::{Local, TimeZone, Timelike, Utc};
        let now = Utc.with_ymd_and_hms(2026, 1, 5, 12, 0, 0).unwrap();
        let local_hour = now.with_timezone(&Local).hour();
        let mut pref = PushPreference::default_for(1);
        pref.quiet_hours_enabled = true;
        pref.quiet_start = format!("{local_hour:02}:00");
        pref.quiet_end = format!("{:02}:59", local_hour);
        pref.timezone = "Local".into();
        assert!(in_quiet_hours(&pref, now));
        pref.quiet_start = format!("{:02}:00", (local_hour + 2) % 24);
        pref.quiet_end = format!("{:02}:00", (local_hour + 3) % 24);
        assert!(!in_quiet_hours(&pref, now));
        pref.timezone = "UTC".into();
        pref.quiet_start = "12:00".into();
        pref.quiet_end = "12:30".into();
        assert!(in_quiet_hours(&pref, now));
    }

    #[test]
    fn payload_matches_go_build_push_payload() {
        let payload = build_push_payload(&message("new_follower", Some(json!({"z": 1, "a": "x"}))));
        assert_eq!(
            String::from_utf8(payload).unwrap(),
            r#"{"body":"amy \u003c3 started following you","data":{"a":"x","z":1},"deepLink":"/profile/amy","tag":"follow:7:9","title":"New follower","type":"new_follower"}"#
        );
        let payload = build_push_payload(&message("follow_request", None));
        assert_eq!(
            String::from_utf8(payload).unwrap(),
            r#"{"actions":[{"action":"accept","title":"Accept"},{"action":"decline","title":"Decline"}],"body":"amy \u003c3 started following you","data":null,"deepLink":"/profile/amy","requireInteraction":true,"tag":"follow:7:9","title":"New follower","type":"follow_request"}"#
        );
    }
}
