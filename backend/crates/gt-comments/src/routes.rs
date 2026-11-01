//! Comment routes, with the per-route middleware of `internal/routes/routes.go`.

use axum::routing::{delete, get, post, put};
use axum::Router;
use gt_core::CoreContext;
use gt_notify::NotifyContext;
use gt_users::UsersContext;

use crate::context::CommentsContext;
use crate::handlers::{self, CommentsState};

/// Every comment route (auth on all of them; `comment` / `comment_like` / API rate limiters as
/// in Go):
///
/// | Method | Path | Limiter |
/// |---|---|---|
/// | `POST` | `/api/days/{username}/{date}/comments` | comment |
/// | `GET` | `/api/days/{username}/{date}/comments` | api |
/// | `GET` | `/api/days/{username}/{date}/comments/count` | api |
/// | `POST` | `/api/days/{username}/{date}/comments/{commentId}/replies` | comment |
/// | `DELETE` | `/api/comments/{commentId}` | api |
/// | `PUT` | `/api/comments/{commentId}` | comment |
/// | `POST` | `/api/comments/{commentId}/like` | comment_like |
/// | `DELETE` | `/api/comments/{commentId}/like` | comment_like |
/// | `GET` | `/api/comments/{commentId}/replies` | api |
///
/// Guards are route layers, so other methods on these paths fall through to the server's
/// `405 Method Not Allowed` without authentication, like Fiber.
pub fn routes(core: &CoreContext, users: &UsersContext, _notify: &NotifyContext, comments: &CommentsContext) -> Router {
    let state = CommentsState {
        comments: comments.comment_service.clone(),
        auth: users.auth_service.clone(),
        profiles: users.profile_service.clone(),
    };
    let guards = &core.guards;
    let api = guards.api();
    let comment = guards.auth_limited(&guards.limiters.comment);
    let comment_like = guards.auth_limited(&guards.limiters.comment_like);

    Router::new()
        .route(
            "/api/days/{username}/{date}/comments",
            post(handlers::create_comment)
                .route_layer(comment.clone())
                .merge(get(handlers::get_comments).route_layer(api.clone())),
        )
        .route("/api/days/{username}/{date}/comments/count", get(handlers::get_comment_count).route_layer(api.clone()))
        .route(
            "/api/days/{username}/{date}/comments/{commentId}/replies",
            post(handlers::create_reply).route_layer(comment.clone()),
        )
        .route(
            "/api/comments/{commentId}",
            delete(handlers::delete_comment)
                .route_layer(api.clone())
                .merge(put(handlers::edit_comment).route_layer(comment)),
        )
        .route(
            "/api/comments/{commentId}/like",
            post(handlers::like_comment)
                .route_layer(comment_like.clone())
                .merge(delete(handlers::unlike_comment).route_layer(comment_like)),
        )
        .route("/api/comments/{commentId}/replies", get(handlers::get_replies).route_layer(api))
        .with_state(state)
}
