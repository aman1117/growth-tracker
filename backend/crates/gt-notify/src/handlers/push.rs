//! `/api/push` handlers (Go: `handlers.PushHandler`).

use axum::extract::State;
use axum::http::HeaderMap;
use gt_core::body::JsonBody;
use gt_core::constants as c;
use gt_core::extract::{AuthUser, MaybeAuthUser};
use gt_core::models::{PushPreference, PUSH_SUBSCRIPTION_STATUS_ACTIVE};
use gt_core::{response, ApiError, ApiResult};

use super::NotifyState;
use crate::dto::{
    CleanupResponse, PushPreferenceDto, PushPreferencesResponse, PushSubscriptionResponse,
    RegisterPushSubscriptionRequest, UnregisterPushSubscriptionRequest, UpdatePushPreferencesRequest,
    VapidPublicKeyResponse,
};
use crate::repository::{NewPushSubscription, UpsertSubscriptionError};

/// Maximum subscription endpoint length (bytes).
pub const MAX_ENDPOINT_LENGTH: usize = 2048;
/// Maximum stored user agent length (characters).
pub const MAX_USER_AGENT_LENGTH: usize = 500;
/// Maximum stored platform length (characters).
pub const MAX_PLATFORM_LENGTH: usize = 50;
/// Maximum stored browser length (characters).
pub const MAX_BROWSER_LENGTH: usize = 50;
/// Header carrying `MAINTENANCE_API_KEY` for maintenance endpoints.
pub const MAINTENANCE_KEY_HEADER: &str = "X-Maintenance-Key";

/// Notification types whose push toggles can be changed.
const VALID_PREFERENCE_TYPES: [&str; 5] =
    ["like_received", "badge_unlocked", "streak_milestone", "streak_at_risk", "system_announcement"];

fn invalid_input(message: impl Into<String>) -> ApiError {
    ApiError::bad_request(message, c::ERR_CODE_INVALID_INPUT)
}

fn invalid_body(err: impl std::fmt::Display, user_id: i64) -> ApiError {
    tracing::warn!(user_id, error = %err, "Invalid request body");
    invalid_input("Invalid request body")
}

/// `GET /api/push/vapid-public-key` (public).
pub(crate) async fn get_vapid_public_key(State(s): State<NotifyState>) -> ApiResult {
    let web_push = &s.config.web_push;
    if web_push.vapid_public_key.is_empty() {
        tracing::error!("VAPID public key not configured");
        return Err(ApiError::internal("Push notifications not configured", c::ERR_CODE_CONFIG_ERROR));
    }
    Ok(response::json(&VapidPublicKeyResponse {
        success: true,
        key_id: web_push.vapid_key_id.clone(),
        public_key: web_push.vapid_public_key.clone(),
    }))
}

/// `POST /api/push/subscriptions`: registers (or refreshes) the device's subscription and makes
/// sure the user has preferences.
pub(crate) async fn register_subscription(
    State(s): State<NotifyState>,
    user: AuthUser,
    JsonBody(body): JsonBody<RegisterPushSubscriptionRequest>,
) -> ApiResult {
    let user_id = user.user_id;
    let req = body.map_err(|e| invalid_body(e, user_id))?;
    let endpoint = &req.subscription.endpoint;
    if endpoint.is_empty() {
        return Err(invalid_input("Endpoint is required"));
    }
    if req.subscription.keys.p256dh.is_empty() || req.subscription.keys.auth.is_empty() {
        return Err(invalid_input("Keys (p256dh and auth) are required"));
    }
    if endpoint.len() > MAX_ENDPOINT_LENGTH {
        return Err(invalid_input("Endpoint too long"));
    }
    if !is_valid_push_endpoint(endpoint) {
        return Err(invalid_input("Invalid push endpoint URL"));
    }
    let key_id = &s.config.web_push.vapid_key_id;
    if !req.key_id.is_empty() && &req.key_id != key_id {
        // Allowed: the subscription is stored with the current key id.
        tracing::warn!(user_id, provided = %req.key_id, expected = %key_id, "VAPID key ID mismatch");
    }
    tracing::info!(
        user_id,
        endpoint_origin = %extract_origin(endpoint),
        platform = %req.device.platform,
        browser = %req.device.browser,
        "Registering push subscription"
    );

    let sub = NewPushSubscription {
        user_id,
        endpoint: endpoint.clone(),
        p256dh: req.subscription.keys.p256dh.clone(),
        auth: req.subscription.keys.auth.clone(),
        vapid_key_id: key_id.clone(),
        status: PUSH_SUBSCRIPTION_STATUS_ACTIVE.into(),
        failure_count: 0,
        user_agent: truncate_chars(&req.device.user_agent, MAX_USER_AGENT_LENGTH),
        platform: truncate_chars(&req.device.platform, MAX_PLATFORM_LENGTH),
        browser: truncate_chars(&req.device.browser, MAX_BROWSER_LENGTH),
    };
    let stored = match s.push_repo.upsert_subscription(&sub).await {
        Ok(stored) => stored,
        Err(UpsertSubscriptionError::EndpointConflict) => {
            tracing::warn!(user_id, endpoint_origin = %extract_origin(endpoint), "Endpoint registered to another user");
            return Err(ApiError::conflict("Endpoint already registered to another user", c::ERR_CODE_CONFLICT));
        }
        Err(UpsertSubscriptionError::Database(err)) => {
            tracing::error!(user_id, error = %err, "Failed to register subscription");
            return Err(ApiError::internal("Failed to register subscription", c::ERR_CODE_DATABASE_ERROR));
        }
    };
    if let Err(err) = s.push_repo.get_or_create_preference(user_id).await {
        tracing::warn!(user_id, error = %err, "Failed to create default push preferences");
    }
    tracing::info!(user_id, subscription_id = stored.id, "Push subscription registered successfully");
    Ok(response::json(&PushSubscriptionResponse {
        success: true,
        message: "Subscription registered successfully".into(),
    }))
}

