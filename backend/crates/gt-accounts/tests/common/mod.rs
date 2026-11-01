//! Shared fixtures for the HTTP tests. Database tests run only when `TEST_DATABASE_URL` points
//! at a PostgreSQL server whose role may create databases (each test uses its own database);
//! Redis checks use `REDIS_URL` (default `redis://127.0.0.1:56379`) and are skipped when it is
//! unreachable.
//!
//! Everything runs on one shared runtime: the Redis connection is a process-wide global whose
//! background task must outlive individual tests. Redis is shared with other test suites, so
//! user ids come from a per-test range (cache keys such as `follow_cnt:<id>` never collide) and
//! keys are never flushed.

#![allow(dead_code)]

use std::future::Future;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicI64, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use async_trait::async_trait;
use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{HeaderMap, Request};
use axum::Router;
use gt_core::config::Config;
use gt_core::CoreContext;
use gt_notify::NotifyContext;
use gt_users::{EmailError, EmailSender, EmailService, UsersContext};
use redis::AsyncCommands;
use serde_json::Value;
use sqlx::postgres::PgPoolOptions;
use sqlx::{Connection, PgConnection, PgPool};
use tokio::runtime::Runtime;
use tokio::sync::OnceCell;
use tower::ServiceExt;

pub const JWT_SECRET: &str = "gt-accounts-test-secret";
pub const FRONTEND_URL: &str = "http://localhost:5173";
/// Password of every fixture user.
pub const TEST_PASSWORD: &str = "password123";
/// `bcrypt.GenerateFromPassword("password123", 10)` from Go (hashing in debug builds is slow).
const TEST_PASSWORD_HASH: &str = "$2a$10$SkzLfruj2/DiHqW9dFWw4.EGXM.STQGFVEzR2vhHekx./2UCHh76q";

/// The shared runtime; tests call [`run`].
pub fn rt() -> &'static Runtime {
    static RT: OnceLock<Runtime> = OnceLock::new();
    RT.get_or_init(|| tokio::runtime::Builder::new_multi_thread().worker_threads(4).enable_all().build().unwrap())
}

pub fn run<F: Future>(future: F) -> F::Output {
    rt().block_on(future)
}

/// Connects the global Redis handle once; `false` when Redis is unavailable.
pub async fn redis_ready() -> bool {
    static READY: OnceCell<bool> = OnceCell::const_new();
    *READY
        .get_or_init(|| async {
            let url = std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:56379".into());
            match gt_core::redis::init(&url).await {
                Ok(()) => gt_core::redis::is_available(),
                Err(err) => {
                    eprintln!("Redis unavailable ({err}); Redis checks are skipped");
                    false
                }
            }
        })
        .await
}

fn redis_conn() -> redis::aio::ConnectionManager {
    gt_core::redis::conn().expect("redis connected")
}

pub async fn redis_get(key: &str) -> Option<String> {
    redis_conn().get(key).await.unwrap()
}

pub async fn redis_set(key: &str, value: &str) {
    redis_conn().set::<_, _, ()>(key, value).await.unwrap();
}

pub async fn redis_del(key: &str) {
    redis_conn().del::<_, ()>(key).await.unwrap();
}

pub async fn redis_ttl(key: &str) -> i64 {
    redis_conn().ttl(key).await.unwrap()
}

/// A unique block of 500 user ids per test (at most 20 tests per binary), so shared-Redis cache
/// keys never collide. Ids stay below 2^31: `recent_searches` stores them as `integer`.
fn id_base() -> i64 {
    static NEXT: AtomicI64 = AtomicI64::new(0);
    1_000_000_000 + i64::from(std::process::id() % 100_000) * 10_000 + NEXT.fetch_add(1, Ordering::Relaxed) * 500
}

/// A distinct client address per request, so the per-IP auth limiter never interferes.
fn next_ip() -> IpAddr {
    static NEXT: AtomicU32 = AtomicU32::new(1);
    IpAddr::V4(Ipv4Addr::from(0x0A00_0000 + NEXT.fetch_add(1, Ordering::Relaxed)))
}

// ==================== Email ====================

/// One captured email.
#[derive(Debug, Clone)]
pub struct Mail {
    pub to: Vec<String>,
    pub subject: String,
    pub html: String,
}

impl Mail {
    /// The token of the link in the email.
    pub fn token(&self) -> String {
        let start = self.html.find("token=").expect("link with a token") + "token=".len();
        self.html[start..].chars().take_while(char::is_ascii_hexdigit).collect()
    }
}

