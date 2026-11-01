//! `StreakService` (port of the streak part of `internal/services/services.go`).

use std::sync::Arc;

use chrono::{NaiveDate, Utc};
use gt_core::models::Streak;

use crate::repository::StreakRepository;

/// Daily streak bookkeeping.
#[derive(Debug, Clone)]
pub struct StreakService {
    streak_repo: Arc<StreakRepository>,
}

impl StreakService {
    /// Go `NewStreakService`.
    pub fn new(streak_repo: Arc<StreakRepository>) -> Self {
        Self { streak_repo }
    }

    /// Records activity on `date` (regular updates) or opens the day for the daily job
    /// (`is_cron`).
    ///
    /// * Regular updates ignore dates before today. "Today" is the current UTC date: Go compared
    ///   against midnight in `date`'s location, and every non-cron caller passes a date parsed with
    ///   `time.Parse` (UTC).
    /// * The daily job (idempotent) creates a `current = 0` record for `date` carrying the latest
    ///   `longest`, unless one exists.
    /// * Otherwise today's record (normally opened by the job) becomes `previous.current + 1`
    ///   once, raising `longest` when beaten; a user with no previous record gets a fresh streak.
    pub async fn add_streak(&self, user_id: i64, date: NaiveDate, is_cron: bool) -> Result<(), sqlx::Error> {
        let today = Utc::now().date_naive();
        if date < today && !is_cron {
            return Ok(());
        }

        let latest = self.streak_repo.find_latest_by_user(user_id).await?;

        if is_cron {
            if self.streak_repo.find_by_user_and_date(user_id, date).await?.is_some() {
                return Ok(());
            }
            let mut opened = Streak {
                id: 0,
                user_id,
                current: 0,
                longest: latest.map(|s| s.longest).unwrap_or(0),
                activity_date: date,
            };
            return self.streak_repo.create(&mut opened).await;
        }

        // Go ignored this lookup's error and treated it as "no previous record".
        let previous = self.streak_repo.find_previous_by_user(user_id).await.ok().flatten();
        let current = previous.as_ref().map(|s| s.current).unwrap_or(0);

        if previous.as_ref().is_some_and(|p| p.id != 0) {
            let Some(mut today_record) = self.streak_repo.find_by_user_and_date(user_id, date).await? else {
                return Ok(());
            };
            if today_record.current != 0 {
                return Ok(()); // Already counted
            }
            today_record.current = current + 1;
            today_record.longest = match &latest {
                Some(l) if l.longest > today_record.current => l.longest,
                _ => today_record.current,
            };
            return self.streak_repo.update(&mut today_record).await;
        }

        // No previous record: count the day on the record the daily job opened, if any (Go
        // ignored this lookup's error too).
        if let Some(mut today_record) = self.streak_repo.find_by_user_and_date(user_id, date).await.ok().flatten() {
            if today_record.id != 0 {
                if today_record.current != 0 {
                    return Ok(()); // Already counted
                }
                today_record.current = current + 1;
                today_record.longest = today_record.longest.max(today_record.current);
                return self.streak_repo.update(&mut today_record).await;
            }
        }

        let mut fresh = Streak { id: 0, user_id, current: current + 1, longest: 1, activity_date: date };
        self.streak_repo.create(&mut fresh).await
    }

    /// The user's record for `date`, or `None`.
    pub async fn get_streak(&self, user_id: i64, date: NaiveDate) -> Result<Option<Streak>, sqlx::Error> {
        self.streak_repo.find_by_user_and_date(user_id, date).await
    }

    /// The user's most recent record, or `None`.
    pub async fn get_latest_streak(&self, user_id: i64) -> Result<Option<Streak>, sqlx::Error> {
        self.streak_repo.find_latest_by_user(user_id).await
    }

    /// The user's most recent record with `current > 0`, or `None`.
    pub async fn get_latest_active_streak(&self, user_id: i64) -> Result<Option<Streak>, sqlx::Error> {
        self.streak_repo.find_latest_active_by_user(user_id).await
    }

    /// All of the user's records, oldest first.
    pub async fn get_all_streaks(&self, user_id: i64) -> Result<Vec<Streak>, sqlx::Error> {
        self.streak_repo.find_all_by_user(user_id).await
    }
}
