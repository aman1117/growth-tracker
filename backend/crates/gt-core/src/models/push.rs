use std::collections::BTreeMap;
use std::str::FromStr;

use chrono::{DateTime, Timelike, Utc};
use serde::Serialize;

use crate::gojson;

pub const PUSH_SUBSCRIPTION_STATUS_ACTIVE: &str = "active";
/// 404/410 from the push service.
pub const PUSH_SUBSCRIPTION_STATUS_GONE: &str = "gone";
/// User unsubscribed or stale.
pub const PUSH_SUBSCRIPTION_STATUS_EXPIRED: &str = "expired";

/// A Web Push subscription for one device (`push_subscriptions`).
#[derive(Debug, Clone, PartialEq, Serialize, sqlx::FromRow)]
pub struct PushSubscription {
    pub id: i64,
    pub user_id: i64,
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
    pub vapid_key_id: String,
    pub status: String,
    pub failure_count: i64,
    pub user_agent: String,
    pub platform: String,
    pub browser: String,
    #[serde(with = "gojson::time_opt")]
    pub last_success_at: Option<DateTime<Utc>>,
    #[serde(with = "gojson::time_opt")]
    pub last_failure_at: Option<DateTime<Utc>>,
    #[serde(with = "gojson::time")]
    pub created_at: DateTime<Utc>,
    #[serde(with = "gojson::time")]
    pub updated_at: DateTime<Utc>,
}

impl PushSubscription {
    pub const COLUMNS: &'static str = "id, user_id, endpoint, p256dh, auth, vapid_key_id, status, failure_count, \
         COALESCE(user_agent, '') AS user_agent, COALESCE(platform, '') AS platform, \
         COALESCE(browser, '') AS browser, last_success_at, last_failure_at, created_at, updated_at";

    pub fn is_active(&self) -> bool {
        self.status == PUSH_SUBSCRIPTION_STATUS_ACTIVE
    }
}

/// A user's push notification preferences (`push_preferences`).
#[derive(Debug, Clone, PartialEq, Serialize, sqlx::FromRow)]
pub struct PushPreference {
    pub id: i64,
    pub user_id: i64,
    pub push_enabled: bool,
    /// Per-type toggles, e.g. `{"like_received": true}` (`null` when unset).
    #[sqlx(json(nullable))]
    pub preferences: Option<BTreeMap<String, bool>>,
    pub quiet_hours_enabled: bool,
    /// `HH:MM`.
    pub quiet_start: String,
    /// `HH:MM`.
    pub quiet_end: String,
    /// IANA time zone.
    pub timezone: String,
    #[serde(with = "gojson::time")]
    pub created_at: DateTime<Utc>,
    #[serde(with = "gojson::time")]
    pub updated_at: DateTime<Utc>,
}

impl PushPreference {
    pub const COLUMNS: &'static str = "id, user_id, push_enabled, preferences, quiet_hours_enabled, \
         COALESCE(quiet_start, '') AS quiet_start, COALESCE(quiet_end, '') AS quiet_end, \
         COALESCE(timezone, '') AS timezone, created_at, updated_at";

    /// Defaults for a user without stored preferences (Go `DefaultPushPreference`).
    pub fn default_for(user_id: i64) -> Self {
        let now = Utc::now();
        Self {
            id: 0,
            user_id,
            push_enabled: true,
            preferences: Some(BTreeMap::new()),
            quiet_hours_enabled: false,
            quiet_start: String::new(),
            quiet_end: String::new(),
            timezone: "Asia/Kolkata".into(),
            created_at: now,
            updated_at: now,
        }
    }

    /// Opt-out model: enabled unless globally disabled or explicitly turned off.
    pub fn is_type_enabled(&self, notification_type: &str) -> bool {
        if !self.push_enabled {
            return false;
        }
        match &self.preferences {
            None => true,
            Some(prefs) => prefs.get(notification_type).copied().unwrap_or(true),
        }
    }

