//! Shared fixtures of the integration tests.
//!
//! Database tests run only when `TEST_DATABASE_URL` points at a PostgreSQL server whose role
//! may create databases (each test gets its own database). Redis checks use `REDIS_URL`
//! (default `redis://127.0.0.1:56379`) and are skipped when it is unreachable.
//!
//! Everything runs on one shared runtime (the Redis connection is a process-wide global whose
//! background task must outlive single tests), and tests touching the global Redis handle or
//! push publisher hold [`serial`].

#![allow(dead_code)]

use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use axum::body::{to_bytes, Body, Bytes};
use axum::extract::{Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Router;
use base64::Engine;
use chrono::NaiveDate;
use gt_core::config::{AzureStorageConfig, Config};
use gt_core::models::{ActivityPhoto, User};
use gt_core::CoreContext;
use gt_notify::push::{set_push_publisher, OutgoingMessage, PushMessage, PushPublisher, PushRequest, PushTransport};
use gt_notify::push::{ServiceBusError, DEFAULT_PUSH_TTL_SECONDS};
use gt_notify::{NotificationRepository, NotificationService, NotifyContext};
use gt_photos::repository::{ActivityPhotoRepository, NewActivityPhoto};
use gt_photos::{ActivityPhotoService, BlobHandler, BlobService, BlobStore, PhotosContext};
use gt_users::{FollowRepository, UserRepository, UsersContext};
use image::{ImageFormat, Rgb, RgbImage};
use rand::RngCore;
use sqlx::postgres::PgPoolOptions;
use sqlx::{Connection, PgConnection, PgPool};
use tokio::runtime::Runtime;
use tokio::sync::OnceCell;
use tower::ServiceExt;

pub const CONTAINER: &str = "profile-pictures";
pub const ACCOUNT: &str = "devstoreaccount1";
/// Public URL prefix of blobs in development (Azurite).
pub const DEV_PREFIX: &str = "http://localhost:10000/devstoreaccount1/profile-pictures/";

// ==================== Runtime and serialization ====================

pub fn rt() -> &'static Runtime {
    static RT: OnceLock<Runtime> = OnceLock::new();
    RT.get_or_init(|| tokio::runtime::Builder::new_multi_thread().worker_threads(4).enable_all().build().unwrap())
}

pub fn run<F: Future>(future: F) -> F::Output {
    rt().block_on(future)
}

/// Serializes tests that use the global Redis handle or push publisher.
pub async fn serial() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    LOCK.lock().await
}

// ==================== Database ====================

pub struct TestDb {
    pub pool: PgPool,
    admin_url: String,
    url: String,
    name: String,
}

impl TestDb {
    /// A freshly migrated database, or `None` (skip) without `TEST_DATABASE_URL`. Photo ids
    /// start in a range unique to this test, so Redis cache keys do not collide.
    pub async fn new(test: &str) -> Option<TestDb> {
        let Ok(admin_url) = std::env::var("TEST_DATABASE_URL") else {
            eprintln!("TEST_DATABASE_URL not set; skipping");
            return None;
        };
        let name = format!("gt_photos_{test}_{}", std::process::id());
        let mut admin = PgConnection::connect(&admin_url).await.expect("connect admin");
        sqlx::query(&format!("DROP DATABASE IF EXISTS {name} WITH (FORCE)")).execute(&mut admin).await.unwrap();
        sqlx::query(&format!("CREATE DATABASE {name}")).execute(&mut admin).await.unwrap();
        let mut url = url::Url::parse(&admin_url).unwrap();
        url.set_path(&format!("/{name}"));
        let pool = PgPoolOptions::new().max_connections(8).connect(url.as_str()).await.expect("connect test db");
        gt_core::db::migrate(&pool).await.expect("migrate");

        static NEXT: AtomicI64 = AtomicI64::new(0);
        let start = 1_000_000_000
            + i64::from(std::process::id() % 100_000) * 10_000
            + NEXT.fetch_add(1, Ordering::Relaxed) * 200;
        sqlx::query(&format!("ALTER SEQUENCE activity_photos_id_seq RESTART WITH {start}"))
            .execute(&pool)
            .await
            .unwrap();
        Some(TestDb { pool, admin_url, url: url.to_string(), name })
    }

