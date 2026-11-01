//! Asynchronous publisher of Web Push requests to Azure Service Bus (port of
//! `internal/services/push_publisher.go`).
//!
//! Publishing never blocks the caller: messages are queued (up to 1000) and a background task
//! sends them in batches of up to 50, or every 100 ms. Without a Service Bus connection string
//! the publisher is "unavailable" and publishing is a silent no-op.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use arc_swap::ArcSwapOption;
use chrono::Utc;
use futures::StreamExt;
use gt_core::config::Config;
use gt_core::models::Notification;
use serde_json::{Map, Value};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use super::message::{
    generate_message_id, is_valid_deep_link, truncate_body, PushMessage, MAX_PUSH_BODY_CHARS, MAX_PUSH_PAYLOAD_BYTES,
};
use super::servicebus::{OutgoingMessage, PropertyValue, ServiceBusClient, ServiceBusError};

/// Buffer up to 1000 messages.
pub const DEFAULT_QUEUE_SIZE: usize = 1000;
/// Send up to 50 messages per batch.
pub const DEFAULT_BATCH_SIZE: usize = 50;
/// Maximum wait before sending a partial batch.
pub const DEFAULT_BATCH_WAIT: Duration = Duration::from_millis(100);
/// TTL of pushes built from a notification (1 hour).
pub const DEFAULT_PUSH_TTL_SECONDS: i64 = 3600;
/// Messages of one batch sent concurrently (the REST API sends one message per request).
const SEND_CONCURRENCY: usize = 16;

/// Where queued messages go. [`ServiceBusClient`] is the production transport; tests and other
/// wiring can provide their own.
#[async_trait::async_trait]
pub trait PushTransport: Send + Sync + 'static {
    /// Sends one message.
    async fn send(&self, message: &OutgoingMessage) -> Result<(), ServiceBusError>;

    /// Establishes the connection ahead of the first message (best effort).
    async fn warmup(&self) -> Result<(), ServiceBusError> {
        Ok(())
    }
}

#[async_trait::async_trait]
impl PushTransport for ServiceBusClient {
    async fn send(&self, message: &OutgoingMessage) -> Result<(), ServiceBusError> {
        ServiceBusClient::send(self, message).await
    }

    async fn warmup(&self) -> Result<(), ServiceBusError> {
        ServiceBusClient::warmup(self).await
    }
}

/// One push to publish (the arguments of Go's `PublishPushNotification`).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct PushRequest {
    pub user_id: i64,
    pub notification_type: String,
    pub title: String,
    pub body: String,
    /// Server-side dedupe key; also the browser collapse tag.
    pub dedupe_key: String,
    /// App-relative path opened on click; anything else is dropped.
    pub deep_link: String,
    pub data: Option<Map<String, Value>>,
    pub ttl_seconds: i64,
}

/// Why a push could not be queued.
#[derive(Debug, thiserror::Error)]
pub enum PushPublishError {
    #[error("failed to marshal push message: {0}")]
    Marshal(#[from] serde_json::Error),
    /// The queue is full; the message was dropped instead of blocking the caller.
    #[error("push notification queue full")]
    QueueFull,
}

/// The push publisher (Go: `services.PushPublisher`).
pub struct PushPublisher {
    sender: Mutex<Option<mpsc::Sender<OutgoingMessage>>>,
    capacity: usize,
    available: AtomicBool,
    worker: tokio::sync::Mutex<Option<JoinHandle<()>>>,
}

impl std::fmt::Debug for PushPublisher {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PushPublisher")
            .field("available", &self.is_available())
            .field("queue", &self.queue_stats())
            .finish()
    }
}

impl PushPublisher {
    /// Builds the publisher from the configuration (Go: `NewPushPublisher`): unavailable without
    /// a connection string, otherwise connected to the configured queue with its background
    /// sender running. Must be called inside a Tokio runtime.
    pub fn new(cfg: &Config) -> Result<Self, ServiceBusError> {
        let sb = &cfg.azure_service_bus;
        if sb.connection_string.is_empty() {
            tracing::warn!("Service Bus not configured, push notifications disabled");
            return Ok(Self::unconfigured());
        }
        let client = ServiceBusClient::from_connection_string(&sb.connection_string, &sb.queue_name)
            .map_err(|e| ServiceBusError::ConnectionString(format!("failed to create Service Bus client: {e}")))?;
        tracing::info!(queue = %sb.queue_name, "Push publisher initialized");
        Ok(Self::with_transport(Arc::new(client), DEFAULT_QUEUE_SIZE, DEFAULT_BATCH_SIZE, DEFAULT_BATCH_WAIT))
    }