/// Records sent emails instead of delivering them; `reject` makes every send fail (attempts are
/// still recorded, so tests can read the token of an undelivered email).
#[derive(Debug, Default)]
pub struct MailRecorder {
    sent: Mutex<Vec<Mail>>,
    reject: bool,
}

impl MailRecorder {
    pub fn rejecting() -> Self {
        Self { sent: Mutex::default(), reject: true }
    }

    /// Every send attempt so far.
    pub fn sent(&self) -> Vec<Mail> {
        self.sent.lock().unwrap().clone()
    }

    /// Waits up to 5 s for the `n`-th email (1-based).
    pub async fn wait_for(&self, n: usize) -> Mail {
        for _ in 0..100 {
            if let Some(mail) = self.sent().get(n - 1) {
                return mail.clone();
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("email #{n} was not sent");
    }
}

#[async_trait]
impl EmailSender for MailRecorder {
    async fn send(&self, to: &[String], subject: &str, html_body: &str) -> Result<(), EmailError> {
        self.sent.lock().unwrap().push(Mail { to: to.to_vec(), subject: subject.into(), html: html_body.into() });
        if self.reject {
            return Err(EmailError("550 rejected".into()));
        }
        Ok(())
    }
}

// ==================== Database ====================

pub struct TestDb {
    pub pool: PgPool,
    admin_url: String,
    name: String,
}

impl TestDb {
    /// A freshly migrated database named `gt_accounts_<test>`, or `None` (skip) without
    /// `TEST_DATABASE_URL`. User ids start at a per-test offset.
    pub async fn new(test: &str) -> Option<TestDb> {
        let Ok(admin_url) = std::env::var("TEST_DATABASE_URL") else {
            eprintln!("TEST_DATABASE_URL not set; skipping");
            return None;
        };
        let name = format!("gt_accounts_{test}");
        let mut admin = PgConnection::connect(&admin_url).await.expect("connect admin");
        sqlx::query(&format!("DROP DATABASE IF EXISTS {name} WITH (FORCE)")).execute(&mut admin).await.unwrap();
        sqlx::query(&format!("CREATE DATABASE {name}")).execute(&mut admin).await.unwrap();
        let mut url = url::Url::parse(&admin_url).unwrap();
        url.set_path(&format!("/{name}"));
        let pool = PgPoolOptions::new().max_connections(8).connect(url.as_str()).await.expect("connect test db");
        gt_core::db::migrate(&pool).await.expect("migrate");
        sqlx::query(&format!("ALTER SEQUENCE users_id_seq RESTART WITH {}", id_base())).execute(&pool).await.unwrap();
        Some(TestDb { pool, admin_url, name })
    }

    pub async fn finish(self) {
        self.pool.close().await;
        let mut admin = PgConnection::connect(&self.admin_url).await.unwrap();
        let _ = sqlx::query(&format!("DROP DATABASE IF EXISTS {} WITH (FORCE)", self.name)).execute(&mut admin).await;
    }
}

/// A pool whose every query fails (Go tests: `testutil.BrokenDB`).
pub fn broken_pool() -> PgPool {
    PgPoolOptions::new()
        .acquire_timeout(Duration::from_millis(500))
        .connect_lazy("postgres://postgres:postgres@127.0.0.1:1/broken")
        .unwrap()
}

/// The accounts router over a database that fails every query (Go tests: `brokenStack`).
pub struct Broken {
    pub core: CoreContext,
    pub app: Router,
}

impl Broken {
    pub fn new() -> Self {
        let core = CoreContext::new(Arc::new(config()), broken_pool());
        let mut users = UsersContext::new(&core);
        users.email_service = None;
        let notify = NotifyContext::new(&core);
        let app = gt_accounts::routes(&core, &users, &notify);
        Self { core, app }
    }

    pub fn token(&self, user_id: i64) -> String {
        self.core.tokens.generate(user_id, "ghost").unwrap().token
    }

    /// Sends a request as `user_id` (anonymous when `None`); the future only borrows `self`.
    pub fn call(
        &self,
        method: &str,
        uri: &str,
        user_id: Option<i64>,
        body: Option<&str>,
    ) -> impl Future<Output = Resp> + '_ {
        let token = user_id.map(|id| self.token(id));
        send(&self.app, request(method, uri, token.as_deref(), body))
    }
}

// ==================== Application ====================

/// A configuration with test secrets.
pub fn config() -> Config {
    let mut config = Config::from_env();
    config.jwt.secret_key = JWT_SECRET.into();
    config.jwt.access_token_ttl = Duration::from_secs(24 * 3600);
    config.server.frontend_url = FRONTEND_URL.into();
    config
}

/// One response, fully read.
#[derive(Debug)]
pub struct Resp {
    pub status: u16,
    pub headers: HeaderMap,
    pub body: String,
}

impl Resp {
    pub fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap_or_else(|e| panic!("not JSON ({e}): {}", self.body))
    }