/// `DELETE /api/push/subscriptions`: expires the user's subscription for the endpoint.
pub(crate) async fn unregister_subscription(
    State(s): State<NotifyState>,
    user: AuthUser,
    JsonBody(body): JsonBody<UnregisterPushSubscriptionRequest>,
) -> ApiResult {
    let user_id = user.user_id;
    let req = body.map_err(|e| invalid_body(e, user_id))?;
    if req.endpoint.is_empty() {
        return Err(invalid_input("Endpoint is required"));
    }
    tracing::info!(user_id, endpoint_origin = %extract_origin(&req.endpoint), "Unregistering push subscription");
    s.push_repo.delete_subscription(&req.endpoint, user_id).await.map_err(|err| {
        tracing::error!(user_id, error = %err, "Failed to unregister subscription");
        ApiError::internal("Failed to unregister subscription", c::ERR_CODE_DATABASE_ERROR)
    })?;
    tracing::info!(user_id, "Push subscription unregistered successfully");
    Ok(response::success("Subscription removed"))
}

/// `GET /api/push/preferences` (created with defaults on first read).
pub(crate) async fn get_preferences(State(s): State<NotifyState>, user: AuthUser) -> ApiResult {
    let pref = load_preferences(&s, user.user_id).await?;
    Ok(response::json(&PushPreferencesResponse { success: true, preferences: PushPreferenceDto::from(&pref) }))
}

async fn load_preferences(s: &NotifyState, user_id: i64) -> Result<PushPreference, ApiError> {
    s.push_repo.get_or_create_preference(user_id).await.map_err(|err| {
        tracing::error!(user_id, error = %err, "Failed to get push preferences");
        ApiError::internal("Failed to get preferences", c::ERR_CODE_DATABASE_ERROR)
    })
}

/// `PUT /api/push/preferences`: partial update; rejected updates are not saved.
pub(crate) async fn update_preferences(
    State(s): State<NotifyState>,
    user: AuthUser,
    JsonBody(body): JsonBody<UpdatePushPreferencesRequest>,
) -> ApiResult {
    let user_id = user.user_id;
    let req = body.map_err(|e| invalid_body(e, user_id))?;
    let mut pref = load_preferences(&s, user_id).await?;
    apply_preference_update(&mut pref, req)?;
    let saved = s.push_repo.update_preference(&pref).await.map_err(|err| {
        tracing::error!(user_id, error = %err, "Failed to update push preferences");
        ApiError::internal("Failed to update preferences", c::ERR_CODE_DATABASE_ERROR)
    })?;
    tracing::info!(user_id, "Push preferences updated");
    Ok(response::json(&PushPreferencesResponse { success: true, preferences: PushPreferenceDto::from(&saved) }))
}