    /// A publisher that is not available (publishing is a no-op).
    pub fn unconfigured() -> Self {
        Self {
            sender: Mutex::new(None),
            capacity: 0,
            available: AtomicBool::new(false),
            worker: tokio::sync::Mutex::new(None),
        }
    }

    /// A publisher sending through `transport`, with its background sender running (it also
    /// warms the connection up). Must be called inside a Tokio runtime.
    pub fn with_transport(
        transport: Arc<dyn PushTransport>,
        queue_size: usize,
        batch_size: usize,
        batch_wait: Duration,
    ) -> Self {
        let capacity = queue_size.max(1);
        let (tx, rx) = mpsc::channel(capacity);
        tokio::spawn(warmup(transport.clone()));
        let worker = tokio::spawn(run_sender(rx, transport, batch_size.max(1), batch_wait));
        Self {
            sender: Mutex::new(Some(tx)),
            capacity,
            available: AtomicBool::new(true),
            worker: tokio::sync::Mutex::new(Some(worker)),
        }
    }

    /// Whether pushes are being sent (configured and not closed) (Go: `IsAvailable`).
    pub fn is_available(&self) -> bool {
        self.available.load(Ordering::Acquire)
    }

    /// `(pending, capacity)` of the queue, for monitoring (Go: `QueueStats`).
    pub fn queue_stats(&self) -> (usize, usize) {
        let guard = self.sender.lock().unwrap_or_else(|e| e.into_inner());
        match guard.as_ref() {
            Some(tx) => (self.capacity - tx.capacity(), self.capacity),
            None => (0, 0),
        }
    }

    /// Stops accepting messages, sends what is queued and stops the background sender. Safe to
    /// call more than once (Go: `Close`).
    pub async fn close(&self) {
        self.available.store(false, Ordering::Release);
        drop(self.sender.lock().unwrap_or_else(|e| e.into_inner()).take());
        if let Some(worker) = self.worker.lock().await.take() {
            if let Err(err) = worker.await {
                tracing::warn!(error = %err, "Push publisher sender task failed");
            }
        }
    }

    /// Queues a push without blocking (Go: `PublishPushNotification`). A no-op returning `Ok`
    /// when the publisher is unavailable; [`PushPublishError::QueueFull`] when the queue is full.
    /// Invalid deep links are cleared, bodies are truncated to 200 characters and `data` is
    /// dropped when the message would exceed 4 KB.
    pub fn publish_push_notification(&self, req: PushRequest) -> Result<(), PushPublishError> {
        if !self.is_available() {
            tracing::debug!(user_id = req.user_id, notification_type = %req.notification_type, "Push publisher not available, skipping");
            return Ok(());
        }
        let message = build_outgoing_message(req)?;
        let user_id = property_u64(&message, "user_id");
        let guard = self.sender.lock().unwrap_or_else(|e| e.into_inner());
        let Some(tx) = guard.as_ref() else { return Ok(()) };
        match tx.try_send(message) {
            Ok(()) => {
                tracing::debug!(user_id, "Push message queued");
                Ok(())
            }
            Err(mpsc::error::TrySendError::Full(message)) => {
                tracing::warn!(user_id, notification_type = %message.subject, queue_size = self.capacity, "Push notification queue full, message dropped");
                Err(PushPublishError::QueueFull)
            }
            // Closed concurrently: like publishing after `close`.
            Err(mpsc::error::TrySendError::Closed(_)) => Ok(()),
        }
    }

    /// Queues a push for a stored notification with a 1 hour TTL; its data is the metadata plus
    /// `notification_id`, so the client can mark it as read when clicked (Go:
    /// `PublishFromNotification`).
    pub fn publish_from_notification(
        &self,
        notif: &Notification,
        dedupe_key: &str,
        deep_link: &str,
    ) -> Result<(), PushPublishError> {
        self.publish_push_notification(PushRequest {
            user_id: notif.user_id,
            notification_type: notif.notif_type.clone(),
            title: notif.title.clone(),
            body: notif.body.clone(),
            dedupe_key: dedupe_key.to_string(),
            deep_link: deep_link.to_string(),
            data: Some(notification_data(notif)),
            ttl_seconds: DEFAULT_PUSH_TTL_SECONDS,
        })
    }
}

