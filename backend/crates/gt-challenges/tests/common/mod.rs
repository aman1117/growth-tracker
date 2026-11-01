//! Shared fixtures of the service and HTTP tests (port of the Go `chEnv` helpers).
//!
//! Database tests run only when `TEST_DATABASE_URL` points at a PostgreSQL server whose role
//! may create databases; each test binary uses its own database.
//!
//! Fault injection (Go: `faultyDB` + `failingOn`): every table has a statement-level trigger
//! and, in the `gt_fault` schema, a view `SELECT * FROM public.<table> WHERE gt_fault_check()`.
//! A faulty pool puts `gt_fault` first on its search path and sets `gt.fail_match` (a regex);
//! `gt_fault_check()` raises `injected failure` when the running statement
//! (`current_query()`) matches it, optionally only for the nth matching statement.

#![allow(dead_code)]

use std::collections::BTreeMap;
use std::fmt::Debug;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Duration, NaiveDate, NaiveTime, TimeZone, Utc};
use chrono_tz::Asia::Kolkata;
use gt_challenges::dto::{ChallengeDetail, ChallengeParticipant, ChallengeUser, CreateChallengeRequest};
use gt_challenges::{ChallengeError, ChallengeRepository, ChallengeService};
use gt_core::constants::CHALLENGE_INVITE_CODE_ALPHABET;
use gt_core::models::{Challenge, CronJobLog};
use gt_notify::{NotificationRepository, NotificationService};
use gt_users::CronJobLogRepository;
use serde_json::Value;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::{Connection, PgConnection, PgPool};
use tracing::field::{Field, Visit};
use tracing::{Event, Level, Subscriber};
use tracing_subscriber::layer::{Context, SubscriberExt};
use tracing_subscriber::Layer;

// ==================== Database ====================

const TABLES: &[&str] = &[
    "users",
    "activities",
    "challenges",
    "challenge_participants",
    "challenge_days",
    "challenge_cheers",
    "challenge_invites",
    "follow_edges_by_follower",
    "follow_edges_by_followee",
    "notification_dedupes",
    "notifications",
    "cron_job_logs",
];

const FAULT_SETUP: &str = r"
CREATE SEQUENCE gt_fault_seq;

CREATE FUNCTION gt_fault_check() RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE
    m text := current_setting('gt.fail_match', true);
    s text := current_setting('gt.fail_skip', true);
    n bigint := coalesce(nullif(current_setting('gt.fail_nth', true), '')::bigint, 0);
    q text := current_query();
    k text;
    seen bigint;
BEGIN
    IF m IS NULL OR m = '' OR q !~ m OR (s IS NOT NULL AND s <> '' AND q ~ s) THEN
        RETURN true;
    END IF;
    IF n > 0 THEN
        k := pg_backend_pid()::text || '/' || statement_timestamp()::text;
        IF current_setting('gt.fail_last', true) IS DISTINCT FROM k THEN
            PERFORM set_config('gt.fail_last', k, false);
            seen := nextval('gt_fault_seq');
        ELSE
            seen := currval('gt_fault_seq');
        END IF;
        IF seen <> n THEN
            RETURN true;
        END IF;
    END IF;
    RAISE EXCEPTION 'injected failure';
END $$;

CREATE FUNCTION gt_fault_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM gt_fault_check();
    RETURN NULL;
END $$;

CREATE SCHEMA gt_fault;
";

/// A statement to fail: every statement matching `matching` (a PostgreSQL regex), or only the
/// `nth` one, unless it also matches `skip`.
#[derive(Debug, Clone, Copy)]
pub struct Fault {
    pub matching: &'static str,
    pub skip: &'static str,
    pub nth: i64,
}

pub const fn fail(matching: &'static str) -> Fault {
    Fault { matching, skip: "", nth: 0 }
}

impl Fault {
    pub const fn nth(self, nth: i64) -> Self {
        Fault { nth, ..self }
    }

    pub const fn except(self, skip: &'static str) -> Self {
        Fault { skip, ..self }
    }
}

pub struct TestDb {
    pub pool: PgPool,
    pub url: String,
    admin_url: String,
    name: String,
}

