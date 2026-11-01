use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use gt_core::models::{
    PushPreference, PushSubscription, PUSH_SUBSCRIPTION_STATUS_ACTIVE, PUSH_SUBSCRIPTION_STATUS_EXPIRED,
    PUSH_SUBSCRIPTION_STATUS_GONE,
};
use sqlx::types::Json;
use sqlx::PgPool;

/// Go `repository.ErrEndpointConflict` and database failures of
/// [`PushRepository::upsert_subscription`].
#[derive(Debug, thiserror::Error)]
pub enum UpsertSubscriptionError {
    /// The endpoint is already registered to a different user.
    #[error("endpoint already registered to another user")]
    EndpointConflict,
    #[error(transparent)]
    Database(#[from] sqlx::Error),
}

/// A subscription to register (Go: the `models.PushSubscription` built by the handler).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct NewPushSubscription {
    pub user_id: i64,
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
    pub vapid_key_id: String,
    /// Empty means the column default (`active`), like GORM's `default:'active'` tag.
    pub status: String,
    pub failure_count: i64,
    pub user_agent: String,
    pub platform: String,
    pub browser: String,
}

/// One delivery attempt to record (Go: `models.PushDeliveryLog` before `Create`).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct NewPushDeliveryLog {
    pub user_id: i64,
    pub subscription_id: i64,
    pub notification_type: String,
    pub dedupe_key: String,
    /// Service Bus message id.
    pub message_id: String,
    /// HTTP status from the push service; `0` when the request failed.
    pub status_code: i64,
    pub error: String,
    pub duration_ms: i64,
}

/// Push subscription, preference and delivery-log operations (Go: `repository.PushRepository`).
#[derive(Debug, Clone)]
pub struct PushRepository {
    pool: PgPool,
}

/// Go `time.Now().AddDate(0, 0, -days)` (calendar days in the process time zone).
fn days_ago(days: i64) -> DateTime<Utc> {
    crate::gotime::local_days_ago(days)
}

/// `now - delta`, saturating at Go's zero time when the delta is out of range.
fn before_now(delta: Option<chrono::Duration>) -> DateTime<Utc> {
    delta.and_then(|d| Utc::now().checked_sub_signed(d)).unwrap_or_else(gt_core::gojson::go_zero_time)
}

impl PushRepository {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    // ==================== Subscriptions ====================

    /// Registers a subscription. An endpoint the same user already registered is updated in
    /// place, keeping its id, creation time and delivery history (`last_success_at`,
    /// `last_failure_at`) — the app re-registers once per session and wiping the history would
    /// make active devices look stale. Fails with
    /// [`UpsertSubscriptionError::EndpointConflict`] when another user owns the endpoint.
    pub async fn upsert_subscription(
        &self,
        sub: &NewPushSubscription,
    ) -> Result<PushSubscription, UpsertSubscriptionError> {
        let now = Utc::now();
        let status = if sub.status.is_empty() { PUSH_SUBSCRIPTION_STATUS_ACTIVE } else { sub.status.as_str() };
        let Some(existing) = self.get_subscription_by_endpoint(&sub.endpoint).await? else {
            let sql = format!(
                "INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, vapid_key_id, status, \
                 failure_count, user_agent, platform, browser, last_success_at, last_failure_at, created_at, updated_at) \
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL, NULL, $11, $11) RETURNING {}",
                PushSubscription::COLUMNS
            );
            return Ok(sqlx::query_as::<_, PushSubscription>(&sql)
                .bind(sub.user_id)
                .bind(&sub.endpoint)
                .bind(&sub.p256dh)
                .bind(&sub.auth)
                .bind(&sub.vapid_key_id)
                .bind(status)
                .bind(sub.failure_count)
                .bind(&sub.user_agent)
                .bind(&sub.platform)
                .bind(&sub.browser)
                .bind(now)
                .fetch_one(&self.pool)
                .await?);
        };
        if existing.user_id != sub.user_id {
            return Err(UpsertSubscriptionError::EndpointConflict);
        }
        // GORM `Save`: every column is written (an upsert by primary key).
        let sql = format!(
            "INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, vapid_key_id, status, \
             failure_count, user_agent, platform, browser, last_success_at, last_failure_at, created_at, updated_at) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) \
             ON CONFLICT (id) DO UPDATE SET user_id = EXCLUDED.user_id, endpoint = EXCLUDED.endpoint, \
             p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, vapid_key_id = EXCLUDED.vapid_key_id, \
             status = EXCLUDED.status, failure_count = EXCLUDED.failure_count, user_agent = EXCLUDED.user_agent, \
             platform = EXCLUDED.platform, browser = EXCLUDED.browser, last_success_at = EXCLUDED.last_success_at, \
             last_failure_at = EXCLUDED.last_failure_at, created_at = EXCLUDED.created_at, \
             updated_at = EXCLUDED.updated_at RETURNING {}",
            PushSubscription::COLUMNS
        );
        Ok(sqlx::query_as::<_, PushSubscription>(&sql)
            .bind(existing.id)
            .bind(sub.user_id)
            .bind(&sub.endpoint)
            .bind(&sub.p256dh)
            .bind(&sub.auth)
            .bind(&sub.vapid_key_id)
            .bind(status)
            .bind(sub.failure_count)
            .bind(&sub.user_agent)
            .bind(&sub.platform)
            .bind(&sub.browser)
            .bind(existing.last_success_at)
            .bind(existing.last_failure_at)
            .bind(existing.created_at)
            .bind(now)
            .fetch_one(&self.pool)
            .await?)
    }

