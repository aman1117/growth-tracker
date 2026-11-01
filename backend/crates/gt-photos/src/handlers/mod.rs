//! HTTP handlers (port of `internal/handlers/blob.go` and `activity_photo.go`).

pub mod activity_photo;
pub mod blob;

use std::future::Future;

use gt_core::error::{ApiError, ApiResult};

pub use blob::BlobHandler;

/// Runs `work` as its own task and waits for it. Dropping the request (client disconnect)
/// then does not abort a multi-step upload or delete halfway, matching Fiber, whose handlers
/// always ran to completion. A panic is resumed so the server's panic handler answers it.
pub(crate) async fn detached<F>(work: F) -> ApiResult
where
    F: Future<Output = ApiResult> + Send + 'static,
{
    match tokio::spawn(work).await {
        Ok(result) => result,
        Err(err) if err.is_panic() => std::panic::resume_unwind(err.into_panic()),
        Err(err) => {
            tracing::error!(error = %err, "Request task cancelled");
            Err(ApiError::server_error())
        }
    }
}
