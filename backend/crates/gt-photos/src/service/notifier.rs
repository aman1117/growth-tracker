//! Story notifications (port of the notification half of `activity_photo_service.go`):
//!
//! * new photos notify every follower of the uploader once per 30 s debounce window
//!   (`photo_uploaded`, "X shared N new photos"), in-app and via Web Push;
//! * a like notifies the photo owner once ever per (owner, liker, photo) (`story_liked`), even
//!   across unlike / re-like.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use gt_core::models::{
    ActivityPhoto, PhotoUploadedMetadata, StoryLikedMetadata, NOTIF_TYPE_PHOTO_UPLOADED, NOTIF_TYPE_STORY_LIKED,
};
use gt_core::timeutil::{format_date, parse_date};
use gt_notify::push::{available_publisher, notification_data, PushRequest};
use gt_notify::{NewNotification, NewNotificationDedupe, NotificationService};
use gt_users::repository::{FollowRepository, UserRepository};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio::time::Instant;

/// Uploads by the same user within this window are announced together.
pub const NOTIFICATION_DEBOUNCE_WINDOW: Duration = Duration::from_secs(30);
/// Budget of one notification run (Go: fresh 30 s context).
const SEND_TIMEOUT: Duration = Duration::from_secs(30);
/// Push TTL of story notifications (4 hours).
const PUSH_TTL_SECONDS: i64 = 14_400;
/// `notification_dedupes.entity_type` of story likes.
const STORY_LIKE_ENTITY_TYPE: &str = "story_like";

/// Photos of one uploader waiting for the debounce window to close.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingPhotoNotification {
    pub uploader_id: i64,
    pub uploader_username: String,
    /// Profile picture URL, `""` when the uploader has none.
    pub uploader_avatar: String,
    /// `YYYY-MM-DD` of the first upload in the window.
    pub photo_date: String,
    pub photo_count: i64,
}

struct PendingEntry {
    notification: PendingPhotoNotification,
    deadline: Instant,
    timer: JoinHandle<()>,
}

/// Sends the story notifications; cheap to clone (shared state).
#[derive(Clone)]
pub(crate) struct PhotoNotifier {
    user_repo: Arc<UserRepository>,
    follow_repo: Arc<FollowRepository>,
    notifications: Arc<NotificationService>,
    pending: Arc<Mutex<HashMap<i64, PendingEntry>>>,
}

impl PhotoNotifier {
    pub(crate) fn new(
        user_repo: Arc<UserRepository>,
        follow_repo: Arc<FollowRepository>,
        notifications: Arc<NotificationService>,
    ) -> Self {
        Self { user_repo, follow_repo, notifications, pending: Arc::default() }
    }

    // ==================== Debounced upload notifications ====================

    /// Counts an upload into the uploader's pending notification, (re)starting the debounce
    /// window; the first upload looks the uploader up (Go holds the lock meanwhile, so
    /// concurrent uploads cannot schedule twice).
    pub(crate) async fn schedule(&self, uploader_id: i64, photo_date: &str) {
        let mut pending = self.pending.lock().await;
        if let Some(entry) = pending.get_mut(&uploader_id) {
            entry.notification.photo_count += 1;
            entry.deadline = Instant::now() + NOTIFICATION_DEBOUNCE_WINDOW;
            tracing::debug!(
                uploader_id,
                photo_count = entry.notification.photo_count,
                "Debounced notification updated"
            );
            return;
        }

        let uploader = match self.user_repo.find_by_id(uploader_id).await {
            Ok(Some(user)) => user,
            Ok(None) => {
                tracing::warn!(uploader_id, "Failed to get uploader for notification");
                return;
            }
            Err(err) => {
                tracing::warn!(uploader_id, error = %err, "Failed to get uploader for notification");
                return;
            }
        };
        let notification = PendingPhotoNotification {
            uploader_id,
            uploader_username: uploader.username,
            uploader_avatar: uploader.profile_pic.unwrap_or_default(),
            photo_date: photo_date.to_string(),
            photo_count: 1,
        };
        self.insert_pending(&mut pending, notification);
        tracing::debug!(uploader_id, photo_date, "Scheduled debounced notification");
    }

    /// Starts the debounce window of a new pending notification.
    fn insert_pending(&self, pending: &mut HashMap<i64, PendingEntry>, notification: PendingPhotoNotification) {
        let uploader_id = notification.uploader_id;
        // The timer waits for the lock, so it always finds the entry inserted below.
        let timer = tokio::spawn(self.clone().run_timer(uploader_id));
        let deadline = Instant::now() + NOTIFICATION_DEBOUNCE_WINDOW;
        pending.insert(uploader_id, PendingEntry { notification, deadline, timer });
    }

    /// Sleeps until the uploader's (possibly extended) deadline, then sends the batch.
    async fn run_timer(self, uploader_id: i64) {
        loop {
            let Some(deadline) = self.pending.lock().await.get(&uploader_id).map(|entry| entry.deadline) else {
                return;
            };
            tokio::time::sleep_until(deadline).await;
            let fired = {
                let mut pending = self.pending.lock().await;
                match pending.get(&uploader_id) {
                    None => return,
                    Some(entry) if entry.deadline > Instant::now() => None,
                    Some(_) => pending.remove(&uploader_id).map(|entry| entry.notification),
                }
            };
            if let Some(notification) = fired {
                self.send_photo_notification_within_budget(&notification).await;
                return;
            }
        }
    }