impl TestDb {
    /// A freshly migrated database named `gt_challenges_<test>` with the fault injection
    /// helpers, or `None` (skip) without `TEST_DATABASE_URL`.
    pub async fn new(test: &str) -> Option<TestDb> {
        let Ok(admin_url) = std::env::var("TEST_DATABASE_URL") else {
            eprintln!("TEST_DATABASE_URL not set; skipping");
            return None;
        };
        let name = format!("gt_challenges_{test}");
        let mut admin = PgConnection::connect(&admin_url).await.expect("connect admin");
        sqlx::query(&format!("DROP DATABASE IF EXISTS {name} WITH (FORCE)")).execute(&mut admin).await.unwrap();
        sqlx::query(&format!("CREATE DATABASE {name}")).execute(&mut admin).await.unwrap();
        let mut url = url::Url::parse(&admin_url).unwrap();
        url.set_path(&format!("/{name}"));
        let url = url.to_string();
        let pool = PgPoolOptions::new().max_connections(24).connect(&url).await.expect("connect test db");
        gt_core::db::migrate(&pool).await.expect("migrate");
        sqlx::raw_sql(FAULT_SETUP).execute(&pool).await.expect("fault setup");
        for table in TABLES {
            let sql = format!(
                "CREATE VIEW gt_fault.{table} AS SELECT * FROM public.{table} WHERE gt_fault_check(); \
                 CREATE TRIGGER gt_fault BEFORE INSERT OR UPDATE OR DELETE ON public.{table} \
                 FOR EACH STATEMENT EXECUTE FUNCTION gt_fault_trigger();"
            );
            sqlx::raw_sql(&sql).execute(&pool).await.expect("fault views");
        }
        Some(TestDb { pool, url, admin_url, name })
    }

    /// Empties every table the tests use.
    pub async fn reset(&self) {
        let sql = format!("TRUNCATE {} RESTART IDENTITY CASCADE", TABLES.join(", "));
        sqlx::query(&sql).execute(&self.pool).await.expect("truncate");
    }

    pub async fn finish(self) {
        self.pool.close().await;
        let mut admin = PgConnection::connect(&self.admin_url).await.unwrap();
        let _ = sqlx::query(&format!("DROP DATABASE IF EXISTS {} WITH (FORCE)", self.name)).execute(&mut admin).await;
    }

    /// A pool on which every statement fails: the tables are not on its search path.
    pub async fn broken_pool(&self) -> PgPool {
        let options = self.url.parse::<PgConnectOptions>().unwrap().options([("search_path", "gt_missing_schema")]);
        PgPoolOptions::new().max_connections(4).connect_with(options).await.expect("connect broken pool")
    }

    /// A pool whose statements matching `fault` fail with `injected failure`.
    pub async fn faulty_pool(&self, fault: Fault) -> PgPool {
        sqlx::query("ALTER SEQUENCE gt_fault_seq RESTART").execute(&self.pool).await.unwrap();
        let options = self.url.parse::<PgConnectOptions>().unwrap();
        PgPoolOptions::new()
            .max_connections(4)
            .after_connect(move |conn, _| {
                Box::pin(async move {
                    sqlx::query(
                        "SELECT set_config('search_path', 'gt_fault, public', false), \
                         set_config('gt.fail_match', $1, false), set_config('gt.fail_skip', $2, false), \
                         set_config('gt.fail_nth', $3, false)",
                    )
                    .bind(fault.matching)
                    .bind(fault.skip)
                    .bind(fault.nth.to_string())
                    .execute(conn)
                    .await?;
                    Ok(())
                })
            })
            .connect_with(options)
            .await
            .expect("connect faulty pool")
    }
}

/// Whether the error is the unexpected (500) kind caused by an injected failure.
pub fn injected(err: &ChallengeError) -> bool {
    matches!(err, ChallengeError::Internal(_)) && format!("{err:#}").contains("injected failure")
}

// ==================== Clock and dates ====================

/// The date most tests call "today".
pub fn cday() -> NaiveDate {
    NaiveDate::from_ymd_opt(2026, 3, 9).unwrap()
}

/// The date `offset` days after [`cday`].
pub fn on(offset: i64) -> NaiveDate {
    cday() + Duration::days(offset)
}

pub fn ymd(d: NaiveDate) -> String {
    d.format("%Y-%m-%d").to_string()
}

/// Noon IST on `d`.
pub fn noon_ist(d: NaiveDate) -> DateTime<Utc> {
    Kolkata.from_local_datetime(&d.and_time(NaiveTime::from_hms_opt(12, 0, 0).unwrap())).unwrap().with_timezone(&Utc)
}

/// A manual clock; the service reads "today" (IST) from it.
#[derive(Clone)]
pub struct ManualClock(Arc<Mutex<DateTime<Utc>>>);

