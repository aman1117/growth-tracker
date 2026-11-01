//! `CronService` (port of the cron part of `internal/services/email.go`).

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::{NaiveDate, Utc};
use gt_core::models::{
    CronJobLog, CRON_JOB_DAILY_STREAK, CRON_JOB_STATUS_COMPLETED, CRON_JOB_STATUS_FAILED, CRON_JOB_STREAK_REMINDER,
};
use gt_core::{gojson, timeutil};
use gt_notify::NotificationService;
use gt_users::{CronJobLogRepository, EmailService, StreakRepository, StreakService, UserRepository};

use super::error::{go_error_text, CronError};

/// Log messages of a job that claims its run in `cron_job_logs`.
struct ClaimMessages {
    claim_failed: &'static str,
    already_claimed: &'static str,
    claimed: &'static str,
}

const DAILY_STREAK_MESSAGES: ClaimMessages = ClaimMessages {
    claim_failed: "Failed to claim daily streak job",
    already_claimed: "Daily streak job already claimed by another instance, skipping",
    claimed: "Successfully claimed daily streak job",
};

const STREAK_REMINDER_MESSAGES: ClaimMessages = ClaimMessages {
    claim_failed: "Failed to claim streak reminder job",
    already_claimed: "Streak reminder job already claimed by another instance, skipping",
    claimed: "Successfully claimed streak reminder job",
};

/// Outcome of trying to claim today's run of a job.
enum Claim {
    /// This instance runs the job; the log row is updated when it finishes.
    Claimed(CronJobLog),
    /// Another instance (or an earlier run) already has it: do nothing.
    TakenElsewhere,
    /// No job log repository, or claiming failed: run without bookkeeping (Go: "better to risk
    /// a duplicate than skip entirely").
    Untracked,
}

/// The instance id recorded in `cron_job_logs`: `HOSTNAME` when set, otherwise
/// `instance-<UnixNano % 10000>` (Go `NewCronService`).
pub fn instance_id_from(hostname: Option<&str>, unix_nanos: u128) -> String {
    match hostname {
        Some(host) if !host.is_empty() => host.to_string(),
        _ => format!("instance-{}", unix_nanos % 10_000),
    }
}

/// Scheduled job logic: daily streak processing, streak reminders and notification cleanup.
/// Safe to run on every replica: the streak and reminder jobs claim their run per IST day.
#[derive(Debug, Clone)]
pub struct CronService {
    user_repo: Arc<UserRepository>,
    streak_repo: Arc<StreakRepository>,
    cron_job_log_repo: Option<Arc<CronJobLogRepository>>,
    streak_service: Arc<StreakService>,
    email_service: Option<Arc<EmailService>>,
    notification_service: Option<Arc<NotificationService>>,
    instance_id: String,
}

impl CronService {
    /// Go `NewCronService`. Without a job log repository the jobs run untracked (and may run on
    /// several replicas); without a notification service reminders fail and the cleanup is a
    /// no-op. The instance id comes from `HOSTNAME` (see [`instance_id_from`]).
    pub fn new(
        user_repo: Arc<UserRepository>,
        streak_repo: Arc<StreakRepository>,
        cron_job_log_repo: Option<Arc<CronJobLogRepository>>,
        streak_service: Arc<StreakService>,
        email_service: Option<Arc<EmailService>>,
        notification_service: Option<Arc<NotificationService>>,
    ) -> Self {
        let hostname = std::env::var("HOSTNAME").ok();
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or_default();
        Self {
            user_repo,
            streak_repo,
            cron_job_log_repo,
            streak_service,
            email_service,
            notification_service,
            instance_id: instance_id_from(hostname.as_deref(), nanos),
        }
    }

    /// Replaces the instance id (tests, or wiring that knows a better replica name).
    pub fn with_instance_id(mut self, instance_id: impl Into<String>) -> Self {
        self.instance_id = instance_id.into();
        self
    }

    /// The id this replica records when it claims a job.
    pub fn instance_id(&self) -> &str {
        &self.instance_id
    }

    /// The email service handed to the constructor (kept like Go; no job sends email today).
    pub fn email_service(&self) -> Option<&Arc<EmailService>> {
        self.email_service.as_ref()
    }