    /// A copy of the uploader's pending notification, if any.
    pub(crate) async fn pending(&self, uploader_id: i64) -> Option<PendingPhotoNotification> {
        self.pending.lock().await.get(&uploader_id).map(|entry| entry.notification.clone())
    }

    /// Removes every pending notification and stops its timer.
    async fn take_all(&self) -> Vec<PendingPhotoNotification> {
        let mut pending = self.pending.lock().await;
        pending
            .drain()
            .map(|(_, entry)| {
                entry.timer.abort();
                entry.notification
            })
            .collect()
    }

    /// Sends every pending notification now instead of at the end of its window.
    pub(crate) async fn flush(&self) {
        for notification in self.take_all().await {
            self.send_photo_notification_within_budget(&notification).await;
        }
    }

    /// Drops every pending notification without sending it.
    pub(crate) async fn cancel(&self) {
        let dropped = self.take_all().await.len();
        if dropped > 0 {
            tracing::debug!(dropped, "Pending photo notifications cancelled");
        }
    }

    async fn send_photo_notification_within_budget(&self, pending: &PendingPhotoNotification) {
        if tokio::time::timeout(SEND_TIMEOUT, self.send_photo_notification(pending)).await.is_err() {
            tracing::warn!(uploader_id = pending.uploader_id, "Photo notifications timed out");
        }
    }

    /// Notifies every follower of the uploader (in-app, then Web Push). Failures for one
    /// follower are logged and do not stop the others.
    pub(crate) async fn send_photo_notification(&self, pending: &PendingPhotoNotification) {
        let follower_ids = match self.follow_repo.get_all_follower_ids(pending.uploader_id).await {
            Ok(ids) => ids,
            Err(err) => {
                tracing::error!(uploader_id = pending.uploader_id, error = %err, "Failed to get followers for notification");
                return;
            }
        };
        if follower_ids.is_empty() {
            return;
        }

        let formatted_date = parse_date(&pending.photo_date)
            .map(|date| date.format("%-d %b, %Y").to_string())
            .unwrap_or_else(|| pending.photo_date.clone());
        let body = if pending.photo_count > 1 {
            format!("{} shared {} new photos", pending.uploader_username, pending.photo_count)
        } else {
            format!("{} shared a new photo", pending.uploader_username)
        };
        let deep_link = format!("/user/{}?date={}", pending.uploader_username, pending.photo_date);
        let metadata = PhotoUploadedMetadata {
            uploader_id: pending.uploader_id,
            uploader_username: pending.uploader_username.clone(),
            uploader_avatar: pending.uploader_avatar.clone(),
            photo_count: pending.photo_count,
            photo_date: pending.photo_date.clone(),
        }
        .to_map();

        for &follower_id in &follower_ids {
            let notif = NewNotification::new(
                follower_id,
                NOTIF_TYPE_PHOTO_UPLOADED,
                "New Story!",
                body.clone(),
                Some(metadata.clone()),
            );
            let created = match self.notifications.create(notif).await {
                Ok(created) => created,
                Err(err) => {
                    tracing::warn!(follower_id, uploader_id = pending.uploader_id, error = %err, "Failed to create photo notification");
                    continue;
                }
            };
            // Story pushes bypass the push preferences, as in Go.
            if let Some(publisher) = available_publisher() {
                let request = PushRequest {
                    user_id: follower_id,
                    notification_type: created.notif_type.clone(),
                    title: created.title.clone(),
                    body: created.body.clone(),
                    dedupe_key: format!("photo_uploaded:{follower_id}:{}:{}", pending.uploader_id, pending.photo_date),
                    deep_link: deep_link.clone(),
                    data: Some(notification_data(&created)),
                    ttl_seconds: PUSH_TTL_SECONDS,
                };
                if let Err(err) = publisher.publish_push_notification(request) {
                    tracing::warn!(notif_id = created.id, follower_id, error = %err, "Failed to publish push notification for photo upload");
                }
            }
        }

        tracing::info!(
            uploader_id = pending.uploader_id,
            photo_count = pending.photo_count,
            follower_count = follower_ids.len(),
            date = %formatted_date,
            "Photo notifications sent"
        );
    }

    // ==================== Story likes ====================

    /// [`PhotoNotifier::send_like_notification`] with Go's 30 s budget.
    pub(crate) async fn send_like_notification_within_budget(&self, liker_id: i64, photo: &ActivityPhoto) {
        if tokio::time::timeout(SEND_TIMEOUT, self.send_like_notification(liker_id, photo)).await.is_err() {
            tracing::warn!(photo_id = photo.id, liker_id, "Story like notification timed out");
        }
    }

