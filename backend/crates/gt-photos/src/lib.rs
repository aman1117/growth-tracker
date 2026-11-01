//! Profile pictures and activity photo stories: Azure Blob Storage, image processing, the
//! `activity_photos` / `story_views` / `story_likes` repository, the services, HTTP handlers
//! and routes.
//!
//! Port of the Go backend's `BlobService` / `BlobHandler`, `ImageProcessor`,
//! `ActivityPhotoRepository` / `ActivityPhotoService` / `ActivityPhotoHandler` and
//! `cmd/backfill_profile_thumbs`.
//!
//! Server wiring:
//!
//! ```ignore
//! let photos = gt_photos::PhotosContext::new(&core, &users, &notify);
//! photos.init().await; // creates the blob container, like Go's NewBlobHandler
//! let app = Router::new().merge(gt_photos::routes(&core, &users, &notify, &photos));
//! ```

pub mod backfill;
pub mod blob;
pub mod context;
pub mod dto;
pub mod form;
pub mod handlers;
pub mod image_processor;
pub mod repository;
pub mod routes;
pub mod service;
pub mod validation;

pub use blob::{BlobClient, BlobError, BlobStore, PublicUrls};
pub use context::PhotosContext;
pub use form::{FormError, FormRequest, UploadedFile};
pub use handlers::BlobHandler;
pub use image_processor::{ImageProcessError, ImageProcessor, ProcessedImages};
pub use repository::{ActivityPhotoRepository, NewActivityPhoto};
pub use routes::routes;
pub use service::{
    ActivityPhotoService, BlobService, BlobSetupError, PendingPhotoNotification, PhotoError, PhotoUpload,
};