/// The push `data` of a stored notification: its metadata plus `notification_id`.
pub fn notification_data(notif: &Notification) -> Map<String, Value> {
    let mut data = match &notif.metadata {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    };
    data.insert("notification_id".into(), Value::from(notif.id));
    data
}

fn property_u64(message: &OutgoingMessage, name: &str) -> u64 {
    message
        .application_properties
        .iter()
        .find_map(|(n, v)| match v {
            PropertyValue::UInt(id) if n == name => Some(*id),
            _ => None,
        })
        .unwrap_or_default()
}

/// Builds the Service Bus message for a push request: the body is the Go JSON of
/// [`PushMessage`]; `MessageID`, `Subject` (the notification type), `TimeToLive` and the
/// application properties `user_id`, `type` and `dedupe_key` are set like the Go publisher.
pub fn build_outgoing_message(req: PushRequest) -> Result<OutgoingMessage, PushPublishError> {
    let deep_link = if !req.deep_link.is_empty() && !is_valid_deep_link(&req.deep_link) {
        tracing::warn!(deep_link = %req.deep_link, "Invalid deep link, clearing");
        String::new()
    } else {
        req.deep_link
    };
    let mut msg = PushMessage {
        message_id: generate_message_id(),
        user_id: req.user_id,
        notification_type: req.notification_type,
        title: req.title,
        body: truncate_body(&req.body, MAX_PUSH_BODY_CHARS),
        tag: req.dedupe_key.clone(),
        dedupe_key: req.dedupe_key,
        deep_link,
        data: req.data,
        ttl_seconds: req.ttl_seconds,
        created_at: Utc::now(),
    };
    let mut payload = msg.to_json()?;
    if payload.len() > MAX_PUSH_PAYLOAD_BYTES {
        tracing::warn!(size = payload.len(), user_id = msg.user_id, "Push payload too large, truncating data");
        msg.data = None;
        payload = msg.to_json()?;
    }
    Ok(OutgoingMessage {
        body: payload,
        time_to_live: Some(Duration::from_secs(msg.ttl_seconds.max(0) as u64)),
        application_properties: vec![
            ("user_id".into(), PropertyValue::UInt(msg.user_id.max(0) as u64)),
            ("type".into(), PropertyValue::Text(msg.notification_type.clone())),
            ("dedupe_key".into(), PropertyValue::Text(msg.dedupe_key.clone())),
        ],
        message_id: msg.message_id,
        subject: msg.notification_type,
    })
}

async fn warmup(transport: Arc<dyn PushTransport>) {
    match transport.warmup().await {
        Ok(()) => tracing::info!("Service Bus connection warmed up"),
        Err(err) => tracing::warn!(error = %err, "Failed to warm up Service Bus connection"),
    }
}

/// Collects queued messages into batches of `batch_size` (or whatever arrived within
/// `batch_wait`) and sends them; when the queue closes, the remainder is sent and the task ends.
async fn run_sender(
    mut rx: mpsc::Receiver<OutgoingMessage>,
    transport: Arc<dyn PushTransport>,
    batch_size: usize,
    batch_wait: Duration,
) {
    let mut batch = Vec::with_capacity(batch_size);
    let mut timer = tokio::time::interval_at(tokio::time::Instant::now() + batch_wait, batch_wait);
    timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            received = rx.recv() => match received {
                Some(message) => {
                    batch.push(message);
                    if batch.len() >= batch_size {
                        flush(&transport, &mut batch).await;
                        timer.reset();
                    }
                }
                None => {
                    flush(&transport, &mut batch).await;
                    return;
                }
            },
            _ = timer.tick() => flush(&transport, &mut batch).await,
        }
    }
}

async fn flush(transport: &Arc<dyn PushTransport>, batch: &mut Vec<OutgoingMessage>) {
    if batch.is_empty() {
        return;
    }
    let messages = std::mem::take(batch);
    let count = messages.len();
    let failures: Vec<ServiceBusError> = futures::stream::iter(messages)
        .map(|message| {
            let transport = transport.clone();
            async move { transport.send(&message).await.err() }
        })
        .buffer_unordered(SEND_CONCURRENCY)
        .filter_map(|failure| async move { failure })
        .collect()
        .await;
    match failures.first() {
        None => tracing::debug!(count, "Sent push notification batch"),
        Some(err) => tracing::error!(count, failed = failures.len(), error = %err, "Failed to send message batch"),
    }
}

