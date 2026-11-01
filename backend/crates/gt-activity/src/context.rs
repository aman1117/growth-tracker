//! `ActivityContext`: the repositories and services of this crate, wired like
//! `internal/container/container.go`.

use std::sync::Arc;

use gt_core::CoreContext;
use gt_notify::NotifyContext;
use gt_users::UsersContext;

use crate::repository::{ActivityPhotoLabels, ActivityRepository, LikeRepository, TileConfigRepository};
use crate::service::{ActivityService, AnalyticsService, TileConfigService};

/// Shared handles to the activity-domain repositories and services. Cheap to clone.
#[derive(Debug, Clone)]
pub struct ActivityContext {
    /// Logged activities.
    pub activity_repo: Arc<ActivityRepository>,
    /// Dashboard tile configurations.
    pub tile_config_repo: Arc<TileConfigRepository>,
    /// Likes on users' days.
    pub like_repo: Arc<LikeRepository>,
    /// Activity logging with streak updates and day-completion notifications.
    pub activity_service: Arc<ActivityService>,
    /// Weekly analytics.
    pub analytics_service: Arc<AnalyticsService>,
    /// Tile configuration validation and storage.
    pub tile_config_service: Arc<TileConfigService>,
}

impl ActivityContext {
    /// Builds the repositories on the core pool and the services on top of the users and
    /// notification services.
    pub fn new(core: &CoreContext, users: &UsersContext, notify: &NotifyContext) -> Self {
        let pool = core.pool.clone();
        let activity_repo = Arc::new(ActivityRepository::new(pool.clone()));
        let tile_config_repo = Arc::new(TileConfigRepository::new(pool.clone()));
        let like_repo = Arc::new(LikeRepository::new(pool.clone()));
        let photo_labels = Arc::new(ActivityPhotoLabels::new(pool));

        let activity_service = Arc::new(ActivityService::new(
            activity_repo.clone(),
            users.streak_service.clone(),
            users.user_repo.clone(),
            users.follow_repo.clone(),
            Some(notify.notification_service.clone()),
        ));
        let analytics_service = Arc::new(AnalyticsService::new(activity_repo.clone(), users.streak_repo.clone()));
        let tile_config_service =
            Arc::new(TileConfigService::new(tile_config_repo.clone(), users.user_repo.clone(), Some(photo_labels)));

        Self { activity_repo, tile_config_repo, like_repo, activity_service, analytics_service, tile_config_service }
    }
}
