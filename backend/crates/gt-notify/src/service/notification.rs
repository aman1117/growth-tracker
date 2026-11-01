use std::sync::Arc;

use gt_core::constants as c;
use gt_core::extract::parse_go_int;
use gt_core::models::Notification;
use redis::AsyncCommands;

use super::NotificationError;
use crate::repository::{NewNotification, NewNotificationDedupe, NotificationRepository};

/// Notification business logic (Go: `services.NotificationService`): persistence, the unread
/// count cache, real-time fan-out over Redis Pub/Sub, WebSocket connection tracking and the
/// hand-off to Web Push.
///
/// Redis is optional everywhere: without it notifications are still stored and listed, only
/// real-time delivery and caching are skipped.
#[derive(Debug, Clone)]
pub struct NotificationService {
    pub(super) repo: Arc<NotificationRepository>,
}

pub(super) fn unread_key(user_id: i64) -> String {
    format!("{}{user_id}", c::NOTIF_UNREAD_PREFIX)
}

impl NotificationService {
    pub fn new(repo: Arc<NotificationRepository>) -> Self {
        Self { repo }
    }

    /// The repository the service writes through.
    pub fn repository(&self) -> &Arc<NotificationRepository> {
        &self.repo
    }

    // ==================== Core CRUD ====================

    /// Stores a notification, invalidates the recipient's unread count and delivers it in real
    /// time (Redis Pub/Sub, or the pending queue when publishing fails). Returns the stored row
    /// (Go: `Create`, which filled in the struct's id).
    pub async fn create(&self, notif: NewNotification) -> Result<Notification, NotificationError> {
        let created = self.repo.create(&notif).await.map_err(|err| {
            tracing::error!(user_id = notif.user_id, notif_type = %notif.notif_type, error = %err, "Failed to create notification");
            NotificationError::Database { context: "failed to create notification", source: err }
        })?;
        self.invalidate_unread_cache(created.user_id).await;
        self.publish_notification(&created).await;
        tracing::info!(id = created.id, user_id = created.user_id, notif_type = %created.notif_type, "Notification created");
        Ok(created)
    }

    /// A page of the user's notifications (newest first) and their total count (Go:
    /// `GetByUserID`). `page` starts at 1.
    pub async fn get_by_user_id(
        &self,
        user_id: i64,
        page: i64,
        page_size: i64,
    ) -> Result<(Vec<Notification>, i64), NotificationError> {
        // Go int arithmetic wraps on overflow; GORM then ignores a negative offset.
        let offset = page.wrapping_sub(1).wrapping_mul(page_size);
        let notifs = self
            .repo
            .get_by_user_id(user_id, page_size, offset)
            .await
            .map_err(NotificationError::db("failed to get notifications"))?;
        let total = self
            .repo
            .count_by_user_id(user_id)
            .await
            .map_err(NotificationError::db("failed to count notifications"))?;
        Ok((notifs, total))
    }

    /// The unread count, served from the Redis cache (`notif:unread:<id>`, 5 minutes) when
    /// possible (Go: `GetUnreadCount`). Cache failures fall back to the database.
    pub async fn get_unread_count(&self, user_id: i64) -> Result<i64, NotificationError> {
        let key = unread_key(user_id);
        if let Some(mut conn) = gt_core::redis::conn() {
            let cached: Result<Option<String>, _> = conn.get(&key).await;
            if let Some(count) = cached.ok().flatten().as_deref().and_then(parse_go_int) {
                return Ok(count);
            }
        }
        let count =
            self.repo.get_unread_count(user_id).await.map_err(NotificationError::db("failed to get unread count"))?;
        if let Some(mut conn) = gt_core::redis::conn() {
            let _: Result<(), _> = conn.set_ex(&key, count, c::NOTIF_UNREAD_CACHE_TTL.as_secs()).await;
        }
        Ok(count)
    }