    pub fn header(&self, name: &str) -> &str {
        self.headers.get(name).map(|v| v.to_str().unwrap()).unwrap_or("")
    }

    /// Asserts a Go error envelope.
    #[track_caller]
    pub fn assert_error(&self, status: u16, code: &str, message: &str) {
        assert_eq!(self.status, status, "body: {}", self.body);
        assert_eq!(self.header("content-type"), "application/json");
        let expected = ErrorEnvelope { success: false, error: message, error_code: code };
        assert_eq!(self.body, gt_core::gojson::to_string(&expected).unwrap());
    }

    /// Asserts `{"success":true,"message":...}` with the given status.
    #[track_caller]
    pub fn assert_success(&self, status: u16, message: &str) {
        assert_eq!(self.status, status, "body: {}", self.body);
        assert_eq!(self.body, format!(r#"{{"success":true,"message":"{message}"}}"#));
    }
}

/// Field order of Go's `dto.ErrorResponse`.
#[derive(serde::Serialize)]
struct ErrorEnvelope<'a> {
    success: bool,
    error: &'a str,
    error_code: &'a str,
}

/// Sends `req` to `app` from a fresh client address (unless one is set).
pub async fn send(app: &Router, mut req: Request<Body>) -> Resp {
    if req.extensions().get::<ConnectInfo<SocketAddr>>().is_none() {
        req.extensions_mut().insert(ConnectInfo(SocketAddr::new(next_ip(), 40000)));
    }
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status().as_u16();
    let headers = resp.headers().clone();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    Resp { status, headers, body: String::from_utf8(bytes.to_vec()).unwrap() }
}

/// Builds a request; `body` is sent as `application/json` when present.
pub fn request(method: &str, uri: &str, token: Option<&str>, body: Option<&str>) -> Request<Body> {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(token) = token {
        builder = builder.header("Authorization", format!("Bearer {token}"));
    }
    match body {
        Some(body) => builder.header("Content-Type", "application/json").body(Body::from(body.to_string())).unwrap(),
        None => builder.body(Body::empty()).unwrap(),
    }
}

/// A fixture user.
#[derive(Debug, Clone)]
pub struct TestUser {
    pub id: i64,
    pub username: String,
    pub email: String,
    pub bio: Option<String>,
    pub profile_pic: Option<String>,
    pub profile_pic_thumb: Option<String>,
    pub token: String,
}

/// Options for [`Env::user`]; by default a public, unverified-badge user with a verified email.
#[derive(Debug, Clone)]
pub struct UserOpts {
    pub username: Option<String>,
    pub private: bool,
    pub verified: bool,
    pub email_verified: bool,
    pub bio: Option<String>,
    /// Picture URL; the thumbnail is `<url>?thumb`.
    pub picture: Option<String>,
}

impl Default for UserOpts {
    fn default() -> Self {
        Self { username: None, private: false, verified: false, email_verified: true, bio: None, picture: None }
    }
}

/// A database, the services and the accounts router.
pub struct Env {
    pub db: TestDb,
    pub core: CoreContext,
    pub users: UsersContext,
    pub notify: NotifyContext,
    pub mail: Arc<MailRecorder>,
    pub app: Router,
    next_user: AtomicU32,
}

impl Env {
    /// An environment whose email service records into a [`MailRecorder`].
    pub async fn new(test: &str) -> Option<Env> {
        Self::with(test, config(), Arc::new(MailRecorder::default())).await
    }

    pub async fn with(test: &str, config: Config, mail: Arc<MailRecorder>) -> Option<Env> {
        let db = TestDb::new(test).await?;
        let config = Arc::new(config);
        let core = CoreContext::new(config.clone(), db.pool.clone());
        let mut users = UsersContext::new(&core);
        users.email_service =
            Some(Arc::new(EmailService::with_sender(mail.clone(), &config.email, &config.server.frontend_url)));
        let notify = NotifyContext::new(&core);
        let app = gt_accounts::routes(&core, &users, &notify);
        Some(Env { db, core, users, notify, mail, app, next_user: AtomicU32::new(1) })
    }

