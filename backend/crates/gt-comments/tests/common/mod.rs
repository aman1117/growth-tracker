//! Shared fixtures of the service and HTTP tests. Database tests run only when
//! `TEST_DATABASE_URL` points at a PostgreSQL server whose role may create databases; each test
//! uses its own database. Redis is not used (the count cache is covered in `repository.rs`).

#![allow(dead_code)]

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::Request;
use axum::response::Response;
use axum::Router;
use chrono::{DateTime, NaiveDate, Utc};
use gt_comments::service::{CommentRepositories, CommentService};
use gt_comments::CommentsContext;
use gt_core::config::Config;
use gt_core::models::{Comment, User};
use gt_core::CoreContext;
use gt_notify::NotifyContext;
use gt_users::repository::{FollowRepository, UserRepository};
use gt_users::UsersContext;
use serde_json::Value;
use sqlx::postgres::PgPoolOptions;
use sqlx::{Connection, PgConnection, PgPool};
use tower::ServiceExt;

// ==================== Database ====================

pub struct TestDb {
    pub pool: PgPool,
    admin_url: String,
    name: String,
}

impl TestDb {
    /// A freshly migrated database named `gt_comments_<test>`, or `None` (skip) without
    /// `TEST_DATABASE_URL`.
    pub async fn new(test: &str) -> Option<TestDb> {
        let Ok(admin_url) = std::env::var("TEST_DATABASE_URL") else {
            eprintln!("TEST_DATABASE_URL not set; skipping");
            return None;
        };
        let name = format!("gt_comments_{test}");
        let mut admin = PgConnection::connect(&admin_url).await.expect("connect admin");
        sqlx::query(&format!("DROP DATABASE IF EXISTS {name} WITH (FORCE)")).execute(&mut admin).await.unwrap();
        sqlx::query(&format!("CREATE DATABASE {name}")).execute(&mut admin).await.unwrap();
        let mut url = url::Url::parse(&admin_url).unwrap();
        url.set_path(&format!("/{name}"));
        let pool = PgPoolOptions::new().max_connections(8).connect(url.as_str()).await.expect("connect test db");
        gt_core::db::migrate(&pool).await.expect("migrate");
        sqlx::query(
            "CREATE OR REPLACE FUNCTION gt_test_fail() RETURNS trigger LANGUAGE plpgsql AS \
             $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$",
        )
        .execute(&pool)
        .await
        .unwrap();
        Some(TestDb { pool, admin_url, name })
    }

    pub async fn finish(self) {
        self.pool.close().await;
        let mut admin = PgConnection::connect(&self.admin_url).await.unwrap();
        let _ = sqlx::query(&format!("DROP DATABASE IF EXISTS {} WITH (FORCE)", self.name)).execute(&mut admin).await;
    }

    /// Makes every `events` statement (e.g. `INSERT`, `UPDATE`, `INSERT OR DELETE`) on `table`
    /// fail until [`TestDb::heal`].
    pub async fn fail_statements(&self, table: &str, events: &str) {
        self.exec(&format!(
            "CREATE TRIGGER gt_fail_{table} BEFORE {events} ON {table} FOR EACH STATEMENT EXECUTE FUNCTION gt_test_fail()"
        ))
        .await;
    }

    /// Makes row updates of `table` matching `condition` (over `OLD`/`NEW`) fail.
    pub async fn fail_updates_when(&self, table: &str, condition: &str) {
        self.exec(&format!(
            "CREATE TRIGGER gt_fail_{table} BEFORE UPDATE ON {table} FOR EACH ROW WHEN ({condition}) \
             EXECUTE FUNCTION gt_test_fail()"
        ))
        .await;
    }

    /// Removes the failure trigger of `table`.
    pub async fn heal(&self, table: &str) {
        self.exec(&format!("DROP TRIGGER IF EXISTS gt_fail_{table} ON {table}")).await;
    }

    /// Makes every query on `table` fail (it disappears) until [`TestDb::restore`].
    pub async fn hide(&self, table: &str) {
        self.exec(&format!("ALTER TABLE {table} RENAME TO {table}_hidden")).await;
    }

    pub async fn restore(&self, table: &str) {
        self.exec(&format!("ALTER TABLE {table}_hidden RENAME TO {table}")).await;
    }

    pub async fn exec(&self, sql: &str) {
        sqlx::query(sql).execute(&self.pool).await.unwrap_or_else(|e| panic!("{sql}: {e}"));
    }

    pub async fn count(&self, sql: &str) -> i64 {
        sqlx::query_scalar(sql).fetch_one(&self.pool).await.unwrap()
    }
}