    /// The subscription registered for `endpoint`, or `None`.
    pub async fn get_subscription_by_endpoint(&self, endpoint: &str) -> Result<Option<PushSubscription>, sqlx::Error> {
        let sql = format!(
            "SELECT {} FROM push_subscriptions WHERE endpoint = $1 ORDER BY id LIMIT 1",
            PushSubscription::COLUMNS
        );
        sqlx::query_as::<_, PushSubscription>(&sql).bind(endpoint).fetch_optional(&self.pool).await
    }

    /// All active subscriptions of a user (no particular order, like the Go query).
    pub async fn get_active_subscriptions_by_user_id(
        &self,
        user_id: i64,
    ) -> Result<Vec<PushSubscription>, sqlx::Error> {
        let sql =
            format!("SELECT {} FROM push_subscriptions WHERE user_id = $1 AND status = $2", PushSubscription::COLUMNS);
        sqlx::query_as::<_, PushSubscription>(&sql)
            .bind(user_id)
            .bind(PUSH_SUBSCRIPTION_STATUS_ACTIVE)
            .fetch_all(&self.pool)
            .await
    }

    /// Soft-deletes the user's subscription for `endpoint` (status `expired`).
    pub async fn delete_subscription(&self, endpoint: &str, user_id: i64) -> Result<(), sqlx::Error> {
        sqlx::query("UPDATE push_subscriptions SET status = $1, updated_at = $2 WHERE endpoint = $3 AND user_id = $4")
            .bind(PUSH_SUBSCRIPTION_STATUS_EXPIRED)
            .bind(Utc::now())
            .bind(endpoint)
            .bind(user_id)
            .execute(&self.pool)
            .await
            .map(|_| ())
    }

