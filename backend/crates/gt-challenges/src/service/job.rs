//! The daily challenge job (port of `services/challenge_job.go`).

use std::time::Instant;

use anyhow::Context as _;
use chrono::{NaiveDate, Utc};
use gt_core::constants as c;
use gt_core::models::{
    Challenge, ChallengeEndedMetadata, CronJobLog, CRON_JOB_CHALLENGE_DAILY, CRON_JOB_STATUS_COMPLETED,
    CRON_JOB_STATUS_FAILED,
};

use super::challenge::{chain, report_notification, ChallengeService};
use super::locking::{final_standings, locked_days, needs_finalizing, EndedResult, LockRange};
use super::rules::{add_days, format_date};

/// The failures of one [`ChallengeService::run_daily_job`] run (Go `errors.Join`): the message
/// lists them one per line.
#[derive(Debug)]
pub struct DailyJobError(pub Vec<anyhow::Error>);

impl std::fmt::Display for DailyJobError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let lines: Vec<String> = self.0.iter().map(chain).collect();
        f.write_str(&lines.join("\n"))
    }
}

impl std::error::Error for DailyJobError {}

impl ChallengeService {
    /// Makes challenge results final. It runs at 00:05 IST and
    /// 1. locks every day that can no longer change (through today-2) of every challenge that
    ///    needs it, catching up on days missed by earlier runs: each participant's result is
    ///    stored in `challenge_days` and `locked_through` advances;
    /// 2. finalizes the challenges whose end date is locked: final ranks, days met, hours and
    ///    completion are stored, and every participant gets a `challenge_ended` notification.
    ///
    /// One replica runs it per IST day (claimed in `cron_job_logs`). Re-running it is safe:
    /// stored days are never rewritten, each challenge is re-checked under its row lock and
    /// finalized challenges are skipped. A failing challenge does not stop the others; it is
    /// retried on the next run.
    pub async fn run_daily_job(&self) -> Result<(), DailyJobError> {
        let started = Instant::now();
        let today = self.today();
        let through = add_days(today, -c::CHALLENGE_LOCK_DELAY_DAYS);
        let job_date = format_date(today);
        let job = CRON_JOB_CHALLENGE_DAILY;

        let mut job_log = None;
        if let Some(repo) = &self.job_log_repo {
            match repo.try_claim_job(CRON_JOB_CHALLENGE_DAILY, today, &self.instance_id).await {
                // Better to risk a duplicate run (it is idempotent) than to skip the day.
                Err(err) => tracing::warn!(
                    job, job_date = %job_date, error = %err,
                    "Failed to claim the challenge job, running without a job log"
                ),
                Ok((claimed, false)) => {
                    tracing::info!(
                        job, job_date = %job_date, claimed_by = %claimed.instance_id, claimed_at = %claimed.started_at,
                        "Challenge job already claimed by another instance, skipping"
                    );
                    return Ok(());
                }
                Ok((claimed, true)) => {
                    tracing::info!(
                        job, job_date = %job_date, instance_id = %self.instance_id, lock_through = %format_date(through),
                        "Claimed the challenge job"
                    );
                    job_log = Some(claimed);
                }
            }
        }

        let mut errs: Vec<anyhow::Error> = Vec::new();
        let mut locked = 0_i64;
        let lock_ids = match self.challenge_ids_to_lock(through).await {
            Ok(ids) => ids,
            Err(err) => {
                tracing::error!(
                    job, job_date = %job_date, error = %chain(&err),
                    "Failed to list challenges to lock; locking is retried on the next run"
                );
                errs.push(err.context("list challenges to lock"));
                Vec::new()
            }
        };
        for id in lock_ids {
            match self.lock_challenge_days(id, through).await {
                Ok(()) => locked += 1,
                Err(err) => {
                    tracing::error!(
                        job, job_date = %job_date, challenge_id = id, error = %chain(&err),
                        "Failed to lock challenge days; they are locked on the next run"
                    );
                    errs.push(err.context(format!("lock challenge {id}")));
                }
            }
        }

        let mut finalized = 0_i64;
        let finalize_ids = match self.challenge_ids_to_finalize().await {
            Ok(ids) => ids,
            Err(err) => {
                tracing::error!(
                    job, job_date = %job_date, error = %chain(&err),
                    "Failed to list challenges to finalize; finalization is retried on the next run"
                );
                errs.push(err.context("list challenges to finalize"));
                Vec::new()
            }
        };
        for id in finalize_ids {
            match self.finalize_challenge(id).await {
                Err(err) => {
                    tracing::error!(
                        job, job_date = %job_date, challenge_id = id, error = %chain(&err),
                        "Failed to finalize challenge; it is retried on the next run"
                    );
                    errs.push(err.context(format!("finalize challenge {id}")));
                }
                Ok(None) => {} // finalized meanwhile
                Ok(Some((challenge, results))) => {
                    finalized += 1;
                    self.notify_ended(&challenge, &results).await;
                }
            }
        }

        let failed = !errs.is_empty();
        let job_err = DailyJobError(errs);
        let (status, message) = if failed {
            (CRON_JOB_STATUS_FAILED, job_err.to_string())
        } else {
            (CRON_JOB_STATUS_COMPLETED, String::new())
        };
        // The job log's users_count holds the number of challenges processed.
        self.update_job_log(job_log, status, locked + finalized, message).await;
        tracing::info!(
            job,
            job_date = %job_date,
            status,
            challenges_locked = locked,
            challenges_finalized = finalized,
            failures = job_err.0.len(),
            duration_ms = started.elapsed().as_millis() as u64,
            "Challenge job finished"
        );
        if failed {
            Err(job_err)
        } else {
            Ok(())
        }
    }