    pub fn pool(&self) -> &PgPool {
        &self.db.pool
    }

    /// Rebuilds the router with another users context (e.g. without an email service).
    pub fn app_with(&self, users: &UsersContext) -> Router {
        gt_accounts::routes(&self.core, users, &self.notify)
    }

    /// A token for the user (empty when the configuration has no JWT secret).
    pub fn token(&self, user_id: i64, username: &str) -> String {
        self.core.tokens.generate(user_id, username).map(|t| t.token).unwrap_or_default()
    }

    /// Creates a user the way registration does (with its `follow_counters` row).
    pub async fn user(&self, opts: UserOpts) -> TestUser {
        let n = self.next_user.fetch_add(1, Ordering::Relaxed);
        let username = opts.username.unwrap_or_else(|| format!("user_{n}"));
        let email = format!("{username}@example.com");
        let thumb = opts.picture.as_ref().map(|url| format!("{url}?thumb"));
        let id: i64 = sqlx::query_scalar(
            "INSERT INTO users (email, username, password_hash, profile_pic, profile_pic_thumb, bio, is_private, \
             is_verified, email_verified) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id",
        )
        .bind(&email)
        .bind(&username)
        .bind(TEST_PASSWORD_HASH)
        .bind(&opts.picture)
        .bind(&thumb)
        .bind(&opts.bio)
        .bind(opts.private)
        .bind(opts.verified)
        .bind(opts.email_verified)
        .fetch_one(self.pool())
        .await
        .unwrap();
        sqlx::query("INSERT INTO follow_counters (user_id) VALUES ($1)").bind(id).execute(self.pool()).await.unwrap();
        let token = self.token(id, &username);
        TestUser { id, username, email, bio: opts.bio, profile_pic: opts.picture, profile_pic_thumb: thumb, token }
    }

    /// A public user with default settings.
    pub async fn plain_user(&self) -> TestUser {
        self.user(UserOpts::default()).await
    }

    /// Sends a request as `user` (anonymous when `None`). The future only borrows the
    /// environment, so closures can forward temporary arguments.
    pub fn call(
        &self,
        method: &str,
        uri: &str,
        user: Option<&TestUser>,
        body: Option<&str>,
    ) -> impl Future<Output = Resp> + '_ {
        let req = request(method, uri, user.map(|u| u.token.as_str()), body);
        send(&self.app, req)
    }

    /// Creates a follow edge (with counters) like `FollowRepository::create_follow_with_counters`.
    pub async fn follow(&self, follower_id: i64, followee_id: i64, state: &str) {
        self.users.follow_repo.create_follow_with_counters(follower_id, followee_id, state, None).await.unwrap();
    }

    /// Pins the creation time of an edge in both edge tables.
    pub async fn set_edge_time(&self, follower_id: i64, followee_id: i64, at: chrono::DateTime<chrono::Utc>) {
        for table in ["follow_edges_by_follower", "follow_edges_by_followee"] {
            sqlx::query(&format!("UPDATE {table} SET created_at = $1 WHERE follower_id = $2 AND followee_id = $3"))
                .bind(at)
                .bind(follower_id)
                .bind(followee_id)
                .execute(self.pool())
                .await
                .unwrap();
        }
    }

    /// The edge state, `None` when there is no edge.
    pub async fn edge_state(&self, follower_id: i64, followee_id: i64) -> Option<String> {
        sqlx::query_scalar("SELECT state FROM follow_edges_by_follower WHERE follower_id = $1 AND followee_id = $2")
            .bind(follower_id)
            .bind(followee_id)
            .fetch_optional(self.pool())
            .await
            .unwrap()
    }

    pub fn count(&self, sql: &str) -> impl Future<Output = i64> + '_ {
        let sql = sql.to_string();
        async move { sqlx::query_scalar(&sql).fetch_one(self.pool()).await.unwrap() }
    }

    pub async fn finish(self) {
        self.db.finish().await;
    }
}

/// Polls `cond` for up to 5 s.
pub async fn eventually<F, Fut>(what: &str, mut cond: F)
where
    F: FnMut() -> Fut,
    Fut: Future<Output = bool>,
{
    for _ in 0..100 {
        if cond().await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("timed out waiting for: {what}");
}
