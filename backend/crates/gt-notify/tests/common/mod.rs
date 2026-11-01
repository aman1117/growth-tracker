//! Shared fixtures. Database tests run only when `TEST_DATABASE_URL` points at a PostgreSQL
//! server whose role may create databases (each test uses its own database); Redis checks use
//! `TEST_REDIS_URL` (default `redis://127.0.0.1:56379`) and are skipped when it is unreachable.
//!
//! Everything runs on one shared runtime: the Redis connection is a process-wide global whose
//! background task must outlive individual tests.

#![allow(dead_code)]

use std::future::Future;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, OnceLock};

use axum::body::Body;
use axum::http::Request;
use axum::response::Response;
use gt_core::config::Config;
use gt_core::CoreContext;
use sqlx::postgres::PgPoolOptions;
use sqlx::{Connection, PgConnection, PgPool};
use tokio::runtime::Runtime;
use tokio::sync::OnceCell;

pub const VAPID_PUBLIC_KEY: &str =
    "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM";
pub const VAPID_PRIVATE_KEY: &str = "IQ9Ur0ykXoHS9gzfYX0aBjy9lvdrjx_PFUXmie9YRcY";
pub const MAINTENANCE_KEY: &str = "maint-secret";

/// The shared runtime; tests call [`run`].
pub fn rt() -> &'static Runtime {
    static RT: OnceLock<Runtime> = OnceLock::new();
    RT.get_or_init(|| tokio::runtime::Builder::new_multi_thread().worker_threads(4).enable_all().build().unwrap())
}

pub fn run<F: Future>(future: F) -> F::Output {
    rt().block_on(future)
}

/// User ids unlikely to collide with other users of the shared Redis.
pub fn unique_user_id() -> i64 {
    static NEXT: AtomicI64 = AtomicI64::new(0);
    7_700_000_000_000 + i64::from(std::process::id()) * 10_000 + NEXT.fetch_add(1, Ordering::Relaxed)
}

/// Connects the global Redis handle once; `false` when Redis is unavailable.
pub async fn redis_ready() -> bool {
    static READY: OnceCell<bool> = OnceCell::const_new();
    *READY
        .get_or_init(|| async {
            let url = std::env::var("TEST_REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:56379".into());
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

pub struct TestDb {
    pub pool: PgPool,
    admin_url: String,
    name: String,
}

impl TestDb {
    /// A freshly migrated database named `gt_notify_<test>`, or `None` (skip) without
    /// `TEST_DATABASE_URL`.
    pub async fn new(test: &str) -> Option<TestDb> {
        let Ok(admin_url) = std::env::var("TEST_DATABASE_URL") else {
            eprintln!("TEST_DATABASE_URL not set; skipping");
            return None;
        };
        let name = format!("gt_notify_{test}");
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

/// A configuration with test secrets.
pub fn config() -> Config {
    let mut config = Config::from_env();
    config.jwt.secret_key = "gt-notify-test-secret".into();
    config.web_push.vapid_public_key = VAPID_PUBLIC_KEY.into();
    config.web_push.vapid_private_key = VAPID_PRIVATE_KEY.into();
    config.web_push.vapid_key_id = "v1".into();
    config.maintenance_api_key = MAINTENANCE_KEY.into();
    config
}

pub fn core(pool: &PgPool) -> CoreContext {
    CoreContext::new(Arc::new(config()), pool.clone())
}

pub fn token(core: &CoreContext, user_id: i64) -> String {
    core.tokens.generate(user_id, &format!("user{user_id}")).unwrap().token
}

/// Builds a request; `body` is sent as JSON when present.
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

/// `(status, content type, body)`.
pub async fn parts(resp: Response) -> (u16, String, String) {
    let status = resp.status().as_u16();
    let content_type = resp.headers().get("content-type").map(|v| v.to_str().unwrap().to_string()).unwrap_or_default();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    (status, content_type, String::from_utf8(bytes.to_vec()).unwrap())
}