impl ManualClock {
    pub fn at_day(d: NaiveDate) -> Self {
        ManualClock(Arc::new(Mutex::new(noon_ist(d))))
    }

    /// Moves the clock to noon IST on `d`.
    pub fn set_day(&self, d: NaiveDate) {
        *self.0.lock().unwrap() = noon_ist(d);
    }

    pub fn now(&self) -> DateTime<Utc> {
        *self.0.lock().unwrap()
    }
}

/// A service on the given pools (challenges, job logs and notifications) and clock.
pub fn service(
    challenges: &PgPool,
    job_logs: Option<&PgPool>,
    notifications: Option<&PgPool>,
    clock: &ManualClock,
) -> ChallengeService {
    let clock = clock.clone();
    ChallengeService::new(
        Arc::new(ChallengeRepository::new(challenges.clone())),
        job_logs.map(|pool| Arc::new(CronJobLogRepository::new(pool.clone()))),
        notifications
            .map(|pool| Arc::new(NotificationService::new(Arc::new(NotificationRepository::new(pool.clone()))))),
    )
    .with_clock(move || clock.now())
}

// ==================== Fixtures ====================

#[derive(Debug, Clone, PartialEq)]
pub struct TestUser {
    pub id: i64,
    pub username: String,
    pub profile_pic: Option<String>,
    pub profile_pic_thumb: Option<String>,
    pub is_verified: bool,
}

static USER_SEQ: AtomicI64 = AtomicI64::new(0);

async fn insert_user(pool: &PgPool, username: &str, avatar: bool) -> TestUser {
    let n = USER_SEQ.fetch_add(1, Ordering::Relaxed) + 1;
    let (pic, thumb) = if avatar {
        (
            Some(format!("https://cdn.example.com/{username}.jpg")),
            Some(format!("https://cdn.example.com/{username}_thumb.jpg")),
        )
    } else {
        (None, None)
    };
    let id = sqlx::query_scalar(
        "INSERT INTO users (email, username, password_hash, profile_pic, profile_pic_thumb, is_verified, email_verified) \
         VALUES ($1, $2, 'x', $3, $4, $5, true) RETURNING id",
    )
    .bind(format!("user{n}@example.com"))
    .bind(username)
    .bind(&pic)
    .bind(&thumb)
    .bind(avatar)
    .fetch_one(pool)
    .await
    .expect("insert user");
    TestUser { id, username: username.to_string(), profile_pic: pic, profile_pic_thumb: thumb, is_verified: avatar }
}

/// A user named `name`.
pub async fn user(pool: &PgPool, name: &str) -> TestUser {
    insert_user(pool, name, false).await
}

/// A user with profile pictures and the verified badge (Go `chAvatar`).
pub async fn user_with_avatar(pool: &PgPool, name: &str) -> TestUser {
    insert_user(pool, name, true).await
}

/// A user with a unique generated name.
pub async fn any_user(pool: &PgPool) -> TestUser {
    let n = USER_SEQ.load(Ordering::Relaxed) + 1;
    insert_user(pool, &format!("member{n:04}"), false).await
}

pub fn ch_user(u: &TestUser) -> ChallengeUser {
    ChallengeUser {
        id: u.id,
        username: u.username.clone(),
        profile_pic: u.profile_pic.clone(),
        profile_pic_thumb: u.profile_pic_thumb.clone(),
        is_verified: u.is_verified,
    }
}

static CODE_SEQ: AtomicI64 = AtomicI64::new(0);

/// A unique, well-formed invite code.
pub fn next_code() -> String {
    let alphabet = CHALLENGE_INVITE_CODE_ALPHABET.as_bytes();
    let mut n = CODE_SEQ.fetch_add(1, Ordering::Relaxed) + 1;
    let mut code = *b"SEEDAAAA";
    for slot in code[4..].iter_mut().rev() {
        *slot = alphabet[(n % 32) as usize];
        n /= 32;
    }
    String::from_utf8(code.to_vec()).unwrap()
}

/// A "Study 2h+" challenge inserted directly (any dates allowed), without participants.
#[derive(Debug, Clone)]
pub struct Seed {
    creator: i64,
    start: NaiveDate,
    days: i64,
    title: String,
    activity: String,
    goal: String,
    target: f64,
    locked_through: Option<NaiveDate>,
    finalized_at: Option<DateTime<Utc>>,
}

