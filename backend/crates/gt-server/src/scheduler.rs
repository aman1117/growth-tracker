//! Daily jobs at fixed IST wall-clock times (replaces `robfig/cron` with
//! `cron.WithLocation(Asia/Kolkata)`). Every replica schedules the jobs; the jobs themselves
//! claim their run in `cron_job_logs` so only one replica does the work.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use chrono::{DateTime, Duration, NaiveTime, TimeZone, Utc};
use gt_core::timeutil::IST;
use tokio::task::JoinHandle;

/// A boxed job future.
pub type JobFuture = Pin<Box<dyn Future<Output = ()> + Send>>;

/// The next instant strictly after `now` whose IST wall-clock time is `at`.
pub fn next_run(now: DateTime<Utc>, at: NaiveTime) -> DateTime<Utc> {
    let local_now = now.with_timezone(&IST);
    let mut day = local_now.date_naive();
    loop {
        if let Some(candidate) = IST.from_local_datetime(&day.and_time(at)).single() {
            let candidate = candidate.with_timezone(&Utc);
            if candidate > now {
                return candidate;
            }
        }
        day += Duration::days(1);
    }
}

/// Runs `job` every day at `at` (IST) until the process exits.
pub fn spawn_daily<F>(name: &'static str, at: NaiveTime, job: F) -> JoinHandle<()>
where
    F: Fn() -> JobFuture + Send + Sync + 'static,
{
    let job = Arc::new(job);
    tokio::spawn(async move {
        loop {
            let now = Utc::now();
            let next = next_run(now, at);
            let wait = (next - now).to_std().unwrap_or_default();
            tracing::debug!(job = name, next_run = %next, "Cron job scheduled");
            tokio::time::sleep(wait).await;
            let job = job.clone();
            // Like robfig/cron, each run is independent: a slow run never delays the schedule.
            tokio::spawn(async move { job().await });
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn next_run_is_in_ist() {
        let at = NaiveTime::from_hms_opt(0, 0, 0).unwrap();
        // 2026-01-01 10:00 UTC = 15:30 IST -> next IST midnight = 2026-01-01 18:30 UTC
        let now = Utc.with_ymd_and_hms(2026, 1, 1, 10, 0, 0).unwrap();
        assert_eq!(next_run(now, at), Utc.with_ymd_and_hms(2026, 1, 1, 18, 30, 0).unwrap());
        // Exactly at the run time -> the following day.
        let now = Utc.with_ymd_and_hms(2026, 1, 1, 18, 30, 0).unwrap();
        assert_eq!(next_run(now, at), Utc.with_ymd_and_hms(2026, 1, 2, 18, 30, 0).unwrap());
        let at = NaiveTime::from_hms_opt(22, 0, 0).unwrap();
        let now = Utc.with_ymd_and_hms(2026, 1, 1, 10, 0, 0).unwrap();
        assert_eq!(next_run(now, at), Utc.with_ymd_and_hms(2026, 1, 1, 16, 30, 0).unwrap());
    }
}
