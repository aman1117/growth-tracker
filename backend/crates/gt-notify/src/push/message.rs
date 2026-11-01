//! The push queue message (Go: `services.PushMessage`) shared by the API server (publisher) and
//! the push worker (consumer). Its JSON encoding is the contract between the two, so a Go worker
//! can consume messages published here and vice versa.

use std::sync::atomic::{AtomicI64, Ordering};

use chrono::{DateTime, Utc};
use gt_core::gojson;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};

use crate::json::null_default;

/// Web Push payloads are limited to 4 KB; larger messages lose their `data`.
pub const MAX_PUSH_PAYLOAD_BYTES: usize = 4096;
/// Bodies are truncated to this many characters.
pub const MAX_PUSH_BODY_CHARS: usize = 200;

/// A message on the push notification queue. Field order, names and `omitempty` rules follow the
/// Go struct; decoding follows `json.Unmarshal` (missing or `null` fields are zero values).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct PushMessage {
    #[serde(deserialize_with = "null_default")]
    pub message_id: String,
    /// Go `uint`: negative values are rejected when decoding.
    #[serde(deserialize_with = "go_uint")]
    pub user_id: i64,
    #[serde(deserialize_with = "null_default")]
    pub notification_type: String,
    #[serde(deserialize_with = "null_default")]
    pub title: String,
    #[serde(deserialize_with = "null_default")]
    pub body: String,
    #[serde(skip_serializing_if = "String::is_empty", deserialize_with = "null_default")]
    pub dedupe_key: String,
    #[serde(skip_serializing_if = "String::is_empty", deserialize_with = "null_default")]
    pub deep_link: String,
    /// Browser-side collapse tag (the dedupe key).
    #[serde(skip_serializing_if = "String::is_empty", deserialize_with = "null_default")]
    pub tag: String,
    #[serde(skip_serializing_if = "map_is_empty")]
    pub data: Option<Map<String, Value>>,
    #[serde(deserialize_with = "null_default")]
    pub ttl_seconds: i64,
    /// Go sets `time.Now().UTC()`, so it always marshals with `Z`.
    #[serde(serialize_with = "gojson::time_utc::serialize", deserialize_with = "go_time_or_zero")]
    pub created_at: DateTime<Utc>,
}

impl Default for PushMessage {
    fn default() -> Self {
        Self {
            message_id: String::new(),
            user_id: 0,
            notification_type: String::new(),
            title: String::new(),
            body: String::new(),
            dedupe_key: String::new(),
            deep_link: String::new(),
            tag: String::new(),
            data: None,
            ttl_seconds: 0,
            created_at: gojson::go_zero_time(),
        }
    }
}

impl PushMessage {
    /// Go `json.Marshal` encoding.
    pub fn to_json(&self) -> serde_json::Result<Vec<u8>> {
        gojson::to_vec(self)
    }

    /// Decodes a queue message body (Go `json.Unmarshal`).
    pub fn from_json(body: &[u8]) -> serde_json::Result<Self> {
        serde_json::from_slice(body)
    }
}

fn map_is_empty(data: &Option<Map<String, Value>>) -> bool {
    data.as_ref().is_none_or(Map::is_empty)
}

fn go_uint<'de, D: Deserializer<'de>>(deserializer: D) -> Result<i64, D::Error> {
    let value = Option::<u64>::deserialize(deserializer)?.unwrap_or(0);
    i64::try_from(value).map_err(|_| serde::de::Error::custom("number out of range"))
}

fn go_time_or_zero<'de, D: Deserializer<'de>>(deserializer: D) -> Result<DateTime<Utc>, D::Error> {
    match Option::<String>::deserialize(deserializer)? {
        None => Ok(gojson::go_zero_time()),
        Some(s) => DateTime::parse_from_rfc3339(&s)
            .map(|t| t.with_timezone(&Utc))
            .map_err(|e| serde::de::Error::custom(format!("parsing time {s:?}: {e}"))),
    }
}

static LAST_MESSAGE_NANOS: AtomicI64 = AtomicI64::new(0);

/// A message id like Go's `fmt.Sprintf("push-%d-%d", UnixNano, Nanosecond)`. The first number
/// is kept strictly increasing within the process so that two messages published within the
/// same clock tick (coarse clocks) never share an id.
pub fn generate_message_id() -> String {
    let now = Utc::now();
    let nanos = now.timestamp_nanos_opt().unwrap_or_default();
    let mut last = LAST_MESSAGE_NANOS.load(Ordering::Relaxed);
    let unique = loop {
        let candidate = nanos.max(last + 1);
        match LAST_MESSAGE_NANOS.compare_exchange_weak(last, candidate, Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => break candidate,
            Err(actual) => last = actual,
        }
    };
    format!("push-{unique}-{}", Utc::now().timestamp_subsec_nanos() % 1_000_000_000)
}

