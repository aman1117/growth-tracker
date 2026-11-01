//! Wiring of the photo features (Go: the blob and activity photo parts of
//! `internal/container/container.go`).

use std::sync::Arc;

use gt_core::CoreContext;
use gt_notify::NotifyContext;
use gt_users::UsersContext;

use crate::handlers::BlobHandler;
use crate::repository::ActivityPhotoRepository;
use crate::service::{ActivityPhotoService, BlobService};

/// Repositories, services and handler state of the photo features. Cheap to clone.
///
/// Blob storage is optional: without `AZURE_STORAGE_CONNECTION_STRING` (or with one the blob
/// client rejects) `blob_handler` and `activity_photo_service` are `None` and
/// [`crate::routes`] registers neither the profile picture nor the activity photo routes.
#[derive(Debug, Clone)]
pub struct PhotosContext {
    /// Always available (the tile configuration renames photo labels through it).
    pub activity_photo_repo: Arc<ActivityPhotoRepository>,
    /// Profile picture bookkeeping (Go `BlobService`); always available.
    pub blob_service: Arc<BlobService>,
    /// Profile picture endpoints (Go `BlobHandler`).
    pub blob_handler: Option<Arc<BlobHandler>>,
    /// Activity photo stories (Go `ActivityPhotoService`).
    pub activity_photo_service: Option<Arc<ActivityPhotoService>>,
}

impl PhotosContext {
    /// Builds everything without I/O. The server must then await [`PhotosContext::init`]
    /// before serving (Go created the container inside `NewBlobHandler`).
    pub fn new(core: &CoreContext, users: &UsersContext, notify: &NotifyContext) -> Self {
        let storage = &core.config.azure_storage;
        let development = core.config.is_development();
        let activity_photo_repo = Arc::new(ActivityPhotoRepository::new(core.pool.clone()));
        let blob_service = Arc::new(BlobService::new(users.user_repo.clone(), storage));

        if storage.connection_string.is_empty() {
            tracing::warn!("Azure Blob Storage not configured; profile picture and activity photo routes disabled");
            return Self { activity_photo_repo, blob_service, blob_handler: None, activity_photo_service: None };
        }

        let activity_photo_service = match ActivityPhotoService::from_config(
            activity_photo_repo.clone(),
            users.user_repo.clone(),
            users.follow_repo.clone(),
            notify.notification_service.clone(),
            storage,
            development,
        ) {
            Ok(service) => Some(Arc::new(service)),
            Err(err) => {
                tracing::warn!(error = %err, "Activity photo service unavailable; activity photo routes disabled");
                None
            }
        };
        let blob_handler = match BlobHandler::new(blob_service.clone(), storage, development) {
            Ok(handler) => Some(Arc::new(handler)),
            Err(err) => {
                tracing::warn!(error = %err, "Blob storage unavailable; profile picture routes disabled");
                None
            }
        };
        Self { activity_photo_repo, blob_service, blob_handler, activity_photo_service }
    }

    /// Startup I/O: creates the blob container (30 s budget; failures are only logged, as in
    /// Go). Does nothing when blob storage is disabled.
    pub async fn init(&self) {
        if let Some(handler) = &self.blob_handler {
            handler.init().await;
        }
    }

    /// Whether the profile picture routes are served.
    pub fn profile_pictures_enabled(&self) -> bool {
        self.blob_handler.is_some()
    }

    /// Whether the activity photo routes are served.
    pub fn activity_photos_enabled(&self) -> bool {
        self.activity_photo_service.is_some()
    }
}
