//! `ActivityRepository` (port of the activity part of `internal/repository/repository.go`).

use chrono::{DateTime, NaiveDate, Utc};
use gt_core::gojson;
use gt_core::models::Activity;
use sqlx::PgPool;

/// Why an activity could not be written.
#[derive(Debug, thiserror::Error)]
pub enum ActivityWriteError {
    /// Rejected by the model validation that GORM ran in its `BeforeSave` hook (e.g.
    /// `invalid activity name: swimming`).
    #[error("{0}")]
    Invalid(String),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
}

/// Handles activity data operations.
#[derive(Debug, Clone)]
pub struct ActivityRepository {
    pool: PgPool,
}

/// GORM leaves a zero `created_at`/`updated_at` to be filled with the current time.
fn time_or_now(value: &DateTime<Utc>) -> Option<DateTime<Utc>> {
    (!gojson::is_go_zero_time(value)).then_some(*value)
}

impl ActivityRepository {
    /// A repository over `pool`.
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// Validates and inserts `activity`, storing the generated id and timestamps in it (GORM
    /// `Create`). Use [`gojson::go_zero_time`] for timestamps that should default to now.
    pub async fn create(&self, activity: &mut Activity) -> Result<(), ActivityWriteError> {
        activity.validate().map_err(ActivityWriteError::Invalid)?;
        let (id, created_at, updated_at): (i64, DateTime<Utc>, DateTime<Utc>) = sqlx::query_as(
            "INSERT INTO activities (user_id, name, duration_hours, note, created_at, updated_at, activity_date) \
             VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, NOW()), COALESCE($6::timestamptz, NOW()), $7) \
             RETURNING id, created_at, updated_at",
        )
        .bind(activity.user_id)
        .bind(&activity.name)
        // Go handed float32 hours to the driver as float64; binding float4 would round
        // differently into numeric(4,2) (e.g. 2.675f32 -> 2.67, not 2.68).
        .bind(f64::from(activity.duration_hours))
        .bind(&activity.note)
        .bind(time_or_now(&activity.created_at))
        .bind(time_or_now(&activity.updated_at))
        .bind(activity.activity_date)
        .fetch_one(&self.pool)
        .await?;
        activity.id = id;
        activity.created_at = created_at;
        activity.updated_at = updated_at;
        Ok(())
    }

    /// Validates and writes every column of `activity` (GORM `Save`: update by id, inserting
    /// when the row is missing; `updated_at` becomes now).
    pub async fn update(&self, activity: &mut Activity) -> Result<(), ActivityWriteError> {
        if activity.id == 0 {
            return self.create(activity).await;
        }
        activity.validate().map_err(ActivityWriteError::Invalid)?;
        let updated_at: DateTime<Utc> = sqlx::query_scalar(
            "INSERT INTO activities (id, user_id, name, duration_hours, note, created_at, updated_at, activity_date) \
             VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, NOW()), NOW(), $7) \
             ON CONFLICT (id) DO UPDATE SET user_id = EXCLUDED.user_id, name = EXCLUDED.name, \
             duration_hours = EXCLUDED.duration_hours, note = EXCLUDED.note, created_at = EXCLUDED.created_at, \
             updated_at = EXCLUDED.updated_at, activity_date = EXCLUDED.activity_date \
             RETURNING updated_at",
        )
        .bind(activity.id)
        .bind(activity.user_id)
        .bind(&activity.name)
        .bind(f64::from(activity.duration_hours))
        .bind(&activity.note)
        .bind(time_or_now(&activity.created_at))
        .bind(activity.activity_date)
        .fetch_one(&self.pool)
        .await?;
        activity.updated_at = updated_at;
        Ok(())
    }

    /// Every activity of the user on `date` (no particular order; empty when none).
    pub async fn find_by_user_and_date(&self, user_id: i64, date: NaiveDate) -> Result<Vec<Activity>, sqlx::Error> {
        let sql = format!("SELECT {} FROM activities WHERE user_id = $1 AND activity_date = $2", Activity::COLUMNS);
        sqlx::query_as::<_, Activity>(&sql).bind(user_id).bind(date).fetch_all(&self.pool).await
    }

    /// Every activity of the user from `start_date` to `end_date` inclusive (no particular
    /// order; empty when none).
    pub async fn find_by_user_and_date_range(
        &self,
        user_id: i64,
        start_date: NaiveDate,
        end_date: NaiveDate,
    ) -> Result<Vec<Activity>, sqlx::Error> {
        let sql = format!(
            "SELECT {} FROM activities WHERE user_id = $1 AND activity_date BETWEEN $2 AND $3",
            Activity::COLUMNS
        );
        sqlx::query_as::<_, Activity>(&sql).bind(user_id).bind(start_date).bind(end_date).fetch_all(&self.pool).await
    }
}
