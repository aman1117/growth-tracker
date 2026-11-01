//! Routes of the accounts API (Go: the matching registrations in `internal/routes/routes.go`),
//! with the same middleware per route and method.

use axum::routing::{any, delete, get, post};
use axum::Router;
use gt_core::CoreContext;
use gt_notify::NotifyContext;
use gt_users::UsersContext;

use crate::handlers::{auth, fiber, follow, password_reset, profile, search_suggestions, verification};
use crate::state::AccountsState;

/// All accounts routes, with state applied. Guards (`auth` = JWT, then the named limiter):
///
/// | Method | Path | Guard |
/// |---|---|---|
/// | POST | `/api/register`, `/api/login` | auth limiter (no JWT) |
/// | POST | `/api/auth/forgot-password`, `/api/auth/reset-password` | password-reset limiter (no JWT) |
/// | GET | `/api/auth/reset-password/validate` | password-reset limiter (no JWT) |
/// | POST | `/api/auth/verify-email` | none |
/// | POST | `/api/auth/resend-verification`, `/api/change-password` | JWT + auth limiter |
/// | POST | `/api/users` | JWT + API limiter |
/// | GET | `/api/autocomplete/users`, `/api/search/suggestions` | JWT + autocomplete limiter |
/// | DELETE | `/api/search/recent/{userId}`, `/api/search/recent` | JWT + API limiter |
/// | POST | `/api/update-username`, `/api/update-privacy`, `/api/update-bio` | JWT + API limiter |
/// | GET | `/api/get-privacy`, `/api/get-bio` | JWT + API limiter |
/// | GET | `/api/profile` | JWT (group, every method) + API limiter |
/// | any | `/api/profile/{*rest}` | JWT (group), then `404 Cannot <METHOD> <path>` |
/// | POST, DELETE | `/api/users/{id}/follow` | JWT + follow limiter |
/// | POST | `/api/follow-requests/{targetId}/cancel` | JWT + API limiter |
/// | GET | `/api/me/follow-requests/incoming` | JWT + API limiter |
/// | POST | `/api/me/follow-requests/{requesterId}/accept`, `.../decline` | JWT + API limiter |
/// | DELETE | `/api/me/followers/{followerId}` | JWT + API limiter |
/// | GET | `/api/users/{id}/followers`, `/following`, `/mutuals`, `/follow-counts`, `/profile` | JWT + API limiter |
/// | POST | `/api/me/follow-counts/reconcile` | JWT + API limiter |
/// | POST | `/api/relationships/lookup` | JWT only |
///
/// Go registered `/api/users/:targetId/follow` next to `/api/users/:userId/...`; axum needs one
/// parameter name per position, so that segment is `{id}` everywhere (the URLs are unchanged).
///
/// Per-route guards use `route_layer`, so a known path with another method gets the server's
/// `405` without running them, like Fiber. The `/api/profile` group middleware is the exception:
/// Fiber ran its auth for every method and sub-path before routing.
pub fn routes(core: &CoreContext, users: &UsersContext, notify: &NotifyContext) -> Router {
    let state = AccountsState::new(core, users, notify);
    let guards = &core.guards;
    let limiters = &guards.limiters;
    let auth_limiter = guards.limited(&limiters.auth);
    let password_limiter = guards.limited(&limiters.password_reset);
    let authed_auth_limiter = guards.auth_limited(&limiters.auth);
    let autocomplete = guards.auth_limited(&limiters.autocomplete);
    let api = guards.api();

    Router::new()
        // ==================== Public: authentication ====================
        .route("/api/register", post(auth::register).route_layer(auth_limiter.clone()))
        .route("/api/login", post(auth::login).route_layer(auth_limiter))
        .route("/api/auth/forgot-password", post(password_reset::forgot_password).route_layer(password_limiter.clone()))
        .route("/api/auth/reset-password", post(password_reset::reset_password).route_layer(password_limiter.clone()))
        .route(
            "/api/auth/reset-password/validate",
            get(password_reset::validate_reset_token).route_layer(password_limiter),
        )
        .route("/api/auth/verify-email", post(verification::verify_email))
        .route(
            "/api/auth/resend-verification",
            post(verification::resend_verification_email).route_layer(authed_auth_limiter.clone()),
        )
        // ==================== Search ====================
        .route("/api/users", post(profile::search_users).route_layer(api.clone()))
        .route("/api/autocomplete/users", get(profile::autocomplete_users).route_layer(autocomplete.clone()))
        .route("/api/search/suggestions", get(search_suggestions::get_search_suggestions).route_layer(autocomplete))
        .route("/api/search/recent/{userId}", delete(search_suggestions::delete_recent_search).route_layer(api.clone()))
        .route("/api/search/recent", delete(search_suggestions::clear_recent_searches).route_layer(api.clone()))
        // ==================== Profile management ====================
        .route("/api/update-username", post(auth::update_username).route_layer(api.clone()))
        .route("/api/update-privacy", post(profile::update_privacy).route_layer(api.clone()))
        .route("/api/get-privacy", get(profile::get_privacy).route_layer(api.clone()))
        .route("/api/update-bio", post(profile::update_bio).route_layer(api.clone()))
        .route("/api/get-bio", get(profile::get_bio).route_layer(api.clone()))
        .route("/api/change-password", post(auth::change_password).route_layer(authed_auth_limiter))
        // `api.Group("/profile", authMiddleware)`: auth runs first for every method and path in
        // the group, then the route (or Fiber's 405 / 404).
        .route(
            "/api/profile",
            get(profile::get_profile)
                .route_layer(guards.limited(&limiters.api))
                .fallback(fiber::method_not_allowed)
                .layer(guards.auth()),
        )
        .route("/api/profile/{*rest}", any(fiber::route_not_found).layer(guards.auth()))
        // ==================== Follow system ====================
        .route(
            "/api/users/{id}/follow",
            post(follow::follow_user).delete(follow::unfollow_user).route_layer(guards.auth_limited(&limiters.follow)),
        )
        .route("/api/follow-requests/{targetId}/cancel", post(follow::cancel_follow_request).route_layer(api.clone()))
        .route("/api/me/follow-requests/incoming", get(follow::get_incoming_requests).route_layer(api.clone()))
        .route(
            "/api/me/follow-requests/{requesterId}/accept",
            post(follow::accept_follow_request).route_layer(api.clone()),
        )
        .route(
            "/api/me/follow-requests/{requesterId}/decline",
            post(follow::decline_follow_request).route_layer(api.clone()),
        )
        .route("/api/me/followers/{followerId}", delete(follow::remove_follower).route_layer(api.clone()))
        .route("/api/users/{id}/followers", get(follow::get_followers).route_layer(api.clone()))
        .route("/api/users/{id}/following", get(follow::get_following).route_layer(api.clone()))
        .route("/api/users/{id}/mutuals", get(follow::get_mutuals).route_layer(api.clone()))
        .route("/api/users/{id}/follow-counts", get(follow::get_follow_counts).route_layer(api.clone()))
        .route("/api/me/follow-counts/reconcile", post(follow::reconcile_my_counters).route_layer(api.clone()))
        .route("/api/users/{id}/profile", get(profile::get_user_profile).route_layer(api))
        // Read-only and needed frequently by the UI: no rate limit.
        .route("/api/relationships/lookup", post(follow::lookup_relationships).route_layer(guards.auth()))
        .with_state(state)
}