    async fn challenge_ids_to_lock(&self, through: NaiveDate) -> anyhow::Result<Vec<i64>> {
        Ok(self.repo.conn().await?.challenge_ids_to_lock(through).await?)
    }

    async fn challenge_ids_to_finalize(&self) -> anyhow::Result<Vec<i64>> {
        Ok(self.repo.conn().await?.challenge_ids_to_finalize().await?)
    }

    /// Stores the result of every participant on every unlocked date of the challenge up to
    /// `through` (or its end date) and advances `locked_through`, in one transaction holding the
    /// challenge's row lock. Each participant gets rows from their window start only.
    pub async fn lock_challenge_days(&self, id: i64, through: NaiveDate) -> anyhow::Result<()> {
        let (mut tx, challenge) = self.repo.lock_challenge(id).await?;
        let Some(range) = LockRange::of(&challenge, through) else {
            tx.commit().await?;
            return Ok(()); // locked meanwhile
        };

        let participants = tx.list_participants(&[challenge.id]).await.context("list participants")?;
        let live = tx.activity_days(&[challenge.id], range.last).await.context("read activity days")?;
        let locked_at = self.now();
        let rows = locked_days(&challenge, range, &participants, &live, locked_at);
        let inserted = tx.insert_days(&rows).await.context("store locked days")?;
        tx.set_locked_through(challenge.id, range.last, locked_at).await.context("advance locked_through")?;
        tracing::info!(
            challenge_id = challenge.id,
            participants = participants.len(),
            from = %format_date(range.first),
            through = %format_date(range.last),
            days = range.days(),
            rows_inserted = inserted,
            "Challenge days locked"
        );
        tx.commit().await?;
        Ok(())
    }

    /// Computes the final standings from the locked days and stores them with `finalized_at`,
    /// in one transaction holding the challenge's row lock. `None` when there is nothing to do.
    pub async fn finalize_challenge(&self, id: i64) -> anyhow::Result<Option<(Challenge, Vec<EndedResult>)>> {
        let (mut tx, challenge) = self.repo.lock_challenge(id).await?;
        if !needs_finalizing(&challenge) {
            tx.commit().await?;
            return Ok(None);
        }
        let participants = tx.list_participants(&[challenge.id]).await.context("list participants")?;
        let totals = tx.locked_totals(&[challenge.id]).await.context("sum locked days")?;
        let (finals, results) = final_standings(&challenge, &participants, &totals);
        tx.save_final_results(&finals).await.context("store final results")?;
        tx.mark_finalized(challenge.id, self.now()).await.context("mark finalized")?;
        tracing::info!(
            challenge_id = challenge.id,
            participants = participants.len(),
            completed = results.iter().filter(|r| r.completed).count(),
            "Challenge finalized"
        );
        tx.commit().await?;
        Ok(Some((challenge, results)))
    }

    async fn notify_ended(&self, challenge: &Challenge, results: &[EndedResult]) {
        let Some(notifications) = &self.notifications else {
            return;
        };
        for r in results {
            let metadata = ChallengeEndedMetadata {
                challenge_id: challenge.id,
                challenge_title: challenge.title.clone(),
                rank: r.rank,
                days_met: r.days_met,
                days_possible: r.days_possible,
                completed: r.completed,
            };
            let result = notifications.notify_challenge_ended(r.user_id, &metadata).await;
            report_notification(challenge.id, "challenge_ended", r.user_id, result);
        }
    }

    /// Records the outcome of a claimed job run.
    async fn update_job_log(&self, job_log: Option<CronJobLog>, status: &str, processed: i64, error: String) {
        let (Some(repo), Some(mut log)) = (&self.job_log_repo, job_log) else {
            return;
        };
        if log.id == 0 {
            return;
        }
        log.status = status.to_string();
        log.users_count = processed;
        log.completed_at = Some(Utc::now());
        log.error = error;
        if let Err(err) = repo.update(&mut log).await {
            tracing::warn!(job_log_id = log.id, error = %err, "Failed to update the challenge job log");
        }
    }
}
