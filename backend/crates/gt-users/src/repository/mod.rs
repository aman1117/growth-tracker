//! Data access for users, streaks, cron job logs, recent searches, follows and badges (port of
//! `internal/repository/{repository,follow_repository,badge_repository}.go`).
//!
//! Every repository is a cheap-to-clone handle on the shared [`sqlx::PgPool`]. Methods return
//! `sqlx::Error` exactly where the Go methods returned GORM errors; "not found" lookups that Go
//! answered with `(nil, nil)` return `Ok(None)`.

mod badge;
mod cron_job_log;
mod follow;
mod recent_search;
mod streak;
mod user;

pub use badge::BadgeRepository;
pub use cron_job_log::CronJobLogRepository;
pub use follow::{FollowListCursor, FollowRepository, MutualEdgeRow, TombstoneCleanupError};
pub use recent_search::{RecentSearchRepository, RecentSearchResult, TrendingUserResult};
pub use streak::StreakRepository;
pub use user::{AutocompleteResult, UserRepository};

/// GORM `Limit(n)`: a negative limit means "no limit". Bind the result as `LIMIT $n`
/// (`LIMIT NULL` is "no limit" in PostgreSQL).
pub(crate) fn go_limit(limit: i64) -> Option<i64> {
    (limit >= 0).then_some(limit)
}

#[cfg(test)]
mod tests {
    use super::go_limit;

    #[test]
    fn negative_limits_mean_unlimited() {
        assert_eq!(go_limit(-1), None);
        assert_eq!(go_limit(0), Some(0));
        assert_eq!(go_limit(21), Some(21));
    }
}
