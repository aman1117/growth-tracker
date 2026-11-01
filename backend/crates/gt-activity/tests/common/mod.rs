//! Shared fixtures. Database tests run only when `TEST_DATABASE_URL` points at a PostgreSQL
//! server whose role may create databases; each test uses its own database.

#![allow(dead_code)]

use std::net::SocketAddr;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::Request;
use axum::Router;
use chrono::NaiveDate;
use gt_activity::ActivityContext;
use gt_core::config::Config;
use gt_core::models::{Notification, User, FOLLOW_STATE_ACTIVE};
use gt_core::CoreContext;
use gt_notify::NotifyContext;
use gt_users::UsersContext;
use sqlx::postgres::PgPoolOptions;
use sqlx::{Connection, PgConnection, PgPool};
use tower::ServiceExt;

pub struct TestDb {
    pub pool: PgPool,
    admin_url: String,
    name: String,
}

impl TestDb {
    /// A freshly migrated database named `gt_activity_<test>`, or `None` (skip) without
    /// `TEST_DATABASE_URL`.
    pub async fn new(test: &str) -> Option<TestDb> {
        let Ok(admin_url) = std::env::var("TEST_DATABASE_URL") else {
            eprintln!("TEST_DATABASE_URL not set; skipping");
            return None;
        };
        let name = format!("gt_activity_{test}");
        let mut admin = PgConnection::connect(&admin_url).await.expect("connect admin");
        sqlx::query(&format!("DROP DATABASE IF EXISTS {name} WITH (FORCE)")).execute(&mut admin).await.unwrap();
        sqlx::query(&format!("CREATE DATABASE {name}")).execute(&mut admin).await.unwrap();
        let mut url = url::Url::parse(&admin_url).unwrap();
        url.set_path(&format!("/{name}"));
        let pool = PgPoolOptions::new().max_connections(8).connect(url.as_str()).await.expect("connect test db");
        gt_core::db::migrate(&pool).await.expect("migrate");
        Some(TestDb { pool, admin_url, name })
    }

    /// Makes new user ids start at `first_id` (unique ids keep shared Redis keys apart).
    pub async fn start_user_ids_at(&self, first_id: i64) {
        sqlx::query(&format!("ALTER SEQUENCE users_id_seq RESTART WITH {first_id}")).execute(&self.pool).await.unwrap();
    }

    pub async fn finish(self) {
        self.pool.close().await;
        let mut admin = PgConnection::connect(&self.admin_url).await.unwrap();
        let _ = sqlx::query(&format!("DROP DATABASE IF EXISTS {} WITH (FORCE)", self.name)).execute(&mut admin).await;
    }
}

/// A pool whose every query fails (Go tests: `testutil.BrokenDB`).
pub async fn broken_pool() -> PgPool {
    let pool = PgPoolOptions::new()
        .acquire_timeout(Duration::from_secs(1))
        .connect_lazy("postgres://broken:broken@127.0.0.1:1/broken")
        .expect("lazy pool");
    pool.close().await;
    pool
}

/// Makes the next statements of `kind` (`INSERT`/`UPDATE`/`DELETE`) on `table` fail.
pub async fn fail_on(pool: &PgPool, kind: &str, table: &str) {
    sqlx::query(
        "CREATE OR REPLACE FUNCTION gt_injected_failure() RETURNS trigger AS $$ \
         BEGIN RAISE EXCEPTION 'injected failure'; END $$ LANGUAGE plpgsql",
    )
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(&format!(
        "CREATE TRIGGER gt_fail_{kind}_{table} BEFORE {kind} ON {table} FOR EACH ROW EXECUTE FUNCTION gt_injected_failure()"
    ))
    .execute(pool)
    .await
    .unwrap();
}

/// Removes a failure installed by [`fail_on`].
pub async fn stop_failing(pool: &PgPool, kind: &str, table: &str) {
    sqlx::query(&format!("DROP TRIGGER IF EXISTS gt_fail_{kind}_{table} ON {table}")).execute(pool).await.unwrap();
}

/// A configuration with a test JWT secret.
pub fn config() -> Config {
    let mut config = Config::from_env();
    config.jwt.secret_key = "gt-activity-test-secret".into();
    config
}

pub fn core(pool: &PgPool) -> CoreContext {
    CoreContext::new(Arc::new(config()), pool.clone())
}

/// Every context of the feature on one pool.
pub struct Stack {
    pub core: CoreContext,
    pub users: UsersContext,
    pub notify: NotifyContext,
    pub activity: ActivityContext,
}

impl Stack {
    pub fn new(pool: &PgPool) -> Stack {
        let core = core(pool);
        let users = UsersContext::new(&core);
        let notify = NotifyContext::new(&core);
        let activity = ActivityContext::new(&core, &users, &notify);
        Stack { core, users, notify, activity }
    }

    pub fn router(&self) -> Router {
        gt_activity::routes(&self.core, &self.users, &self.notify, &self.activity)
    }
}

/// The application's routes on the shared pool, with the given parts replaced (e.g. by
/// contexts built on [`broken_pool`]).
pub fn router_with(
    good: &Stack,
    users: Option<&UsersContext>,
    notify: Option<&NotifyContext>,
    activity: Option<&ActivityContext>,
) -> Router {
    gt_activity::routes(
        &good.core,
        users.unwrap_or(&good.users),
        notify.unwrap_or(&good.notify),
        activity.unwrap_or(&good.activity),
    )
}