// ==================== Global publisher (Go: InitPushPublisher / GetPushPublisher) ====================

static PUBLISHER: ArcSwapOption<PushPublisher> = ArcSwapOption::const_empty();
static INITIALIZED: AtomicBool = AtomicBool::new(false);

/// Initializes the global publisher once (Go: `InitPushPublisher` with its `sync.Once`): later
/// calls do nothing and return `Ok`, even after a failed first call. The server calls it at
/// startup only when `AZURE_SERVICEBUS_CONNECTION_STRING` is set and keeps running without push
/// when it fails. Must be called inside a Tokio runtime.
pub fn init_push_publisher(cfg: &Config) -> Result<(), ServiceBusError> {
    if INITIALIZED.swap(true, Ordering::AcqRel) {
        return Ok(());
    }
    let publisher = PushPublisher::new(cfg)?;
    PUBLISHER.store(Some(Arc::new(publisher)));
    Ok(())
}

/// The global publisher, `None` until [`init_push_publisher`] succeeded (Go: `GetPushPublisher`).
pub fn get_push_publisher() -> Option<Arc<PushPublisher>> {
    PUBLISHER.load_full()
}

/// The global publisher when it is available (Go: `publisher != nil && publisher.IsAvailable()`).
pub fn available_publisher() -> Option<Arc<PushPublisher>> {
    get_push_publisher().filter(|p| p.is_available())
}

/// Replaces the global publisher (tests, alternative wiring) and marks it initialized.
pub fn set_push_publisher(publisher: Option<Arc<PushPublisher>>) {
    INITIALIZED.store(true, Ordering::Release);
    PUBLISHER.store(publisher);
}