/// Applies the requested changes in the Go handler's order, validating as it goes.
fn apply_preference_update(pref: &mut PushPreference, req: UpdatePushPreferencesRequest) -> Result<(), ApiError> {
    if let Some(enabled) = req.push_enabled {
        pref.push_enabled = enabled;
    }
    if let Some(toggles) = req.preferences {
        let prefs = pref.preferences.get_or_insert_with(Default::default);
        for (notif_type, enabled) in toggles {
            if !is_valid_notification_type(&notif_type) {
                return Err(invalid_input(format!("Invalid notification type: {notif_type}")));
            }
            prefs.insert(notif_type, enabled);
        }
    }
    if let Some(enabled) = req.quiet_hours_enabled {
        pref.quiet_hours_enabled = enabled;
    }
    if let Some(start) = req.quiet_start {
        if !is_valid_time_format(&start) {
            return Err(invalid_input("Invalid quiet_start format (expected HH:MM)"));
        }
        pref.quiet_start = start;
    }
    if let Some(end) = req.quiet_end {
        if !is_valid_time_format(&end) {
            return Err(invalid_input("Invalid quiet_end format (expected HH:MM)"));
        }
        pref.quiet_end = end;
    }
    if let Some(timezone) = req.timezone {
        if !is_valid_timezone(&timezone) {
            return Err(invalid_input("Invalid timezone"));
        }
        pref.timezone = timezone;
    }
    if pref.quiet_hours_enabled && (pref.quiet_start.is_empty() || pref.quiet_end.is_empty()) {
        return Err(invalid_input("Quiet hours requires both start and end times"));
    }
    Ok(())
}

/// `POST /api/push/cleanup` (authenticated, plus the `X-Maintenance-Key` header): expires
/// subscriptions without a delivery in 90 days, deletes `gone` ones older than 7 days and
/// delivery logs older than 30 days. Failures are only logged (their count is 0).
pub(crate) async fn run_cleanup(State(s): State<NotifyState>, user: MaybeAuthUser, headers: HeaderMap) -> ApiResult {
    let user_id = user.0.map(|u| u.user_id).unwrap_or_default();
    let expected = &s.config.maintenance_api_key;
    if expected.is_empty() {
        tracing::warn!(user_id, "Push cleanup rejected: MAINTENANCE_API_KEY is not configured");
        return Err(ApiError::forbidden("Maintenance endpoints are disabled", c::ERR_CODE_NOT_AUTHORIZED));
    }
    let provided = headers.get(MAINTENANCE_KEY_HEADER).map(|v| v.as_bytes()).unwrap_or_default();
    if !constant_time_eq(provided, expected.as_bytes()) {
        tracing::warn!(user_id, key_provided = !provided.is_empty(), "Push cleanup rejected: invalid maintenance key");
        return Err(ApiError::forbidden("Invalid maintenance key", c::ERR_CODE_NOT_AUTHORIZED));
    }

    tracing::info!(user_id, "Running push data cleanup");
    let stale = s.push_repo.cleanup_stale_subscriptions(90).await.unwrap_or_else(|err| {
        tracing::error!(user_id, error = %err, "Failed to cleanup stale subscriptions");
        0
    });
    let gone = s.push_repo.cleanup_gone_subscriptions(7).await.unwrap_or_else(|err| {
        tracing::error!(user_id, error = %err, "Failed to cleanup gone subscriptions");
        0
    });
    let logs = s.push_repo.cleanup_old_delivery_logs(30).await.unwrap_or_else(|err| {
        tracing::error!(user_id, error = %err, "Failed to cleanup old delivery logs");
        0
    });
    tracing::info!(
        user_id,
        stale_subscriptions = stale,
        gone_subscriptions = gone,
        old_logs = logs,
        "Push cleanup completed"
    );
    Ok(response::json(&CleanupResponse {
        gone_subscriptions_deleted: gone,
        old_logs_deleted: logs,
        stale_subscriptions_cleaned: stale,
        success: true,
    }))
}

// ==================== Validation helpers ====================

/// Go `subtle.ConstantTimeCompare(a, b) == 1`.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// The first 50 bytes of a URL for logs (the Go handler logs this "origin").
fn extract_origin(url: &str) -> String {
    if url.len() <= 50 {
        return url.to_string();
    }
    let mut end = 50;
    while !url.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}...", &url[..end])
}

/// Strict `HH:MM` (00:00-23:59), with Go's byte arithmetic.
fn is_valid_time_format(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 5 || b[2] != b':' {
        return false;
    }
    let digit = |x: u8| x.wrapping_sub(b'0');
    let hour = digit(b[0]).wrapping_mul(10).wrapping_add(digit(b[1]));
    let minute = digit(b[3]).wrapping_mul(10).wrapping_add(digit(b[4]));
    hour <= 23
        && minute <= 59
        && (b'0'..=b'2').contains(&b[0])
        && b[1].is_ascii_digit()
        && (b'0'..=b'5').contains(&b[3])
        && b[4].is_ascii_digit()
}

/// IANA zone accepted by Go's `time.LoadLocation` (non-empty, at most 50 bytes; `UTC` and
/// `Local` are built in).
fn is_valid_timezone(tz: &str) -> bool {
    if tz.is_empty() || tz.len() > 50 {
        return false;
    }
    tz == "UTC" || tz == "Local" || tz.parse::<chrono_tz::Tz>().is_ok()
}

