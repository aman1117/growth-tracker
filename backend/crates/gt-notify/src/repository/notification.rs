use std::fmt::Display;
use std::time::Duration;

use chrono::{DateTime, Utc};
use gt_core::models::{Notification, NotificationDedupe};
use serde_json::Value;
use sqlx::types::Json;
use sqlx::{PgExecutor, PgPool};

use super::{gorm_limit, gorm_offset};

/// A notification to insert (Go: a `models.Notification` passed to `Create` before it has an id).
#[derive(Debug, Clone, PartialEq)]
pub struct NewNotification {
    pub user_id: i64,
    pub notif_type: String,
    pub title: String,
    pub body: String,
    /// JSON object, or `None` for SQL `NULL` (Go: nil `NotificationMetadata`).
    pub metadata: Option<Value>,
}

impl NewNotification {
    pub fn new(
        user_id: i64,
        notif_type: impl Into<String>,
        title: impl Into<String>,
        body: impl Into<String>,
        metadata: Option<Value>,
    ) -> Self {
        Self { user_id, notif_type: notif_type.into(), title: title.into(), body: body.into(), metadata }
    }
}

/// An "only once ever" delivery record to insert (`notification_dedupes`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewNotificationDedupe {
    /// Recipient.
    pub user_id: i64,
    /// Actor (e.g. the liker); `0` for system notifications.
    pub actor_id: i64,
    pub notif_type: String,
    /// E.g. `day_like`.
    pub entity_type: String,
    /// E.g. `123:2026-01-05`.
    pub entity_key: String,
}

impl NewNotificationDedupe {
    pub fn new(
        user_id: i64,
        actor_id: i64,
        notif_type: impl Into<String>,
        entity_type: impl Into<String>,
        entity_key: impl Into<String>,
    ) -> Self {
        Self {
            user_id,
            actor_id,
            notif_type: notif_type.into(),
            entity_type: entity_type.into(),
            entity_key: entity_key.into(),
        }
    }
}

/// [`NotificationRepository::delete_older_than`] failed on its second statement; read
/// notifications already removed are still reported (Go returns both the count and the error).
#[derive(Debug, thiserror::Error)]
#[error("{source}")]
pub struct PartialDeleteError {
    pub deleted: i64,
    #[source]
    pub source: sqlx::Error,
}

/// Notification data operations (Go: `repository.NotificationRepository`).
#[derive(Debug, Clone)]
pub struct NotificationRepository {
    pool: PgPool,
}

impl NotificationRepository {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// The underlying pool, for callers that need their own transaction (Go: `GetDB`).
    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    /// Inserts a notification and returns the stored row (Go: `Create`).
    pub async fn create(&self, notif: &NewNotification) -> Result<Notification, sqlx::Error> {
        Self::create_with(&self.pool, notif).await
    }

    /// [`create`](Self::create) on any executor, e.g. inside a transaction (Go: `tx.Create(notif)`).
    /// `created_at` is the application clock, like GORM's `autoCreateTime`.
    pub async fn create_with<'e, E: PgExecutor<'e>>(
        executor: E,
        notif: &NewNotification,
    ) -> Result<Notification, sqlx::Error> {
        let sql = format!(
            "INSERT INTO notifications (user_id, type, title, body, metadata, read_at, created_at) \
             VALUES ($1, $2, $3, $4, $5, NULL, $6) RETURNING {}",
            Notification::COLUMNS
        );
        sqlx::query_as::<_, Notification>(&sql)
            .bind(notif.user_id)
            .bind(&notif.notif_type)
            .bind(&notif.title)
            .bind(&notif.body)
            .bind(notif.metadata.as_ref().map(Json))
            .bind(Utc::now())
            .fetch_one(executor)
            .await
    }

