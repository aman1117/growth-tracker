//! `CronJobLogRepository` (port of the cron job log part of `internal/repository/repository.go`).

use chrono::{DateTime, NaiveDate, Utc};
use gt_core::gojson;
use gt_core::models::{CronJobLog, CRON_JOB_STATUS_COMPLETED, CRON_JOB_STATUS_RUNNING};
use sqlx::PgPool;

/// Handles cron job log data operations.
///
/// Go's `CronJobLog.CompletedAt` is a plain `time.Time`, so GORM writes the zero time
/// (`0001-01-01T00:00:00Z`) rather than NULL for an unfinished job. [`CronJobLogRepository::create`]
/// and [`CronJobLogRepository::update`] do the same for `completed_at: None`, keeping rows written
/// by either implementation identical; claims inserted by [`CronJobLogRepository::try_claim_job`]
/// leave it NULL, as Go's raw INSERT did.
#[derive(Debug, Clone)]
pub struct CronJobLogRepository {
    pool: PgPool,
}

fn completed_at_for_write(log: &CronJobLog) -> DateTime<Utc> {
    log.completed_at.unwrap_or_else(gojson::go_zero_time)
}

impl CronJobLogRepository {
    /// A repository over `pool`.
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// Inserts `log` and stores the generated id in it (GORM `Create`: an empty status becomes
    /// `running`, the column default).
    pub async fn create(&self, log: &mut CronJobLog) -> Result<(), sqlx::Error> {
        if log.status.is_empty() {
            log.status = CRON_JOB_STATUS_RUNNING.to_string();
        }
        log.id = sqlx::query_scalar(
            "INSERT INTO cron_job_logs (job_name, job_date, started_at, completed_at, status, users_count, error, instance_id) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id",
        )
        .bind(&log.job_name)
        .bind(log.job_date)
        .bind(log.started_at)
        .bind(completed_at_for_write(log))
        .bind(&log.status)
        .bind(log.users_count)
        .bind(&log.error)
        .bind(&log.instance_id)
        .fetch_one(&self.pool)
        .await?;
        Ok(())
    }

    /// Atomically claims `job_name` for `job_date` with `INSERT ... ON CONFLICT DO NOTHING`, so only
    /// one replica runs a job per day. Returns `(log, true)` when this call claimed the job and
    /// `(existing_log, false)` when another instance already had.
    pub async fn try_claim_job(
        &self,
        job_name: &str,
        job_date: NaiveDate,
        instance_id: &str,
    ) -> Result<(CronJobLog, bool), sqlx::Error> {
        let started_at = Utc::now();
        let inserted = sqlx::query(
            "INSERT INTO cron_job_logs (job_name, job_date, started_at, status, instance_id, users_count) \
             VALUES ($1, $2, $3, $4, $5, 0) ON CONFLICT (job_name, job_date) DO NOTHING",
        )
        .bind(job_name)
        .bind(job_date)
        .bind(started_at)
        .bind(CRON_JOB_STATUS_RUNNING)
        .bind(instance_id)
        .execute(&self.pool)
        .await?
        .rows_affected();

        let sql = format!(
            "SELECT {} FROM cron_job_logs WHERE job_name = $1 AND job_date = $2 ORDER BY id LIMIT 1",
            CronJobLog::COLUMNS
        );
        let log = sqlx::query_as::<_, CronJobLog>(&sql).bind(job_name).bind(job_date).fetch_one(&self.pool).await?;
        Ok((log, inserted > 0))
    }

    /// Writes every column of `log` (GORM `Save`: update by id, insert when the row is missing or
    /// the id is 0).
    pub async fn update(&self, log: &mut CronJobLog) -> Result<(), sqlx::Error> {
        if log.id == 0 {
            return self.create(log).await;
        }
        // On insert GORM applies the status default; on update it writes the value as is.
        sqlx::query(
            "INSERT INTO cron_job_logs (id, job_name, job_date, started_at, completed_at, status, users_count, error, instance_id) \
             VALUES ($1, $2, $3, $4, $5, COALESCE(NULLIF($6, ''), 'running'), $7, $8, $9) \
             ON CONFLICT (id) DO UPDATE SET job_name = EXCLUDED.job_name, job_date = EXCLUDED.job_date, \
             started_at = EXCLUDED.started_at, completed_at = EXCLUDED.completed_at, status = $6, \
             users_count = EXCLUDED.users_count, error = EXCLUDED.error, instance_id = EXCLUDED.instance_id",
        )
        .bind(log.id)
        .bind(&log.job_name)
        .bind(log.job_date)
        .bind(log.started_at)
        .bind(completed_at_for_write(log))
        .bind(&log.status)
        .bind(log.users_count)
        .bind(&log.error)
        .bind(&log.instance_id)
        .execute(&self.pool)
        .await
        .map(|_| ())
    }

    /// The completed run of `job_name` for `job_date`, or `None`.
    pub async fn find_by_job_name_and_date(
        &self,
        job_name: &str,
        job_date: NaiveDate,
    ) -> Result<Option<CronJobLog>, sqlx::Error> {
        let sql = format!(
            "SELECT {} FROM cron_job_logs WHERE job_name = $1 AND job_date = $2 AND status = $3 ORDER BY id LIMIT 1",
            CronJobLog::COLUMNS
        );
        sqlx::query_as::<_, CronJobLog>(&sql)
            .bind(job_name)
            .bind(job_date)
            .bind(CRON_JOB_STATUS_COMPLETED)
            .fetch_optional(&self.pool)
            .await
    }

    /// The latest `limit` runs of `job_name`, newest first (a negative limit returns all).
    pub async fn find_recent_by_job_name(&self, job_name: &str, limit: i64) -> Result<Vec<CronJobLog>, sqlx::Error> {
        let sql = format!(
            "SELECT {} FROM cron_job_logs WHERE job_name = $1 ORDER BY started_at DESC LIMIT $2",
            CronJobLog::COLUMNS
        );
        sqlx::query_as::<_, CronJobLog>(&sql).bind(job_name).bind(super::go_limit(limit)).fetch_all(&self.pool).await
    }
}