pub fn seed(creator: &TestUser, start: NaiveDate, days: i64) -> Seed {
    Seed {
        creator: creator.id,
        start,
        days,
        title: "Study 2h+".into(),
        activity: "study".into(),
        goal: "at_least".into(),
        target: 2.0,
        locked_through: None,
        finalized_at: None,
    }
}

impl Seed {
    pub fn locked(mut self, through: NaiveDate) -> Self {
        self.locked_through = Some(through);
        self
    }

    pub fn finalized(mut self, at: DateTime<Utc>) -> Self {
        self.finalized_at = Some(at);
        self
    }

    pub fn goal(mut self, title: &str, activity: &str, goal: &str, target: f64) -> Self {
        (self.title, self.activity, self.goal, self.target) = (title.into(), activity.into(), goal.into(), target);
        self
    }

    pub async fn insert(self, pool: &PgPool) -> Challenge {
        let sql = format!(
            "INSERT INTO challenges (creator_id, title, activity, goal_type, target_hours, start_date, end_date, \
             invite_code, locked_through, finalized_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) \
             RETURNING {}",
            Challenge::COLUMNS
        );
        sqlx::query_as(&sql)
            .bind(self.creator)
            .bind(&self.title)
            .bind(&self.activity)
            .bind(&self.goal)
            .bind(self.target)
            .bind(self.start)
            .bind(self.start + Duration::days(self.days - 1))
            .bind(next_code())
            .bind(self.locked_through)
            .bind(self.finalized_at)
            .fetch_one(pool)
            .await
            .expect("insert challenge")
    }
}

static JOIN_SEQ: AtomicI64 = AtomicI64::new(0);

/// Adds a participant directly; participants added later joined later.
pub async fn join(pool: &PgPool, challenge: &Challenge, user: &TestUser, joined_on: NaiveDate) {
    let seconds = JOIN_SEQ.fetch_add(1, Ordering::Relaxed) + 1;
    let joined_at = joined_on.and_hms_opt(0, 0, 0).unwrap().and_utc() + Duration::seconds(seconds);
    sqlx::query(
        "INSERT INTO challenge_participants (challenge_id, user_id, joined_at, joined_on) VALUES ($1, $2, $3, $4)",
    )
    .bind(challenge.id)
    .bind(user.id)
    .bind(joined_at)
    .bind(joined_on)
    .execute(pool)
    .await
    .expect("insert participant");
}

/// Stores a locked day.
pub async fn snapshot(pool: &PgPool, challenge: &Challenge, user: &TestUser, date: NaiveDate, hours: f64, met: bool) {
    sqlx::query(
        "INSERT INTO challenge_days (challenge_id, user_id, day_date, hours, logged, met, locked_at) \
         VALUES ($1, $2, $3, $4, $5, $6, now())",
    )
    .bind(challenge.id)
    .bind(user.id)
    .bind(date)
    .bind(hours)
    .bind(hours > 0.0)
    .bind(met)
    .execute(pool)
    .await
    .expect("insert day");
}

/// Records an activity.
pub async fn log_activity(pool: &PgPool, user: &TestUser, name: &str, hours: f32, date: NaiveDate) {
    sqlx::query("INSERT INTO activities (user_id, name, duration_hours, activity_date) VALUES ($1, $2, $3, $4)")
        .bind(user.id)
        .bind(name)
        .bind(hours)
        .bind(date)
        .execute(pool)
        .await
        .expect("insert activity");
}

/// Final results of one participant (Go `chEnv.finalize`).
#[derive(Debug, Clone, Copy)]
pub struct FinalStanding {
    pub rank: i64,
    pub days_met: i64,
    pub hours: f64,
    pub completed: bool,
}

/// Stores final results for one participant and marks the challenge finalized at `at`.
pub async fn finalize(
    pool: &PgPool,
    challenge: &Challenge,
    user: &TestUser,
    standing: FinalStanding,
    at: DateTime<Utc>,
) {
    sqlx::query(
        "UPDATE challenge_participants SET final_rank = $1, final_days_met = $2, final_total_hours = $3, completed = $4 \
         WHERE challenge_id = $5 AND user_id = $6",
    )
    .bind(standing.rank)
    .bind(standing.days_met)
    .bind(standing.hours)
    .bind(standing.completed)
    .bind(challenge.id)
    .bind(user.id)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query("UPDATE challenges SET locked_through = end_date, finalized_at = $1 WHERE id = $2")
        .bind(at)
        .bind(challenge.id)
        .execute(pool)
        .await
        .unwrap();
}

