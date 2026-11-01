//! The follow-event pipeline of `FollowService` (port of the Pub/Sub half of
//! `internal/services/follow.go`): events are published on the Redis channel `follow_events` and
//! a background subscriber applies them to `follow_counters`. When Redis is down, publishing
//! fails or nobody is subscribed, counters are updated synchronously instead.

use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use futures::StreamExt;
use gt_core::gojson;
use gt_core::models::{
    FollowEvent, FOLLOW_EVENT_ACCEPTED, FOLLOW_EVENT_CREATED, FOLLOW_EVENT_DECLINED, FOLLOW_EVENT_REMOVED,
    FOLLOW_STATE_ACTIVE, FOLLOW_STATE_PENDING,
};
use gt_core::redis as gt_redis;
use redis::AsyncCommands;
use serde::Deserialize;
use tokio::task::JoinHandle;

use super::follow::{count_cache_key, FollowService};

const SUBSCRIBE_TIMEOUT: Duration = Duration::from_secs(5);
const RESUBSCRIBE_MIN_DELAY: Duration = Duration::from_millis(100);
const RESUBSCRIBE_MAX_DELAY: Duration = Duration::from_secs(5);

/// A follow event as Go's `json.Unmarshal` accepted it: missing or `null` fields keep their zero
/// value and unknown fields are ignored; ids must be non-negative integers and `timestamp`, when
/// present, an RFC 3339 string.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct IncomingEvent {
    #[serde(rename = "type")]
    event_type: Option<String>,
    follower_id: Option<u64>,
    followee_id: Option<u64>,
    state: Option<String>,
    timestamp: Option<String>,
}

/// A decoded follow event.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedEvent {
    event_type: String,
    follower_id: i64,
    followee_id: i64,
    state: String,
}

fn parse_event(payload: &str) -> Result<ParsedEvent, String> {
    // serde would also accept a JSON array for a struct; Go only accepts an object (or null).
    let raw: IncomingEvent = match serde_json::from_str::<serde_json::Value>(payload).map_err(|e| e.to_string())? {
        serde_json::Value::Null => IncomingEvent::default(),
        value @ serde_json::Value::Object(_) => serde_json::from_value(value).map_err(|e| e.to_string())?,
        other => {
            return Err(format!(
                "json: cannot unmarshal {} into Go value of type models.FollowEvent",
                json_kind(&other)
            ))
        }
    };
    if let Some(ts) = &raw.timestamp {
        DateTime::parse_from_rfc3339(ts).map_err(|e| format!("parsing time {ts:?}: {e}"))?;
    }
    let id = |v: Option<u64>| i64::try_from(v.unwrap_or(0)).map_err(|e| e.to_string());
    Ok(ParsedEvent {
        event_type: raw.event_type.unwrap_or_default(),
        follower_id: id(raw.follower_id)?,
        followee_id: id(raw.followee_id)?,
        state: raw.state.unwrap_or_default(),
    })
}

fn json_kind(value: &serde_json::Value) -> &'static str {
    match value {
        serde_json::Value::Null => "null",
        serde_json::Value::Bool(_) => "bool",
        serde_json::Value::Number(_) => "number",
        serde_json::Value::String(_) => "string",
        serde_json::Value::Array(_) => "array",
        serde_json::Value::Object(_) => "object",
    }
}

/// Counter changes implied by an event: `(follower Δfollowing, followee Δfollowers, followee
/// Δpending)`. `None` for events that do not touch counters.
fn subscriber_deltas(event_type: &str, state: &str) -> Option<(i64, i64, i64)> {
    match (event_type, state) {
        (FOLLOW_EVENT_CREATED, FOLLOW_STATE_ACTIVE) => Some((1, 1, 0)),
        (FOLLOW_EVENT_CREATED, FOLLOW_STATE_PENDING) => Some((0, 0, 1)),
        (FOLLOW_EVENT_ACCEPTED, _) => Some((1, 1, -1)),
        (FOLLOW_EVENT_REMOVED, _) => Some((-1, -1, 0)),
        (FOLLOW_EVENT_DECLINED, _) => Some((0, 0, -1)),
        _ => None,
    }
}

/// The synchronous fallback differs from the subscriber only for FOLLOW_CREATED: anything that
/// is not PENDING counts as a direct follow.
fn fallback_deltas(event_type: &str, state: &str) -> Option<(i64, i64, i64)> {
    match (event_type, state) {
        (FOLLOW_EVENT_CREATED, FOLLOW_STATE_PENDING) => Some((0, 0, 1)),
        (FOLLOW_EVENT_CREATED, _) => Some((1, 1, 0)),
        _ => subscriber_deltas(event_type, state),
    }
}

