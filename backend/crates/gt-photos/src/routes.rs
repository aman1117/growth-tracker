//! Routes of the photo features (Go: `internal/routes/routes.go`, "Profile Picture" and
//! "Activity Photos (Stories)").

use std::sync::Arc;

use axum::http::StatusCode;
use axum::response::Response;
use axum::routing::{delete, get, post, MethodRouter};
use axum::Router;
use gt_core::guard::Guards;
use gt_core::response;
use gt_core::CoreContext;
use gt_notify::NotifyContext;
use gt_users::UsersContext;

use crate::context::PhotosContext;
use crate::handlers::{activity_photo as photo, blob, BlobHandler};
use crate::service::ActivityPhotoService;

/// The photo routes, registered only when blob storage is configured (Go registers them only
/// when the handlers exist). Empty when blob storage is disabled.
///
/// Profile pictures (inside the authenticated `/api/profile` group, so authentication runs for
/// every method of these paths):
///
/// | Method | Path | Middleware |
/// |---|---|---|
/// | `POST` | `/api/profile/upload-picture` | auth + upload limiter |
/// | `DELETE` | `/api/profile/picture` | auth + API limiter |
///
/// Activity photos (each route authenticated + API limiter, except the upload: auth + upload
/// limiter): `POST /api/activity-photo`, `DELETE /api/activity-photo/{id}`,
/// `GET /api/activity-photos`, `GET /api/activity-photos/following`,
/// `POST /api/activity-photo/{id}/view`, `GET /api/activity-photo/{id}/viewers`,
/// `POST`/`DELETE /api/activity-photo/{id}/like`, `GET /api/activity-photo/{id}/like-status`,
/// `GET /api/activity-photo/{id}/interactions`.
pub fn routes(core: &CoreContext, _users: &UsersContext, _notify: &NotifyContext, photos: &PhotosContext) -> Router {
    let mut router = Router::new();
    if let Some(handler) = &photos.blob_handler {
        router = router.merge(profile_picture_routes(&core.guards, handler.clone()));
    }
    if let Some(service) = &photos.activity_photo_service {
        router = router.merge(activity_photo_routes(&core.guards, service.clone()));
    }
    router
}

/// Fiber's `ErrMethodNotAllowed` (the path exists for another method).
async fn method_not_allowed() -> Response {
    response::text(StatusCode::METHOD_NOT_ALLOWED, "Method Not Allowed")
}

fn profile_picture_routes(guards: &Guards, handler: Arc<BlobHandler>) -> Router {
    // The `/api/profile` group authenticates every method before routing; the limiter is
    // per route.
    let in_group = |route: MethodRouter<Arc<BlobHandler>>| route.fallback(method_not_allowed).layer(guards.auth());
    Router::new()
        .route(
            "/api/profile/upload-picture",
            in_group(post(blob::upload_picture).route_layer(guards.limited(&guards.limiters.upload))),
        )
        .route(
            "/api/profile/picture",
            in_group(delete(blob::delete_picture).route_layer(guards.limited(&guards.limiters.api))),
        )
        .with_state(handler)
}

fn activity_photo_routes(guards: &Guards, service: Arc<ActivityPhotoService>) -> Router {
    let api = guards.api();
    Router::new()
        .route(
            "/api/activity-photo",
            post(photo::upload_photo).route_layer(guards.auth_limited(&guards.limiters.upload)),
        )
        .route("/api/activity-photo/{id}", delete(photo::delete_photo).route_layer(api.clone()))
        .route("/api/activity-photos", get(photo::get_photos).route_layer(api.clone()))
        .route("/api/activity-photos/following", get(photo::get_following_stories).route_layer(api.clone()))
        .route("/api/activity-photo/{id}/view", post(photo::record_view).route_layer(api.clone()))
        .route("/api/activity-photo/{id}/viewers", get(photo::get_photo_viewers).route_layer(api.clone()))
        .route(
            "/api/activity-photo/{id}/like",
            post(photo::like_photo).delete(photo::unlike_photo).route_layer(api.clone()),
        )
        .route("/api/activity-photo/{id}/like-status", get(photo::get_photo_like_status).route_layer(api.clone()))
        .route("/api/activity-photo/{id}/interactions", get(photo::get_photo_interactions).route_layer(api))
        .with_state(service)
}
