//! `UsersContext`: the repositories and services of this crate, wired like
//! `internal/container/container.go`.

use std::sync::Arc;

use gt_core::CoreContext;

use crate::repository::{
    BadgeRepository, CronJobLogRepository, FollowRepository, RecentSearchRepository, StreakRepository, UserRepository,
};
use crate::service::{
    AuthService, BadgeService, EmailService, FollowService, ProfileService, SearchSuggestionsService, StreakService,
};

/// Shared handles to every users-domain repository and service. Cheap to clone.
#[derive(Debug, Clone)]
pub struct UsersContext {
    /// Users table access.
    pub user_repo: Arc<UserRepository>,
    /// Daily streak rows.
    pub streak_repo: Arc<StreakRepository>,
    /// Earned badges.
    pub badge_repo: Arc<BadgeRepository>,
    /// Follow edges, counters and tombstones.
    pub follow_repo: Arc<FollowRepository>,
    /// Cron run bookkeeping (distributed claim per job and date).
    pub cron_job_log_repo: Arc<CronJobLogRepository>,
    /// Recent searches and trending users.
    pub recent_search_repo: Arc<RecentSearchRepository>,
    /// Registration, login and password management.
    pub auth_service: Arc<AuthService>,
    /// Profile reads/updates and visibility checks.
    pub profile_service: Arc<ProfileService>,
    /// Streak bookkeeping.
    pub streak_service: Arc<StreakService>,
    /// Badge awards.
    pub badge_service: Arc<BadgeService>,
    /// Follow graph operations with Redis caching and rate limits.
    pub follow_service: Arc<FollowService>,
    /// Recent searches and trending suggestions.
    pub search_suggestions_service: Arc<SearchSuggestionsService>,
    /// Transactional email; `None` when it could not be initialized (Go left
    /// `container.EmailService` nil when `NewEmailService` failed).
    pub email_service: Option<Arc<EmailService>>,
}

impl UsersContext {
    /// Builds every repository and service from the core pool and config. Does not start the
    /// follow counter subscriber; the server calls
    /// [`FollowService::start_follow_counter_subscriber`] once Redis is up.
    pub fn new(core: &CoreContext) -> Self {
        let pool = core.pool.clone();
        let cfg = &core.config;

        let user_repo = Arc::new(UserRepository::new(pool.clone()));
        let streak_repo = Arc::new(StreakRepository::new(pool.clone()));
        let badge_repo = Arc::new(BadgeRepository::new(pool.clone()));
        let follow_repo = Arc::new(FollowRepository::new(pool.clone()));
        let cron_job_log_repo = Arc::new(CronJobLogRepository::new(pool.clone()));
        let recent_search_repo = Arc::new(RecentSearchRepository::new(pool));

        let auth_service = Arc::new(AuthService::new(user_repo.clone()));
        let profile_service = Arc::new(ProfileService::new(user_repo.clone(), follow_repo.clone()));
        let streak_service = Arc::new(StreakService::new(streak_repo.clone()));
        let badge_service = Arc::new(BadgeService::new(badge_repo.clone(), user_repo.clone()));
        let follow_service = Arc::new(FollowService::new(follow_repo.clone(), user_repo.clone(), cfg.follow.clone()));
        let search_suggestions_service = Arc::new(SearchSuggestionsService::new(recent_search_repo.clone()));

        let email_service = match EmailService::new(&cfg.email, &cfg.server.frontend_url) {
            Ok(service) => Some(Arc::new(service)),
            Err(e) => {
                tracing::warn!(error = %e, "Email service unavailable; emails will not be sent");
                None
            }
        };

        Self {
            user_repo,
            streak_repo,
            badge_repo,
            follow_repo,
            cron_job_log_repo,
            recent_search_repo,
            auth_service,
            profile_service,
            streak_service,
            badge_service,
            follow_service,
            search_suggestions_service,
            email_service,
        }
    }
}