impl FollowService {
    /// Applies counter deltas in Go's statement order; individual failures are ignored, as in Go.
    async fn apply_deltas(&self, follower_id: i64, followee_id: i64, (following, followers, pending): (i64, i64, i64)) {
        if following != 0 {
            let _ = self.repo.increment_following_count(follower_id, following).await;
        }
        if followers != 0 {
            let _ = self.repo.increment_followers_count(followee_id, followers).await;
        }
        if pending != 0 {
            let _ = self.repo.increment_pending_requests_count(followee_id, pending).await;
        }
    }

    /// Updates counters directly (fallback when the event cannot go through Redis).
    async fn update_counters_synchronously(&self, event_type: &str, follower_id: i64, followee_id: i64, state: &str) {
        if let Some(deltas) = fallback_deltas(event_type, state) {
            self.apply_deltas(follower_id, followee_id, deltas).await;
        }
    }

    /// Publishes a follow event (`{"type","follower_id","followee_id","state","timestamp"}`, Go
    /// JSON) on the follow event channel for the counter subscriber. Falls back to updating the
    /// counters synchronously when Redis is unavailable, publishing fails or no subscriber
    /// received the event. (The follow operations themselves update counters transactionally;
    /// this is the asynchronous pipeline Go kept alongside.)
    pub async fn publish_follow_event(&self, event_type: &str, follower_id: i64, followee_id: i64, state: &str) {
        let Some(mut conn) = gt_redis::conn() else {
            self.update_counters_synchronously(event_type, follower_id, followee_id, state).await;
            return;
        };
        let event = FollowEvent {
            event_type: event_type.to_string(),
            follower_id,
            followee_id,
            state: state.to_string(),
            timestamp: Utc::now(),
        };
        let payload = match gojson::to_string(&event) {
            Ok(payload) => payload,
            Err(e) => {
                tracing::error!(event_type, error = %e, "Failed to marshal follow event");
                self.update_counters_synchronously(event_type, follower_id, followee_id, state).await;
                return;
            }
        };
        let published: Result<i64, _> = conn.publish(&self.event_channel, payload).await;
        match published {
            Err(e) => {
                tracing::error!(event_type, error = %e, "Failed to publish follow event");
                self.update_counters_synchronously(event_type, follower_id, followee_id, state).await;
            }
            Ok(0) => {
                // Nobody is listening (subscriber not started because Redis was down at startup,
                // or reconnecting), so the event would be lost.
                tracing::warn!(
                    event_type,
                    "No follow counter subscriber received the event, updating counters synchronously"
                );
                self.update_counters_synchronously(event_type, follower_id, followee_id, state).await;
            }
            Ok(_) => {}
        }
    }

    /// Processes one follow event payload from the channel: updates counters (unknown event
    /// types change nothing) and drops both users' cached counts. Malformed payloads are logged
    /// and ignored.
    pub async fn handle_follow_event(&self, payload: &str) {
        let event = match parse_event(payload) {
            Ok(event) => event,
            Err(error) => {
                tracing::error!(payload, error = %error, "Failed to unmarshal follow event");
                return;
            }
        };
        if let Some(deltas) = subscriber_deltas(&event.event_type, &event.state) {
            self.apply_deltas(event.follower_id, event.followee_id, deltas).await;
        }
        if let Some(mut conn) = gt_redis::conn() {
            let keys = [count_cache_key(event.follower_id), count_cache_key(event.followee_id)];
            let _: Result<(), _> = conn.del(&keys).await;
        }
        tracing::debug!(
            event_type = %event.event_type,
            follower_id = event.follower_id,
            followee_id = event.followee_id,
            "Follow event processed"
        );
    }

    /// Starts the background subscriber that applies follow events to `follow_counters`. Call
    /// once at startup. Like Go, it is not started when Redis is unavailable at that moment
    /// (publishers then fall back to synchronous updates). Once running it survives Redis
    /// outages: when the subscription drops it resubscribes with backoff. Abort the returned
    /// handle to stop it (Go: cancelling the context).
    pub fn start_follow_counter_subscriber(self: &Arc<Self>) -> Option<JoinHandle<()>> {
        if !gt_redis::is_available() {
            tracing::warn!("Redis not available, follow counter subscriber not started");
            return None;
        }
        let service = Arc::clone(self);
        Some(tokio::spawn(async move { service.run_counter_subscriber().await }))
    }

    async fn subscribe(&self) -> anyhow::Result<redis::aio::PubSub> {
        let handle = gt_redis::get().ok_or_else(|| anyhow::anyhow!("redis client not initialized"))?;
        let mut pubsub = tokio::time::timeout(SUBSCRIBE_TIMEOUT, handle.client.get_async_pubsub()).await??;
        tokio::time::timeout(SUBSCRIBE_TIMEOUT, pubsub.subscribe(&self.event_channel)).await??;
        Ok(pubsub)
    }