    /// A closed pool on this database: every query fails immediately (Go `BrokenDB`).
    pub async fn broken(&self) -> PgPool {
        let pool = PgPoolOptions::new().connect_lazy(&self.url).unwrap();
        pool.close().await;
        pool
    }

    pub async fn finish(self) {
        self.pool.close().await;
        let mut admin = PgConnection::connect(&self.admin_url).await.unwrap();
        let _ = sqlx::query(&format!("DROP DATABASE IF EXISTS {} WITH (FORCE)", self.name)).execute(&mut admin).await;
    }
}

/// An injected failure: every `event` statement on `table` raises `injected failure`.
pub struct Fault {
    pool: PgPool,
    name: String,
    table: String,
}

/// How the injected failure reads in Go-style error messages.
pub const INJECTED: &str = "ERROR: injected failure (SQLSTATE P0001)";

pub async fn fail_on(pool: &PgPool, event: &str, table: &str) -> Fault {
    sqlx::query(
        "CREATE OR REPLACE FUNCTION gt_photos_injected_failure() RETURNS trigger LANGUAGE plpgsql AS \
         $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$",
    )
    .execute(pool)
    .await
    .unwrap();
    let name = format!("fail_{}_{table}", event.to_lowercase());
    sqlx::query(&format!(
        "CREATE TRIGGER {name} BEFORE {event} ON {table} FOR EACH STATEMENT EXECUTE FUNCTION gt_photos_injected_failure()"
    ))
    .execute(pool)
    .await
    .unwrap();
    Fault { pool: pool.clone(), name, table: table.to_string() }
}

impl Fault {
    pub async fn clear(self) {
        sqlx::query(&format!("DROP TRIGGER IF EXISTS {} ON {}", self.name, self.table))
            .execute(&self.pool)
            .await
            .unwrap();
    }
}

// ==================== Fixtures ====================

static NEXT_USER: AtomicI64 = AtomicI64::new(0);

/// A new user with a unique name.
pub async fn create_user(pool: &PgPool) -> User {
    let username = format!("u{}_{}", std::process::id(), NEXT_USER.fetch_add(1, Ordering::Relaxed));
    let id: i64 =
        sqlx::query_scalar("INSERT INTO users (email, username, password_hash) VALUES ($1, $2, 'x') RETURNING id")
            .bind(format!("{username}@example.com"))
            .bind(&username)
            .fetch_one(pool)
            .await
            .unwrap();
    get_user(pool, id).await
}

pub async fn get_user(pool: &PgPool, id: i64) -> User {
    UserRepository::new(pool.clone()).find_by_id(id).await.unwrap().expect("user exists")
}

pub async fn set_picture(pool: &PgPool, user_id: i64, pic: Option<&str>, thumb: Option<&str>) {
    sqlx::query("UPDATE users SET profile_pic = $1, profile_pic_thumb = $2 WHERE id = $3")
        .bind(pic)
        .bind(thumb)
        .bind(user_id)
        .execute(pool)
        .await
        .unwrap();
}

/// An active follow edge `follower -> followee` (both edge tables).
pub async fn follow(pool: &PgPool, follower: i64, followee: i64) {
    for table in ["follow_edges_by_follower", "follow_edges_by_followee"] {
        sqlx::query(&format!("INSERT INTO {table} (follower_id, followee_id, state) VALUES ($1, $2, 'ACTIVE')"))
            .bind(follower)
            .bind(followee)
            .execute(pool)
            .await
            .unwrap();
    }
}

