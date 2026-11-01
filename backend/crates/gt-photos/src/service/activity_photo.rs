//! Activity photos ("stories"): uploads to Azure Blob Storage, deletion, views and likes
//! (port of `internal/services/activity_photo_service.go`).

use std::sync::Arc;

use bytes::Bytes;
use chrono::NaiveDate;
use gt_core::config::AzureStorageConfig;
use gt_core::models::{ActivityPhoto, PhotoInteraction, PhotoLiker, PhotoViewer, UserStoryGroup};
use gt_core::timeutil::{format_date, today_ist};
use gt_notify::NotificationService;
use gt_users::repository::{FollowRepository, UserRepository};

use super::error::{BlobSetupError, PhotoError};
use super::notifier::{PendingPhotoNotification, PhotoNotifier};
use super::tasks::BackgroundTasks;
use crate::blob::{activity_photo_blob_names, new_blob_id, with_deadline, BlobError, BlobStore};
use crate::blob::{DELETE_TIMEOUT, UPLOAD_TIMEOUT};
use crate::form::UploadedFile;
use crate::image_processor::ImageProcessor;
use crate::repository::{ActivityPhotoRepository, NewActivityPhoto};
use crate::validation::{validate_photo_date, validate_photo_size};

/// What the client sent with an activity photo (the multipart form fields).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PhotoUpload {
    pub activity_name: String,
    pub photo_date: NaiveDate,
    /// Custom tile metadata; empty strings are stored as `NULL`.
    pub activity_icon: String,
    pub activity_color: String,
    pub activity_label: String,
}

impl PhotoUpload {
    /// An upload without custom tile metadata.
    pub fn new(activity_name: impl Into<String>, photo_date: NaiveDate) -> Self {
        Self {
            activity_name: activity_name.into(),
            photo_date,
            activity_icon: String::new(),
            activity_color: String::new(),
            activity_label: String::new(),
        }
    }
}

/// Activity photo business logic (Go `ActivityPhotoService`).
pub struct ActivityPhotoService {
    repo: Arc<ActivityPhotoRepository>,
    follow_repo: Arc<FollowRepository>,
    processor: ImageProcessor,
    store: Option<BlobStore>,
    notifier: PhotoNotifier,
    tasks: BackgroundTasks,
}

impl std::fmt::Debug for ActivityPhotoService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ActivityPhotoService").field("store", &self.store).finish_non_exhaustive()
    }
}

impl ActivityPhotoService {
    /// A service uploading to `store`; without one, uploads fail with
    /// `blob storage is not configured`.
    pub fn new(
        repo: Arc<ActivityPhotoRepository>,
        user_repo: Arc<UserRepository>,
        follow_repo: Arc<FollowRepository>,
        notifications: Arc<NotificationService>,
        store: Option<BlobStore>,
    ) -> Self {
        let notifier = PhotoNotifier::new(user_repo, follow_repo.clone(), notifications);
        Self { repo, follow_repo, processor: ImageProcessor::new(), store, notifier, tasks: BackgroundTasks::default() }
    }

    /// Go `NewActivityPhotoService`: blob storage from the configuration (none when the
    /// connection string is empty); an invalid connection string is an error.
    /// `development` selects Azurite public URLs.
    pub fn from_config(
        repo: Arc<ActivityPhotoRepository>,
        user_repo: Arc<UserRepository>,
        follow_repo: Arc<FollowRepository>,
        notifications: Arc<NotificationService>,
        cfg: &AzureStorageConfig,
        development: bool,
    ) -> Result<Self, BlobSetupError> {
        let store = BlobStore::from_config(cfg, development).map_err(BlobSetupError)?;
        Ok(Self::new(repo, user_repo, follow_repo, notifications, store))
    }

    /// The container photos are uploaded to, if configured.
    pub fn blob_store(&self) -> Option<&BlobStore> {
        self.store.as_ref()
    }

    pub fn repository(&self) -> &Arc<ActivityPhotoRepository> {
        &self.repo
    }

    // ==================== Upload and delete ====================