/// A pool whose every query fails (Go `testutil.BrokenDB`).
pub async fn broken_pool() -> PgPool {
    let pool = PgPoolOptions::new().connect_lazy("postgres://nobody:nothing@127.0.0.1:1/none").unwrap();
    pool.close().await;
    pool
}

// ==================== Fixtures ====================

pub fn day() -> NaiveDate {
    NaiveDate::from_ymd_opt(2026, 3, 9).unwrap()
}

pub const DAY: &str = "2026-03-09";

#[derive(Default, Clone)]
pub struct UserOpts {
    pub private: bool,
    pub verified: bool,
    pub avatar: Option<&'static str>,
}

pub async fn create_user_with(pool: &PgPool, username: &str, opts: UserOpts) -> User {
    let sql = format!(
        "INSERT INTO users (email, username, password_hash, profile_pic, profile_pic_thumb, is_private, is_verified, email_verified) \
         VALUES ($1, $2, 'hash', $3, $4, $5, $6, true) RETURNING {}",
        User::COLUMNS
    );
    sqlx::query_as::<_, User>(&sql)
        .bind(format!("{username}@example.com"))
        .bind(username)
        .bind(opts.avatar)
        .bind(opts.avatar.map(|a| format!("{a}?thumb")))
        .bind(opts.private)
        .bind(opts.verified)
        .fetch_one(pool)
        .await
        .expect("create user")
}

pub async fn create_user(pool: &PgPool, username: &str) -> User {
    create_user_with(pool, username, UserOpts::default()).await
}

/// An accepted follow edge in both edge tables.
pub async fn follow(pool: &PgPool, follower: &User, followee: &User) {
    for table in ["follow_edges_by_follower", "follow_edges_by_followee"] {
        sqlx::query(&format!(
            "INSERT INTO {table} (follower_id, followee_id, state, created_at, accepted_at, updated_at) \
             VALUES ($1, $2, 'ACTIVE', NOW(), NOW(), NOW())"
        ))
        .bind(follower.id)
        .bind(followee.id)
        .execute(pool)
        .await
        .unwrap();
    }
}

/// Inserts a comment directly (Go `seedComment` / `createComment`): replies point at their
/// parent, its thread root and the parent author.
pub async fn seed_comment(
    pool: &PgPool,
    owner: &User,
    author: &User,
    body: &str,
    parent: Option<&Comment>,
    day_date: NaiveDate,
) -> Comment {
    let sql = format!(
        "INSERT INTO comments (day_owner_id, day_date, author_id, parent_comment_id, root_comment_id, reply_to_user_id, body) \
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING {}",
        Comment::COLUMNS
    );
    sqlx::query_as::<_, Comment>(&sql)
        .bind(owner.id)
        .bind(day_date)
        .bind(author.id)
        .bind(parent.map(|p| p.id))
        .bind(parent.map(|p| p.root_comment_id.unwrap_or(p.id)))
        .bind(parent.map(|p| p.author_id))
        .bind(body)
        .fetch_one(pool)
        .await
        .expect("seed comment")
}

/// Sets one column of a comment (e.g. `like_count`, `is_deleted`, `created_at`).
pub async fn set_comment<T>(pool: &PgPool, id: i64, column: &str, value: T)
where
    T: for<'q> sqlx::Encode<'q, sqlx::Postgres> + sqlx::Type<sqlx::Postgres> + Send,
{
    sqlx::query(&format!("UPDATE comments SET {column} = $1 WHERE id = $2"))
        .bind(value)
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
}

pub async fn set_created_at(pool: &PgPool, id: i64, at: DateTime<Utc>) {
    set_comment(pool, id, "created_at", at).await;
}

pub async fn load_comment(pool: &PgPool, id: i64) -> Comment {
    let sql = format!("SELECT {} FROM comments WHERE id = $1", Comment::COLUMNS);
    sqlx::query_as::<_, Comment>(&sql).bind(id).fetch_one(pool).await.expect("comment exists")
}

// ==================== Notifications ====================