    /// Marks one of the user's notifications as read (Go: `MarkAsRead`).
    pub async fn mark_as_read(&self, id: i64, user_id: i64) -> Result<(), NotificationError> {
        self.repo
            .mark_as_read(id, user_id)
            .await
            .map_err(NotificationError::db("failed to mark notification as read"))?;
        self.invalidate_unread_cache(user_id).await;
        Ok(())
    }

    /// Marks all of the user's notifications as read (Go: `MarkAllAsRead`).
    pub async fn mark_all_as_read(&self, user_id: i64) -> Result<(), NotificationError> {
        self.repo
            .mark_all_as_read(user_id)
            .await
            .map_err(NotificationError::db("failed to mark all notifications as read"))?;
        self.invalidate_unread_cache(user_id).await;
        Ok(())
    }

    /// Deletes one of the user's notifications; [`NotificationError::NotFound`] when it does not
    /// exist or belongs to someone else (Go: `Delete`).
    pub async fn delete(&self, id: i64, user_id: i64) -> Result<(), NotificationError> {
        let notif = self.repo.get_by_id(id).await.map_err(NotificationError::db("failed to get notification"))?;
        let Some(notif) = notif.filter(|n| n.user_id == user_id) else {
            return Err(NotificationError::NotFound);
        };
        self.repo.delete(id, user_id).await.map_err(NotificationError::db("failed to delete notification"))?;
        if !notif.is_read() {
            self.invalidate_unread_cache(user_id).await;
        }
        Ok(())
    }

    // ==================== Cleanup ====================

    /// Deletes read notifications older than 30 days and unread ones older than 90 days,
    /// returning how many were removed (Go: `CleanupOldNotifications`, run by the 3 AM IST cron).
    pub async fn cleanup_old_notifications(&self) -> Result<i64, NotificationError> {
        let read_cutoff = crate::gotime::local_days_ago(c::NOTIF_READ_RETENTION_DAYS);
        let unread_cutoff = crate::gotime::local_days_ago(c::NOTIF_UNREAD_RETENTION_DAYS);
        match self.repo.delete_older_than(read_cutoff, unread_cutoff).await {
            Ok(deleted) => {
                if deleted > 0 {
                    tracing::info!(
                        deleted_count = deleted,
                        read_cutoff = %read_cutoff,
                        unread_cutoff = %unread_cutoff,
                        "Cleaned up old notifications"
                    );
                }
                Ok(deleted)
            }
            Err(err) => {
                tracing::error!(
                    read_cutoff = %read_cutoff,
                    unread_cutoff = %unread_cutoff,
                    error = %err.source,
                    "Failed to cleanup old notifications"
                );
                Err(NotificationError::Sqlx(err.source))
            }
        }
    }

    // ==================== Helpers ====================

    /// Drops the cached unread count of a user. Failures are only logged.
    pub async fn invalidate_unread_cache(&self, user_id: i64) {
        let Some(mut conn) = gt_core::redis::conn() else { return };
        if let Err(err) = conn.del::<_, ()>(unread_key(user_id)).await {
            tracing::warn!(user_id, error = %err, "Failed to invalidate unread cache");
        }
    }

    /// Stores the dedupe record and the notification in one transaction; nothing is stored and
    /// `None` is returned when the dedupe record already exists. Performs no side effects
    /// (no cache invalidation, real-time delivery or push), so callers that need the Go
    /// "dedupe + create" transaction alone (e.g. story likes) can reuse it.
    pub async fn store_once(
        &self,
        dedupe: &NewNotificationDedupe,
        notif: &NewNotification,
    ) -> Result<Option<Notification>, sqlx::Error> {
        let mut tx = self.repo.pool().begin().await?;
        if !NotificationRepository::create_dedupe_record_with(&mut *tx, dedupe).await? {
            tx.commit().await?;
            return Ok(None);
        }
        let created = NotificationRepository::create_with(&mut *tx, notif).await?;
        tx.commit().await?;
        Ok(Some(created))
    }
}
