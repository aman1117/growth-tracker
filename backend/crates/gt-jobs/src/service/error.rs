//! Errors of the jobs and their Go-compatible text.

use gt_notify::NotificationError;
use sqlx::postgres::{PgDatabaseError, PgSeverity};

/// A failed job run. The messages are the Go errors (`fmt.Errorf(...)`) because the server logs
/// them (`Daily job failed: ...`).
#[derive(Debug, thiserror::Error)]
pub enum CronError {
    /// [`CronService::send_streak_reminders`](super::CronService::send_streak_reminders) without
    /// a notification service.
    #[error("notification service not configured")]
    NotificationServiceNotConfigured,
    /// A repository error returned as is (Go returned GORM errors unwrapped).
    #[error("{}", go_error_text(.0))]
    Database(#[source] sqlx::Error),
    /// Looking up the users to remind failed.
    #[error("failed to find users who missed streak: {}", go_error_text(.0))]
    FindUsersMissedStreak(#[source] sqlx::Error),
    /// Deleting old notifications failed.
    #[error("notification cleanup failed: {0}")]
    NotificationCleanup(#[source] NotificationError),
}

/// The text Go's `err.Error()` produced for a database error: pgx formats server errors as
/// `ERROR: <message> (SQLSTATE <code>)`. Other errors use their own description. Stored in
/// `cron_job_logs.error`, as the Go jobs did.
pub fn go_error_text(err: &sqlx::Error) -> String {
    if let sqlx::Error::Database(db) = err {
        if let Some(pg) = db.try_downcast_ref::<PgDatabaseError>() {
            return format!("{}: {} (SQLSTATE {})", severity_text(pg.severity()), pg.message(), pg.code());
        }
    }
    err.to_string()
}

fn severity_text(severity: PgSeverity) -> &'static str {
    match severity {
        PgSeverity::Panic => "PANIC",
        PgSeverity::Fatal => "FATAL",
        PgSeverity::Error => "ERROR",
        PgSeverity::Warning => "WARNING",
        PgSeverity::Notice => "NOTICE",
        PgSeverity::Debug => "DEBUG",
        PgSeverity::Info => "INFO",
        PgSeverity::Log => "LOG",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_match_go() {
        assert_eq!(CronError::NotificationServiceNotConfigured.to_string(), "notification service not configured");
        assert_eq!(
            CronError::FindUsersMissedStreak(sqlx::Error::PoolClosed).to_string(),
            format!("failed to find users who missed streak: {}", sqlx::Error::PoolClosed)
        );
        assert_eq!(go_error_text(&sqlx::Error::RowNotFound), sqlx::Error::RowNotFound.to_string());
    }
}
