//! Routes of the notification feature (Go: `internal/routes/routes.go`, "Notifications",
//! "Push Notifications" and the WebSocket route).

use axum::routing::{any, delete, get, patch, post, MethodRouter};
use axum::Router;
use gt_core::extract::AuthUser;
use gt_core::guard::Guard;
use gt_core::CoreContext;

use crate::context::NotifyContext;
use crate::handlers::{fiber, notification, push, websocket, NotifyState};

/// All notification, push and WebSocket routes:
///
/// - `/api/notifications` (auth + API limiter on every method and sub-path, like the Go group
///   middleware): `GET ""`, `GET /unread-count`, `PATCH /{id}/read`, `PATCH /read-all`,
///   `DELETE /{id}`
/// - `/api/push`: `GET /vapid-public-key` (public); `POST`/`DELETE /subscriptions`,
///   `GET`/`PUT /preferences` and `POST /cleanup` (auth + API limiter)
/// - `GET /api/ws/notifications?token=<jwt>` (WebSocket)
pub fn routes(core: &CoreContext, notify: &NotifyContext) -> Router {
    let state = NotifyState {
        notifications: notify.notification_service.clone(),
        push_repo: notify.push_repo.clone(),
        ws: notify.ws_handler.clone(),
        config: core.config.clone(),
    };
    let api = core.guards.api();

    Router::new()
        .merge(notification_routes(api.clone()))
        .merge(push_routes(api))
        .route("/api/ws/notifications", any(websocket::handle_upgrade))
        .route("/api/ws/notifications/{*rest}", any(websocket::handle_subpath))
        .with_state(state)
}

/// A path inside the guarded notifications group: the guard runs for every method, and
/// methods without a handler get Fiber's 405 after it.
fn grouped(route: MethodRouter<NotifyState>, guard: &Guard) -> MethodRouter<NotifyState> {
    route.fallback(fiber::method_not_allowed).layer(guard.clone())
}

fn notification_routes(guard: Guard) -> Router<NotifyState> {
    // Fiber matches `DELETE /read-all` and `DELETE /unread-count` with `DELETE /:id`.
    let delete_unread_count = |axum::extract::State(s): axum::extract::State<NotifyState>, user: AuthUser| {
        notification::delete_literal(s, user, "unread-count")
    };
    let delete_read_all = |axum::extract::State(s): axum::extract::State<NotifyState>, user: AuthUser| {
        notification::delete_literal(s, user, "read-all")
    };
    Router::new()
        .route("/api/notifications", grouped(get(notification::get_notifications), &guard))
        .route(
            "/api/notifications/unread-count",
            grouped(get(notification::get_unread_count).delete(delete_unread_count), &guard),
        )
        .route(
            "/api/notifications/read-all",
            grouped(patch(notification::mark_all_as_read).delete(delete_read_all), &guard),
        )
        .route("/api/notifications/{id}", grouped(delete(notification::delete_notification), &guard))
        .route("/api/notifications/{id}/read", grouped(patch(notification::mark_as_read), &guard))
        // Deeper paths: the group middleware runs, then no route matches.
        .route("/api/notifications/{id}/{segment}", any(fiber::route_not_found).layer(guard.clone()))
        .route("/api/notifications/{id}/{segment}/{*rest}", any(fiber::route_not_found).layer(guard))
}

fn push_routes(guard: Guard) -> Router<NotifyState> {
    let guarded =
        |route: MethodRouter<NotifyState>| route.route_layer(guard.clone()).fallback(fiber::method_not_allowed);
    Router::new()
        .route("/api/push/vapid-public-key", get(push::get_vapid_public_key).fallback(fiber::method_not_allowed))
        .route(
            "/api/push/subscriptions",
            guarded(post(push::register_subscription).delete(push::unregister_subscription)),
        )
        .route("/api/push/preferences", guarded(get(push::get_preferences).put(push::update_preferences)))
        .route("/api/push/cleanup", guarded(post(push::run_cleanup)))
}
