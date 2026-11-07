//! Shared fixtures. Database tests run only when `TEST_DATABASE_URL` points at a PostgreSQL
//! server whose role may create databases (each test uses its own database); Redis checks use
//! `REDIS_URL` (default `redis://127.0.0.1:56379`) and are skipped when it is unreachable.
//!
//! Everything runs on one shared runtime: the Redis connection is a process-wide global whose
//! background task must outlive individual tests.

#![allow(dead_code)]

use std::collections::HashSet;
use std::future::Future;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex, OnceLock};

use async_trait::async_trait;
use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::Request;
use axum::Router;
use gt_chat::{ChatContext, ChatRealtime};
use gt_core::config::Config;
use gt_core::CoreContext;
use gt_notify::push::PushRequest;
use serde_json::Value;
use sqlx::postgres::PgPoolOptions;
use sqlx::{Connection, PgConnection, PgPool};
use tokio::runtime::Runtime;
use tokio::sync::OnceCell;
use tower::ServiceExt;

// ==================== Runtime and Redis ====================

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

// ==================== Database ====================

pub struct TestDb {
    pub pool: PgPool,
    admin_url: String,
    name: String,
}

impl TestDb {
    /// A freshly migrated database named `gt_chat_<test>`, or `None` (skip) without
    /// `TEST_DATABASE_URL`.
    pub async fn new(test: &str) -> Option<TestDb> {
        let Ok(admin_url) = std::env::var("TEST_DATABASE_URL") else {
            eprintln!("TEST_DATABASE_URL not set; skipping");
            return None;
        };
        let name = format!("gt_chat_{test}");
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

    pub async fn exec(&self, sql: &str) {
        sqlx::query(sql).execute(&self.pool).await.unwrap_or_else(|e| panic!("{sql}: {e}"));
    }

    pub async fn scalar(&self, sql: &str) -> i64 {
        sqlx::query_scalar(sql).fetch_one(&self.pool).await.unwrap_or_else(|e| panic!("{sql}: {e}"))
    }
}

/// A pool whose every query fails.
pub async fn broken_pool() -> PgPool {
    let pool = PgPoolOptions::new().connect_lazy("postgres://nobody:nothing@127.0.0.1:1/none").unwrap();
    pool.close().await;
    pool
}

// ==================== Fixtures ====================

#[derive(Debug, Clone)]
pub struct TestUser {
    pub id: i64,
    pub username: String,
}

pub async fn create_user(pool: &PgPool, username: &str) -> TestUser {
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO users (email, username, password_hash, profile_pic, profile_pic_thumb, is_verified) \
         VALUES ($1, $2, 'hash', $3, $4, true) RETURNING id",
    )
    .bind(format!("{username}@example.com"))
    .bind(username)
    .bind(format!("https://cdn.example/{username}.jpg"))
    .bind(format!("https://cdn.example/{username}_thumb.jpg"))
    .fetch_one(pool)
    .await
    .expect("create user");
    TestUser { id, username: username.to_string() }
}