    /// The midnight (IST) job: opens today's streak record (`current = 0`, carrying `longest`)
    /// for every user. Claims the `daily_streak` run for today first; when another instance has
    /// it, returns `Ok` without doing anything. Stops at the first failing user, recording the
    /// number processed so far (Go `RunDailyJob`).
    pub async fn run_daily_job(&self) -> Result<(), CronError> {
        let today = timeutil::today_ist();
        let mut job_log = match self.claim(CRON_JOB_DAILY_STREAK, today, &DAILY_STREAK_MESSAGES).await {
            Claim::TakenElsewhere => return Ok(()),
            Claim::Claimed(log) => Some(log),
            Claim::Untracked => None,
        };

        let users = match self.user_repo.get_all().await {
            Ok(users) => users,
            Err(err) => {
                self.update_job_log(job_log.as_mut(), CRON_JOB_STATUS_FAILED, 0, &go_error_text(&err)).await;
                return Err(CronError::Database(err));
            }
        };

        let mut processed: i64 = 0;
        for user in &users {
            if let Err(err) = self.streak_service.add_streak(user.id, today, true).await {
                self.update_job_log(job_log.as_mut(), CRON_JOB_STATUS_FAILED, processed, &go_error_text(&err)).await;
                return Err(CronError::Database(err));
            }
            processed += 1;
        }

        self.update_job_log(job_log.as_mut(), CRON_JOB_STATUS_COMPLETED, processed, "").await;
        tracing::info!(users_processed = processed, instance_id = %self.instance_id, "Daily streak job completed");
        Ok(())
    }

    /// The 10 PM (IST) job: an in-app notification plus a Web Push to every user whose record
    /// for today still has `current = 0`. Claims the `streak_reminder` run for today first.
    /// Failed reminders are logged and skipped; the job log counts the successful ones (Go
    /// `SendStreakReminders`).
    pub async fn send_streak_reminders(&self) -> Result<(), CronError> {
        let Some(notifications) = &self.notification_service else {
            return Err(CronError::NotificationServiceNotConfigured);
        };

        let today_date = timeutil::today_ist();
        let today = timeutil::format_date(&today_date);

        let mut job_log = match self.claim(CRON_JOB_STREAK_REMINDER, today_date, &STREAK_REMINDER_MESSAGES).await {
            Claim::TakenElsewhere => return Ok(()),
            Claim::Claimed(log) => Some(log),
            Claim::Untracked => None,
        };

        let user_ids = match self.streak_repo.find_users_missed_streak(&today).await {
            Ok(ids) => ids,
            Err(err) => {
                self.update_job_log(job_log.as_mut(), CRON_JOB_STATUS_FAILED, 0, &go_error_text(&err)).await;
                return Err(CronError::FindUsersMissedStreak(err));
            }
        };

        if user_ids.is_empty() {
            tracing::info!("All users have logged today");
            self.update_job_log(job_log.as_mut(), CRON_JOB_STATUS_COMPLETED, 0, "").await;
            return Ok(());
        }

        tracing::info!(
            user_count = user_ids.len(),
            date = %today,
            instance_id = %self.instance_id,
            "Sending streak reminders"
        );

        let (mut success, mut failed) = (0_i64, 0_i64);
        for &user_id in &user_ids {
            match notifications.notify_streak_reminder(user_id, &today).await {
                Ok(()) => success += 1,
                Err(err) => {
                    tracing::warn!(user_id, error = %err, "Failed to send streak reminder");
                    failed += 1;
                }
            }
        }

        tracing::info!(success, failed, instance_id = %self.instance_id, "Streak reminders completed");
        self.update_job_log(job_log.as_mut(), CRON_JOB_STATUS_COMPLETED, success, "").await;
        Ok(())
    }

    /// The 3 AM (IST) job: deletes read notifications older than 30 days and unread ones older
    /// than 90 days. A no-op without a notification service (Go `CleanupOldNotifications`).
    pub async fn cleanup_old_notifications(&self) -> Result<(), CronError> {
        let Some(notifications) = &self.notification_service else {
            return Ok(());
        };
        let deleted = notifications.cleanup_old_notifications().await.map_err(CronError::NotificationCleanup)?;
        if deleted > 0 {
            tracing::info!(deleted_count = deleted, "Notification cleanup completed");
        }
        Ok(())
    }

