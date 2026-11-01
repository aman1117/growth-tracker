//! HTTP handlers (port of `internal/handlers/{activity,streak,analytics,tile_config,like,badge}.go`).

pub(crate) mod activity;
pub(crate) mod analytics;
pub(crate) mod badge;
pub(crate) mod like;
pub(crate) mod streak;
pub(crate) mod tile_config;

use std::sync::Arc;

use gt_core::models::User;
use gt_core::ApiError;
use gt_notify::NotificationService;
use gt_users::{AuthService, BadgeService, ProfileService, StreakService};

use crate::repository::LikeRepository;
use crate::service::{ActivityService, AnalyticsService, TileConfigService};

/// State shared by every handler of this crate.
#[derive(Clone)]
pub(crate) struct ActivityState {
    pub activity: Arc<ActivityService>,
    pub analytics: Arc<AnalyticsService>,
    pub tile_config: Arc<TileConfigService>,
    pub likes: Arc<LikeRepository>,
    pub auth: Arc<AuthService>,
    pub profile: Arc<ProfileService>,
    pub streak: Arc<StreakService>,
    pub badges: Arc<BadgeService>,
    pub notifications: Arc<NotificationService>,
}

impl ActivityState {
    /// The user named `username` when the caller may see their data, as the activity, streak
    /// and analytics handlers check it: a failed or empty lookup is `400 Failed to find user`,
    /// a hidden private profile `403 This account is private`.
    async fn visible_user(&self, username: &str, current_user_id: i64, what: &str) -> Result<User, ApiError> {
        let user = match self.auth.get_user_by_username(username).await {
            Ok(Some(user)) => user,
            Ok(None) | Err(_) => {
                tracing::warn!(user_id = current_user_id, target_username = %username, "{what} fetch failed - user not found");
                return Err(ApiError::user_not_found());
            }
        };
        if !self.profile.can_view_profile(Some(&user), current_user_id).await {
            tracing::debug!(user_id = current_user_id, target_username = %username, "{what} access denied - private account");
            return Err(ApiError::private_account());
        }
        Ok(user)
    }
}