/// Blob name of a seeded photo file.
pub fn photo_blob(user_id: i64, date: NaiveDate, activity: &str, file: &str) -> String {
    format!("activity-photos/{user_id}/{date}/{activity}/{file}")
}

/// A photo whose URLs point into the container (`full.jpg` / `thumb.jpg`).
pub async fn seed_photo(pool: &PgPool, user_id: i64, activity: &str, date: NaiveDate) -> ActivityPhoto {
    ActivityPhotoRepository::new(pool.clone())
        .create(&NewActivityPhoto {
            user_id,
            activity_name: activity.into(),
            photo_date: date,
            photo_url: format!("{DEV_PREFIX}{}", photo_blob(user_id, date, activity, "full.jpg")),
            thumbnail_url: format!("{DEV_PREFIX}{}", photo_blob(user_id, date, activity, "thumb.jpg")),
            activity_icon: None,
            activity_color: None,
            activity_label: None,
        })
        .await
        .unwrap()
}

pub async fn count(pool: &PgPool, sql: &str) -> i64 {
    sqlx::query_scalar(sql).fetch_one(pool).await.unwrap()
}

/// `(type, title, body, metadata)` of a user's notifications, oldest first.
pub async fn notifications_of(pool: &PgPool, user_id: i64) -> Vec<(String, String, String, serde_json::Value)> {
    sqlx::query_as::<_, (String, String, String, Option<serde_json::Value>)>(
        "SELECT type, title, COALESCE(body, ''), metadata FROM notifications WHERE user_id = $1 ORDER BY id",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
    .unwrap()
    .into_iter()
    .map(|(kind, title, body, metadata)| (kind, title, body, metadata.unwrap_or_default()))
    .collect()
}

pub fn ist_day(offset_days: i64) -> NaiveDate {
    gt_core::timeutil::today_ist() + chrono::Duration::days(offset_days)
}

pub fn day(y: i32, m: u32, d: u32) -> NaiveDate {
    NaiveDate::from_ymd_opt(y, m, d).unwrap()
}

// ==================== Images ====================

fn test_image(width: u32, height: u32) -> RgbImage {
    RgbImage::from_fn(width, height, |x, y| Rgb([(x % 256) as u8, (y % 256) as u8, 128]))
}

pub fn png_bytes(width: u32, height: u32) -> Vec<u8> {
    let mut out = std::io::Cursor::new(Vec::new());
    test_image(width, height).write_to(&mut out, ImageFormat::Png).unwrap();
    out.into_inner()
}

pub fn jpeg_bytes(width: u32, height: u32) -> Vec<u8> {
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 90).encode_image(&test_image(width, height)).unwrap();
    out
}

/// `(width, height)` of a JPEG.
pub fn jpeg_size(data: &[u8]) -> (u32, u32) {
    let img = image::load_from_memory_with_format(data, ImageFormat::Jpeg).unwrap();
    (img.width(), img.height())
}

/// Starts like an ISO BMFF `ftyp` box (detected as HEIC).
pub const HEIC_HEADER: &[u8] = &[0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0x00, 0x00];

// ==================== Fake Azure Blob Storage ====================

/// A request received by the fake blob store; `name` is the path after the account
/// (`profile-pictures/<blob>`, or the container for container requests).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobCall {
    pub method: String,
    pub name: String,
    pub content_type: String,
    pub size: usize,
}

type Matcher = Arc<dyn Fn(&str) -> bool + Send + Sync>;

#[derive(Default)]
struct FakeState {
    blobs: HashMap<String, Vec<u8>>,
    calls: Vec<BlobCall>,
    fail_put: Option<Matcher>,
    fail_delete: Option<Matcher>,
    container_response: Option<(u16, String)>,
}

/// A minimal Azure Blob endpoint: container creation, Put Blob and Delete Blob. Failing
/// uploads get `403 AuthorizationFailure` (not retried), failing deletes `404 BlobNotFound`.
#[derive(Clone)]
pub struct FakeBlobStore {
    addr: std::net::SocketAddr,
    state: Arc<Mutex<FakeState>>,
}

