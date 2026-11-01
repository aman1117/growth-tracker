//! Routes of the challenge feature (Go: `internal/routes/routes.go`, "Challenges").

use axum::routing::{get, post};
use axum::Router;
use gt_core::CoreContext;
use gt_notify::NotifyContext;
use gt_users::UsersContext;

use crate::context::ChallengesContext;
use crate::handlers;

/// Every challenge route. Reads use authentication + the API limiter, writes authentication +
/// the challenge write limiter (30/min per user). The guards are route layers, so a method
/// without a handler gets the server's 405 without authentication, like Fiber.
///
/// | Method   | Path                                       | Guard           |
/// |----------|--------------------------------------------|-----------------|
/// | `GET`    | `/api/challenges`                          | api             |
/// | `POST`   | `/api/challenges`                          | challenge write |
/// | `GET`    | `/api/challenges/{id}`                     | api             |
/// | `DELETE` | `/api/challenges/{id}`                     | challenge write |
/// | `POST`   | `/api/challenges/{id}/leave`               | challenge write |
/// | `POST`   | `/api/challenges/{id}/cheers`              | challenge write |
/// | `GET`    | `/api/challenges/{id}/invite-candidates`   | api             |
/// | `POST`   | `/api/challenges/{id}/invites`             | challenge write |
/// | `GET`    | `/api/challenge-codes/{code}`              | api             |
/// | `POST`   | `/api/challenge-codes/{code}/join`         | challenge write |
pub fn routes(
    core: &CoreContext,
    _users: &UsersContext,
    _notify: &NotifyContext,
    challenges: &ChallengesContext,
) -> Router {
    let guards = &core.guards;
    let read = guards.api();
    let write = guards.auth_limited(&guards.limiters.challenge_write);

    Router::new()
        .route(
            "/api/challenges",
            get(handlers::list_challenges)
                .route_layer(read.clone())
                .merge(post(handlers::create_challenge).route_layer(write.clone())),
        )
        .route(
            "/api/challenges/{id}",
            get(handlers::get_challenge)
                .route_layer(read.clone())
                .merge(axum::routing::delete(handlers::delete_challenge).route_layer(write.clone())),
        )
        .route("/api/challenges/{id}/leave", post(handlers::leave_challenge).route_layer(write.clone()))
        .route("/api/challenges/{id}/cheers", post(handlers::cheer_participant).route_layer(write.clone()))
        .route("/api/challenges/{id}/invite-candidates", get(handlers::get_invite_candidates).route_layer(read.clone()))
        .route("/api/challenges/{id}/invites", post(handlers::invite_users).route_layer(write.clone()))
        .route("/api/challenge-codes/{code}", get(handlers::preview_challenge).route_layer(read))
        .route("/api/challenge-codes/{code}/join", post(handlers::join_challenge).route_layer(write))
        .with_state(challenges.challenge_service.clone())
}