    /// Atomically claims `job_name` for `job_date` (one replica wins per day).
    async fn claim(&self, job_name: &str, job_date: NaiveDate, messages: &ClaimMessages) -> Claim {
        let Some(repo) = &self.cron_job_log_repo else {
            return Claim::Untracked;
        };
        let job_date_text = timeutil::format_date(&job_date);
        match repo.try_claim_job(job_name, job_date, &self.instance_id).await {
            Err(err) => {
                tracing::warn!(error = %go_error_text(&err), "{}", messages.claim_failed);
                Claim::Untracked
            }
            Ok((existing, false)) => {
                tracing::info!(
                    job_date = %job_date_text,
                    claimed_by = %existing.instance_id,
                    claimed_at = %gojson::format_go_time(&existing.started_at),
                    "{}",
                    messages.already_claimed
                );
                Claim::TakenElsewhere
            }
            Ok((log, true)) => {
                tracing::info!(job_date = %job_date_text, instance_id = %self.instance_id, "{}", messages.claimed);
                Claim::Claimed(log)
            }
        }
    }

    /// Records the outcome of a claimed run. Does nothing without a repository or for a log that
    /// was never stored; a failed update is only logged (Go `updateJobLog`).
    async fn update_job_log(&self, log: Option<&mut CronJobLog>, status: &str, users_count: i64, error_msg: &str) {
        let (Some(repo), Some(log)) = (&self.cron_job_log_repo, log) else {
            return;
        };
        if log.id == 0 {
            return;
        }
        log.status = status.to_string();
        log.users_count = users_count;
        log.completed_at = Some(Utc::now());
        log.error = error_msg.to_string();
        if let Err(err) = repo.update(log).await {
            tracing::warn!(error = %go_error_text(&err), "Failed to update cron job log");
        }
    }
}

#[cfg(test)]
mod tests {
    use sqlx::postgres::PgPoolOptions;
    use sqlx::PgPool;

    use super::*;

    /// A pool that fails every query (closed before use; never connects).
    async fn broken_pool() -> PgPool {
        let pool = PgPoolOptions::new().connect_lazy("postgres://gt@127.0.0.1:1/broken").unwrap();
        pool.close().await;
        pool
    }

    async fn service(job_logs: Option<PgPool>) -> CronService {
        let pool = broken_pool().await;
        let streak_repo = Arc::new(StreakRepository::new(pool.clone()));
        CronService::new(
            Arc::new(UserRepository::new(pool)),
            streak_repo.clone(),
            job_logs.map(|p| Arc::new(CronJobLogRepository::new(p))),
            Arc::new(StreakService::new(streak_repo)),
            None,
            None,
        )
    }

    fn running_log(id: i64) -> CronJobLog {
        CronJobLog {
            id,
            job_name: CRON_JOB_DAILY_STREAK.into(),
            job_date: NaiveDate::from_ymd_opt(2026, 3, 9).unwrap(),
            started_at: Utc::now(),
            completed_at: None,
            status: "running".into(),
            users_count: 0,
            error: String::new(),
            instance_id: "a".into(),
        }
    }

    #[test]
    fn instance_id_prefers_hostname() {
        assert_eq!(instance_id_from(Some("worker-7"), 123_456), "worker-7");
        assert_eq!(instance_id_from(Some(""), 123_456), "instance-3456");
        assert_eq!(instance_id_from(None, 42), "instance-42");
    }

    #[tokio::test]
    async fn update_job_log_skips_untracked_runs() {
        let mut log = running_log(1);
        service(None).await.update_job_log(Some(&mut log), CRON_JOB_STATUS_COMPLETED, 1, "").await;
        assert_eq!(log.status, "running", "nothing to do without a repository");

        let svc = service(Some(broken_pool().await)).await;
        svc.update_job_log(None, CRON_JOB_STATUS_COMPLETED, 1, "").await;
        let mut unsaved = running_log(0);
        svc.update_job_log(Some(&mut unsaved), CRON_JOB_STATUS_COMPLETED, 1, "").await;
        assert_eq!(unsaved.status, "running", "logs that were never stored are left alone");
        assert_eq!(unsaved.completed_at, None);
    }

    #[tokio::test]
    async fn update_job_log_failures_are_only_logged() {
        let svc = service(Some(broken_pool().await)).await;
        let mut log = running_log(7);
        svc.update_job_log(Some(&mut log), CRON_JOB_STATUS_FAILED, 3, "boom").await;
        assert_eq!(log.status, CRON_JOB_STATUS_FAILED);
        assert_eq!(log.users_count, 3);
        assert_eq!(log.error, "boom");
        assert!(log.completed_at.is_some());
    }

    #[tokio::test]
    async fn reminders_require_a_notification_service() {
        let err = service(None).await.send_streak_reminders().await.unwrap_err();
        assert_eq!(err.to_string(), "notification service not configured");
        assert!(service(None).await.cleanup_old_notifications().await.is_ok(), "cleanup is a no-op");
    }
}
