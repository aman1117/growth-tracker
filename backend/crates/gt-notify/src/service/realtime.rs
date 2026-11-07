//! Real-time delivery: Redis Pub/Sub fan-out, the pending queue and WebSocket connection
//! tracking (Go: the "Redis Pub/Sub Operations" and "WebSocket Connection Tracking" sections).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use futures::StreamExt;
use gt_core::constants as c;
use gt_core::gojson;
use gt_core::models::Notification;
use redis::AsyncCommands;
use serde::{Deserialize, Deserializer};
use serde_json::{Map, Value};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use super::{NotificationError, NotificationService};
use crate::json::null_default;

/// Buffered messages per subscription (go-redis `PubSub.Channel` buffers 100).
const SUBSCRIPTION_BUFFER: usize = 100;
const RESUBSCRIBE_MIN_DELAY: Duration = Duration::from_millis(100);
const RESUBSCRIBE_MAX_DELAY: Duration = Duration::from_secs(5);

fn channel_name(user_id: i64) -> String {
    format!("{}{user_id}", c::NOTIF_CHANNEL_PREFIX)
}

fn pending_key(user_id: i64) -> String {
    format!("{}{user_id}", c::NOTIF_PENDING_PREFIX)
}

fn ws_conn_key(user_id: i64) -> String {
    format!("{}{user_id}", c::NOTIF_WS_CONN_PREFIX)
}

fn events_channel_name(user_id: i64) -> String {
    format!("{}{user_id}", c::NOTIF_EVENTS_PREFIX)
}

/// The channel a published payload arrived on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PublishedKind {
    /// `notif:channel:<user_id>`: the JSON of a stored notification.
    Notification,
    /// `notif:events:<user_id>`: a complete WebSocket message (`{"type":..,"payload":..}`).
    Event,
}

/// One payload received by a [`NotificationSubscription`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Published {
    pub kind: PublishedKind,
    pub payload: Vec<u8>,
}

impl NotificationService {
    /// Publishes the notification (its Go JSON encoding) on `notif:channel:<user_id>`; when
    /// publishing fails it is queued on `notif:pending:<user_id>` for the next WebSocket
    /// connection. A no-op without Redis (Go: `publishNotification`).
    pub async fn publish_notification(&self, notif: &Notification) {
        let Some(mut conn) = gt_core::redis::conn() else { return };
        let payload = match gojson::to_vec(notif) {
            Ok(payload) => payload,
            Err(err) => {
                tracing::warn!(notif_id = notif.id, error = %err, "Failed to marshal notification for pub/sub");
                return;
            }
        };
        if let Err(err) = conn.publish::<_, _, i64>(channel_name(notif.user_id), &payload).await {
            tracing::warn!(user_id = notif.user_id, notif_id = notif.id, error = %err, "Pub/sub failed, queueing notification");
            self.queue_pending_notification(notif.user_id, &payload).await;
        }
    }

    /// Pushes a payload on the user's pending queue (`LPUSH` + 24 h `EXPIRE`).
    async fn queue_pending_notification(&self, user_id: i64, payload: &[u8]) {
        let Some(mut conn) = gt_core::redis::conn() else { return };
        let key = pending_key(user_id);
        let result: Result<(), _> = redis::pipe()
            .lpush(&key, payload)
            .ignore()
            .expire(&key, c::NOTIF_PENDING_TTL.as_secs() as i64)
            .ignore()
            .query_async(&mut conn)
            .await;
        if let Err(err) = result {
            tracing::error!(user_id, error = %err, "Failed to queue pending notification");
        }
    }

    /// Drains the user's pending queue, oldest first, skipping entries that are not
    /// notifications. Empty without Redis (Go: `GetPendingNotifications`).
    pub async fn get_pending_notifications(&self, user_id: i64) -> Vec<Notification> {
        let mut notifications = Vec::new();
        let Some(mut conn) = gt_core::redis::conn() else { return notifications };
        let key = pending_key(user_id);
        loop {
            let payload: Option<Vec<u8>> = match conn.rpop(&key, None).await {
                Ok(payload) => payload,
                Err(err) => {
                    tracing::error!(user_id, error = %err, "Failed to pop pending notification");
                    break;
                }
            };
            let Some(payload) = payload else { break };
            match decode_notification(&payload) {
                Ok(notif) => notifications.push(notif),
                Err(err) => tracing::warn!(user_id, error = %err, "Failed to unmarshal pending notification"),
            }
        }
        notifications
    }