/// An active follow edge from `follower` to `followee` (both edge tables).
pub async fn follow(pool: &PgPool, follower: &TestUser, followee: &TestUser) {
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

pub async fn unfollow(pool: &PgPool, follower: &TestUser, followee: &TestUser) {
    for table in ["follow_edges_by_follower", "follow_edges_by_followee"] {
        sqlx::query(&format!("DELETE FROM {table} WHERE follower_id = $1 AND followee_id = $2"))
            .bind(follower.id)
            .bind(followee.id)
            .execute(pool)
            .await
            .unwrap();
    }
}

// ==================== Realtime recorder ====================

/// Records events and pushes instead of delivering them.
#[derive(Default)]
pub struct Recorder {
    pub events: Mutex<Vec<(i64, String, Value)>>,
    pub connected: Mutex<HashSet<i64>>,
    pub pushes: Mutex<Vec<PushRequest>>,
}

impl Recorder {
    /// Removes and returns the recorded events.
    pub fn take_events(&self) -> Vec<(i64, String, Value)> {
        std::mem::take(&mut *self.events.lock().unwrap())
    }

    pub fn take_pushes(&self) -> Vec<PushRequest> {
        std::mem::take(&mut *self.pushes.lock().unwrap())
    }

    /// `(recipient, type)` of the recorded events, in order.
    pub fn take_kinds(&self) -> Vec<(i64, String)> {
        self.take_events().into_iter().map(|(user, kind, _)| (user, kind)).collect()
    }

    pub fn set_connected(&self, user_id: i64) {
        self.connected.lock().unwrap().insert(user_id);
    }
}

#[async_trait]
impl ChatRealtime for Recorder {
    async fn send(&self, user_id: i64, event_type: &str, payload: &Value) {
        self.events.lock().unwrap().push((user_id, event_type.to_string(), payload.clone()));
    }

    async fn is_connected(&self, user_id: i64) -> bool {
        self.connected.lock().unwrap().contains(&user_id)
    }

    fn push(&self, request: PushRequest) {
        self.pushes.lock().unwrap().push(request);
    }
}

// ==================== Stack ====================

pub fn config() -> Config {
    let mut config = Config::from_env();
    config.jwt.secret_key = "gt-chat-test-secret".into();
    config
}

pub fn core(pool: &PgPool) -> CoreContext {
    CoreContext::new(Arc::new(config()), pool.clone())
}

pub struct Stack {
    pub core: CoreContext,
    pub chat: ChatContext,
    pub recorder: Arc<Recorder>,
}

impl Stack {
    pub fn new(pool: &PgPool) -> Self {
        let core = core(pool);
        let recorder = Arc::new(Recorder::default());
        let chat = ChatContext::with_realtime(&core, recorder.clone());
        Self { core, chat, recorder }
    }

    pub fn router(&self) -> Router {
        gt_chat::routes(&self.core, &self.chat)
    }

    pub fn token(&self, user: &TestUser) -> String {
        self.core.tokens.generate(user.id, &user.username).unwrap().token
    }
}

// ==================== HTTP ====================

#[derive(Debug)]
pub struct Res {
    pub status: u16,
    pub body: String,
}

impl Res {
    pub fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap_or_else(|e| panic!("invalid JSON {:?}: {e}", self.body))
    }

    /// Asserts an error envelope with this status and code.
    #[track_caller]
    pub fn assert_error(&self, status: u16, code: &str) {
        assert_eq!(self.status, status, "{}", self.body);
        let json = self.json();
        assert_eq!(json["success"], false, "{}", self.body);
        assert_eq!(json["error_code"], code, "{}", self.body);
    }
}

pub async fn send(router: &Router, method: &str, uri: &str, token: Option<&str>, body: Option<Value>) -> Res {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(token) = token {
        builder = builder.header("Authorization", format!("Bearer {token}"));
    }
    let mut req = match body {
        Some(body) => builder.header("Content-Type", "application/json").body(Body::from(body.to_string())).unwrap(),
        None => builder.body(Body::empty()).unwrap(),
    };
    req.extensions_mut().insert(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 40000))));
    let resp = router.clone().oneshot(req).await.unwrap();
    let status = resp.status().as_u16();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    Res { status, body: String::from_utf8(bytes.to_vec()).unwrap() }
}

/// Two users who may message each other, their conversation id and tokens.
pub struct Pair {
    pub amy: TestUser,
    pub ben: TestUser,
    pub amy_token: String,
    pub ben_token: String,
    pub conversation_id: i64,
}

pub async fn pair(db: &TestDb, stack: &Stack) -> Pair {
    let amy = create_user(&db.pool, "amy").await;
    let ben = create_user(&db.pool, "ben").await;
    follow(&db.pool, &amy, &ben).await;
    let amy_token = stack.token(&amy);
    let ben_token = stack.token(&ben);
    let res =
        send(&stack.router(), "POST", "/api/chats", Some(&amy_token), Some(serde_json::json!({"user_id": ben.id})))
            .await;
    assert_eq!(res.status, 200, "{}", res.body);
    let conversation_id = res.json()["conversation"]["id"].as_i64().unwrap();
    stack.recorder.take_events();
    Pair { amy, ben, amy_token, ben_token, conversation_id }
}

/// Sends a message and returns its JSON.
pub async fn post_message(stack: &Stack, token: &str, conversation_id: i64, body: Value) -> Value {
    let res =
        send(&stack.router(), "POST", &format!("/api/chats/{conversation_id}/messages"), Some(token), Some(body)).await;
    assert_eq!(res.status, 201, "{}", res.body);
    res.json()["message"].clone()
}
