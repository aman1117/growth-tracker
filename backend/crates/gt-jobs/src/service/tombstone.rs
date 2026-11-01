//! Follow tombstone cleanup (the 4 AM IST job body of `setupCronJobs` in `cmd/server/main.go`).

use chrono::{DateTime, Days, Local, TimeDelta, TimeZone, Utc};
use gt_core::constants::DEFAULT_TOMBSTONE_RETENTION_DAYS;
use gt_users::{FollowRepository, TombstoneCleanupError};

use super::go_error_text;

/// Edges removed before this instant are deleted: `retention_days` calendar days before `now`
/// in `now`'s time zone (Go `time.Now().AddDate(0, 0, -days)`, which keeps the local wall
/// clock across daylight saving changes). A non-positive retention means the default 7 days;
/// one too large to represent keeps every edge.
pub fn tombstone_cutoff<Tz: TimeZone>(now: DateTime<Tz>, retention_days: i64) -> DateTime<Utc> {
    let days = if retention_days <= 0 { DEFAULT_TOMBSTONE_RETENTION_DAYS } else { retention_days };
    let calendar = u64::try_from(days)
        .ok()
        .and_then(|d| now.clone().checked_sub_days(Days::new(d)))
        .map(|cutoff| cutoff.with_timezone(&Utc));
    // A wall-clock time that does not exist (or is ambiguous) on the target day: fall back to
    // whole 24-hour days.
    calendar
        .or_else(|| TimeDelta::try_days(days).and_then(|delta| now.with_timezone(&Utc).checked_sub_signed(delta)))
        .unwrap_or(DateTime::<Utc>::MIN_UTC)
}

/// Deletes `REMOVED` follow edges older than the retention (`FOLLOW_TOMBSTONE_RETENTION_DAYS`)
/// from both edge tables and logs the outcome like the Go cron job. Returns the number of rows
/// deleted.
pub async fn cleanup_follow_tombstones(
    follow_repo: &FollowRepository,
    retention_days: i64,
) -> Result<i64, TombstoneCleanupError> {
    let cutoff = tombstone_cutoff(Local::now(), retention_days);
    match follow_repo.cleanup_old_tombstones(cutoff).await {
        Ok(deleted) => {
            tracing::info!("Follow tombstone cleanup completed, deleted {deleted} edges");
            Ok(deleted)
        }
        Err(err) => {
            tracing::error!("Follow tombstone cleanup failed: {}", go_error_text(&err.source));
            Err(err)
        }
    }
}

#[cfg(test)]
mod tests {
    use chrono_tz::America::New_York;

    use super::*;

    #[test]
    fn cutoff_defaults_to_seven_days() {
        let now = Utc.with_ymd_and_hms(2026, 3, 10, 4, 0, 0).unwrap();
        assert_eq!(tombstone_cutoff(now, 3), Utc.with_ymd_and_hms(2026, 3, 7, 4, 0, 0).unwrap());
        assert_eq!(tombstone_cutoff(now, 0), Utc.with_ymd_and_hms(2026, 3, 3, 4, 0, 0).unwrap());
        assert_eq!(tombstone_cutoff(now, -5), Utc.with_ymd_and_hms(2026, 3, 3, 4, 0, 0).unwrap());
        assert_eq!(tombstone_cutoff(now, i64::MAX), DateTime::<Utc>::MIN_UTC);
    }

    #[test]
    fn cutoff_keeps_the_local_wall_clock_like_go_add_date() {
        // 12:00 EDT, two days after the switch to daylight saving time.
        let now = New_York.with_ymd_and_hms(2026, 3, 10, 12, 0, 0).unwrap();
        // Three days earlier at 12:00 EST (17:00 UTC), not 72 hours earlier (16:00 UTC).
        assert_eq!(tombstone_cutoff(now, 3), Utc.with_ymd_and_hms(2026, 3, 7, 17, 0, 0).unwrap());
    }
}