    /// Inserts several notifications in one transaction, 100 rows per statement (Go:
    /// `CreateBatch` / `CreateInBatches(notifs, 100)`).
    pub async fn create_batch(&self, notifs: &[NewNotification]) -> Result<Vec<Notification>, sqlx::Error> {
        if notifs.is_empty() {
            return Ok(Vec::new());
        }
        let mut tx = self.pool.begin().await?;
        let mut created = Vec::with_capacity(notifs.len());
        let now = Utc::now();
        for chunk in notifs.chunks(100) {
            let mut builder = sqlx::QueryBuilder::new(
                "INSERT INTO notifications (user_id, type, title, body, metadata, read_at, created_at) ",
            );
            builder.push_values(chunk, |mut row, n| {
                row.push_bind(n.user_id)
                    .push_bind(&n.notif_type)
                    .push_bind(&n.title)
                    .push_bind(&n.body)
                    .push_bind(n.metadata.as_ref().map(Json))
                    .push("NULL")
                    .push_bind(now);
            });
            builder.push(format!(" RETURNING {}", Notification::COLUMNS));
            let rows = builder.build_query_as::<Notification>().fetch_all(&mut *tx).await?;
            created.extend(rows);
        }
        tx.commit().await?;
        Ok(created)
    }

    /// The notification with `id`, or `None` (Go: `GetByID`).
    pub async fn get_by_id(&self, id: i64) -> Result<Option<Notification>, sqlx::Error> {
        let sql = format!("SELECT {} FROM notifications WHERE id = $1 ORDER BY id LIMIT 1", Notification::COLUMNS);
        sqlx::query_as::<_, Notification>(&sql).bind(id).fetch_optional(&self.pool).await
    }

    /// A page of the user's notifications, newest first (Go: `GetByUserID`).
    pub async fn get_by_user_id(
        &self,
        user_id: i64,
        limit: i64,
        offset: i64,
    ) -> Result<Vec<Notification>, sqlx::Error> {
        let sql = format!(
            "SELECT {} FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3",
            Notification::COLUMNS
        );
        sqlx::query_as::<_, Notification>(&sql)
            .bind(user_id)
            .bind(gorm_limit(limit))
            .bind(gorm_offset(offset))
            .fetch_all(&self.pool)
            .await
    }

    /// The user's unread notifications, newest first (Go: `GetUnreadByUserID`).
    pub async fn get_unread_by_user_id(&self, user_id: i64, limit: i64) -> Result<Vec<Notification>, sqlx::Error> {
        let sql = format!(
            "SELECT {} FROM notifications WHERE user_id = $1 AND read_at IS NULL ORDER BY created_at DESC LIMIT $2",
            Notification::COLUMNS
        );
        sqlx::query_as::<_, Notification>(&sql).bind(user_id).bind(gorm_limit(limit)).fetch_all(&self.pool).await
    }

    /// Number of unread notifications (Go: `GetUnreadCount`).
    pub async fn get_unread_count(&self, user_id: i64) -> Result<i64, sqlx::Error> {
        sqlx::query_scalar("SELECT count(*) FROM notifications WHERE user_id = $1 AND read_at IS NULL")
            .bind(user_id)
            .fetch_one(&self.pool)
            .await
    }

    /// Marks one of the user's unread notifications as read; others' notifications and
    /// already-read ones are left alone (Go: `MarkAsRead`).
    pub async fn mark_as_read(&self, id: i64, user_id: i64) -> Result<(), sqlx::Error> {
        sqlx::query("UPDATE notifications SET read_at = $1 WHERE id = $2 AND user_id = $3 AND read_at IS NULL")
            .bind(Utc::now())
            .bind(id)
            .bind(user_id)
            .execute(&self.pool)
            .await
            .map(|_| ())
    }

    /// Marks all of the user's notifications as read (Go: `MarkAllAsRead`).
    pub async fn mark_all_as_read(&self, user_id: i64) -> Result<(), sqlx::Error> {
        sqlx::query("UPDATE notifications SET read_at = $1 WHERE user_id = $2 AND read_at IS NULL")
            .bind(Utc::now())
            .bind(user_id)
            .execute(&self.pool)
            .await
            .map(|_| ())
    }

