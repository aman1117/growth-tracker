//! Routes of this crate (Go: `internal/routes/routes.go`, "Activities", "Streaks", "Analytics",
//! "Tile Configuration", "Likes" and "Badges"). Every route requires authentication and counts
//! against the general API rate limiter.

use axum::routing::{get, post};
use axum::Router;
use gt_core::CoreContext;
use gt_notify::NotifyContext;
use gt_users::UsersContext;

use crate::context::ActivityContext;
use crate::handlers::{activity, analytics, badge, like, streak, tile_config, ActivityState};

/// All routes of this crate, with state applied:
///
/// | Method | Path |
/// |---|---|
/// | POST | `/api/create-activity` |
/// | POST | `/api/get-activities` |
/// | POST | `/api/get-daily-totals` |
/// | POST | `/api/get-streak` |
/// | POST | `/api/get-week-analytics` |
/// | GET, POST | `/api/tile-config` |
/// | POST | `/api/tile-config/user` |
/// | POST | `/api/like-day` |
/// | POST | `/api/unlike-day` |
/// | POST | `/api/get-likes` |
/// | GET | `/api/badges` |
/// | POST | `/api/badges/user` |
///
/// The guard (auth + API limiter) only wraps the registered methods (`route_layer`); other
/// methods fall through to the server's 405 handler, as Fiber answers them without running
/// the route middleware.
pub fn routes(core: &CoreContext, users: &UsersContext, notify: &NotifyContext, activity: &ActivityContext) -> Router {
    let state = ActivityState {
        activity: activity.activity_service.clone(),
        analytics: activity.analytics_service.clone(),
        tile_config: activity.tile_config_service.clone(),
        likes: activity.like_repo.clone(),
        auth: users.auth_service.clone(),
        profile: users.profile_service.clone(),
        streak: users.streak_service.clone(),
        badges: users.badge_service.clone(),
        notifications: notify.notification_service.clone(),
    };
    let api = core.guards.api();

    Router::new()
        // Activities
        .route("/api/create-activity", post(activity::create_activity).route_layer(api.clone()))
        .route("/api/get-activities", post(activity::get_activities).route_layer(api.clone()))
        .route("/api/get-daily-totals", post(activity::get_daily_totals).route_layer(api.clone()))
        // Streaks
        .route("/api/get-streak", post(streak::get_streak).route_layer(api.clone()))
        // Analytics
        .route("/api/get-week-analytics", post(analytics::get_week_analytics).route_layer(api.clone()))
        // Tile configuration
        .route("/api/tile-config", get(tile_config::get_config).post(tile_config::save_config).route_layer(api.clone()))
        .route("/api/tile-config/user", post(tile_config::get_config_by_username).route_layer(api.clone()))
        // Likes
        .route("/api/like-day", post(like::like_day).route_layer(api.clone()))
        .route("/api/unlike-day", post(like::unlike_day).route_layer(api.clone()))
        .route("/api/get-likes", post(like::get_likes).route_layer(api.clone()))
        // Badges
        .route("/api/badges", get(badge::get_badges).route_layer(api.clone()))
        .route("/api/badges/user", post(badge::get_badges_by_username).route_layer(api))
        .with_state(state)
}