    /// Stores the owner's `story_liked` notification unless this liker was already announced
    /// for this photo (dedupe record and notification in one transaction, without the
    /// real-time side effects of `NotificationService::create`), then queues the push.
    pub(crate) async fn send_like_notification(&self, liker_id: i64, photo: &ActivityPhoto) {
        let liker = match self.user_repo.find_by_id(liker_id).await {
            Ok(Some(user)) => user,
            Ok(None) => {
                tracing::warn!(liker_id, "Failed to get liker for notification");
                return;
            }
            Err(err) => {
                tracing::warn!(liker_id, error = %err, "Failed to get liker for notification");
                return;
            }
        };
        let owner_id = photo.user_id;
        let entity_key = photo.id.to_string();
        let photo_date = format_date(&photo.photo_date);

        let dedupe =
            NewNotificationDedupe::new(owner_id, liker_id, NOTIF_TYPE_STORY_LIKED, STORY_LIKE_ENTITY_TYPE, &entity_key);
        let metadata = StoryLikedMetadata {
            liker_id,
            liker_username: liker.username.clone(),
            liker_avatar: liker.profile_pic.clone().unwrap_or_default(),
            photo_id: photo.id,
            photo_date: photo_date.clone(),
        };
        let notif = NewNotification::new(
            owner_id,
            NOTIF_TYPE_STORY_LIKED,
            "New Like!",
            format!("{} liked your story", liker.username),
            Some(metadata.to_map()),
        );

        let created = match self.notifications.store_once(&dedupe, &notif).await {
            Ok(Some(created)) => created,
            Ok(None) => {
                tracing::debug!(user_id = owner_id, actor_id = liker_id, entity_key = %entity_key, "Skipping duplicate story like notification");
                return;
            }
            Err(err) => {
                tracing::warn!(photo_id = photo.id, liker_id, owner_id, error = %err, "Transaction failed for story like notification");
                return;
            }
        };
        tracing::info!(id = created.id, photo_id = photo.id, liker_id, owner_id, "Story like notification created");

        if let Some(publisher) = available_publisher() {
            let request = PushRequest {
                user_id: owner_id,
                notification_type: created.notif_type.clone(),
                title: created.title.clone(),
                body: created.body.clone(),
                dedupe_key: format!("story_liked:{owner_id}:{liker_id}:{}", photo.id),
                deep_link: format!("/user/{}?date={photo_date}", liker.username),
                data: Some(notification_data(&created)),
                ttl_seconds: PUSH_TTL_SECONDS,
            };
            if let Err(err) = publisher.publish_push_notification(request) {
                tracing::warn!(notif_id = created.id, owner_id, error = %err, "Failed to publish push notification for story like");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;
    use gt_notify::NotificationRepository;
    use sqlx::postgres::PgPoolOptions;

    #[test]
    fn notification_date_format_matches_go() {
        let date = NaiveDate::from_ymd_opt(2026, 4, 5).unwrap();
        assert_eq!(date.format("%-d %b, %Y").to_string(), "5 Apr, 2026");
    }

    /// A notifier whose database is unreachable (sending only logs errors).
    fn offline_notifier() -> PhotoNotifier {
        let pool = PgPoolOptions::new()
            .acquire_timeout(Duration::from_millis(50))
            .connect_lazy("postgres://nobody@127.0.0.1:9/none")
            .unwrap();
        PhotoNotifier::new(
            Arc::new(UserRepository::new(pool.clone())),
            Arc::new(FollowRepository::new(pool.clone())),
            Arc::new(NotificationService::new(Arc::new(NotificationRepository::new(pool)))),
        )
    }

    fn pending(uploader_id: i64) -> PendingPhotoNotification {
        PendingPhotoNotification {
            uploader_id,
            uploader_username: "sam".into(),
            uploader_avatar: String::new(),
            photo_date: "2026-04-05".into(),
            photo_count: 1,
        }
    }

    #[tokio::test(start_paused = true)]
    async fn uploads_within_the_window_extend_it() {
        let notifier = offline_notifier();
        notifier.insert_pending(&mut *notifier.pending.lock().await, pending(7));

        tokio::time::sleep(Duration::from_secs(20)).await;
        // An existing entry is updated without looking the uploader up.
        notifier.schedule(7, "2026-04-06").await;
        tokio::time::sleep(Duration::from_secs(25)).await;
        let current = notifier.pending(7).await.expect("window was extended to 50 s");
        assert_eq!(current.photo_count, 2);
        assert_eq!(current.photo_date, "2026-04-05", "the first upload's date is kept");

        tokio::time::sleep(Duration::from_secs(6)).await;
        assert_eq!(notifier.pending(7).await, None, "sent after 30 s without uploads");
    }

    #[tokio::test(start_paused = true)]
    async fn cancel_and_flush_empty_the_queue() {
        let notifier = offline_notifier();
        notifier.insert_pending(&mut *notifier.pending.lock().await, pending(1));
        notifier.insert_pending(&mut *notifier.pending.lock().await, pending(2));
        notifier.cancel().await;
        assert_eq!(notifier.pending(1).await, None);

        notifier.insert_pending(&mut *notifier.pending.lock().await, pending(3));
        notifier.flush().await;
        assert_eq!(notifier.pending(3).await, None);
    }
}