    /// Subscribes to the user's notification channel; `None` without Redis (Go:
    /// `SubscribeToNotifications`). Like go-redis, the subscription reconnects by itself when
    /// the Redis connection drops.
    pub fn subscribe_to_notifications(&self, user_id: i64) -> Option<NotificationSubscription> {
        let handle = gt_core::redis::get()?;
        Some(NotificationSubscription::start(
            handle.client.clone(),
            vec![(channel_name(user_id), PublishedKind::Notification)],
        ))
    }

    /// Subscribes to both the user's notification channel and their event channel (what a
    /// WebSocket connection forwards); `None` without Redis.
    pub fn subscribe_to_realtime(&self, user_id: i64) -> Option<NotificationSubscription> {
        let handle = gt_core::redis::get()?;
        Some(NotificationSubscription::start(
            handle.client.clone(),
            vec![
                (channel_name(user_id), PublishedKind::Notification),
                (events_channel_name(user_id), PublishedKind::Event),
            ],
        ))
    }

    /// Publishes a complete WebSocket message on `notif:events:<user_id>`, delivered to every
    /// connection of the user on any instance. Events are best-effort and never queued: `false`
    /// without Redis or when publishing fails, so the caller can fall back to local delivery.
    pub async fn publish_user_event(&self, user_id: i64, message: &str) -> bool {
        let Some(mut conn) = gt_core::redis::conn() else { return false };
        match conn.publish::<_, _, i64>(events_channel_name(user_id), message).await {
            Ok(_) => true,
            Err(err) => {
                tracing::warn!(user_id, error = %err, "Failed to publish realtime event; delivering locally only");
                false
            }
        }
    }

    // ==================== WebSocket connection tracking ====================

    /// Registers a WebSocket connection in `notif:ws:conn:<user_id>` (45 s TTL). `Ok(false)`
    /// when the user already has the maximum number of connections; always allowed without
    /// Redis (Go: `TrackWSConnection`).
    pub async fn track_ws_connection(&self, user_id: i64, conn_id: &str) -> Result<bool, NotificationError> {
        let Some(mut conn) = gt_core::redis::conn() else { return Ok(true) };
        let key = ws_conn_key(user_id);
        let count: i64 =
            conn.scard(&key).await.map_err(NotificationError::redis("failed to check connection count"))?;
        if count >= c::WS_MAX_CONNS_PER_USER as i64 {
            return Ok(false);
        }
        redis::pipe()
            .sadd(&key, conn_id)
            .ignore()
            .expire(&key, c::NOTIF_WS_CONN_TTL.as_secs() as i64)
            .ignore()
            .query_async::<()>(&mut conn)
            .await
            .map_err(NotificationError::redis("failed to track connection"))?;
        Ok(true)
    }

    /// Removes a WebSocket connection from the tracking set (Go: `RemoveWSConnection`).
    pub async fn remove_ws_connection(&self, user_id: i64, conn_id: &str) {
        let Some(mut conn) = gt_core::redis::conn() else { return };
        let _: Result<(), _> = conn.srem(ws_conn_key(user_id), conn_id).await;
    }

    /// Extends the tracking TTL; called on every heartbeat (Go: `RefreshWSConnection`).
    pub async fn refresh_ws_connection(&self, user_id: i64) {
        let Some(mut conn) = gt_core::redis::conn() else { return };
        let _: Result<(), _> = conn.expire(ws_conn_key(user_id), c::NOTIF_WS_CONN_TTL.as_secs() as i64).await;
    }