    /// Deletes every subscription of the user (account deletion).
    pub async fn delete_subscriptions_by_user_id(&self, user_id: i64) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM push_subscriptions WHERE user_id = $1")
            .bind(user_id)
            .execute(&self.pool)
            .await
            .map(|_| ())
    }

    /// Marks a dead endpoint (404/410 from the push service) as `gone`.
    pub async fn mark_subscription_gone(&self, id: i64) -> Result<(), sqlx::Error> {
        let now = Utc::now();
        sqlx::query("UPDATE push_subscriptions SET status = $1, last_failure_at = $2, updated_at = $2 WHERE id = $3")
            .bind(PUSH_SUBSCRIPTION_STATUS_GONE)
            .bind(now)
            .bind(id)
            .execute(&self.pool)
            .await
            .map(|_| ())
    }

    /// Records a successful delivery and resets the failure count.
    pub async fn update_subscription_success(&self, id: i64) -> Result<(), sqlx::Error> {
        let now = Utc::now();
        sqlx::query(
            "UPDATE push_subscriptions SET last_success_at = $1, failure_count = 0, updated_at = $1 WHERE id = $2",
        )
        .bind(now)
        .bind(id)
        .execute(&self.pool)
        .await
        .map(|_| ())
    }

    /// Counts a failed delivery; with `max_failures > 0` the subscription expires once it has
    /// failed that many times.
    pub async fn increment_subscription_failure(&self, id: i64, max_failures: i64) -> Result<(), sqlx::Error> {
        let now = Utc::now();
        sqlx::query(
            "UPDATE push_subscriptions SET failure_count = failure_count + 1, last_failure_at = $1, updated_at = $1 \
             WHERE id = $2",
        )
        .bind(now)
        .bind(id)
        .execute(&self.pool)
        .await?;
        if max_failures > 0 {
            sqlx::query(
                "UPDATE push_subscriptions SET status = $1, updated_at = $2 WHERE id = $3 AND failure_count >= $4",
            )
            .bind(PUSH_SUBSCRIPTION_STATUS_EXPIRED)
            .bind(Utc::now())
            .bind(id)
            .bind(max_failures)
            .execute(&self.pool)
            .await?;
        }
        Ok(())
    }

    /// Expires active subscriptions without a successful push in `stale_days` days (judged by
    /// the subscription date when they never had one); returns how many were expired.
    pub async fn cleanup_stale_subscriptions(&self, stale_days: i64) -> Result<i64, sqlx::Error> {
        let cutoff = days_ago(stale_days);
        let result = sqlx::query(
            "UPDATE push_subscriptions SET status = $1, updated_at = $2 WHERE status = $3 \
             AND (last_success_at < $4 OR (last_success_at IS NULL AND created_at < $4))",
        )
        .bind(PUSH_SUBSCRIPTION_STATUS_EXPIRED)
        .bind(Utc::now())
        .bind(PUSH_SUBSCRIPTION_STATUS_ACTIVE)
        .bind(cutoff)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() as i64)
    }

    /// Deletes `gone` subscriptions last updated more than `days_old` days ago.
    pub async fn cleanup_gone_subscriptions(&self, days_old: i64) -> Result<i64, sqlx::Error> {
        let result = sqlx::query("DELETE FROM push_subscriptions WHERE status = $1 AND updated_at < $2")
            .bind(PUSH_SUBSCRIPTION_STATUS_GONE)
            .bind(days_ago(days_old))
            .execute(&self.pool)
            .await?;
        Ok(result.rows_affected() as i64)
    }

    // ==================== Preferences ====================

    /// The user's preferences, creating the defaults when missing. A concurrent creation by
    /// another request is tolerated by reading its row.
    pub async fn get_or_create_preference(&self, user_id: i64) -> Result<PushPreference, sqlx::Error> {
        if let Some(pref) = self.find_preference(user_id).await? {
            return Ok(pref);
        }
        let defaults = PushPreference::default_for(user_id);
        let sql = format!(
            "INSERT INTO push_preferences (user_id, push_enabled, preferences, quiet_hours_enabled, quiet_start, \
             quiet_end, timezone, created_at, updated_at) VALUES ($1, $2, $3, DEFAULT, $4, $5, $6, $7, $7) RETURNING {}",
            PushPreference::COLUMNS
        );
        let created = sqlx::query_as::<_, PushPreference>(&sql)
            .bind(user_id)
            .bind(defaults.push_enabled)
            .bind(defaults.preferences.as_ref().map(Json))
            .bind(&defaults.quiet_start)
            .bind(&defaults.quiet_end)
            .bind(&defaults.timezone)
            .bind(Utc::now())
            .fetch_one(&self.pool)
            .await;
        match created {
            Ok(pref) => Ok(pref),
            Err(err) => match self.find_preference(user_id).await {
                Ok(Some(pref)) => Ok(pref),
                _ => Err(err),
            },
        }
    }

    async fn find_preference(&self, user_id: i64) -> Result<Option<PushPreference>, sqlx::Error> {
        let sql =
            format!("SELECT {} FROM push_preferences WHERE user_id = $1 ORDER BY id LIMIT 1", PushPreference::COLUMNS);
        sqlx::query_as::<_, PushPreference>(&sql).bind(user_id).fetch_optional(&self.pool).await
    }

    /// Saves every column of `pref` (GORM `Save`: an upsert by id, `updated_at` set to now) and
    /// returns the stored row.
    pub async fn update_preference(&self, pref: &PushPreference) -> Result<PushPreference, sqlx::Error> {
        let now = Utc::now();
        let prefs: Option<Json<&BTreeMap<String, bool>>> = pref.preferences.as_ref().map(Json);
        if pref.id == 0 {
            let sql = format!(
                "INSERT INTO push_preferences (user_id, push_enabled, preferences, quiet_hours_enabled, quiet_start, \
                 quiet_end, timezone, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8) RETURNING {}",
                PushPreference::COLUMNS
            );
            return sqlx::query_as::<_, PushPreference>(&sql)
                .bind(pref.user_id)
                .bind(pref.push_enabled)
                .bind(prefs)
                .bind(pref.quiet_hours_enabled)
                .bind(&pref.quiet_start)
                .bind(&pref.quiet_end)
                .bind(&pref.timezone)
                .bind(now)
                .fetch_one(&self.pool)
                .await;
        }
        let sql = format!(
            "INSERT INTO push_preferences (id, user_id, push_enabled, preferences, quiet_hours_enabled, quiet_start, \
             quiet_end, timezone, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) \
             ON CONFLICT (id) DO UPDATE SET user_id = EXCLUDED.user_id, push_enabled = EXCLUDED.push_enabled, \
             preferences = EXCLUDED.preferences, quiet_hours_enabled = EXCLUDED.quiet_hours_enabled, \
             quiet_start = EXCLUDED.quiet_start, quiet_end = EXCLUDED.quiet_end, timezone = EXCLUDED.timezone, \
             created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at RETURNING {}",
            PushPreference::COLUMNS
        );
        sqlx::query_as::<_, PushPreference>(&sql)
            .bind(pref.id)
            .bind(pref.user_id)
            .bind(pref.push_enabled)
            .bind(prefs)
            .bind(pref.quiet_hours_enabled)
            .bind(&pref.quiet_start)
            .bind(&pref.quiet_end)
            .bind(&pref.timezone)
            .bind(pref.created_at)
            .bind(now)
            .fetch_one(&self.pool)
            .await
    }

    /// Deletes the user's preferences (account deletion).
    pub async fn delete_preference_by_user_id(&self, user_id: i64) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM push_preferences WHERE user_id = $1")
            .bind(user_id)
            .execute(&self.pool)
            .await
            .map(|_| ())
    }

    // ==================== Delivery logs ====================

    /// Records a delivery attempt and returns its id.
    pub async fn create_delivery_log(&self, log: &NewPushDeliveryLog) -> Result<i64, sqlx::Error> {
        sqlx::query_scalar(
            "INSERT INTO push_delivery_logs (user_id, subscription_id, notification_type, dedupe_key, message_id, \
             status_code, error, duration_ms, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id",
        )
        .bind(log.user_id)
        .bind(log.subscription_id)
        .bind(&log.notification_type)
        .bind(&log.dedupe_key)
        .bind(&log.message_id)
        .bind(log.status_code)
        .bind(&log.error)
        .bind(log.duration_ms)
        .bind(Utc::now())
        .fetch_one(&self.pool)
        .await
    }

    /// Whether the message was already delivered (or attempted) to the subscription.
    pub async fn check_idempotency(&self, message_id: &str, subscription_id: i64) -> Result<bool, sqlx::Error> {
        let count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM push_delivery_logs WHERE message_id = $1 AND subscription_id = $2",
        )
        .bind(message_id)
        .bind(subscription_id)
        .fetch_one(&self.pool)
        .await?;
        Ok(count > 0)
    }

    /// Whether a push with the same dedupe key reached the user successfully within the last
    /// `window_seconds`. An empty key never dedupes (and runs no query).
    pub async fn check_dedupe_window(
        &self,
        user_id: i64,
        dedupe_key: &str,
        window_seconds: i64,
    ) -> Result<bool, sqlx::Error> {
        if dedupe_key.is_empty() {
            return Ok(false);
        }
        let cutoff = before_now(chrono::Duration::try_seconds(window_seconds));
        let count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM push_delivery_logs WHERE user_id = $1 AND dedupe_key = $2 AND created_at > $3 \
             AND status_code >= 200 AND status_code < 300",
        )
        .bind(user_id)
        .bind(dedupe_key)
        .bind(cutoff)
        .fetch_one(&self.pool)
        .await?;
        Ok(count > 0)
    }

    /// Deletes delivery logs older than `days_old` days.
    pub async fn cleanup_old_delivery_logs(&self, days_old: i64) -> Result<i64, sqlx::Error> {
        let result = sqlx::query("DELETE FROM push_delivery_logs WHERE created_at < $1")
            .bind(days_ago(days_old))
            .execute(&self.pool)
            .await?;
        Ok(result.rows_affected() as i64)
    }
}
