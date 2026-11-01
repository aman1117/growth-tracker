//! `JobsContext`: the scheduled jobs wired from the other feature contexts (Go: the
//! `CronService` part of `internal/container` and `setupCronJobs` in `cmd/server/main.go`).

use std::sync::Arc;

use chrono::NaiveTime;
use gt_core::models::{
    CRON_JOB_DAILY_STREAK, CRON_JOB_FOLLOW_TOMBSTONE_CLEAN, CRON_JOB_NOTIFICATION_CLEANUP, CRON_JOB_STREAK_REMINDER,
};
use gt_core::CoreContext;
use gt_notify::NotifyContext;
use gt_users::{FollowRepository, TombstoneCleanupError, UsersContext};

use crate::service::{cleanup_follow_tombstones, CronService};

/// A job the server runs every day at a fixed IST time. (The 00:05 challenge job belongs to
/// the challenges feature.)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ScheduledJob {
    /// 00:00 IST: open today's streak records ([`CronService::run_daily_job`]).
    DailyStreak,
    /// 22:00 IST: remind users who have not logged today ([`CronService::send_streak_reminders`]).
    StreakReminder,
    /// 03:00 IST: delete old notifications ([`CronService::cleanup_old_notifications`]).
    NotificationCleanup,
    /// 04:00 IST: delete old follow tombstones ([`JobsContext::cleanup_follow_tombstones`]).
    FollowTombstoneCleanup,
}

impl ScheduledJob {
    /// Every job, in the order Go registered them.
    pub const ALL: [ScheduledJob; 4] = [
        ScheduledJob::DailyStreak,
        ScheduledJob::StreakReminder,
        ScheduledJob::NotificationCleanup,
        ScheduledJob::FollowTombstoneCleanup,
    ];

    /// Stable job name (the `cron_job_logs.job_name` constants).
    pub fn name(self) -> &'static str {
        match self {
            ScheduledJob::DailyStreak => CRON_JOB_DAILY_STREAK,
            ScheduledJob::StreakReminder => CRON_JOB_STREAK_REMINDER,
            ScheduledJob::NotificationCleanup => CRON_JOB_NOTIFICATION_CLEANUP,
            ScheduledJob::FollowTombstoneCleanup => CRON_JOB_FOLLOW_TOMBSTONE_CLEAN,
        }
    }

    /// The IST wall-clock hour the job runs at (Go cron specs `0 0 <hour> * * *`).
    pub fn ist_hour(self) -> u32 {
        match self {
            ScheduledJob::DailyStreak => 0,
            ScheduledJob::StreakReminder => 22,
            ScheduledJob::NotificationCleanup => 3,
            ScheduledJob::FollowTombstoneCleanup => 4,
        }
    }

    /// The IST wall-clock time the job runs at.
    pub fn ist_time(self) -> NaiveTime {
        NaiveTime::from_hms_opt(self.ist_hour(), 0, 0).unwrap_or(NaiveTime::MIN)
    }
}

/// The scheduled jobs and their dependencies. Cheap to clone.
#[derive(Debug, Clone)]
pub struct JobsContext {
    /// Streak, reminder and notification cleanup jobs.
    pub cron_service: Arc<CronService>,
    /// Follow edges, for the tombstone cleanup.
    pub follow_repo: Arc<FollowRepository>,
    /// `FOLLOW_TOMBSTONE_RETENTION_DAYS` (non-positive means 7).
    pub tombstone_retention_days: i64,
}

impl JobsContext {
    /// Wires the jobs like `internal/container/container.go`: the cron service gets the job log
    /// repository, the (optional) email service and the notification service.
    pub fn new(core: &CoreContext, users: &UsersContext, notify: &NotifyContext) -> Self {
        let cron_service = CronService::new(
            users.user_repo.clone(),
            users.streak_repo.clone(),
            Some(users.cron_job_log_repo.clone()),
            users.streak_service.clone(),
            users.email_service.clone(),
            Some(notify.notification_service.clone()),
        );
        Self {
            cron_service: Arc::new(cron_service),
            follow_repo: users.follow_repo.clone(),
            tombstone_retention_days: core.config.follow.tombstone_retention_days,
        }
    }

    /// The 4 AM job: deletes follow tombstones older than the retention and logs the outcome
    /// (`Follow tombstone cleanup completed, deleted N edges` / `... failed: ...`).
    pub async fn cleanup_follow_tombstones(&self) -> Result<i64, TombstoneCleanupError> {
        cleanup_follow_tombstones(&self.follow_repo, self.tombstone_retention_days).await
    }

    /// Runs one scheduled job and logs its outcome with the messages of the Go cron closures
    /// (e.g. `Daily job failed: ...` / `Daily job completed successfully`). Never fails: a
    /// scheduler just calls it at [`ScheduledJob::ist_time`].
    pub async fn run(&self, job: ScheduledJob) {
        match job {
            ScheduledJob::DailyStreak => match self.cron_service.run_daily_job().await {
                Ok(()) => tracing::info!("Daily job completed successfully"),
                Err(err) => tracing::error!("Daily job failed: {err}"),
            },
            ScheduledJob::StreakReminder => match self.cron_service.send_streak_reminders().await {
                Ok(()) => tracing::info!("Streak reminder job completed successfully"),
                Err(err) => tracing::error!("Streak reminder job failed: {err}"),
            },
            ScheduledJob::NotificationCleanup => match self.cron_service.cleanup_old_notifications().await {
                Ok(()) => tracing::info!("Notification cleanup job completed successfully"),
                Err(err) => tracing::error!("Notification cleanup job failed: {err}"),
            },
            ScheduledJob::FollowTombstoneCleanup => {
                // The outcome is logged by the cleanup itself.
                let _ = self.cleanup_follow_tombstones().await;
            }
        }
    }
}