    /// Number of tracked WebSocket connections of the user; 0 without Redis (Go:
    /// `GetWSConnectionCount`).
    pub async fn get_ws_connection_count(&self, user_id: i64) -> Result<i64, NotificationError> {
        let Some(mut conn) = gt_core::redis::conn() else { return Ok(0) };
        conn.scard(ws_conn_key(user_id)).await.map_err(NotificationError::redis("failed to get connection count"))
    }
}

/// A live subscription to one user's realtime channels. Messages are the raw payloads
/// published on them (the Go JSON of a notification, or a complete WebSocket message for
/// events). Dropping it unsubscribes.
pub struct NotificationSubscription {
    rx: mpsc::Receiver<Published>,
    subscribed: Arc<AtomicBool>,
    task: JoinHandle<()>,
}

impl NotificationSubscription {
    fn start(client: redis::Client, channels: Vec<(String, PublishedKind)>) -> Self {
        let (tx, rx) = mpsc::channel(SUBSCRIPTION_BUFFER);
        let subscribed = Arc::new(AtomicBool::new(false));
        let task = tokio::spawn(run_subscription(client, channels, tx, subscribed.clone()));
        Self { rx, subscribed, task }
    }

    /// The next published payload; `None` once the subscription has ended.
    pub async fn recv(&mut self) -> Option<Vec<u8>> {
        self.rx.recv().await.map(|published| published.payload)
    }

    /// The next published payload with the channel it arrived on.
    pub async fn recv_published(&mut self) -> Option<Published> {
        self.rx.recv().await
    }

    /// Whether the `SUBSCRIBE` is currently active (messages published before that are lost,
    /// as with any Redis subscription).
    pub fn is_subscribed(&self) -> bool {
        self.subscribed.load(Ordering::Acquire)
    }
}