impl FakeBlobStore {
    pub async fn start() -> FakeBlobStore {
        let state = Arc::new(Mutex::new(FakeState::default()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = Router::new().fallback(fake_blob_handler).with_state(state.clone());
        rt().spawn(async move { axum::serve(listener, app).await.unwrap() });
        FakeBlobStore { addr, state }
    }

    /// An Azurite-style connection string with a random key.
    pub fn connection_string(&self) -> String {
        let mut key = [0u8; 64];
        rand::thread_rng().fill_bytes(&mut key);
        format!(
            "DefaultEndpointsProtocol=http;AccountName={ACCOUNT};AccountKey={};BlobEndpoint=http://{}/{ACCOUNT};",
            base64::engine::general_purpose::STANDARD.encode(key),
            self.addr
        )
    }

    pub fn storage_config(&self) -> AzureStorageConfig {
        AzureStorageConfig {
            account_name: ACCOUNT.into(),
            connection_string: self.connection_string(),
            container_name: CONTAINER.into(),
        }
    }

    /// A blob store on the fake (development URLs unless `production`).
    pub fn store(&self, production: bool) -> BlobStore {
        BlobStore::from_config(&self.storage_config(), !production).unwrap().unwrap()
    }

    pub fn calls(&self) -> Vec<BlobCall> {
        self.state.lock().unwrap().calls.clone()
    }

    /// `"<METHOD> <blob>"` of the blob requests (container prefix removed).
    pub fn blob_requests(&self) -> Vec<String> {
        let prefix = format!("{CONTAINER}/");
        self.calls()
            .into_iter()
            .filter_map(|c| c.name.strip_prefix(&prefix).map(|name| format!("{} {name}", c.method)))
            .collect()
    }

    /// Names (with container) of the requests of one method.
    pub fn requests_with(&self, method: &str) -> Vec<String> {
        self.calls().into_iter().filter(|c| c.method == method).map(|c| c.name).collect()
    }

    pub fn blob(&self, name: &str) -> Option<Vec<u8>> {
        self.state.lock().unwrap().blobs.get(name).cloned()
    }

    pub fn blob_names(&self) -> Vec<String> {
        self.state.lock().unwrap().blobs.keys().cloned().collect()
    }

    /// Uploads of blobs matching `matcher` fail (`None`: none fail).
    pub fn set_fail_put(&self, matcher: Option<fn(&str) -> bool>) {
        self.state.lock().unwrap().fail_put = matcher.map(|m| Arc::new(m) as Matcher);
    }

    /// Deletes of blobs matching `matcher` fail (`None`: none fail).
    pub fn set_fail_delete(&self, matcher: Option<fn(&str) -> bool>) {
        self.state.lock().unwrap().fail_delete = matcher.map(|m| Arc::new(m) as Matcher);
    }

    pub fn set_container_response(&self, status: u16, code: &str) {
        self.state.lock().unwrap().container_response = Some((status, code.to_string()));
    }
}

async fn fake_blob_handler(State(state): State<Arc<Mutex<FakeState>>>, request: Request) -> Response {
    let method = request.method().as_str().to_string();
    let path = request.uri().path().to_string();
    let is_container = request.uri().query().is_some_and(|q| q.contains("restype=container"));
    let content_type = header(request.headers(), "x-ms-blob-content-type");
    let body = to_bytes(request.into_body(), usize::MAX).await.unwrap_or_default();
    let name = percent_decode(path.strip_prefix(&format!("/{ACCOUNT}/")).unwrap_or(&path));
    let blob = name.strip_prefix(&format!("{CONTAINER}/")).unwrap_or(&name).to_string();

    let mut state = state.lock().unwrap();
    state.calls.push(BlobCall { method: method.clone(), name: name.clone(), content_type, size: body.len() });
    match method.as_str() {
        "PUT" if is_container => match state.container_response.clone() {
            Some((status, code)) => error_response(status, &code),
            None => StatusCode::CREATED.into_response(),
        },
        "PUT" => {
            if state.fail_put.as_ref().is_some_and(|fail| fail(&blob)) {
                return error_response(403, "AuthorizationFailure");
            }
            state.blobs.insert(name, body.to_vec());
            StatusCode::CREATED.into_response()
        }
        "DELETE" => {
            if state.fail_delete.as_ref().is_some_and(|fail| fail(&blob)) {
                return error_response(404, "BlobNotFound");
            }
            state.blobs.remove(&name);
            StatusCode::ACCEPTED.into_response()
        }
        _ => StatusCode::BAD_REQUEST.into_response(),
    }
}

fn error_response(status: u16, code: &str) -> Response {
    let mut resp = StatusCode::from_u16(status).unwrap().into_response();
    resp.headers_mut().insert("x-ms-error-code", code.parse().unwrap());
    resp
}

fn header(headers: &HeaderMap, name: &str) -> String {
    headers.get(name).and_then(|v| v.to_str().ok()).unwrap_or("").to_string()
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap()
}

// ==================== Redis ====================

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

/// Runs `f` with Redis unavailable, then restores the handle.
pub async fn without_redis<F: Future>(f: F) -> F::Output {
    let saved = gt_core::redis::get();
    gt_core::redis::set_handle(None);
    let out = f.await;
    gt_core::redis::set_handle(saved.map(|h| (*h).clone()));
    out
}

pub async fn redis_cmd<T: redis::FromRedisValue>(cmd: &mut redis::Cmd) -> T {
    let mut conn = gt_core::redis::conn().expect("redis connected");
    cmd.query_async(&mut conn).await.unwrap()
}

pub async fn redis_get(key: &str) -> Option<String> {
    redis_cmd(redis::cmd("GET").arg(key)).await
}

pub async fn redis_set(key: &str, value: &str) {
    redis_cmd::<()>(redis::cmd("SET").arg(key).arg(value).arg("EX").arg(300)).await;
}

pub async fn redis_del(key: &str) {
    redis_cmd::<()>(redis::cmd("DEL").arg(key)).await;
}

/// Stores a hash at `key`, so string commands on it fail with `WRONGTYPE`.
pub async fn redis_wrong_type(key: &str) {
    redis_del(key).await;
    redis_cmd::<()>(redis::cmd("HSET").arg(key).arg("f").arg("v")).await;
    redis_cmd::<()>(redis::cmd("EXPIRE").arg(key).arg(300)).await;
}

pub fn like_count_key(photo_id: i64) -> String {
    gt_core::redis::story_like_count_cache_key(photo_id)
}

pub fn liked_by_key(photo_id: i64, user_id: i64) -> String {
    gt_core::redis::story_liked_by_cache_key(photo_id, user_id)
}

// ==================== Push ====================

/// Records every push sent through the global publisher.
#[derive(Default)]
pub struct PushRecorder {
    sent: Mutex<Vec<PushMessage>>,
}

#[async_trait::async_trait]
impl PushTransport for PushRecorder {
    async fn send(&self, message: &OutgoingMessage) -> Result<(), ServiceBusError> {
        self.sent.lock().unwrap().push(PushMessage::from_json(&message.body).unwrap());
        Ok(())
    }
}

impl PushRecorder {
    /// The pushes sent so far, after giving the batching sender a moment.
    pub async fn sent(&self) -> Vec<PushMessage> {
        tokio::time::sleep(Duration::from_millis(150)).await;
        self.sent.lock().unwrap().clone()
    }

    pub fn clear(&self) {
        self.sent.lock().unwrap().clear();
    }
}

/// Installs a recording global push publisher.
pub fn install_push() -> Arc<PushRecorder> {
    let recorder = Arc::new(PushRecorder::default());
    let publisher = PushPublisher::with_transport(recorder.clone(), 100, 1, Duration::from_millis(5));
    set_push_publisher(Some(Arc::new(publisher)));
    recorder
}

/// A transport that never finishes sending.
struct Stuck;

#[async_trait::async_trait]
impl PushTransport for Stuck {
    async fn send(&self, _message: &OutgoingMessage) -> Result<(), ServiceBusError> {
        std::future::pending().await
    }
}

/// Installs a global publisher whose queue is full: every publish fails with `QueueFull`.
pub async fn install_full_push() {
    let publisher = Arc::new(PushPublisher::with_transport(Arc::new(Stuck), 1, 1, Duration::from_millis(1)));
    let filler = || PushRequest {
        user_id: 1,
        notification_type: "filler".into(),
        title: "t".into(),
        body: "b".into(),
        ttl_seconds: DEFAULT_PUSH_TTL_SECONDS,
        ..PushRequest::default()
    };
    publisher.publish_push_notification(filler()).unwrap();
    for _ in 0..200 {
        if publisher.queue_stats().0 == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    publisher.publish_push_notification(filler()).unwrap();
    assert!(publisher.publish_push_notification(filler()).is_err(), "queue is full");
    set_push_publisher(Some(publisher));
}

pub fn uninstall_push() {
    set_push_publisher(None);
}

// ==================== Application ====================

pub const JWT_SECRET: &str = "gt-photos-test-secret";

/// A configuration with test secrets, `env` (`development` / `production`) and the given
/// blob storage.
pub fn config(env: &str, storage: AzureStorageConfig) -> Config {
    let mut config = Config::from_env();
    config.jwt.secret_key = JWT_SECRET.into();
    config.env = env.into();
    config.azure_storage = storage;
    config
}

pub fn no_storage() -> AzureStorageConfig {
    AzureStorageConfig {
        account_name: ACCOUNT.into(),
        connection_string: String::new(),
        container_name: CONTAINER.into(),
    }
}

/// The contexts of a test application.
pub struct App {
    pub core: CoreContext,
    pub users: UsersContext,
    pub notify: NotifyContext,
}

impl App {
    pub fn new(pool: &PgPool, env: &str, storage: AzureStorageConfig) -> App {
        let core = CoreContext::new(Arc::new(config(env, storage)), pool.clone());
        let users = UsersContext::new(&core);
        let notify = NotifyContext::new(&core);
        App { core, users, notify }
    }

    pub fn photos(&self) -> PhotosContext {
        PhotosContext::new(&self.core, &self.users, &self.notify)
    }

    pub fn router(&self, photos: &PhotosContext) -> Router {
        gt_photos::routes(&self.core, &self.users, &self.notify, photos)
    }

    /// A router serving only the activity photo routes of `service`.
    pub fn photo_router(&self, service: Arc<ActivityPhotoService>) -> Router {
        let mut photos = self.photos();
        photos.blob_handler = None;
        photos.activity_photo_service = Some(service);
        self.router(&photos)
    }

    /// A router serving only the profile picture routes of `handler`.
    pub fn blob_router(&self, handler: BlobHandler) -> Router {
        let mut photos = self.photos();
        photos.activity_photo_service = None;
        photos.blob_handler = Some(Arc::new(handler));
        self.router(&photos)
    }

    pub fn token(&self, user_id: i64) -> String {
        self.core.tokens.generate(user_id, &format!("user{user_id}")).unwrap().token
    }
}

/// The pools behind each repository of an activity photo service (any may be broken).
pub struct ServicePools<'a> {
    pub photos: &'a PgPool,
    pub users: &'a PgPool,
    pub follows: &'a PgPool,
    pub notifs: &'a PgPool,
}

impl<'a> ServicePools<'a> {
    pub fn all(pool: &'a PgPool) -> Self {
        Self { photos: pool, users: pool, follows: pool, notifs: pool }
    }

    pub fn service(&self, store: Option<BlobStore>) -> Arc<ActivityPhotoService> {
        Arc::new(ActivityPhotoService::new(
            Arc::new(ActivityPhotoRepository::new(self.photos.clone())),
            Arc::new(UserRepository::new(self.users.clone())),
            Arc::new(FollowRepository::new(self.follows.clone())),
            Arc::new(NotificationService::new(Arc::new(NotificationRepository::new(self.notifs.clone())))),
            store,
        ))
    }
}

/// A profile picture handler whose user lookups and updates use `users`.
pub fn blob_handler(users: &PgPool, store: Option<BlobStore>) -> BlobHandler {
    let service = BlobService::new(Arc::new(UserRepository::new(users.clone())), &no_storage());
    BlobHandler::with_store(Arc::new(service), store)
}

/// Stops background notification work of a service (Go `stopPhotoTimers`).
pub async fn stop_notifications(service: &ActivityPhotoService) {
    service.wait_for_background_tasks().await;
    service.cancel_pending_notifications().await;
}

// ==================== HTTP ====================

pub struct TestResponse {
    pub status: u16,
    pub headers: HeaderMap,
    pub body: String,
}

impl TestResponse {
    pub fn json(&self) -> serde_json::Value {
        serde_json::from_str(&self.body).unwrap_or_else(|e| panic!("invalid JSON ({e}): {}", self.body))
    }

    /// Asserts Go's error envelope.
    pub fn assert_error(&self, status: u16, code: &str, message: &str) {
        assert_eq!(self.status, status, "body: {}", self.body);
        assert_eq!(self.json(), serde_json::json!({"success": false, "error": message, "error_code": code}));
    }

    /// Asserts the status and code of an error and returns its message.
    pub fn error_message(&self, status: u16, code: &str) -> String {
        assert_eq!(self.status, status, "body: {}", self.body);
        let body = self.json();
        assert_eq!(body["error_code"], code, "body: {}", self.body);
        body["error"].as_str().unwrap().to_string()
    }

    pub fn assert_success_message(&self, message: &str) {
        assert_eq!(self.status, 200, "body: {}", self.body);
        assert_eq!(self.json(), serde_json::json!({"success": true, "message": message}));
    }
}

/// Sends a request; `body` is `(bytes, content type)`.
pub async fn call(
    router: &Router,
    method: &str,
    uri: &str,
    token: Option<&str>,
    body: Option<(Vec<u8>, String)>,
) -> TestResponse {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(token) = token {
        builder = builder.header("Authorization", format!("Bearer {token}"));
    }
    let request = match body {
        Some((bytes, content_type)) => {
            builder.header("Content-Type", content_type).body(Body::from(Bytes::from(bytes))).unwrap()
        }
        None => builder.body(Body::empty()).unwrap(),
    };
    let response = router.clone().oneshot(request).await.unwrap();
    let status = response.status().as_u16();
    let headers = response.headers().clone();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    TestResponse { status, headers, body: String::from_utf8_lossy(&bytes).into_owned() }
}

/// A `multipart/form-data` body with text `fields` and an optional `(field, filename, data)`
/// file part.
pub fn multipart(fields: &[(&str, &str)], file: Option<(&str, &str, &[u8])>) -> (Vec<u8>, String) {
    const BOUNDARY: &str = "gtphotos7MA4YWxkTrZu0gW";
    let mut body = Vec::new();
    for (name, value) in fields {
        body.extend_from_slice(
            format!("--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n").as_bytes(),
        );
    }
    if let Some((field, filename, data)) = file {
        body.extend_from_slice(
            format!(
                "--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"{field}\"; filename=\"{filename}\"\r\n\
                 Content-Type: application/octet-stream\r\n\r\n"
            )
            .as_bytes(),
        );
        body.extend_from_slice(data);
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{BOUNDARY}--\r\n").as_bytes());
    (body, format!("multipart/form-data; boundary={BOUNDARY}"))
}