/// A follow edge in both edge tables.
pub async fn follow(pool: &PgPool, follower: &TestUser, followee: &TestUser, state: &str) {
    for sql in [
        "INSERT INTO follow_edges_by_follower (follower_id, followee_id, state, created_at) VALUES ($1, $2, $3, now())",
        "INSERT INTO follow_edges_by_followee (follower_id, followee_id, state, created_at) VALUES ($1, $2, $3, now())",
    ] {
        sqlx::query(sql).bind(follower.id).bind(followee.id).bind(state).execute(pool).await.expect("insert follow");
    }
}

pub async fn invite(pool: &PgPool, challenge: &Challenge, inviter: &TestUser, invitee: &TestUser, at: DateTime<Utc>) {
    sqlx::query(
        "INSERT INTO challenge_invites (challenge_id, inviter_id, invitee_id, created_at) VALUES ($1, $2, $3, $4)",
    )
    .bind(challenge.id)
    .bind(inviter.id)
    .bind(invitee.id)
    .bind(at)
    .execute(pool)
    .await
    .expect("insert invite");
}

/// `SELECT count(*) FROM <table> WHERE <condition>` with integer binds.
pub async fn count(pool: &PgPool, table: &str, condition: &str, binds: &[i64]) -> i64 {
    let sql = format!("SELECT count(*) FROM {table} WHERE {condition}");
    binds.iter().fold(sqlx::query_scalar(&sql), |q, b| q.bind(*b)).fetch_one(pool).await.expect("count")
}

pub async fn load_challenge(pool: &PgPool, id: i64) -> Challenge {
    let sql = format!("SELECT {} FROM challenges WHERE id = $1", Challenge::COLUMNS);
    sqlx::query_as(&sql).bind(id).fetch_one(pool).await.expect("load challenge")
}

/// A stored notification.
#[derive(Debug, Clone, PartialEq)]
pub struct StoredNotification {
    pub title: String,
    pub body: String,
    pub metadata: Value,
}

/// A user's notifications of one type, oldest first.
pub async fn notifications(pool: &PgPool, user_id: i64, notif_type: &str) -> Vec<StoredNotification> {
    let rows: Vec<(String, Option<String>, Option<Value>)> =
        sqlx::query_as("SELECT title, body, metadata FROM notifications WHERE user_id = $1 AND type = $2 ORDER BY id")
            .bind(user_id)
            .bind(notif_type)
            .fetch_all(pool)
            .await
            .expect("notifications");
    rows.into_iter()
        .map(|(title, body, metadata)| StoredNotification {
            title,
            body: body.unwrap_or_default(),
            metadata: metadata.unwrap_or(Value::Null),
        })
        .collect()
}

/// The locked dates of a participant.
pub async fn challenge_day_dates(pool: &PgPool, challenge_id: i64, user_id: i64) -> Vec<String> {
    let days: Vec<NaiveDate> = sqlx::query_scalar(
        "SELECT day_date FROM challenge_days WHERE challenge_id = $1 AND user_id = $2 ORDER BY day_date",
    )
    .bind(challenge_id)
    .bind(user_id)
    .fetch_all(pool)
    .await
    .unwrap();
    days.into_iter().map(ymd).collect()
}

pub async fn cron_job_logs(pool: &PgPool, job_name: &str) -> Vec<CronJobLog> {
    let sql = format!("SELECT {} FROM cron_job_logs WHERE job_name = $1 ORDER BY id", CronJobLog::COLUMNS);
    sqlx::query_as(&sql).bind(job_name).fetch_all(pool).await.unwrap()
}

/// A valid "Study 2h+" create request.
pub fn study_request(start: NaiveDate, days: i64) -> CreateChallengeRequest {
    CreateChallengeRequest {
        title: "Study 2h+".into(),
        activity: "study".into(),
        goal_type: "at_least".into(),
        target_hours: Some(2.0),
        duration_days: Some(days),
        start_date: ymd(start),
    }
}

/// The participant entry of `user_id` in a detail.
pub fn participant_of(detail: &ChallengeDetail, user_id: i64) -> ChallengeParticipant {
    detail
        .participants
        .iter()
        .find(|p| p.user.id == user_id)
        .cloned()
        .unwrap_or_else(|| panic!("user {user_id} is not a participant"))
}

// ==================== Test environment ====================