impl Drop for NotificationSubscription {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn run_subscription(
    client: redis::Client,
    channels: Vec<(String, PublishedKind)>,
    tx: mpsc::Sender<Published>,
    subscribed: Arc<AtomicBool>,
) {
    let names: Vec<&str> = channels.iter().map(|(name, _)| name.as_str()).collect();
    let channel = names.join(",");
    let kind_of =
        |name: &str| channels.iter().find(|(n, _)| n == name).map_or(PublishedKind::Notification, |(_, kind)| *kind);
    let mut delay = RESUBSCRIBE_MIN_DELAY;
    loop {
        match client.get_async_pubsub().await {
            Ok(mut pubsub) => match pubsub.subscribe(&names).await {
                Ok(()) => {
                    subscribed.store(true, Ordering::Release);
                    delay = RESUBSCRIBE_MIN_DELAY;
                    let mut messages = pubsub.on_message();
                    while let Some(msg) = messages.next().await {
                        let published = Published {
                            kind: kind_of(msg.get_channel_name()),
                            payload: msg.get_payload_bytes().to_vec(),
                        };
                        if tx.send(published).await.is_err() {
                            return;
                        }
                    }
                    subscribed.store(false, Ordering::Release);
                    tracing::warn!(channel = %channel, "Notification subscription lost, resubscribing");
                }
                Err(err) => tracing::warn!(channel = %channel, error = %err, "Failed to subscribe to notifications"),
            },
            Err(err) => tracing::warn!(channel = %channel, error = %err, "Failed to open Redis pub/sub connection"),
        }
        if tx.is_closed() {
            return;
        }
        tokio::time::sleep(delay).await;
        delay = (delay * 2).min(RESUBSCRIBE_MAX_DELAY);
    }
}

// ==================== Decoding (Go `json.Unmarshal` into `models.Notification`) ====================

#[derive(Default, Deserialize)]
#[serde(default)]
struct NotificationWire {
    #[serde(deserialize_with = "null_default")]
    id: u64,
    #[serde(deserialize_with = "null_default")]
    user_id: u64,
    #[serde(rename = "type", deserialize_with = "null_default")]
    notif_type: String,
    #[serde(deserialize_with = "null_default")]
    title: String,
    #[serde(deserialize_with = "null_default")]
    body: String,
    metadata: Option<Map<String, Value>>,
    #[serde(deserialize_with = "go_time_opt")]
    read_at: Option<DateTime<Utc>>,
    #[serde(deserialize_with = "go_time_opt")]
    created_at: Option<DateTime<Utc>>,
}

fn go_time_opt<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<DateTime<Utc>>, D::Error> {
    match Option::<String>::deserialize(deserializer)? {
        None => Ok(None),
        Some(s) => DateTime::parse_from_rfc3339(&s)
            .map(|t| Some(t.with_timezone(&Utc)))
            .map_err(|e| serde::de::Error::custom(format!("parsing time {s:?}: {e}"))),
    }
}

/// Decodes a notification published on a notification channel (Go JSON of
/// `models.Notification`) with `json.Unmarshal` semantics: missing or `null` fields are zero
/// values, `metadata` must be an object or `null`.
pub fn decode_notification(payload: &[u8]) -> Result<Notification, serde_json::Error> {
    let wire: NotificationWire = serde_json::from_slice(payload)?;
    let to_i64 = |v: u64| i64::try_from(v).map_err(|_| serde::de::Error::custom("number out of range"));
    Ok(Notification {
        id: to_i64(wire.id)?,
        user_id: to_i64(wire.user_id)?,
        notif_type: wire.notif_type,
        title: wire.title,
        body: wire.body,
        metadata: wire.metadata.map(Value::Object),
        read_at: wire.read_at,
        created_at: wire.created_at.unwrap_or_else(gojson::go_zero_time),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn decodes_published_notifications() {
        let n = decode_notification(
            br#"{"id":11,"user_id":3,"type":"like_received","title":"t","body":"b","metadata":{"liker_id":7},"read_at":null,"created_at":"2026-01-05T10:00:00.5Z"}"#,
        )
        .unwrap();
        assert_eq!(n.id, 11);
        assert_eq!(n.metadata, Some(serde_json::json!({"liker_id": 7})));
        assert_eq!(n.read_at, None);
        assert_eq!(
            n.created_at,
            Utc.with_ymd_and_hms(2026, 1, 5, 10, 0, 0).unwrap() + chrono::Duration::milliseconds(500)
        );

        let partial = decode_notification(br#"{"id":99,"title":"raw"}"#).unwrap();
        assert_eq!(partial.created_at, gojson::go_zero_time());
        assert_eq!(partial.metadata, None);

        assert!(decode_notification(b"{not json").is_err());
        assert!(decode_notification(br#"{"metadata":[1]}"#).is_err());
        assert!(decode_notification(br#"{"id":-1}"#).is_err());
    }

    #[test]
    fn round_trips_the_published_encoding() {
        let n = Notification {
            id: 5,
            user_id: 9,
            notif_type: "badge_unlocked".into(),
            title: "Hi <b>".into(),
            body: String::new(),
            metadata: Some(serde_json::json!({"b": 1, "a": "x"})),
            read_at: Some(Utc.with_ymd_and_hms(2026, 1, 5, 12, 30, 0).unwrap()),
            created_at: Utc.with_ymd_and_hms(2026, 1, 5, 10, 0, 0).unwrap(),
        };
        let json = gojson::to_string(&n).unwrap();
        // Database times marshal in the process time zone (`Z` in production, `+05:30` on IST hosts).
        assert_eq!(
            json,
            format!(
                r#"{{"id":5,"user_id":9,"type":"badge_unlocked","title":"Hi \u003cb\u003e","body":"","metadata":{{"a":"x","b":1}},"read_at":"{}","created_at":"{}"}}"#,
                gojson::format_go_time(&n.read_at.unwrap()),
                gojson::format_go_time(&n.created_at)
            )
        );
        assert_eq!(decode_notification(json.as_bytes()).unwrap(), n);
    }

    #[test]
    fn decodes_times_in_any_offset() {
        let ist = decode_notification(br#"{"id":1,"created_at":"2026-01-05T15:30:00+05:30"}"#).unwrap();
        assert_eq!(ist.created_at, Utc.with_ymd_and_hms(2026, 1, 5, 10, 0, 0).unwrap());
    }
}
