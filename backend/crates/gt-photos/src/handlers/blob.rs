//! Profile picture upload and removal (port of `internal/handlers/blob.go`).

use std::sync::Arc;

use axum::extract::State;
use axum::response::IntoResponse;
use gt_core::config::AzureStorageConfig;
use gt_core::constants as c;
use gt_core::error::{ApiError, ApiResult};
use gt_core::extract::AuthUser;
use gt_core::models::User;
use gt_core::response;
use tokio::time::Instant;

use super::detached;
use crate::blob::{new_blob_id, profile_picture_blob_names, with_deadline, BlobNames, BlobStore};
use crate::blob::{CREATE_CONTAINER_TIMEOUT, DELETE_TIMEOUT, UPLOAD_TIMEOUT};
use crate::dto::ProfilePictureResponse;
use crate::form::{FormRequest, UploadedFile};
use crate::image_processor::{ImageProcessor, ProcessedImages, MIME_JPEG};
use crate::service::{BlobService, BlobSetupError};
use crate::validation::{no_image_error, validate_profile_picture};

/// Profile picture endpoints (Go `BlobHandler`): images are resized to at most 1080 px with
/// a 200 px square thumbnail and stored as `<userID>/<uuid>.jpg` / `_thumb.jpg`.
#[derive(Debug)]
pub struct BlobHandler {
    blob_svc: Arc<BlobService>,
    store: Option<BlobStore>,
    processor: ImageProcessor,
}

impl BlobHandler {
    /// Go `NewBlobHandler` without the container creation, which is async (run
    /// [`BlobHandler::init`] at startup): disabled without a connection string, an error for an
    /// invalid one. `development` selects Azurite public URLs.
    pub fn new(
        blob_svc: Arc<BlobService>,
        cfg: &AzureStorageConfig,
        development: bool,
    ) -> Result<Self, BlobSetupError> {
        let store = BlobStore::from_config(cfg, development).map_err(BlobSetupError)?;
        Ok(Self::with_store(blob_svc, store))
    }

    /// A handler on an explicit container (`None`: uploads answer 503).
    pub fn with_store(blob_svc: Arc<BlobService>, store: Option<BlobStore>) -> Self {
        Self { blob_svc, store, processor: ImageProcessor::profile_picture() }
    }

    /// Whether blob storage is configured.
    pub fn is_enabled(&self) -> bool {
        self.store.is_some()
    }

    pub fn blob_store(&self) -> Option<&BlobStore> {
        self.store.as_ref()
    }

    /// Creates the container (30 s budget). An existing container is fine; other failures are
    /// only logged and the handler stays enabled, as in Go.
    pub async fn init(&self) {
        let Some(store) = &self.store else { return };
        if let Err(err) = with_deadline(CREATE_CONTAINER_TIMEOUT, store.ensure_container()).await {
            tracing::warn!(container = store.container(), error = %err, "Container creation warning: {err}");
        }
        tracing::info!("Azure Blob Storage initialized successfully");
    }

    /// Converts and stores a new profile picture, replacing the previous one. Go checks, in
    /// order: storage configured, file present, size, extension, image decodes, user exists.
    pub async fn upload_profile_picture(self: Arc<Self>, user_id: i64, form: &FormRequest) -> ApiResult {
        if !self.is_enabled() {
            return Err(ApiError::service_unavailable("Profile picture upload is not configured"));
        }
        let file = form.file("image").map_err(|_| no_image_error())?.clone();
        validate_profile_picture(&file)?;
        detached(async move { self.store_profile_picture(user_id, file).await }).await
    }

    async fn store_profile_picture(&self, user_id: i64, file: UploadedFile) -> ApiResult {
        let store = self
            .store
            .as_ref()
            .ok_or_else(|| ApiError::service_unavailable("Profile picture upload is not configured"))?;
        let processed = self.processor.process_blocking(file.data, file.filename).await.map_err(|err| {
            tracing::warn!(user_id, error = %err, "Profile picture processing failed");
            ApiError::bad_request(format!("Failed to process image: {err}"), c::ERR_CODE_INVALID_REQUEST)
        })?;
        let names = profile_picture_blob_names(user_id, &new_blob_id());

        let user = self.find_user(user_id).await?;
        delete_old_blobs(store, &user).await;

        let (full_url, thumb_url) = upload_pair(store, &names, &processed).await?;
        if let Err(err) = self.blob_svc.update_profile_pic(user_id, Some(&full_url), Some(&thumb_url)).await {
            tracing::error!(user_id, error = %err, "Failed to save profile picture URLs");
            return Err(update_failed());
        }

        tracing::info!(
            user_id,
            full_url = %full_url,
            thumb_url = %thumb_url,
            full_size_bytes = processed.full_size,
            thumb_size_bytes = processed.thumb_size,
            "Profile picture uploaded"
        );
        Ok(response::json(&ProfilePictureResponse {
            profile_pic: full_url,
            profile_pic_thumb: thumb_url,
            success: true,
        }))
    }