    /// Validates the date (IST, last 7 days) and size, rejects a second photo for the same
    /// activity and day, converts the image, uploads it and its thumbnail and stores the row.
    /// Blobs already uploaded are removed when a later step fails. Followers are notified
    /// after the debounce window.
    pub async fn upload(
        &self,
        user_id: i64,
        upload: &PhotoUpload,
        file: &UploadedFile,
    ) -> Result<ActivityPhoto, PhotoError> {
        validate_photo_date(upload.photo_date, today_ist())?;
        validate_photo_size(file.size)?;

        let existing = self
            .repo
            .get_existing(user_id, &upload.activity_name, upload.photo_date)
            .await
            .map_err(PhotoError::db("failed to check existing photo"))?;
        if existing.is_some() {
            return Err(PhotoError::AlreadyExists);
        }

        let processed = self
            .processor
            .process_blocking(file.data.clone(), file.filename.clone())
            .await
            .map_err(PhotoError::Process)?;

        let date = format_date(&upload.photo_date);
        let names = activity_photo_blob_names(user_id, &date, &upload.activity_name, &new_blob_id());
        let store = self.store.as_ref().ok_or(PhotoError::StorageNotConfigured)?;

        let photo_url = upload_blob(store, &names.full, processed.full, processed.mime_type)
            .await
            .map_err(PhotoError::UploadFull)?;
        let thumbnail_url = match upload_blob(store, &names.thumbnail, processed.thumbnail, processed.mime_type).await {
            Ok(url) => url,
            Err(err) => {
                delete_blob(store, &names.full).await;
                return Err(PhotoError::UploadThumbnail(err));
            }
        };

        let new_photo = NewActivityPhoto {
            user_id,
            activity_name: upload.activity_name.clone(),
            photo_date: upload.photo_date,
            photo_url,
            thumbnail_url,
            activity_icon: non_empty(&upload.activity_icon),
            activity_color: non_empty(&upload.activity_color),
            activity_label: non_empty(&upload.activity_label),
        };
        let photo = match self.repo.create(&new_photo).await {
            Ok(photo) => photo,
            Err(err) => {
                delete_blob(store, &names.full).await;
                delete_blob(store, &names.thumbnail).await;
                return Err(PhotoError::db("failed to save photo")(err));
            }
        };

        let notifier = self.notifier.clone();
        let photo_date = date.clone();
        self.tasks.spawn(async move { notifier.schedule(user_id, &photo_date).await });

        tracing::info!(
            user_id,
            activity_name = %upload.activity_name,
            photo_date = %date,
            photo_id = photo.id,
            "Activity photo uploaded"
        );
        Ok(photo)
    }

    /// Deletes the owner's photo and its blobs (blob failures are only logged; views and likes
    /// cascade).
    pub async fn delete(&self, photo_id: i64, user_id: i64) -> Result<(), PhotoError> {
        let photo = self
            .repo
            .get_by_id(photo_id)
            .await
            .map_err(PhotoError::db("failed to get photo"))?
            .ok_or(PhotoError::NotFound)?;
        if photo.user_id != user_id {
            return Err(PhotoError::DeleteForbidden);
        }

        self.delete_photo_blobs(&photo).await;
        self.repo.delete(photo_id).await.map_err(PhotoError::db("failed to delete photo"))?;

        tracing::info!(photo_id, user_id, "Activity photo deleted");
        Ok(())
    }

    /// Deletes every photo of one of the user's activities (custom tile removal).
    pub async fn delete_by_activity(&self, user_id: i64, activity_name: &str) -> Result<(), PhotoError> {
        let photos = self
            .repo
            .get_by_activity_name(user_id, activity_name)
            .await
            .map_err(PhotoError::db("failed to get photos"))?;
        for photo in &photos {
            self.delete_photo_blobs(photo).await;
        }
        self.repo
            .delete_by_user_and_activity(user_id, activity_name)
            .await
            .map_err(PhotoError::db("failed to delete photos"))?;

        tracing::info!(user_id, activity_name, count = photos.len(), "Activity photos deleted for tile");
        Ok(())
    }

    /// Deletes the blobs behind a photo's URLs; URLs outside the container are left alone.
    async fn delete_photo_blobs(&self, photo: &ActivityPhoto) {
        let Some(store) = &self.store else {
            tracing::debug!(photo_id = photo.id, "Blob storage not configured; photo blobs not deleted");
            return;
        };
        for url in [&photo.photo_url, &photo.thumbnail_url] {
            let blob_name = store.blob_name_from_url(url);
            if !blob_name.is_empty() {
                delete_blob(store, &blob_name).await;
            }
        }
    }

    // ==================== Reads and views ====================

    /// A user's photos of one day.
    pub async fn get_by_user_and_date(
        &self,
        user_id: i64,
        photo_date: NaiveDate,
    ) -> Result<Vec<ActivityPhoto>, PhotoError> {
        self.repo.get_by_user_and_date(user_id, photo_date).await.map_err(PhotoError::repository)
    }

    /// Story groups of the users the viewer follows (`None` when there are none).
    pub async fn get_following_stories(
        &self,
        viewer_id: i64,
        photo_date: NaiveDate,
        limit: i64,
    ) -> Result<Option<Vec<UserStoryGroup>>, PhotoError> {
        self.repo.get_following_photos_grouped(viewer_id, photo_date, limit).await.map_err(PhotoError::repository)
    }