/// Deep links must be app-relative paths; absolute URLs could send users anywhere.
pub fn is_valid_deep_link(link: &str) -> bool {
    link.starts_with('/')
}

/// Keeps at most `max_len` characters, replacing the tail with `...` (never splits a character).
pub fn truncate_body(body: &str, max_len: usize) -> String {
    if body.chars().count() <= max_len {
        return body.to_string();
    }
    let mut out: String = body.chars().take(max_len.saturating_sub(3)).collect();
    out.push_str("...");
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use serde_json::json;

    fn sample() -> PushMessage {
        PushMessage {
            message_id: "push-1-2".into(),
            user_id: 42,
            notification_type: "story_liked".into(),
            title: "Story liked".into(),
            body: "alice <3 your story".into(),
            dedupe_key: "story:7".into(),
            deep_link: "/stories/7".into(),
            tag: "story:7".into(),
            data: json!({"photo_id": 7, "notification_id": 3}).as_object().cloned(),
            ttl_seconds: 120,
            created_at: Utc.with_ymd_and_hms(2026, 3, 9, 10, 0, 0).unwrap()
                + chrono::Duration::nanoseconds(123_456_789),
        }
    }

    #[test]
    fn encodes_exactly_like_the_go_struct() {
        assert_eq!(
            String::from_utf8(sample().to_json().unwrap()).unwrap(),
            r#"{"message_id":"push-1-2","user_id":42,"notification_type":"story_liked","title":"Story liked","body":"alice \u003c3 your story","dedupe_key":"story:7","deep_link":"/stories/7","tag":"story:7","data":{"notification_id":3,"photo_id":7},"ttl_seconds":120,"created_at":"2026-03-09T10:00:00.123456789Z"}"#
        );
        let minimal = PushMessage { message_id: "m".into(), data: Some(Map::new()), ..PushMessage::default() };
        assert_eq!(
            String::from_utf8(minimal.to_json().unwrap()).unwrap(),
            r#"{"message_id":"m","user_id":0,"notification_type":"","title":"","body":"","ttl_seconds":0,"created_at":"0001-01-01T00:00:00Z"}"#
        );
    }

    #[test]
    fn decodes_go_messages() {
        // As produced by the Go publisher (json.Marshal of services.PushMessage).
        let go = br#"{"message_id":"push-1767225600000000000-0","user_id":7,"notification_type":"like_received","title":"New Like!","body":"bob liked your 2 Jan, 2026 activities","dedupe_key":"like:7:2026-01-02","deep_link":"/?date=2026-01-02","tag":"like:7:2026-01-02","data":{"liked_date":"2026-01-02","liker_avatar":"","liker_id":2,"liker_username":"bob","notification_id":15},"ttl_seconds":3600,"created_at":"2026-01-01T00:00:00.123Z"}"#;
        let msg = PushMessage::from_json(go).unwrap();
        assert_eq!(msg.user_id, 7);
        assert_eq!(msg.ttl_seconds, 3600);
        assert_eq!(msg.data.as_ref().unwrap()["notification_id"], json!(15));
        assert_eq!(msg.to_json().unwrap(), go.to_vec(), "re-encoding is byte-identical");

        let round = sample();
        assert_eq!(PushMessage::from_json(&round.to_json().unwrap()).unwrap(), round);

        let sparse = PushMessage::from_json(br#"{"user_id":3,"title":null,"data":null}"#).unwrap();
        assert_eq!(sparse.user_id, 3);
        assert_eq!(sparse.title, "");
        assert_eq!(sparse.created_at, gojson::go_zero_time());
        assert!(PushMessage::from_json(br#"{"user_id":-1}"#).is_err(), "Go cannot decode a negative uint");
        assert!(PushMessage::from_json(b"not json").is_err());
    }

    #[test]
    fn helpers() {
        let id = generate_message_id();
        assert!(id.starts_with("push-"));
        let parts: Vec<&str> = id["push-".len()..].split('-').collect();
        assert_eq!(parts.len(), 2);
        assert!(parts.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit())));
        assert_ne!(generate_message_id(), generate_message_id());

        assert!(is_valid_deep_link("/profile/alice"));
        assert!(!is_valid_deep_link("https://example.com/profile"));
        assert!(!is_valid_deep_link("javascript:alert(1)"));

        assert_eq!(truncate_body("short", 10), "short");
        assert_eq!(truncate_body("exactly10!", 10), "exactly10!");
        assert_eq!(truncate_body("abcdefghijk", 10), "abcdefg...");
        assert_eq!(truncate_body(&"ü".repeat(10), 10), "ü".repeat(10));
        assert_eq!(truncate_body("日本語のテキストです。", 10), "日本語のテキス...");
        assert_eq!(truncate_body(&"🔥".repeat(11), 10), format!("{}...", "🔥".repeat(7)));
        assert_eq!(truncate_body(&"a".repeat(250), MAX_PUSH_BODY_CHARS), format!("{}...", "a".repeat(197)));
    }
}