/// `(type, body, metadata)` of a user's notifications, oldest first.
pub async fn notifications_of(pool: &PgPool, user_id: i64) -> Vec<(String, String, Value)> {
    sqlx::query_as::<_, (String, String, Option<Value>)>(
        "SELECT type, COALESCE(body, ''), metadata FROM notifications WHERE user_id = $1 ORDER BY id",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
    .unwrap()
    .into_iter()
    .map(|(t, b, m)| (t, b, m.unwrap_or(Value::Null)))
    .collect()
}

pub async fn notification_types(pool: &PgPool, user_id: i64) -> Vec<String> {
    notifications_of(pool, user_id).await.into_iter().map(|(t, _, _)| t).collect()
}

/// Lets fire-and-forget notification tasks finish (Go `waitForAsync`).
pub async fn wait_for_async() {
    tokio::time::sleep(Duration::from_millis(400)).await;
}

/// Waits until `user_id` has a notification of `notif_type` and returns its metadata.
pub async fn wait_notification(pool: &PgPool, user_id: i64, notif_type: &str) -> Value {
    for _ in 0..100 {
        if let Some((_, _, meta)) = notifications_of(pool, user_id).await.into_iter().find(|(t, _, _)| t == notif_type)
        {
            return meta;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("no {notif_type} notification for user {user_id}");
}

// ==================== Contexts ====================

pub fn config() -> Config {
    let mut config = Config::from_env();
    config.jwt.secret_key = "gt-comments-test-secret".into();
    config
}

pub struct Stack {
    pub core: CoreContext,
    pub users: UsersContext,
    pub notify: NotifyContext,
    pub comments: CommentsContext,
}

impl Stack {
    pub fn new(pool: &PgPool) -> Self {
        let core = CoreContext::new(Arc::new(config()), pool.clone());
        let users = UsersContext::new(&core);
        let notify = NotifyContext::new(&core);
        let comments = CommentsContext::new(&core, &users, &notify);
        Self { core, users, notify, comments }
    }

    pub fn router(&self) -> Router {
        gt_comments::routes(&self.core, &self.users, &self.notify, &self.comments)
    }

    /// The routes with the comment service of `other` (e.g. on a broken database) and this
    /// stack's users (Go: `NewCommentHandler(faulty.commentSvc, env.profileSvc, env.authSvc)`).
    pub fn router_with_comments_of(&self, other: &Stack) -> Router {
        gt_comments::routes(&self.core, &self.users, &self.notify, &other.comments)
    }

    pub fn token(&self, user: &User) -> String {
        self.core.tokens.generate(user.id, &user.username).unwrap().token
    }
}

/// A comment service over `comment_pool` whose user lookups use `user_pool` (Go
/// `newCommentServiceWith`). `notify` enables notifications.
pub fn service_with(comment_pool: &PgPool, user_pool: &PgPool, notify: Option<&PgPool>) -> CommentService {
    let user_repo = Arc::new(UserRepository::new(user_pool.clone()));
    let follow_repo = Arc::new(FollowRepository::new(user_pool.clone()));
    let notifications = notify.map(|pool| {
        let repo = Arc::new(gt_notify::NotificationRepository::new(pool.clone()));
        Arc::new(gt_notify::NotificationService::new(repo))
    });
    CommentService::new(CommentRepositories::new(comment_pool.clone()), user_repo, Some(follow_repo), notifications)
}

// ==================== HTTP ====================

pub struct Res {
    pub status: u16,
    pub content_type: String,
    pub body: String,
}

impl Res {
    pub fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap_or_else(|e| panic!("invalid JSON {:?}: {e}", self.body))
    }

    /// Asserts the exact Go error envelope (`success`, `error`, `error_code`).
    #[track_caller]
    pub fn assert_error(&self, status: u16, code: &str, message: &str) {
        let expected = format!(
            r#"{{"success":false,"error":{},"error_code":{}}}"#,
            gt_core::gojson::to_string(message).unwrap(),
            gt_core::gojson::to_string(code).unwrap()
        );
        assert_eq!(
            (self.status, self.content_type.as_str(), self.body.as_str()),
            (status, "application/json", expected.as_str())
        );
    }
}

pub async fn send(router: &Router, method: &str, uri: &str, token: Option<&str>, body: Option<&str>) -> Res {
    send_with(router, method, uri, token, body, &[]).await
}

pub async fn send_with(
    router: &Router,
    method: &str,
    uri: &str,
    token: Option<&str>,
    body: Option<&str>,
    headers: &[(&str, &str)],
) -> Res {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(token) = token {
        builder = builder.header("Authorization", format!("Bearer {token}"));
    }
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    let mut req = match body {
        Some(body) => builder.header("Content-Type", "application/json").body(Body::from(body.to_string())).unwrap(),
        None => builder.body(Body::empty()).unwrap(),
    };
    req.extensions_mut().insert(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 40000))));
    let resp: Response = router.clone().oneshot(req).await.unwrap();
    let status = resp.status().as_u16();
    let content_type = resp.headers().get("content-type").map(|v| v.to_str().unwrap().to_string()).unwrap_or_default();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    Res { status, content_type, body: String::from_utf8(bytes.to_vec()).unwrap() }
}

/// `{"body": <body>}` as JSON.
pub fn body_json(body: &str) -> String {
    serde_json::json!({ "body": body }).to_string()
}

pub fn ids(list: &Value) -> Vec<i64> {
    list["comments"].as_array().unwrap().iter().map(|c| c["id"].as_i64().unwrap()).collect()
}