    /// Records that the viewer saw the photo; the owner's own views are not recorded.
    pub async fn record_view(&self, viewer_id: i64, photo_id: i64) -> Result<(), PhotoError> {
        let photo = self.repo.get_by_id(photo_id).await.map_err(PhotoError::repository)?.ok_or(PhotoError::NotFound)?;
        if photo.user_id == viewer_id {
            return Ok(());
        }
        self.repo.record_view(viewer_id, photo_id).await.map_err(PhotoError::repository)
    }

    /// A page of the photo's viewers and their total (owner only).
    pub async fn get_viewers(
        &self,
        photo_id: i64,
        owner_id: i64,
        limit: i64,
        offset: i64,
    ) -> Result<(Option<Vec<PhotoViewer>>, i64), PhotoError> {
        self.owned_photo(photo_id, owner_id, PhotoError::ViewersForbidden).await?;
        self.repo.get_viewers(photo_id, limit, offset).await.map_err(PhotoError::repository)
    }

    pub async fn get_view_count(&self, photo_id: i64) -> Result<i64, PhotoError> {
        self.repo.get_view_count(photo_id).await.map_err(PhotoError::repository)
    }

    pub async fn get_by_id(&self, photo_id: i64) -> Result<Option<ActivityPhoto>, PhotoError> {
        self.repo.get_by_id(photo_id).await.map_err(PhotoError::repository)
    }

    /// Users always see their own stories; others must follow them.
    pub async fn can_view_stories(&self, viewer_id: i64, target_user_id: i64) -> Result<bool, PhotoError> {
        self.follows(viewer_id, target_user_id).await.map_err(PhotoError::repository)
    }

    async fn follows(&self, viewer_id: i64, target_user_id: i64) -> Result<bool, sqlx::Error> {
        if viewer_id == target_user_id {
            return Ok(true);
        }
        self.follow_repo.is_following(viewer_id, target_user_id).await
    }

    /// The photo when `owner_id` owns it; `forbidden` otherwise.
    async fn owned_photo(
        &self,
        photo_id: i64,
        owner_id: i64,
        forbidden: PhotoError,
    ) -> Result<ActivityPhoto, PhotoError> {
        let photo = self.repo.get_by_id(photo_id).await.map_err(PhotoError::repository)?.ok_or(PhotoError::NotFound)?;
        if photo.user_id != owner_id {
            return Err(forbidden);
        }
        Ok(photo)
    }

    // ==================== Likes ====================

    /// Likes a followed user's photo (liking counts as viewing). Idempotent: an existing like
    /// returns early without touching the cache or notifying again. The owner is notified in
    /// the background.
    pub async fn like_photo(&self, liker_id: i64, photo_id: i64) -> Result<(), PhotoError> {
        let photo = self
            .repo
            .get_by_id(photo_id)
            .await
            .map_err(PhotoError::db("failed to get photo"))?
            .ok_or(PhotoError::NotFound)?;
        if photo.user_id == liker_id {
            return Err(PhotoError::CannotLikeOwnPhoto);
        }
        let can_view =
            self.follows(liker_id, photo.user_id).await.map_err(PhotoError::db("failed to check permissions"))?;
        if !can_view {
            return Err(PhotoError::MustFollow);
        }

        let already_liked = self.repo.has_liked_photo(liker_id, photo_id).await.unwrap_or_else(|err| {
            tracing::warn!(error = %err, photo_id, liker_id, "Failed to check existing like");
            false
        });
        if already_liked {
            tracing::info!(photo_id, liker_id, "Photo already liked, returning early");
            return Ok(());
        }

        self.repo.like_photo(liker_id, photo_id).await.map_err(PhotoError::db("failed to like photo"))?;
        if let Err(err) = self.repo.record_view(liker_id, photo_id).await {
            tracing::warn!(error = %err, photo_id, liker_id, "Failed to record view on like");
        }

        // Cache updates are best effort, as in Go (errors ignored).
        let _ = gt_core::redis::increment_story_like_count(photo_id).await;
        let _ = gt_core::redis::set_story_liked_by_user(photo_id, liker_id, true).await;

        let owner_id = photo.user_id;
        let notifier = self.notifier.clone();
        self.tasks.spawn(async move { notifier.send_like_notification_within_budget(liker_id, &photo).await });

        tracing::info!(photo_id, liker_id, owner_id, "Photo liked");
        Ok(())
    }

    /// Removes a like (a missing like is not an error).
    pub async fn unlike_photo(&self, liker_id: i64, photo_id: i64) -> Result<(), PhotoError> {
        self.repo
            .get_by_id(photo_id)
            .await
            .map_err(PhotoError::db("failed to get photo"))?
            .ok_or(PhotoError::NotFound)?;
        self.repo.unlike_photo(liker_id, photo_id).await.map_err(PhotoError::db("failed to unlike photo"))?;

        let _ = gt_core::redis::decrement_story_like_count(photo_id).await;
        let _ = gt_core::redis::set_story_liked_by_user(photo_id, liker_id, false).await;

        tracing::info!(photo_id, liker_id, "Photo unliked");
        Ok(())
    }

