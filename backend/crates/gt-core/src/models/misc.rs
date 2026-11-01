use chrono::{DateTime, NaiveDate, NaiveDateTime, Utc};

/// A user's streak snapshot for a day (`streaks`).
#[derive(Debug, Clone, PartialEq, sqlx::FromRow)]
pub struct Streak {
    pub id: i64,
    pub user_id: i64,
    pub current: i64,
    pub longest: i64,
    pub activity_date: NaiveDate,
}

impl Streak {
    pub const COLUMNS: &'static str = "id, user_id, current, longest, activity_date";
}

/// A like on a user's day (`likes`).
#[derive(Debug, Clone, PartialEq, sqlx::FromRow)]
pub struct Like {
    pub id: i64,
    pub liker_id: i64,
    pub liked_user_id: i64,
    pub liked_date: NaiveDate,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl Like {
    pub const COLUMNS: &'static str = "id, liker_id, liked_user_id, liked_date, created_at, updated_at";
}

/// A badge earned by a user (`user_badges`).
#[derive(Debug, Clone, PartialEq, sqlx::FromRow)]
pub struct UserBadge {
    pub id: i64,
    pub user_id: i64,
    pub badge_key: String,
    pub earned_at: DateTime<Utc>,
}

impl UserBadge {
    pub const COLUMNS: &'static str = "id, user_id, badge_key, earned_at";
}

/// A user's recent profile search (`recent_searches`, integer ids, timestamp without zone).
#[derive(Debug, Clone, PartialEq, sqlx::FromRow)]
pub struct RecentSearch {
    pub id: i64,
    pub user_id: i64,
    pub searched_user_id: i64,
    pub searched_at: NaiveDateTime,
}

impl RecentSearch {
    pub const COLUMNS: &'static str =
        "id::int8 AS id, user_id::int8 AS user_id, searched_user_id::int8 AS searched_user_id, searched_at";
}

/// One execution of a cron job (`cron_job_logs`). The unique `(job_name, job_date)` index lets
/// only one replica claim a job per day.
#[derive(Debug, Clone, PartialEq, sqlx::FromRow)]
pub struct CronJobLog {
    pub id: i64,
    pub job_name: String,
    pub job_date: NaiveDate,
    pub started_at: DateTime<Utc>,
    pub completed_at: Option<DateTime<Utc>>,
    pub status: String,
    pub users_count: i64,
    pub error: String,
    pub instance_id: String,
}

impl CronJobLog {
    pub const COLUMNS: &'static str = "id, job_name, job_date, started_at, completed_at, status, \
         COALESCE(users_count, 0) AS users_count, COALESCE(error, '') AS error, \
         COALESCE(instance_id, '') AS instance_id";
}

pub const CRON_JOB_DAILY_STREAK: &str = "daily_streak";
pub const CRON_JOB_STREAK_REMINDER: &str = "streak_reminder";
pub const CRON_JOB_NOTIFICATION_CLEANUP: &str = "notification_cleanup";
pub const CRON_JOB_FOLLOW_TOMBSTONE_CLEAN: &str = "follow_tombstone_cleanup";
pub const CRON_JOB_CHALLENGE_DAILY: &str = "challenge_daily";

pub const CRON_JOB_STATUS_RUNNING: &str = "running";
pub const CRON_JOB_STATUS_COMPLETED: &str = "completed";
pub const CRON_JOB_STATUS_FAILED: &str = "failed";
pub const CRON_JOB_STATUS_SKIPPED: &str = "skipped";