/// A service on the test database with a manual clock (Go `chEnv`).
pub struct Ch<'a> {
    pub db: &'a TestDb,
    pub pool: PgPool,
    pub clock: ManualClock,
    pub svc: ChallengeService,
}

impl<'a> Ch<'a> {
    pub fn new(db: &'a TestDb, today: NaiveDate) -> Self {
        let clock = ManualClock::at_day(today);
        let svc = service(&db.pool, Some(&db.pool), Some(&db.pool), &clock);
        Ch { db, pool: db.pool.clone(), clock, svc }
    }

    /// A service on the given pools with this clock; `None` leaves that dependency out.
    pub fn service(
        &self,
        challenges: &PgPool,
        job_logs: Option<&PgPool>,
        notifications: Option<&PgPool>,
    ) -> ChallengeService {
        service(challenges, job_logs, notifications, &self.clock)
    }

    /// A service whose challenge statements matching `fault` fail.
    pub async fn failing(&self, fault: Fault) -> ChallengeService {
        let faulty = self.db.faulty_pool(fault).await;
        self.service(&faulty, Some(&self.pool), Some(&self.pool))
    }
}

/// Runs each case on emptied tables.
#[allow(unused_macros)]
macro_rules! cases {
    ($db:expr, $label:literal, $($case:ident),+ $(,)?) => {
        $(
            $db.reset().await;
            eprintln!("{}: {}", $label, stringify!($case));
            $case(&$db).await;
        )+
    };
}

/// Asserts that a result is the given error.
#[allow(unused_macros)]
macro_rules! assert_err {
    ($result:expr, $pattern:pat $(,)?) => {{
        let result = $result;
        assert!(matches!(result, Err($pattern)), "expected {}, got {:?}", stringify!($pattern), result.map(|_| "Ok"));
    }};
    ($result:expr, $pattern:pat, $($msg:tt)+) => {{
        let result = $result;
        assert!(
            matches!(result, Err($pattern)),
            "{}: expected {}, got {:?}",
            format!($($msg)+),
            stringify!($pattern),
            result.map(|_| "Ok")
        );
    }};
}

/// The code and message of a validation error.
pub fn validation<T: Debug>(result: Result<T, ChallengeError>) -> (&'static str, String) {
    match result {
        Err(ChallengeError::Validation(v)) => (v.code, v.message),
        other => panic!("expected a validation error, got {:?}", other.map(|_| "Ok")),
    }
}

// ==================== Logs ====================

/// One captured log event of the backend crates.
#[derive(Debug, Clone)]
pub struct LogEvent {
    pub level: Level,
    pub message: String,
    pub fields: BTreeMap<String, String>,
}

/// Collects the log events of the current thread while its guard lives.
#[derive(Clone, Default)]
pub struct LogCapture(Arc<Mutex<Vec<LogEvent>>>);

impl LogCapture {
    /// Starts capturing on this thread (the test's own future runs here).
    pub fn start() -> (LogCapture, tracing::subscriber::DefaultGuard) {
        let capture = LogCapture::default();
        let subscriber = tracing_subscriber::registry().with(CaptureLayer(capture.clone()));
        (capture, tracing::subscriber::set_default(subscriber))
    }

    pub fn with_message(&self, message: &str) -> Vec<LogEvent> {
        self.0.lock().unwrap().iter().filter(|e| e.message == message).cloned().collect()
    }

    pub fn count(&self, message: &str) -> usize {
        self.with_message(message).len()
    }
}

struct CaptureLayer(LogCapture);

impl<S: Subscriber> Layer<S> for CaptureLayer {
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        if !event.metadata().target().starts_with("gt_") {
            return;
        }
        let mut visitor = FieldVisitor::default();
        event.record(&mut visitor);
        (self.0).0.lock().unwrap().push(LogEvent {
            level: *event.metadata().level(),
            message: visitor.message,
            fields: visitor.fields,
        });
    }
}

#[derive(Default)]
struct FieldVisitor {
    message: String,
    fields: BTreeMap<String, String>,
}

impl Visit for FieldVisitor {
    fn record_str(&mut self, field: &Field, value: &str) {
        self.record(field, value.to_string());
    }

    fn record_debug(&mut self, field: &Field, value: &dyn Debug) {
        self.record(field, format!("{value:?}"));
    }
}

impl FieldVisitor {
    fn record(&mut self, field: &Field, value: String) {
        if field.name() == "message" {
            self.message = value;
        } else {
            self.fields.insert(field.name().to_string(), value);
        }
    }
}