/// Closes the global publisher, sending what is still queued (graceful shutdown).
pub async fn close_push_publisher() {
    if let Some(publisher) = get_push_publisher() {
        publisher.close().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Records sent messages; optionally fails every send.
    #[derive(Default)]
    pub(crate) struct Recorder {
        pub sent: Mutex<Vec<OutgoingMessage>>,
        pub fail: bool,
    }

    #[async_trait::async_trait]
    impl PushTransport for Recorder {
        async fn send(&self, message: &OutgoingMessage) -> Result<(), ServiceBusError> {
            if self.fail {
                return Err(ServiceBusError::Status { status: 400, body: "nope".into() });
            }
            self.sent.lock().unwrap().push(message.clone());
            Ok(())
        }
    }

    fn request(user_id: i64) -> PushRequest {
        PushRequest {
            user_id,
            notification_type: "like_received".into(),
            title: "New like".into(),
            body: "Someone liked your day".into(),
            dedupe_key: "like:1".into(),
            deep_link: "/notifications".into(),
            data: json!({"n": user_id}).as_object().cloned(),
            ttl_seconds: 60,
        }
    }

    #[test]
    fn builds_the_service_bus_message_like_go() {
        let message = build_outgoing_message(PushRequest {
            user_id: 42,
            notification_type: "story_liked".into(),
            title: "Story liked".into(),
            body: "alice liked your story".into(),
            dedupe_key: "story:7".into(),
            deep_link: "/stories/7".into(),
            data: json!({"photo_id": 7}).as_object().cloned(),
            ttl_seconds: 120,
        })
        .unwrap();
        let body = PushMessage::from_json(&message.body).unwrap();
        assert_eq!(body.message_id, message.message_id);
        assert_eq!(body.user_id, 42);
        assert_eq!(body.tag, "story:7", "the dedupe key doubles as collapse tag");
        assert_eq!(body.deep_link, "/stories/7");
        assert_eq!(body.data, json!({"photo_id": 7}).as_object().cloned());
        assert_eq!(body.ttl_seconds, 120);
        assert!((Utc::now() - body.created_at).num_seconds() < 60);
        assert_eq!(message.subject, "story_liked");
        assert_eq!(message.time_to_live, Some(Duration::from_secs(120)));
        assert_eq!(
            message.application_properties,
            vec![
                ("user_id".to_string(), PropertyValue::UInt(42)),
                ("type".to_string(), PropertyValue::Text("story_liked".into())),
                ("dedupe_key".to_string(), PropertyValue::Text("story:7".into())),
            ]
        );
    }

    #[test]
    fn clears_unsafe_links_truncates_bodies_and_drops_oversized_data() {
        let mut req = request(1);
        req.deep_link = "https://evil.example/phish".into();
        req.body = "ü".repeat(250);
        let body = PushMessage::from_json(&build_outgoing_message(req).unwrap().body).unwrap();
        assert_eq!(body.deep_link, "");
        assert_eq!(body.body, format!("{}...", "ü".repeat(197)));

        let mut req = request(1);
        req.data = json!({"blob": "x".repeat(5000)}).as_object().cloned();
        let message = build_outgoing_message(req).unwrap();
        assert!(message.body.len() <= MAX_PUSH_PAYLOAD_BYTES);
        assert_eq!(PushMessage::from_json(&message.body).unwrap().data, None);
    }

    #[test]
    fn notification_data_adds_the_id() {
        let mut notif = Notification {
            id: 10,
            user_id: 3,
            notif_type: "like_received".into(),
            title: String::new(),
            body: String::new(),
            metadata: Some(json!({"liker_username": "alice"})),
            read_at: None,
            created_at: Utc::now(),
        };
        assert_eq!(Value::Object(notification_data(&notif)), json!({"liker_username": "alice", "notification_id": 10}));
        notif.metadata = None;
        assert_eq!(Value::Object(notification_data(&notif)), json!({"notification_id": 10}));
    }

    #[tokio::test]
    async fn unconfigured_publisher_is_a_no_op() {
        let mut cfg = Config::from_env();
        cfg.azure_service_bus.connection_string.clear();
        let p = PushPublisher::new(&cfg).unwrap();
        assert!(!p.is_available());
        assert_eq!(p.queue_stats(), (0, 0));
        assert!(p.publish_push_notification(request(1)).is_ok());
        p.close().await;

        cfg.azure_service_bus.connection_string = "not-a-connection-string".into();
        let err = PushPublisher::new(&cfg).unwrap_err();
        assert!(err.to_string().starts_with("failed to create Service Bus client"), "{err}");
    }

    #[tokio::test]
    async fn batches_flush_on_size_timer_and_close() {
        let recorder = Arc::new(Recorder::default());
        let p = PushPublisher::with_transport(recorder.clone(), 16, 2, Duration::from_secs(3600));
        for id in 1..=5 {
            p.publish_push_notification(request(id)).unwrap();
        }
        tokio::time::timeout(Duration::from_secs(5), async {
            while recorder.sent.lock().unwrap().len() < 4 {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("two full batches are sent without waiting for the timer");
        p.close().await;
        assert_eq!(recorder.sent.lock().unwrap().len(), 5, "closing flushes the remainder");
        assert!(!p.is_available());
        p.close().await;
        assert!(p.publish_push_notification(request(9)).is_ok(), "publishing after close is a no-op");
        assert_eq!(recorder.sent.lock().unwrap().len(), 5);

        let recorder = Arc::new(Recorder::default());
        let p = PushPublisher::with_transport(recorder.clone(), 16, 10, Duration::from_millis(20));
        p.publish_push_notification(request(1)).unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while recorder.sent.lock().unwrap().is_empty() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("a partial batch is flushed by the timer");
        p.close().await;
    }

    /// Blocks every send until released, so the queue fills up behind it.
    #[derive(Default)]
    struct Blocked {
        release: tokio::sync::Notify,
        sends: std::sync::atomic::AtomicUsize,
    }

    #[async_trait::async_trait]
    impl PushTransport for Blocked {
        async fn send(&self, _message: &OutgoingMessage) -> Result<(), ServiceBusError> {
            self.sends.fetch_add(1, Ordering::SeqCst);
            self.release.notified().await;
            Err(ServiceBusError::Status { status: 503, body: "busy".into() })
        }
    }

    #[tokio::test]
    async fn full_queue_is_reported_instead_of_blocking() {
        let transport = Arc::new(Blocked::default());
        let p = PushPublisher::with_transport(transport.clone(), 1, 1, Duration::from_secs(3600));
        p.publish_push_notification(request(1)).unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while transport.sends.load(Ordering::SeqCst) == 0 {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("the first message is being sent");
        p.publish_push_notification(request(2)).unwrap();
        assert_eq!(p.queue_stats(), (1, 1));
        let err = p.publish_push_notification(request(3)).unwrap_err();
        assert_eq!(err.to_string(), "push notification queue full");

        // Send failures are only logged; closing still drains the queue.
        transport.release.notify_waiters();
        let closing = tokio::spawn(async move {
            p.close().await;
        });
        while !closing.is_finished() {
            transport.release.notify_waiters();
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(transport.sends.load(Ordering::SeqCst), 2);
    }
}
