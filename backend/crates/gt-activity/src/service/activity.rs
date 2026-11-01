//! `ActivityService` (port of the activity part of `internal/services/services.go`).

use std::sync::Arc;

use chrono::NaiveDate;
use gt_core::gojson;
use gt_core::models::Activity;
use gt_notify::NotificationService;
use gt_users::{FollowRepository, StreakService, UserRepository};

use crate::dates::format_date;
use crate::dto::DailyTotals;
use crate::repository::{ActivityRepository, ActivityWriteError};

/// A day holds at most this many hours.
const MAX_DAY_HOURS: f32 = 24.0;

/// Errors of [`ActivityService::create_or_update_activity`]. The messages are the Go error
/// strings.
#[derive(Debug, thiserror::Error)]
pub enum ActivityError {
    /// The day would exceed 24 hours.
    #[error("total hours cannot be more than 24")]
    HoursExceeded,
    /// Rejected by the activity model validation.
    #[error("{0}")]
    Invalid(String),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
}

impl From<ActivityWriteError> for ActivityError {
    fn from(err: ActivityWriteError) -> Self {
        match err {
            ActivityWriteError::Invalid(message) => ActivityError::Invalid(message),
            ActivityWriteError::Database(err) => ActivityError::Database(err),
        }
    }
}

/// Logging activities, with streak updates and day-completion notifications.
#[derive(Debug, Clone)]
pub struct ActivityService {
    activity_repo: Arc<ActivityRepository>,
    streak_service: Arc<StreakService>,
    user_repo: Arc<UserRepository>,
    follow_repo: Arc<FollowRepository>,
    /// `None` disables day-completion notifications (Go: a nil notification service).
    notifications: Option<Arc<NotificationService>>,
}

impl ActivityService {
    /// Go `NewActivityService`.
    pub fn new(
        activity_repo: Arc<ActivityRepository>,
        streak_service: Arc<StreakService>,
        user_repo: Arc<UserRepository>,
        follow_repo: Arc<FollowRepository>,
        notifications: Option<Arc<NotificationService>>,
    ) -> Self {
        Self { activity_repo, streak_service, user_repo, follow_repo, notifications }
    }

    /// Sets the hours (and note) of an activity on a day, creating it when needed, as long as
    /// the day stays within 24 hours. When the day reaches 24 hours the followers are notified
    /// in the background; then the streak is updated (only for today's date).
    pub async fn create_or_update_activity(
        &self,
        user_id: i64,
        name: &str,
        hours: f32,
        date: NaiveDate,
        note: Option<String>,
    ) -> Result<(), ActivityError> {
        let day_activities = self.activity_repo.find_by_user_and_date(user_id, date).await?;

        // Hours are summed in float32 in the database order, like Go.
        let mut total_hours: f32 = 0.0;
        let mut existing: Option<Activity> = None;
        for activity in day_activities {
            total_hours += activity.duration_hours;
            if activity.name == name {
                existing = Some(activity);
            }
        }
        let previous_total = total_hours;
        let new_total = match &existing {
            Some(activity) => total_hours - activity.duration_hours + hours,
            None => total_hours + hours,
        };
        if new_total > MAX_DAY_HOURS {
            return Err(ActivityError::HoursExceeded);
        }

        match existing {
            Some(mut activity) => {
                activity.duration_hours = hours;
                activity.note = note;
                self.activity_repo.update(&mut activity).await?;
            }
            None => {
                let mut activity = Activity {
                    id: 0,
                    user_id,
                    name: name.to_string(),
                    duration_hours: hours,
                    note,
                    created_at: gojson::go_zero_time(),
                    updated_at: gojson::go_zero_time(),
                    activity_date: date,
                };
                self.activity_repo.create(&mut activity).await?;
            }
        }

        let crossed = previous_total < MAX_DAY_HOURS && new_total >= MAX_DAY_HOURS;
        tracing::debug!(user_id, previous_total, new_total, threshold_check = crossed, "Activity hours calculation");
        if crossed {
            self.notify_followers_of_day_completion(user_id, date);
        }

        self.streak_service.add_streak(user_id, date, false).await?;
        Ok(())
    }

    /// Tells the user's followers that the day is complete, in the background (Go goroutine).
    pub fn notify_followers_of_day_completion(&self, user_id: i64, date: NaiveDate) {
        let Some(notifications) = self.notifications.clone() else {
            tracing::warn!(
                user_id,
                notif_svc_nil = true,
                "Skipping day completion notification - missing dependencies"
            );
            return;
        };
        // Dates are calendar dates, so the IST date Go formatted is the same day.
        let date_str = format_date(date);
        tracing::info!(user_id, date = %date_str, "Triggering day completion notification");

        let user_repo = self.user_repo.clone();
        let follow_repo = self.follow_repo.clone();
        tokio::spawn(async move {
            let user = match user_repo.find_by_id(user_id).await {
                Ok(user) => user,
                Err(err) => {
                    tracing::warn!(user_id, error = %err, "Failed to get user for day completion notification");
                    return;
                }
            };
            let follower_ids = match follow_repo.get_all_follower_ids(user_id).await {
                Ok(ids) => ids,
                Err(err) => {
                    tracing::warn!(user_id, error = %err, "Failed to get followers for day completion notification");
                    return;
                }
            };
            if follower_ids.is_empty() {
                tracing::debug!(user_id, "No followers to notify for day completion");
                return;
            }
            let Some(user) = user else {
                // Go dereferenced the missing user here and recovered from the panic.
                tracing::error!(user_id, "Day completion notification skipped - user not found");
                return;
            };
            tracing::info!(
                user_id,
                username = %user.username,
                follower_count = follower_ids.len(),
                "Sending day completion notifications to followers"
            );
            let avatar = user.profile_pic.as_deref().unwrap_or_default();
            if let Err(err) =
                notifications.notify_day_completed(user_id, &user.username, avatar, &date_str, &follower_ids).await
            {
                tracing::warn!(user_id, date = %date_str, error = %err, "Failed to send day completion notifications");
            }
        });
    }

    /// The user's activities from `start_date` to `end_date` inclusive.
    pub async fn get_activities(
        &self,
        user_id: i64,
        start_date: NaiveDate,
        end_date: NaiveDate,
    ) -> Result<Vec<Activity>, sqlx::Error> {
        self.activity_repo.find_by_user_and_date_range(user_id, start_date, end_date).await
    }

    /// Total hours per `YYYY-MM-DD` from `start_date` to `end_date` inclusive (days without
    /// activities are absent).
    pub async fn get_daily_totals(
        &self,
        user_id: i64,
        start_date: NaiveDate,
        end_date: NaiveDate,
    ) -> Result<DailyTotals, sqlx::Error> {
        let activities = self.activity_repo.find_by_user_and_date_range(user_id, start_date, end_date).await?;
        let mut totals = DailyTotals::new();
        for activity in activities {
            *totals.entry(format_date(activity.activity_date)).or_insert(0.0) += activity.duration_hours;
        }
        Ok(totals)
    }
}
