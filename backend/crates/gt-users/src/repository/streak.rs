//! `StreakRepository` (port of the streak part of `internal/repository/repository.go`).

use chrono::NaiveDate;
use gt_core::models::Streak;
use sqlx::PgPool;

/// Handles streak data operations.
#[derive(Debug, Clone)]
pub struct StreakRepository {
    pool: PgPool,
}

impl StreakRepository {
    /// A repository over `pool`.
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// Inserts `streak` and stores the generated id in it (GORM `Create`).
    pub async fn create(&self, streak: &mut Streak) -> Result<(), sqlx::Error> {
        streak.id = sqlx::query_scalar(
            "INSERT INTO streaks (user_id, current, longest, activity_date) VALUES ($1, $2, $3, $4) RETURNING id",
        )
        .bind(streak.user_id)
        .bind(streak.current)
        .bind(streak.longest)
        .bind(streak.activity_date)
        .fetch_one(&self.pool)
        .await?;
        Ok(())
    }

    /// Writes every column of `streak` (GORM `Save`: update by id, insert when the row is missing
    /// or the id is 0).
    pub async fn update(&self, streak: &mut Streak) -> Result<(), sqlx::Error> {
        if streak.id == 0 {
            return self.create(streak).await;
        }
        sqlx::query(
            "INSERT INTO streaks (id, user_id, current, longest, activity_date) VALUES ($1, $2, $3, $4, $5) \
             ON CONFLICT (id) DO UPDATE SET user_id = EXCLUDED.user_id, current = EXCLUDED.current, \
             longest = EXCLUDED.longest, activity_date = EXCLUDED.activity_date",
        )
        .bind(streak.id)
        .bind(streak.user_id)
        .bind(streak.current)
        .bind(streak.longest)
        .bind(streak.activity_date)
        .execute(&self.pool)
        .await
        .map(|_| ())
    }

    async fn find_one(&self, sql: &str, user_id: i64) -> Result<Option<Streak>, sqlx::Error> {
        sqlx::query_as::<_, Streak>(sql).bind(user_id).fetch_optional(&self.pool).await
    }

    /// The user's most recent streak record (by `activity_date`), or `None`.
    pub async fn find_latest_by_user(&self, user_id: i64) -> Result<Option<Streak>, sqlx::Error> {
        let sql =
            format!("SELECT {} FROM streaks WHERE user_id = $1 ORDER BY activity_date DESC LIMIT 1", Streak::COLUMNS);
        self.find_one(&sql, user_id).await
    }

    /// The user's most recent record with `current > 0` (a day they actually logged), or `None`.
    pub async fn find_latest_active_by_user(&self, user_id: i64) -> Result<Option<Streak>, sqlx::Error> {
        let sql = format!(
            "SELECT {} FROM streaks WHERE user_id = $1 AND current > 0 ORDER BY activity_date DESC LIMIT 1",
            Streak::COLUMNS
        );
        self.find_one(&sql, user_id).await
    }

    /// The user's second most recent record, or `None`.
    pub async fn find_previous_by_user(&self, user_id: i64) -> Result<Option<Streak>, sqlx::Error> {
        let sql = format!(
            "SELECT {} FROM streaks WHERE user_id = $1 ORDER BY activity_date DESC LIMIT 1 OFFSET 1",
            Streak::COLUMNS
        );
        self.find_one(&sql, user_id).await
    }

    /// The user's record for `date` (the most recently inserted one if there are several), or
    /// `None` (GORM `Last`).
    pub async fn find_by_user_and_date(&self, user_id: i64, date: NaiveDate) -> Result<Option<Streak>, sqlx::Error> {
        let sql = format!(
            "SELECT {} FROM streaks WHERE user_id = $1 AND activity_date = $2 ORDER BY id DESC LIMIT 1",
            Streak::COLUMNS
        );
        sqlx::query_as::<_, Streak>(&sql).bind(user_id).bind(date).fetch_optional(&self.pool).await
    }

    /// Every record of the user, oldest first.
    pub async fn find_all_by_user(&self, user_id: i64) -> Result<Vec<Streak>, sqlx::Error> {
        let sql = format!("SELECT {} FROM streaks WHERE user_id = $1 ORDER BY activity_date ASC", Streak::COLUMNS);
        sqlx::query_as::<_, Streak>(&sql).bind(user_id).fetch_all(&self.pool).await
    }

    /// Distinct ids of users whose record for `date` (`YYYY-MM-DD`) has `current = 0`.
    pub async fn find_users_missed_streak(&self, date: &str) -> Result<Vec<i64>, sqlx::Error> {
        sqlx::query_scalar("SELECT DISTINCT user_id FROM streaks WHERE current = 0 AND DATE(activity_date) = $1::date")
            .bind(date)
            .fetch_all(&self.pool)
            .await
    }
}