    /// Whether `now` falls inside the quiet hours in the user's time zone (UTC when the zone
    /// is unknown, the process zone for `Local` like Go's `time.LoadLocation`). Overnight
    /// ranges such as 22:00-08:00 are supported.
    pub fn is_in_quiet_hours(&self, now: DateTime<Utc>) -> bool {
        if !self.quiet_hours_enabled || self.quiet_start.is_empty() || self.quiet_end.is_empty() {
            return false;
        }
        let minutes = if self.timezone == "Local" {
            let t = now.with_timezone(&chrono::Local);
            (t.hour() * 60 + t.minute()) as i64
        } else {
            match chrono_tz::Tz::from_str(&self.timezone) {
                Ok(tz) if !self.timezone.is_empty() => {
                    let t = now.with_timezone(&tz);
                    (t.hour() * 60 + t.minute()) as i64
                }
                _ => (now.hour() * 60 + now.minute()) as i64,
            }
        };
        let start = parse_time_to_minutes(&self.quiet_start);
        let end = parse_time_to_minutes(&self.quiet_end);
        if start > end {
            minutes >= start || minutes < end
        } else {
            minutes >= start && minutes < end
        }
    }
}

/// Parses `HH:MM` into minutes since midnight; `0` when malformed.
pub fn parse_time_to_minutes(s: &str) -> i64 {
    parse_hhmm(s).map(|(h, m)| h * 60 + m).unwrap_or(0)
}

/// Strict `HH:MM` (00-23, 00-59).
pub fn parse_hhmm(s: &str) -> Option<(i64, i64)> {
    let b = s.as_bytes();
    if b.len() != 5 || b[2] != b':' {
        return None;
    }
    let num = |x: &[u8]| -> Option<i64> {
        x.iter().try_fold(0i64, |acc, d| d.is_ascii_digit().then(|| acc * 10 + i64::from(d - b'0')))
    };
    let h = num(&b[0..2])?;
    let m = num(&b[3..5])?;
    ((0..=23).contains(&h) && (0..=59).contains(&m)).then_some((h, m))
}

/// One push delivery attempt (`push_delivery_logs`).
#[derive(Debug, Clone, PartialEq, Serialize, sqlx::FromRow)]
pub struct PushDeliveryLog {
    pub id: i64,
    pub user_id: i64,
    pub subscription_id: i64,
    pub notification_type: String,
    pub dedupe_key: String,
    /// Service Bus message id.
    pub message_id: String,
    pub status_code: i64,
    pub error: String,
    pub duration_ms: i64,
    #[serde(with = "gojson::time")]
    pub created_at: DateTime<Utc>,
}

impl PushDeliveryLog {
    pub const COLUMNS: &'static str = "id, user_id, subscription_id, notification_type, \
         COALESCE(dedupe_key, '') AS dedupe_key, message_id, status_code, COALESCE(error, '') AS error, \
         duration_ms, created_at";

    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.status_code)
    }

    pub fn is_permanent_failure(&self) -> bool {
        self.status_code == 404 || self.status_code == 410
    }

    pub fn is_retryable(&self) -> bool {
        self.status_code == 429 || (500..600).contains(&self.status_code)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn quiet_hours_overnight_in_user_zone() {
        let mut p = PushPreference::default_for(1);
        p.quiet_hours_enabled = true;
        p.quiet_start = "22:00".into();
        p.quiet_end = "08:00".into();
        // 17:00 UTC = 22:30 IST
        assert!(p.is_in_quiet_hours(Utc.with_ymd_and_hms(2026, 1, 1, 17, 0, 0).unwrap()));
        // 06:00 UTC = 11:30 IST
        assert!(!p.is_in_quiet_hours(Utc.with_ymd_and_hms(2026, 1, 1, 6, 0, 0).unwrap()));
    }

    #[test]
    fn type_toggles_default_on() {
        let mut p = PushPreference::default_for(1);
        assert!(p.is_type_enabled("like_received"));
        p.preferences = Some(BTreeMap::from([("like_received".to_string(), false)]));
        assert!(!p.is_type_enabled("like_received"));
        p.push_enabled = false;
        assert!(!p.is_type_enabled("other"));
    }

    #[test]
    fn hhmm() {
        assert_eq!(parse_hhmm("07:45"), Some((7, 45)));
        assert_eq!(parse_hhmm("24:00"), None);
        assert_eq!(parse_hhmm("7:45"), None);
    }
}