    /// Whether the user liked the photo: Redis first, then the database (which refills the
    /// cache). Cache failures fall back to the database.
    pub async fn has_liked_photo(&self, liker_id: i64, photo_id: i64) -> Result<bool, PhotoError> {
        match gt_core::redis::get_story_liked_by_user(photo_id, liker_id).await {
            Ok((liked, true)) => return Ok(liked),
            Ok(_) => {}
            Err(err) => tracing::warn!(error = %err, "Failed to get liked status from cache"),
        }
        let liked = self.repo.has_liked_photo(liker_id, photo_id).await.map_err(PhotoError::repository)?;
        let _ = gt_core::redis::set_story_liked_by_user(photo_id, liker_id, liked).await;
        Ok(liked)
    }

    /// The photo's like count: Redis first, then the database (which refills the cache).
    pub async fn get_photo_like_count(&self, photo_id: i64) -> Result<i64, PhotoError> {
        match gt_core::redis::get_story_like_count(photo_id).await {
            Ok(count) if count >= 0 => return Ok(count),
            Ok(_) => {}
            Err(err) => tracing::warn!(error = %err, "Failed to get like count from cache"),
        }
        let count = self.repo.get_photo_like_count(photo_id).await.map_err(PhotoError::repository)?;
        let _ = gt_core::redis::set_story_like_count(photo_id, count).await;
        Ok(count)
    }

    /// A page of the photo's likers and their total (owner only).
    pub async fn get_photo_likers(
        &self,
        photo_id: i64,
        owner_id: i64,
        limit: i64,
        offset: i64,
    ) -> Result<(Option<Vec<PhotoLiker>>, i64), PhotoError> {
        self.owned_photo(photo_id, owner_id, PhotoError::LikersForbidden).await?;
        self.repo.get_photo_likers(photo_id, limit, offset).await.map_err(PhotoError::repository)
    }

    /// Viewers and likers combined, with the number of distinct users (owner only).
    pub async fn get_photo_interactions(
        &self,
        photo_id: i64,
        owner_id: i64,
        limit: i64,
        offset: i64,
    ) -> Result<(Option<Vec<PhotoInteraction>>, i64), PhotoError> {
        self.owned_photo(photo_id, owner_id, PhotoError::InteractionsForbidden).await?;
        self.repo.get_photo_interactions(photo_id, limit, offset).await.map_err(PhotoError::repository)
    }

    // ==================== Notifications ====================

    /// Counts an upload into the uploader's debounced follower notification (normally done
    /// by [`ActivityPhotoService::upload`]).
    pub async fn schedule_notification(&self, uploader_id: i64, photo_date: &str) {
        self.notifier.schedule(uploader_id, photo_date).await;
    }

    /// The uploader's notification waiting for its debounce window, if any.
    pub async fn pending_notification(&self, uploader_id: i64) -> Option<PendingPhotoNotification> {
        self.notifier.pending(uploader_id).await
    }

    /// Sends every pending upload notification now (e.g. before shutting down).
    pub async fn flush_pending_notifications(&self) {
        self.notifier.flush().await;
    }

    /// Drops every pending upload notification without sending it.
    pub async fn cancel_pending_notifications(&self) {
        self.notifier.cancel().await;
    }

    /// Notifies the uploader's followers about `pending` right away.
    pub async fn send_photo_notification(&self, pending: &PendingPhotoNotification) {
        self.notifier.send_photo_notification(pending).await;
    }

    /// Notifies the photo's owner about a like, once per liker and photo.
    pub async fn send_like_notification(&self, liker_id: i64, photo: &ActivityPhoto) {
        self.notifier.send_like_notification(liker_id, photo).await;
    }

    /// Waits until background work started by uploads and likes (scheduling, like
    /// notifications) has finished. Debounce timers are not waited for.
    pub async fn wait_for_background_tasks(&self) {
        self.tasks.wait_idle().await;
    }
}

fn non_empty(value: &str) -> Option<String> {
    (!value.is_empty()).then(|| value.to_string())
}

/// Uploads one blob within Go's 60 s budget and returns its public URL.
async fn upload_blob(store: &BlobStore, blob_name: &str, data: Bytes, content_type: &str) -> Result<String, BlobError> {
    with_deadline(UPLOAD_TIMEOUT, store.upload(blob_name, data, content_type)).await
}

/// Deletes one blob within Go's 30 s budget; failures are only logged.
async fn delete_blob(store: &BlobStore, blob_name: &str) {
    if let Err(err) = with_deadline(DELETE_TIMEOUT, store.delete(blob_name)).await {
        tracing::warn!(blob_name, error = %err, "Failed to delete blob");
    }
}