/// Registers `username` (`<username>@example.com`) and returns the row.
pub async fn create_user(stack: &Stack, username: &str, is_private: bool) -> User {
    let repo = &stack.users.user_repo;
    repo.create(&format!("{username}@example.com"), username, "hash").await.expect("create user");
    let user = repo.find_by_username(username).await.unwrap().expect("user exists");
    if is_private {
        repo.update_privacy(user.id, true).await.unwrap();
    }
    repo.find_by_id(user.id).await.unwrap().unwrap()
}

/// Unique usernames within a test database.
pub fn username(prefix: &str) -> String {
    static NEXT: AtomicI64 = AtomicI64::new(1);
    format!("{prefix}{}", NEXT.fetch_add(1, Ordering::Relaxed))
}

pub async fn follow(stack: &Stack, follower: &User, followee: &User) {
    stack
        .users
        .follow_repo
        .create_follow_with_counters(follower.id, followee.id, FOLLOW_STATE_ACTIVE, None)
        .await
        .unwrap();
}

pub fn day(y: i32, m: u32, d: u32) -> NaiveDate {
    NaiveDate::from_ymd_opt(y, m, d).unwrap()
}

/// Inserts an activity directly (Go: `testutil.CreateActivity`) and returns its id.
pub async fn insert_activity(pool: &PgPool, user_id: i64, name: &str, hours: f64, date: NaiveDate) -> i64 {
    sqlx::query_scalar(
        "INSERT INTO activities (user_id, name, duration_hours, activity_date) VALUES ($1, $2, $3, $4) RETURNING id",
    )
    .bind(user_id)
    .bind(name)
    .bind(hours)
    .bind(date)
    .fetch_one(pool)
    .await
    .unwrap()
}

/// Inserts a streak row (Go: `testutil.CreateStreak`) and returns its id.
pub async fn insert_streak(pool: &PgPool, user_id: i64, current: i64, longest: i64, date: NaiveDate) -> i64 {
    sqlx::query_scalar(
        "INSERT INTO streaks (user_id, current, longest, activity_date) VALUES ($1, $2, $3, $4) RETURNING id",
    )
    .bind(user_id)
    .bind(current)
    .bind(longest)
    .bind(date)
    .fetch_one(pool)
    .await
    .unwrap()
}

/// Inserts an activity photo and returns its id.
pub async fn insert_photo(
    pool: &PgPool,
    user_id: i64,
    activity_name: &str,
    date: NaiveDate,
    label: Option<&str>,
) -> i64 {
    sqlx::query_scalar(
        "INSERT INTO activity_photos (user_id, activity_name, photo_date, photo_url, thumbnail_url, activity_label) \
         VALUES ($1, $2, $3, 'http://p/x.jpg', 'http://p/x_t.jpg', $4) RETURNING id",
    )
    .bind(user_id)
    .bind(activity_name)
    .bind(date)
    .bind(label)
    .fetch_one(pool)
    .await
    .unwrap()
}

pub async fn photo_label(pool: &PgPool, photo_id: i64) -> Option<String> {
    sqlx::query_scalar("SELECT activity_label FROM activity_photos WHERE id = $1")
        .bind(photo_id)
        .fetch_one(pool)
        .await
        .unwrap()
}

pub async fn count(pool: &PgPool, sql: &str) -> i64 {
    sqlx::query_scalar(sql).fetch_one(pool).await.unwrap()
}

/// The user's notifications of `notif_type`, oldest first.
pub async fn notifications(pool: &PgPool, user_id: i64, notif_type: &str) -> Vec<Notification> {
    let sql =
        format!("SELECT {} FROM notifications WHERE user_id = $1 AND type = $2 ORDER BY id", Notification::COLUMNS);
    sqlx::query_as::<_, Notification>(&sql).bind(user_id).bind(notif_type).fetch_all(pool).await.unwrap()
}

/// Waits (up to 5 s) until the user has `n` notifications of `notif_type`.
pub async fn wait_notifications(pool: &PgPool, user_id: i64, notif_type: &str, n: usize) -> Vec<Notification> {
    for _ in 0..100 {
        let found = notifications(pool, user_id, notif_type).await;
        if found.len() >= n {
            return found;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    notifications(pool, user_id, notif_type).await
}

pub fn token(stack: &Stack, user: &User) -> String {
    stack.core.tokens.generate(user.id, &user.username).unwrap().token
}

/// Sends a request as `user` (JSON body when given) and returns `(status, body)`.
pub async fn send(
    router: &Router,
    stack: &Stack,
    user: &User,
    method: &str,
    path: &str,
    body: Option<&str>,
) -> (u16, String) {
    let builder =
        Request::builder().method(method).uri(path).header("Authorization", format!("Bearer {}", token(stack, user)));
    let mut request = match body {
        Some(body) => builder.header("Content-Type", "application/json").body(Body::from(body.to_string())).unwrap(),
        None => builder.body(Body::empty()).unwrap(),
    };
    request.extensions_mut().insert(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 50000))));
    let response = router.clone().oneshot(request).await.unwrap();
    let status = response.status().as_u16();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, String::from_utf8(bytes.to_vec()).unwrap())
}

/// `{"success":false,"error":<message>,"error_code":<code>}` (messages need no escaping).
pub fn error_body(message: &str, code: &str) -> String {
    format!(r#"{{"success":false,"error":"{message}","error_code":"{code}"}}"#)
}
