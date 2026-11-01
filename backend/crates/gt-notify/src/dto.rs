//! Request and response bodies of the notification and push endpoints (port of the
//! notification/push parts of `internal/dto`). Field order and `omitempty` follow the Go structs.

use std::collections::BTreeMap;

use gt_core::models::{Notification, PushPreference};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

use crate::json::null_default;

// ==================== Responses ====================

/// A notification in API responses (Go: `dto.NotificationDTO`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct NotificationDto {
    pub id: i64,
    #[serde(rename = "type")]
    pub notif_type: String,
    pub title: String,
    pub body: String,
    /// Omitted when absent or empty (Go map `omitempty`).
    #[serde(skip_serializing_if = "metadata_is_empty")]
    pub metadata: Option<Value>,
    /// `YYYY-MM-DDTHH:MM:SSZ`; omitted while unread.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_at: Option<String>,
    pub created_at: String,
}

fn metadata_is_empty(metadata: &Option<Value>) -> bool {
    match metadata {
        None | Some(Value::Null) => true,
        Some(Value::Object(map)) => map.is_empty(),
        Some(_) => false,
    }
}

/// Go `Format("2006-01-02T15:04:05Z")` on a database time: the wall clock in the process time
/// zone, whole seconds, then a literal `Z` (so it is only UTC when the server runs in UTC).
fn format_dto_time(t: &chrono::DateTime<chrono::Utc>) -> String {
    gt_core::gojson::format_local_literal_z(t)
}

impl From<&Notification> for NotificationDto {
    fn from(n: &Notification) -> Self {
        Self {
            id: n.id,
            notif_type: n.notif_type.clone(),
            title: n.title.clone(),
            body: n.body.clone(),
            metadata: n.metadata.clone(),
            read_at: n.read_at.as_ref().map(format_dto_time),
            created_at: format_dto_time(&n.created_at),
        }
    }
}

/// Go `dto.NotificationsToDTOs`: always a (possibly empty) array, never `null`.
pub fn notifications_to_dtos(notifications: &[Notification]) -> Vec<NotificationDto> {
    notifications.iter().map(NotificationDto::from).collect()
}

/// `GET /api/notifications` (Go: `dto.NotificationsResponse`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct NotificationsResponse {
    pub success: bool,
    pub notifications: Vec<NotificationDto>,
    pub total: i64,
    pub page: i64,
    pub page_size: i64,
    pub has_more: bool,
}

/// `GET /api/notifications/unread-count` (Go: `dto.UnreadCountResponse`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UnreadCountResponse {
    pub success: bool,
    pub unread_count: i64,
}

/// `GET /api/push/vapid-public-key` (Go: `dto.VapidPublicKeyResponse`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct VapidPublicKeyResponse {
    pub success: bool,
    #[serde(rename = "keyId")]
    pub key_id: String,
    #[serde(rename = "publicKey")]
    pub public_key: String,
}

/// `POST /api/push/subscriptions` (Go: `dto.PushSubscriptionResponse`; `message` is never omitted).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PushSubscriptionResponse {
    pub success: bool,
    pub message: String,
}

/// Push preferences in API responses (Go: `dto.PushPreferenceDTO`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PushPreferenceDto {
    pub push_enabled: bool,
    /// Always an object (`{}` when nothing is set).
    pub preferences: BTreeMap<String, bool>,
    pub quiet_hours_enabled: bool,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub quiet_start: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub quiet_end: String,
    pub timezone: String,
}

impl From<&PushPreference> for PushPreferenceDto {
    fn from(p: &PushPreference) -> Self {
        Self {
            push_enabled: p.push_enabled,
            preferences: p.preferences.clone().unwrap_or_default(),
            quiet_hours_enabled: p.quiet_hours_enabled,
            quiet_start: p.quiet_start.clone(),
            quiet_end: p.quiet_end.clone(),
            timezone: p.timezone.clone(),
        }
    }
}

/// `GET`/`PUT /api/push/preferences` (Go: `dto.PushPreferencesResponse`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PushPreferencesResponse {
    pub success: bool,
    pub preferences: PushPreferenceDto,
}

/// `POST /api/push/cleanup`. The Go handler answers with a `fiber.Map`, so the keys are sorted
/// alphabetically (unlike `dto.CleanupResponse`, which it does not use).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CleanupResponse {
    pub gone_subscriptions_deleted: i64,
    pub old_logs_deleted: i64,
    pub stale_subscriptions_cleaned: i64,
    pub success: bool,
}

// ==================== Requests ====================
//
// Go's `json.Unmarshal` treats `null` as "leave the zero value", so every field accepts it.

/// Encryption keys of a browser subscription (Go: `dto.PushSubscriptionKeys`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct PushSubscriptionKeys {
    #[serde(deserialize_with = "null_default")]
    pub p256dh: String,
    #[serde(deserialize_with = "null_default")]
    pub auth: String,
}

/// The browser's `PushSubscription` (Go: `dto.PushSubscriptionData`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct PushSubscriptionData {
    #[serde(deserialize_with = "null_default")]
    pub endpoint: String,
    #[serde(deserialize_with = "null_default")]
    pub keys: PushSubscriptionKeys,
}

/// Device metadata (Go: `dto.PushDeviceInfo`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct PushDeviceInfo {
    #[serde(rename = "userAgent", deserialize_with = "null_default")]
    pub user_agent: String,
    #[serde(deserialize_with = "null_default")]
    pub platform: String,
    #[serde(deserialize_with = "null_default")]
    pub browser: String,
}

