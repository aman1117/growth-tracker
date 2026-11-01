//! Activities, streaks, analytics, tile configuration, day likes and badges HTTP API (port of
//! the Go backend's activity/tile config/like repositories, the activity, tile config and
//! analytics services, and the activity, streak, analytics, tile config, like and badge
//! handlers).
//!
//! Server wiring:
//!
//! ```ignore
//! let users = gt_users::UsersContext::new(&core);
//! let notify = gt_notify::NotifyContext::new(&core);
//! let activity = gt_activity::ActivityContext::new(&core, &users, &notify);
//! let app = Router::new().merge(gt_activity::routes(&core, &users, &notify, &activity));
//! // Other features may reuse `activity.activity_repo`.
//! ```

pub mod context;
mod dates;
pub mod dto;
mod gosort;
mod handlers;
pub mod repository;
pub mod routes;
pub mod service;

pub use context::ActivityContext;
pub use repository::{
    ActivityPhotoLabels, ActivityRepository, ActivityWriteError, LikeDeleteError, LikeRepository, LikeWithUser,
    TileConfigRepository,
};
pub use routes::routes;
pub use service::{
    ActivityError, ActivityService, AnalyticsService, TileConfigError, TileConfigService, TileConfigValidationError,
};