    async fn run_counter_subscriber(&self) {
        let mut delay = RESUBSCRIBE_MIN_DELAY;
        let mut started = false;
        loop {
            match self.subscribe().await {
                Ok(mut pubsub) => {
                    if started {
                        tracing::info!("Follow counter subscriber resubscribed");
                    } else {
                        tracing::info!("Follow counter subscriber started");
                        started = true;
                    }
                    delay = RESUBSCRIBE_MIN_DELAY;
                    let mut messages = pubsub.on_message();
                    while let Some(msg) = messages.next().await {
                        match msg.get_payload::<String>() {
                            Ok(payload) => self.handle_follow_event(&payload).await,
                            Err(e) => tracing::error!(error = %e, "Failed to unmarshal follow event"),
                        }
                    }
                    tracing::warn!("Follow counter subscription lost, resubscribing");
                }
                Err(e) => {
                    tracing::warn!(error = %e, retry_in_ms = delay.as_millis() as u64, "Follow counter subscribe failed")
                }
            }
            tokio::time::sleep(delay).await;
            delay = (delay * 2).min(RESUBSCRIBE_MAX_DELAY);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_events_like_encoding_json() {
        let ok = parse_event(
            r#"{"type":"FOLLOW_CREATED","follower_id":1,"followee_id":2,"state":"ACTIVE","timestamp":"2026-01-04T10:05:06.5Z","extra":1}"#,
        )
        .unwrap();
        assert_eq!(
            ok,
            ParsedEvent { event_type: "FOLLOW_CREATED".into(), follower_id: 1, followee_id: 2, state: "ACTIVE".into() }
        );
        let sparse = parse_event(r#"{"type":"FOLLOW_REMOVED","state":null}"#).unwrap();
        assert_eq!((sparse.follower_id, sparse.followee_id, sparse.state.as_str()), (0, 0, ""));
        assert!(parse_event("null").is_ok());
        assert!(parse_event("not json").is_err());
        assert!(parse_event(r#"{"follower_id":-1}"#).is_err());
        assert!(parse_event(r#"{"follower_id":1.5}"#).is_err());
        assert!(parse_event(r#"{"timestamp":"yesterday"}"#).is_err());
        assert!(parse_event("[]").is_err());
    }

    #[test]
    fn state_transitions_map_to_counter_deltas() {
        assert_eq!(subscriber_deltas(FOLLOW_EVENT_CREATED, FOLLOW_STATE_ACTIVE), Some((1, 1, 0)));
        assert_eq!(subscriber_deltas(FOLLOW_EVENT_CREATED, FOLLOW_STATE_PENDING), Some((0, 0, 1)));
        assert_eq!(subscriber_deltas(FOLLOW_EVENT_CREATED, "REMOVED"), None);
        assert_eq!(subscriber_deltas(FOLLOW_EVENT_ACCEPTED, FOLLOW_STATE_ACTIVE), Some((1, 1, -1)));
        assert_eq!(subscriber_deltas(FOLLOW_EVENT_REMOVED, "REMOVED"), Some((-1, -1, 0)));
        assert_eq!(subscriber_deltas(FOLLOW_EVENT_DECLINED, "REMOVED"), Some((0, 0, -1)));
        assert_eq!(subscriber_deltas("FOLLOW_UNKNOWN", FOLLOW_STATE_ACTIVE), None);

        assert_eq!(fallback_deltas(FOLLOW_EVENT_CREATED, "REMOVED"), Some((1, 1, 0)), "non-pending counts as a follow");
        assert_eq!(fallback_deltas(FOLLOW_EVENT_CREATED, FOLLOW_STATE_PENDING), Some((0, 0, 1)));
        assert_eq!(fallback_deltas(FOLLOW_EVENT_ACCEPTED, FOLLOW_STATE_ACTIVE), Some((1, 1, -1)));
    }

    #[test]
    fn published_payload_is_go_json() {
        let timestamp = DateTime::parse_from_rfc3339("2026-01-04T10:05:06.123Z").unwrap().with_timezone(&Utc);
        let event = FollowEvent {
            event_type: FOLLOW_EVENT_CREATED.into(),
            follower_id: 1,
            followee_id: 2,
            state: FOLLOW_STATE_ACTIVE.into(),
            timestamp,
        };
        // `timestamp` is Go's local-zone `time.Now()` (`...Z` on a UTC host such as production).
        assert_eq!(
            gojson::to_string(&event).unwrap(),
            format!(
                r#"{{"type":"FOLLOW_CREATED","follower_id":1,"followee_id":2,"state":"ACTIVE","timestamp":"{}"}}"#,
                gojson::format_go_time(&timestamp)
            )
        );
        assert!(gojson::format_go_time(&timestamp).contains(":06.123"));
    }
}