/// `POST /api/push/subscriptions` (Go: `dto.RegisterPushSubscriptionRequest`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct RegisterPushSubscriptionRequest {
    #[serde(rename = "keyId", deserialize_with = "null_default")]
    pub key_id: String,
    #[serde(deserialize_with = "null_default")]
    pub subscription: PushSubscriptionData,
    #[serde(deserialize_with = "null_default")]
    pub device: PushDeviceInfo,
}

/// `DELETE /api/push/subscriptions` (Go: `dto.UnregisterPushSubscriptionRequest`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct UnregisterPushSubscriptionRequest {
    #[serde(deserialize_with = "null_default")]
    pub endpoint: String,
}

/// `PUT /api/push/preferences` (Go: `dto.UpdatePushPreferencesRequest`): absent or `null`
/// fields are left unchanged.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct UpdatePushPreferencesRequest {
    pub push_enabled: Option<bool>,
    /// Per-type toggles; a `null` toggle is `false` (Go decodes `null` into a map entry as the
    /// zero value).
    #[serde(deserialize_with = "nullable_bool_map")]
    pub preferences: Option<BTreeMap<String, bool>>,
    pub quiet_hours_enabled: Option<bool>,
    pub quiet_start: Option<String>,
    pub quiet_end: Option<String>,
    pub timezone: Option<String>,
}

fn nullable_bool_map<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<BTreeMap<String, bool>>, D::Error> {
    let map = Option::<BTreeMap<String, Option<bool>>>::deserialize(deserializer)?;
    Ok(map.map(|m| m.into_iter().map(|(k, v)| (k, v.unwrap_or(false))).collect()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{TimeZone, Utc};
    use gt_core::gojson;
    use serde_json::json;

    fn notification(metadata: Option<Value>, read: bool) -> Notification {
        Notification {
            id: 11,
            user_id: 3,
            notif_type: "like_received".into(),
            title: "New like".into(),
            body: "bob liked your day".into(),
            metadata,
            read_at: read
                .then(|| Utc.with_ymd_and_hms(2026, 1, 5, 12, 30, 0).unwrap() + chrono::Duration::milliseconds(250)),
            created_at: Utc.with_ymd_and_hms(2026, 1, 5, 10, 0, 0).unwrap() + chrono::Duration::microseconds(5),
        }
    }

    /// Local wall clock of a UTC instant, as Go prints it with the literal `Z` layout.
    fn local_z(h: u32, m: u32) -> String {
        let t = Utc.with_ymd_and_hms(2026, 1, 5, h, m, 0).unwrap();
        format!("{}Z", gojson::to_go_local(&t).format("%Y-%m-%dT%H:%M:%S"))
    }

    #[test]
    fn notification_dtos_match_go() {
        let unread = NotificationDto::from(&notification(Some(json!({"liker_id": 7})), false));
        assert_eq!(
            gojson::to_string(&unread).unwrap(),
            format!(
                r#"{{"id":11,"type":"like_received","title":"New like","body":"bob liked your day","metadata":{{"liker_id":7}},"created_at":"{}"}}"#,
                local_z(10, 0)
            )
        );
        let read = NotificationDto::from(&notification(Some(json!({})), true));
        assert_eq!(
            gojson::to_string(&read).unwrap(),
            format!(
                r#"{{"id":11,"type":"like_received","title":"New like","body":"bob liked your day","read_at":"{}","created_at":"{}"}}"#,
                local_z(12, 30),
                local_z(10, 0)
            )
        );
        assert_eq!(gojson::to_string(&notifications_to_dtos(&[])).unwrap(), "[]");
    }

    #[test]
    fn preference_and_cleanup_bodies_match_go() {
        let mut pref = PushPreference::default_for(1);
        pref.preferences = None;
        assert_eq!(
            gojson::to_string(&PushPreferencesResponse { success: true, preferences: (&pref).into() }).unwrap(),
            r#"{"success":true,"preferences":{"push_enabled":true,"preferences":{},"quiet_hours_enabled":false,"timezone":"Asia/Kolkata"}}"#
        );
        let cleanup = CleanupResponse {
            gone_subscriptions_deleted: 1,
            old_logs_deleted: 2,
            stale_subscriptions_cleaned: 3,
            success: true,
        };
        assert_eq!(
            gojson::to_string(&cleanup).unwrap(),
            r#"{"gone_subscriptions_deleted":1,"old_logs_deleted":2,"stale_subscriptions_cleaned":3,"success":true}"#
        );
    }

    #[test]
    fn requests_accept_null_like_go() {
        let req: RegisterPushSubscriptionRequest =
            serde_json::from_str(r#"{"keyId":null,"subscription":null,"device":{"userAgent":null}}"#).unwrap();
        assert_eq!(req, RegisterPushSubscriptionRequest::default());
        let req: UpdatePushPreferencesRequest =
            serde_json::from_str(r#"{"push_enabled":null,"preferences":{"like_received":null,"badge_unlocked":true}}"#)
                .unwrap();
        assert_eq!(req.push_enabled, None);
        assert_eq!(
            req.preferences.unwrap(),
            BTreeMap::from([("badge_unlocked".into(), true), ("like_received".into(), false)])
        );
        assert!(serde_json::from_str::<UpdatePushPreferencesRequest>(r#"{"push_enabled":"yes"}"#).is_err());
    }
}