/// Push endpoints must be HTTPS URLs of at least 10 bytes.
fn is_valid_push_endpoint(endpoint: &str) -> bool {
    endpoint.len() >= 10 && endpoint.starts_with("https://")
}

fn is_valid_notification_type(notif_type: &str) -> bool {
    VALID_PREFERENCE_TYPES.contains(&notif_type)
}

/// Keeps at most `max_len` characters (requests decode to valid UTF-8 already).
fn truncate_chars(s: &str, max_len: usize) -> String {
    s.chars().take(max_len).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn time_formats() {
        for (input, want) in [
            ("00:00", true),
            ("23:59", true),
            ("09:05", true),
            ("24:00", false),
            ("23:60", false),
            ("7:30", false),
            ("07-30", false),
            ("0a:00", false),
            ("00:0a", false),
            ("30:00", false),
            ("", false),
            ("07:300", false),
        ] {
            assert_eq!(is_valid_time_format(input), want, "{input}");
        }
    }

    #[test]
    fn endpoints_zones_types_and_truncation() {
        assert!(is_valid_push_endpoint("https://push.example.com/send/device-1"));
        assert!(is_valid_push_endpoint("https://a.b"));
        assert!(!is_valid_push_endpoint("https://a"));
        assert!(!is_valid_push_endpoint("http://push.example.com/x"));
        assert!(!is_valid_push_endpoint(""));

        assert!(is_valid_timezone("UTC"));
        assert!(is_valid_timezone("Asia/Kolkata"));
        assert!(is_valid_timezone("Europe/Berlin"));
        assert!(!is_valid_timezone("Nowhere/City"));
        assert!(!is_valid_timezone("Mars/Olympus_Mons"));
        assert!(!is_valid_timezone(""));
        assert!(!is_valid_timezone(&"A".repeat(51)));

        for t in VALID_PREFERENCE_TYPES {
            assert!(is_valid_notification_type(t));
        }
        assert!(!is_valid_notification_type("comment_received"));

        let long = format!("https://push.example.com/{}", "x".repeat(100));
        assert_eq!(extract_origin(&long), format!("{}...", &long[..50]));
        assert_eq!(truncate_chars("héllo", 2), "hé");
        assert_eq!(truncate_chars("🚀🚀🚀", 2), "🚀🚀");
        assert!(constant_time_eq(b"key", b"key"));
        assert!(!constant_time_eq(b"key", b"ke"));
        assert!(!constant_time_eq(b"", b"key"));
    }

    #[test]
    fn preference_updates_merge_and_validate() {
        let mut pref = PushPreference::default_for(1);
        let req: UpdatePushPreferencesRequest = serde_json::from_str(
            r#"{"push_enabled":false,"preferences":{"like_received":false,"badge_unlocked":true},"quiet_hours_enabled":true,"quiet_start":"22:30","quiet_end":"07:00","timezone":"Europe/Berlin"}"#,
        )
        .unwrap();
        apply_preference_update(&mut pref, req).unwrap();
        assert!(!pref.push_enabled);
        assert_eq!(pref.quiet_start, "22:30");

        let partial: UpdatePushPreferencesRequest =
            serde_json::from_str(r#"{"preferences":{"streak_at_risk":false},"push_enabled":true}"#).unwrap();
        apply_preference_update(&mut pref, partial).unwrap();
        assert_eq!(
            pref.preferences.clone().unwrap().into_iter().collect::<Vec<_>>(),
            vec![("badge_unlocked".into(), true), ("like_received".into(), false), ("streak_at_risk".into(), false)]
        );
        assert_eq!(pref.timezone, "Europe/Berlin");

        let mut null_prefs = PushPreference::default_for(1);
        null_prefs.preferences = None;
        apply_preference_update(
            &mut null_prefs,
            serde_json::from_str(r#"{"preferences":{"system_announcement":false}}"#).unwrap(),
        )
        .unwrap();
        assert_eq!(null_prefs.preferences.unwrap().len(), 1);

        for (body, message) in [
            (r#"{"preferences":{"follow_request":false}}"#, "Invalid notification type: follow_request"),
            (r#"{"quiet_start":"24:00"}"#, "Invalid quiet_start format (expected HH:MM)"),
            (r#"{"quiet_end":"ab:cd"}"#, "Invalid quiet_end format (expected HH:MM)"),
            (r#"{"timezone":""}"#, "Invalid timezone"),
            (r#"{"quiet_hours_enabled":true,"quiet_start":"22:00"}"#, "Quiet hours requires both start and end times"),
        ] {
            let mut pref = PushPreference::default_for(1);
            let err = apply_preference_update(&mut pref, serde_json::from_str(body).unwrap()).unwrap_err();
            assert_eq!(err.message, message, "{body}");
            assert_eq!(err.code, c::ERR_CODE_INVALID_INPUT);
        }
    }
}