    /// Deletes the notification when it belongs to the user (Go: `Delete`).
    pub async fn delete(&self, id: i64, user_id: i64) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM notifications WHERE id = $1 AND user_id = $2")
            .bind(id)
            .bind(user_id)
            .execute(&self.pool)
            .await
            .map(|_| ())
    }

    /// Deletes read notifications created before `read_older_than`, then unread ones created
    /// before `unread_older_than` (two statements, no transaction), returning how many were
    /// deleted (Go: `DeleteOlderThan`).
    pub async fn delete_older_than(
        &self,
        read_older_than: DateTime<Utc>,
        unread_older_than: DateTime<Utc>,
    ) -> Result<i64, PartialDeleteError> {
        let read = sqlx::query("DELETE FROM notifications WHERE read_at IS NOT NULL AND created_at < $1")
            .bind(read_older_than)
            .execute(&self.pool)
            .await
            .map_err(|source| PartialDeleteError { deleted: 0, source })?
            .rows_affected() as i64;
        let unread = sqlx::query("DELETE FROM notifications WHERE read_at IS NULL AND created_at < $1")
            .bind(unread_older_than)
            .execute(&self.pool)
            .await
            .map_err(|source| PartialDeleteError { deleted: read, source })?
            .rows_affected() as i64;
        Ok(read + unread)
    }

    /// Total number of the user's notifications (Go: `CountByUserID`).
    pub async fn count_by_user_id(&self, user_id: i64) -> Result<i64, sqlx::Error> {
        sqlx::query_scalar("SELECT count(*) FROM notifications WHERE user_id = $1")
            .bind(user_id)
            .fetch_one(&self.pool)
            .await
    }

    /// Whether the user got a notification of `notif_type` within `within` whose metadata has
    /// `key` equal to `value` (compared as text, like Go's `fmt.Sprint(value)` against `->>`).
    pub async fn exists_by_type_and_metadata(
        &self,
        user_id: i64,
        notif_type: &str,
        key: &str,
        value: impl Display,
        within: Duration,
    ) -> Result<bool, sqlx::Error> {
        let since = chrono::Duration::from_std(within)
            .ok()
            .and_then(|d| Utc::now().checked_sub_signed(d))
            .unwrap_or_else(gt_core::gojson::go_zero_time);
        let count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM notifications WHERE user_id = $1 AND type = $2 AND created_at > $3 \
             AND metadata->>$4 = $5",
        )
        .bind(user_id)
        .bind(notif_type)
        .bind(since)
        .bind(key)
        .bind(value.to_string())
        .fetch_one(&self.pool)
        .await?;
        Ok(count > 0)
    }

    /// Inserts a dedupe record unless it already exists; `true` when it was created (Go:
    /// `CreateDedupeRecord`).
    pub async fn create_dedupe_record(&self, dedupe: &NewNotificationDedupe) -> Result<bool, sqlx::Error> {
        Self::create_dedupe_record_with(&self.pool, dedupe).await
    }

    /// [`create_dedupe_record`](Self::create_dedupe_record) on any executor (Go:
    /// `tx.Clauses(clause.OnConflict{DoNothing: true}).Create(dedupe)`).
    pub async fn create_dedupe_record_with<'e, E: PgExecutor<'e>>(
        executor: E,
        dedupe: &NewNotificationDedupe,
    ) -> Result<bool, sqlx::Error> {
        let result = sqlx::query(
            "INSERT INTO notification_dedupes (user_id, actor_id, type, entity_type, entity_key, created_at) \
             VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING",
        )
        .bind(dedupe.user_id)
        .bind(dedupe.actor_id)
        .bind(&dedupe.notif_type)
        .bind(&dedupe.entity_type)
        .bind(&dedupe.entity_key)
        .bind(Utc::now())
        .execute(executor)
        .await?;
        Ok(result.rows_affected() > 0)
    }

    /// The first dedupe record of an actor for a type and entity key, whoever the recipient
    /// (Go: the `First` lookup in `NotifyDayCompleted`).
    pub async fn find_dedupe_by_actor(
        &self,
        actor_id: i64,
        notif_type: &str,
        entity_key: &str,
    ) -> Result<Option<NotificationDedupe>, sqlx::Error> {
        let sql = format!(
            "SELECT {} FROM notification_dedupes WHERE actor_id = $1 AND type = $2 AND entity_key = $3 \
             ORDER BY id LIMIT 1",
            NotificationDedupe::COLUMNS
        );
        sqlx::query_as::<_, NotificationDedupe>(&sql)
            .bind(actor_id)
            .bind(notif_type)
            .bind(entity_key)
            .fetch_optional(&self.pool)
            .await
    }
}