    /// Deletes the user's picture blobs (failures are only logged) and clears both URLs.
    pub async fn delete_profile_picture(self: Arc<Self>, user_id: i64) -> ApiResult {
        detached(async move { self.remove_profile_picture(user_id).await }).await
    }

    async fn remove_profile_picture(&self, user_id: i64) -> ApiResult {
        let user = self.find_user(user_id).await?;
        if let Some(store) = &self.store {
            delete_old_blobs(store, &user).await;
        }
        if let Err(err) = self.blob_svc.update_profile_pic(user_id, None, None).await {
            tracing::error!(user_id, error = %err, "Failed to clear profile picture URLs");
            return Err(update_failed());
        }
        tracing::info!(user_id, "Profile picture deleted");
        Ok(response::success(c::MSG_PROFILE_PIC_DELETED))
    }

    /// The user, or 404 `User not found` (also when the lookup fails, as in Go).
    async fn find_user(&self, user_id: i64) -> Result<User, ApiError> {
        match self.blob_svc.get_user(user_id).await {
            Ok(Some(user)) => Ok(user),
            Ok(None) => Err(user_not_found()),
            Err(err) => {
                tracing::warn!(user_id, error = %err, "Failed to look up user for profile picture");
                Err(user_not_found())
            }
        }
    }
}

fn user_not_found() -> ApiError {
    ApiError::not_found("User not found", c::ERR_CODE_USER_NOT_FOUND)
}

fn update_failed() -> ApiError {
    ApiError::internal("Failed to update profile", c::ERR_CODE_UPDATE_FAILED)
}

fn upload_failed() -> ApiError {
    ApiError::internal("Failed to upload image", c::ERR_CODE_SERVER_ERROR)
}

/// Uploads the full image, then the thumbnail, under one 60 s budget; the full image is
/// removed again when the thumbnail fails. Returns both public URLs.
async fn upload_pair(
    store: &BlobStore,
    names: &BlobNames,
    processed: &ProcessedImages,
) -> Result<(String, String), ApiError> {
    let deadline = Instant::now() + UPLOAD_TIMEOUT;
    let remaining = || deadline.saturating_duration_since(Instant::now());

    let full_url = with_deadline(remaining(), store.upload(&names.full, processed.full.clone(), MIME_JPEG))
        .await
        .map_err(|err| {
            tracing::error!(error = %err, "Failed to upload profile pic blob");
            upload_failed()
        })?;
    match with_deadline(remaining(), store.upload(&names.thumbnail, processed.thumbnail.clone(), MIME_JPEG)).await {
        Ok(thumb_url) => Ok((full_url, thumb_url)),
        Err(err) => {
            let _ = with_deadline(remaining(), store.delete(&names.full)).await;
            tracing::error!(error = %err, "Failed to upload profile pic thumbnail");
            Err(upload_failed())
        }
    }
}

/// Deletes the blobs behind the user's current picture URLs (one 30 s budget); URLs outside
/// the container are left alone and failures are only logged.
async fn delete_old_blobs(store: &BlobStore, user: &User) {
    let deadline = Instant::now() + DELETE_TIMEOUT;
    let pictures = [
        (user.profile_pic.as_deref(), "Failed to delete old profile pic blob"),
        (user.profile_pic_thumb.as_deref(), "Failed to delete old profile pic thumbnail blob"),
    ];
    for (url, failure) in pictures {
        let Some(url) = url.filter(|url| !url.is_empty()) else { continue };
        let blob_name = store.blob_name_from_url(url);
        if blob_name.is_empty() {
            continue;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if let Err(err) = with_deadline(remaining, store.delete(&blob_name)).await {
            tracing::warn!(error = %err, blob_name = %blob_name, "{failure}");
        }
    }
}

// ==================== Axum handlers ====================

/// `POST /api/profile/upload-picture` (multipart field `image`).
pub(crate) async fn upload_picture(
    State(handler): State<Arc<BlobHandler>>,
    user: AuthUser,
    form: FormRequest,
) -> axum::response::Response {
    handler.upload_profile_picture(user.user_id, &form).await.into_response()
}

/// `DELETE /api/profile/picture`.
pub(crate) async fn delete_picture(State(handler): State<Arc<BlobHandler>>, user: AuthUser) -> ApiResult {
    handler.delete_profile_picture(user.user_id).await
}
