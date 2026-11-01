//! Shared fixtures. Database tests run only when `TEST_DATABASE_URL` points at a PostgreSQL
//! server whose role may create databases; each test uses its own database. Redis is never
//! initialized, so notifications are only stored (no shared Redis keys are touched).

#![allow(dead_code)]

use std::sync::Arc;

use chrono::{DateTime, NaiveDate, Utc};
use gt_core::models::{CronJobLog, Notification, User};
use gt_jobs::CronService;
use gt_notify::{NotificationRepository, NotificationService};
use gt_users::{CronJobLogRepository, StreakRepository, StreakService, UserRepository};
use sqlx::postgres::PgPoolOptions;
use sqlx::{Connection, PgConnection, PgPool};

pub struct TestDb {
    pub pool: PgPool,
    admin_url: String,
    name: String,
}

impl TestDb {
    /// A freshly migrated database named `gt_jobs_<test>`, or `None` (skip) without
    /// `TEST_DATABASE_URL`.
    pub async fn new(test: &str) -> Option<TestDb> {
        let Ok(admin_url) = std::env::var("TEST_DATABASE_URL") else {
            eprintln!("TEST_DATABASE_URL not set; skipping");
            return None;
        };
        let name = format!("gt_jobs_{test}");
        let mut admin = PgConnection::connect(&admin_url).await.expect("connect admin");
        sqlx::query(&format!("DROP DATABASE IF EXISTS {name} WITH (FORCE)")).execute(&mut admin).await.unwrap();
        sqlx::query(&format!("CREATE DATABASE {name}")).execute(&mut admin).await.unwrap();
        let mut url = url::Url::parse(&admin_url).unwrap();
        url.set_path(&format!("/{name}"));
        let pool = PgPoolOptions::new().max_connections(8).connect(url.as_str()).await.expect("connect test db");
        gt_core::db::migrate(&pool).await.expect("migrate");
        Some(TestDb { pool, admin_url, name })
    }

    pub async fn finish(self) {
        self.pool.close().await;
        let mut admin = PgConnection::connect(&self.admin_url).await.unwrap();
        let _ = sqlx::query(&format!("DROP DATABASE IF EXISTS {} WITH (FORCE)", self.name)).execute(&mut admin).await;
    }
}

/// A pool on which every query fails (Go: `testutil.BrokenDB`).
pub async fn broken_pool() -> PgPool {
    let pool = PgPoolOptions::new().connect_lazy("postgres://gt@127.0.0.1:1/broken").unwrap();
    pool.close().await;
    pool
}

/// The database behind each dependency of the cron service; `None` leaves the job log
/// repository or the notification service unconfigured.
pub struct Deps {
    pub users: PgPool,
    pub streaks: PgPool,
    pub job_logs: Option<PgPool>,
    pub notifs: Option<PgPool>,
}

impl Deps {
    /// Everything on `pool`.
    pub fn all(pool: &PgPool) -> Self {
        Self { users: pool.clone(), streaks: pool.clone(), job_logs: Some(pool.clone()), notifs: Some(pool.clone()) }
    }
}

pub fn cron_service(deps: Deps) -> CronService {
    let streak_repo = Arc::new(StreakRepository::new(deps.streaks));
    CronService::new(
        Arc::new(UserRepository::new(deps.users)),
        streak_repo.clone(),
        deps.job_logs.map(|p| Arc::new(CronJobLogRepository::new(p))),
        Arc::new(StreakService::new(streak_repo)),
        None,
        deps.notifs.map(|p| Arc::new(NotificationService::new(Arc::new(NotificationRepository::new(p))))),
    )
    .with_instance_id("cron-test")
}

pub async fn create_user(pool: &PgPool, username: &str) -> User {
    let repo = UserRepository::new(pool.clone());
    repo.create(&format!("{username}@example.com"), username, "hash").await.expect("create user");
    repo.find_by_username(username).await.unwrap().expect("user exists")
}

pub async fn create_streak(pool: &PgPool, user_id: i64, current: i64, longest: i64, date: NaiveDate) {
    sqlx::query("INSERT INTO streaks (user_id, current, longest, activity_date) VALUES ($1, $2, $3, $4)")
        .bind(user_id)
        .bind(current)
        .bind(longest)
        .bind(date)
        .execute(pool)
        .await
        .unwrap();
}

/// `(current, longest)` of the user's records for `date`.
pub async fn streaks_on(pool: &PgPool, user_id: i64, date: NaiveDate) -> Vec<(i64, i64)> {
    sqlx::query_as("SELECT current, longest FROM streaks WHERE user_id = $1 AND activity_date = $2 ORDER BY id")
        .bind(user_id)
        .bind(date)
        .fetch_all(pool)
        .await
        .unwrap()
}

pub async fn count(pool: &PgPool, sql: &str) -> i64 {
    sqlx::query_scalar(sql).fetch_one(pool).await.unwrap()
}

pub async fn job_logs(pool: &PgPool, job_name: &str) -> Vec<CronJobLog> {
    let sql = format!("SELECT {} FROM cron_job_logs WHERE job_name = $1 ORDER BY id", CronJobLog::COLUMNS);
    sqlx::query_as(&sql).bind(job_name).fetch_all(pool).await.unwrap()
}

pub async fn notifications_of(pool: &PgPool, user_id: i64) -> Vec<Notification> {
    let sql = format!("SELECT {} FROM notifications WHERE user_id = $1 ORDER BY id", Notification::COLUMNS);
    sqlx::query_as(&sql).bind(user_id).fetch_all(pool).await.unwrap()
}

/// Inserts an unread notification created at `created_at` and returns its id.
pub async fn seed_notification(pool: &PgPool, user_id: i64, created_at: DateTime<Utc>) -> i64 {
    sqlx::query_scalar(
        "INSERT INTO notifications (user_id, type, title, body, created_at) \
         VALUES ($1, 'system_announcement', 'Hello', 'World', $2) RETURNING id",
    )
    .bind(user_id)
    .bind(created_at)
    .fetch_one(pool)
    .await
    .unwrap()
}

pub fn assert_recent(at: Option<DateTime<Utc>>) {
    let at = at.expect("timestamp set");
    assert!((Utc::now() - at).num_seconds().abs() < 60, "{at} is not recent");
}
