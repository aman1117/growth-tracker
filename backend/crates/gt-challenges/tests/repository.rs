//! Database tests of `ChallengeRepository` (port of `repository/challenge_repository_test.go`).
//!
//! They run only when `TEST_DATABASE_URL` points at a PostgreSQL server whose role may create
//! databases. One test creates its own database, runs every case in sequence on a clean set
//! of tables and drops the database at the end.

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::Duration as StdDuration;

use chrono::{DateTime, Duration, NaiveDate, TimeZone, Utc};
use gt_challenges::repository::{
    ChallengeFinalResult, ChallengeLockedTotal, ChallengeRepoError, ChallengeRepository, InviteCandidateRow,
    NewChallenge, NewChallengeCheer, NewChallengeDay, NewChallengeParticipant,
};
use gt_core::constants::CHALLENGE_INVITE_CODE_ALPHABET;
use gt_core::models::{
    Challenge, ChallengeInvite, ChallengeParticipant, FOLLOW_STATE_ACTIVE, FOLLOW_STATE_PENDING, FOLLOW_STATE_REMOVED,
    NOTIF_ENTITY_CHALLENGE, NOTIF_ENTITY_CHALLENGE_DAY, NOTIF_TYPE_CHALLENGE_CHEER, NOTIF_TYPE_CHALLENGE_JOINED,
};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::{Connection, PgConnection, PgPool};

const DB_NAME: &str = "gt_challenges_repository_test";

// ==================== Database ====================

fn database_url(admin_url: &str, name: &str) -> String {
    let mut url = url::Url::parse(admin_url).expect("valid TEST_DATABASE_URL");
    url.set_path(&format!("/{name}"));
    url.to_string()
}

async fn recreate_database(admin_url: &str, name: &str) {
    let mut admin = PgConnection::connect(admin_url).await.expect("connect admin");
    sqlx::query(&format!("DROP DATABASE IF EXISTS {name} WITH (FORCE)")).execute(&mut admin).await.unwrap();
    sqlx::query(&format!("CREATE DATABASE {name}")).execute(&mut admin).await.unwrap();
}

async fn drop_database(admin_url: &str, name: &str) {
    let mut admin = PgConnection::connect(admin_url).await.expect("connect admin");
    let _ = sqlx::query(&format!("DROP DATABASE IF EXISTS {name} WITH (FORCE)")).execute(&mut admin).await;
}

async fn pool_with(url: &str, options: &[(&str, &str)]) -> PgPool {
    let connect = url.parse::<PgConnectOptions>().expect("valid URL").options(options.iter().copied());
    PgPoolOptions::new().max_connections(16).connect_with(connect).await.expect("connect test db")
}

struct Env {
    pool: PgPool,
    repo: ChallengeRepository,
    /// Every statement fails: its tables are not on the search path.
    broken: ChallengeRepository,
    url: String,
}

impl Env {
    async fn reset(&self) {
        sqlx::query(
            "TRUNCATE users, activities, challenges, challenge_participants, challenge_days, challenge_cheers, \
             challenge_invites, follow_edges_by_follower, follow_edges_by_followee, notification_dedupes \
             RESTART IDENTITY CASCADE",
        )
        .execute(&self.pool)
        .await
        .expect("truncate");
    }
}

macro_rules! cases {
    ($env:expr, $($case:ident),+ $(,)?) => {
        $(
            $env.reset().await;
            eprintln!("challenge repository: {}", stringify!($case));
            $case(&$env).await;
        )+
    };
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn challenge_repository() {
    let Ok(admin_url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL not set; skipping");
        return;
    };
    recreate_database(&admin_url, DB_NAME).await;
    let url = database_url(&admin_url, DB_NAME);
    let pool = pool_with(&url, &[]).await;
    gt_core::db::migrate(&pool).await.expect("migrate");
    let broken = ChallengeRepository::new(pool_with(&url, &[("search_path", "gt_missing_schema")]).await);
    let env = Env { repo: ChallengeRepository::new(pool.clone()), pool, broken, url };

    cases!(
        env,
        create_and_find,
        with_transaction,
        with_locked_challenge,
        with_locked_challenge_serialises_joins,
        lock_user,
        delete_cascades,
        list_for_user,
        count_open_for_user,
        job_selection,
        set_locked_through_and_mark_finalized,
        participants,
        remove_participant,
        save_final_results,
        activity_days,
        insert_and_list_days,
        locked_totals,
        cheers,
        create_invites,
        delete_stale_invites,
        invite_candidates,
    );

    env.broken.pool().close().await;
    env.pool.close().await;
    drop_database(&admin_url, DB_NAME).await;
}

// ==================== Fixtures ====================

/// A fixed reference time for rows whose ordering matters.
fn t0() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 3, 1, 12, 0, 0).unwrap()
}

/// The date most fixtures are recorded on.
fn day() -> NaiveDate {
    NaiveDate::from_ymd_opt(2026, 3, 9).unwrap()
}

fn plus(d: NaiveDate, days: i64) -> NaiveDate {
    d + Duration::days(days)
}

fn ymd(d: NaiveDate) -> String {
    d.format("%Y-%m-%d").to_string()
}

#[derive(Debug, Clone)]
struct TestUser {
    id: i64,
    profile_pic: Option<String>,
    profile_pic_thumb: Option<String>,
}

static USER_SEQ: AtomicI64 = AtomicI64::new(0);

async fn insert_user(pool: &PgPool, username: &str, avatar: bool, verified: bool) -> TestUser {
    let n = USER_SEQ.fetch_add(1, Ordering::Relaxed) + 1;
    let (pic, thumb) = if avatar {
        (
            Some(format!("https://blob.example.com/avatars/{username}.jpg")),
            Some(format!("https://blob.example.com/avatars/{username}_thumb.jpg")),
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
    .bind(verified)
    .fetch_one(pool)
    .await
    .expect("insert user");
    TestUser { id, profile_pic: pic, profile_pic_thumb: thumb }
}

/// A user with a unique generated username.
async fn user(pool: &PgPool) -> TestUser {
    let n = USER_SEQ.load(Ordering::Relaxed) + 1;
    insert_user(pool, &format!("user{n}"), false, false).await
}

async fn named(pool: &PgPool, username: &str) -> TestUser {
    insert_user(pool, username, false, false).await
}

static CODE_SEQ: AtomicI64 = AtomicI64::new(0);

/// A unique, well-formed invite code.
fn next_code() -> String {
    let alphabet = CHALLENGE_INVITE_CODE_ALPHABET.as_bytes();
    let mut n = CODE_SEQ.fetch_add(1, Ordering::Relaxed) + 1;
    let mut code = *b"TESTAAAA";
    for slot in code[4..].iter_mut().rev() {
        *slot = alphabet[(n % 32) as usize];
        n /= 32;
    }
    String::from_utf8(code.to_vec()).unwrap()
}

/// A "study 2h+" challenge of `days` days from `start`.
#[derive(Debug, Clone)]
struct Seed {
    creator: i64,
    start: NaiveDate,
    days: i64,
    activity: &'static str,
    goal: &'static str,
    target: f64,
    locked_through: Option<NaiveDate>,
    finalized_at: Option<DateTime<Utc>>,
}

fn seed(creator: &TestUser, start: NaiveDate, days: i64) -> Seed {
    Seed {
        creator: creator.id,
        start,
        days,
        activity: "study",
        goal: "at_least",
        target: 2.0,
        locked_through: None,
        finalized_at: None,
    }
}

impl Seed {
    fn locked(mut self, through: NaiveDate) -> Self {
        self.locked_through = Some(through);
        self
    }

    fn finalized(mut self, at: DateTime<Utc>) -> Self {
        self.finalized_at = Some(at);
        self
    }

    fn goal(mut self, activity: &'static str, goal: &'static str, target: f64) -> Self {
        (self.activity, self.goal, self.target) = (activity, goal, target);
        self
    }

    async fn insert(self, pool: &PgPool) -> Challenge {
        let sql = format!(
            "INSERT INTO challenges (creator_id, title, activity, goal_type, target_hours, start_date, end_date, \
             invite_code, locked_through, finalized_at) VALUES ($1, 'Study 2h+', $2, $3, $4, $5, $6, $7, $8, $9) \
             RETURNING {}",
            Challenge::COLUMNS
        );
        sqlx::query_as(&sql)
            .bind(self.creator)
            .bind(self.activity)
            .bind(self.goal)
            .bind(self.target)
            .bind(self.start)
            .bind(plus(self.start, self.days - 1))
            .bind(next_code())
            .bind(self.locked_through)
            .bind(self.finalized_at)
            .fetch_one(pool)
            .await
            .expect("insert challenge")
    }
}

static JOIN_SEQ: AtomicI64 = AtomicI64::new(0);

/// Adds the user to the challenge; participants added later joined later.
async fn join(pool: &PgPool, challenge: &Challenge, user: &TestUser, joined_on: NaiveDate) -> ChallengeParticipant {
    let seconds = JOIN_SEQ.fetch_add(1, Ordering::Relaxed) + 1;
    let joined_at = joined_on.and_hms_opt(0, 0, 0).unwrap().and_utc() + Duration::seconds(seconds);
    let sql = format!(
        "INSERT INTO challenge_participants (challenge_id, user_id, joined_at, joined_on) VALUES ($1, $2, $3, $4) \
         RETURNING {}",
        ChallengeParticipant::COLUMNS
    );
    sqlx::query_as(&sql)
        .bind(challenge.id)
        .bind(user.id)
        .bind(joined_at)
        .bind(joined_on)
        .fetch_one(pool)
        .await
        .expect("insert participant")
}

/// Stores a locked day.
async fn locked_day(pool: &PgPool, challenge: &Challenge, user: &TestUser, date: NaiveDate, hours: f64, met: bool) {
    sqlx::query(
        "INSERT INTO challenge_days (challenge_id, user_id, day_date, hours, logged, met, locked_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(challenge.id)
    .bind(user.id)
    .bind(date)
    .bind(hours)
    .bind(hours > 0.0)
    .bind(met)
    .bind(t0())
    .execute(pool)
    .await
    .expect("insert day");
}

async fn invite(
    pool: &PgPool,
    challenge: &Challenge,
    inviter: &TestUser,
    invitee: &TestUser,
    at: DateTime<Utc>,
) -> i64 {
    sqlx::query_scalar(
        "INSERT INTO challenge_invites (challenge_id, inviter_id, invitee_id, created_at) VALUES ($1, $2, $3, $4) \
         RETURNING id",
    )
    .bind(challenge.id)
    .bind(inviter.id)
    .bind(invitee.id)
    .bind(at)
    .fetch_one(pool)
    .await
    .expect("insert invite")
}

/// A follow edge in both edge tables.
async fn follow(pool: &PgPool, follower: &TestUser, followee: &TestUser, state: &str) {
    for sql in [
        "INSERT INTO follow_edges_by_follower (follower_id, followee_id, state, created_at) VALUES ($1, $2, $3, $4)",
        "INSERT INTO follow_edges_by_followee (follower_id, followee_id, state, created_at) VALUES ($1, $2, $3, $4)",
    ] {
        sqlx::query(sql)
            .bind(follower.id)
            .bind(followee.id)
            .bind(state)
            .bind(t0())
            .execute(pool)
            .await
            .expect("insert follow");
    }
}

async fn activity(pool: &PgPool, user: &TestUser, name: &str, hours: f32, date: NaiveDate) {
    sqlx::query("INSERT INTO activities (user_id, name, duration_hours, activity_date) VALUES ($1, $2, $3, $4)")
        .bind(user.id)
        .bind(name)
        .bind(hours)
        .bind(date)
        .execute(pool)
        .await
        .expect("insert activity");
}

/// `SELECT count(*) FROM <table> WHERE <condition>` with integer binds.
async fn count(pool: &PgPool, table: &str, condition: &str, binds: &[i64]) -> i64 {
    let sql = format!("SELECT count(*) FROM {table} WHERE {condition}");
    binds.iter().fold(sqlx::query_scalar(&sql), |q, b| q.bind(*b)).fetch_one(pool).await.expect("count")
}

async fn load_challenge(pool: &PgPool, id: i64) -> Challenge {
    let sql = format!("SELECT {} FROM challenges WHERE id = $1", Challenge::COLUMNS);
    sqlx::query_as(&sql).bind(id).fetch_one(pool).await.expect("load challenge")
}

fn candidate_names(rows: &[InviteCandidateRow]) -> Vec<&str> {
    rows.iter().map(|r| r.username.as_str()).collect()
}

fn invitee_ids(invites: &[ChallengeInvite]) -> Vec<i64> {
    invites.iter().map(|i| i.invitee_id).collect()
}

fn new_challenge(creator: &TestUser, code: &str) -> NewChallenge {
    NewChallenge {
        creator_id: creator.id,
        title: "t".into(),
        activity: "study".into(),
        goal_type: "at_least".into(),
        target_hours: 1.0,
        start_date: day(),
        end_date: plus(day(), 2),
        invite_code: code.into(),
    }
}

fn new_participant(
    challenge: &Challenge,
    user: &TestUser,
    joined_at: DateTime<Utc>,
    joined_on: NaiveDate,
) -> NewChallengeParticipant {
    NewChallengeParticipant { challenge_id: challenge.id, user_id: user.id, joined_at, joined_on }
}

// ==================== Challenges ====================

async fn create_and_find(env: &Env) {
    let creator = user(&env.pool).await;
    let mut db = env.repo.conn().await.unwrap();
    let challenge = NewChallenge {
        creator_id: creator.id,
        title: "Read 📚 daily".into(),
        activity: "book_reading".into(),
        goal_type: "at_most".into(),
        target_hours: 1.25,
        start_date: day(),
        end_date: plus(day(), 20),
        invite_code: "K7Q2M9XA".into(),
    };
    let created = db.create_challenge(&challenge).await.unwrap().expect("created");
    assert_ne!(created.id, 0);

    let got = db.find_by_id(created.id).await.unwrap().expect("found");
    assert_eq!(got.creator_id, creator.id);
    assert_eq!(got.title, "Read 📚 daily");
    assert_eq!(got.activity, "book_reading");
    assert_eq!(got.goal_type, "at_most");
    assert_eq!(got.target_hours, 1.25);
    assert_eq!(ymd(got.start_date), "2026-03-09");
    assert_eq!(ymd(got.end_date), "2026-03-29");
    assert_eq!(got.duration_days(), 21);
    assert_eq!(got.locked_through, None);
    assert_eq!(got.finalized_at, None);
    assert!(got.created_at > t0());
    assert_eq!(got, created);

    let by_code = db.find_by_invite_code("K7Q2M9XA").await.unwrap().expect("found by code");
    assert_eq!(by_code.id, created.id);

    // A taken invite code is reported, not an error.
    let dup = NewChallenge { title: "Other".into(), ..new_challenge(&creator, "K7Q2M9XA") };
    assert_eq!(db.create_challenge(&dup).await.unwrap(), None);
    assert_eq!(count(&env.pool, "challenges", "invite_code = 'K7Q2M9XA'", &[]).await, 1);

    // Missing challenges are None; codes are normalised by the caller.
    assert_eq!(db.find_by_id(created.id + 100).await.unwrap(), None);
    assert_eq!(db.find_by_invite_code("ZZZZZZZZ").await.unwrap(), None);
    assert_eq!(db.find_by_invite_code("k7q2m9xa").await.unwrap(), None);

    // Unknown creator.
    let orphan = NewChallenge { creator_id: 9999, ..new_challenge(&creator, "ABCDEFGH") };
    assert!(db.create_challenge(&orphan).await.is_err());

    let mut broken = env.broken.conn().await.unwrap();
    assert!(broken.find_by_id(created.id).await.is_err());
    assert!(broken.find_by_invite_code("K7Q2M9XA").await.is_err());
}

async fn with_transaction(env: &Env) {
    let creator = user(&env.pool).await;

    let mut tx = env.repo.begin().await.unwrap();
    tx.create_challenge(&new_challenge(&creator, "COMMITTD")).await.unwrap().expect("created");
    tx.commit().await.unwrap();
    assert_eq!(count(&env.pool, "challenges", "invite_code = 'COMMITTD'", &[]).await, 1);

    let mut tx = env.repo.begin().await.unwrap();
    tx.create_challenge(&new_challenge(&creator, "R0LLBACK")).await.unwrap().expect("created");
    drop(tx);
    assert_eq!(count(&env.pool, "challenges", "invite_code = 'R0LLBACK'", &[]).await, 0, "rolled back");

    let mut tx = env.repo.begin().await.unwrap();
    tx.create_challenge(&new_challenge(&creator, "R0LLBAK2")).await.unwrap().expect("created");
    tx.rollback().await.unwrap();
    assert_eq!(count(&env.pool, "challenges", "invite_code = 'R0LLBAK2'", &[]).await, 0, "rolled back");
}

async fn with_locked_challenge(env: &Env) {
    let creator = user(&env.pool).await;
    let c = seed(&creator, day(), 5).insert(&env.pool).await;

    let (mut tx, locked) = env.repo.lock_challenge(c.id).await.unwrap();
    assert_eq!(locked, c);
    tx.add_participant(&new_participant(&locked, &creator, t0(), day())).await.unwrap();
    tx.commit().await.unwrap();
    assert_eq!(count(&env.pool, "challenge_participants", "challenge_id = $1", &[c.id]).await, 1);

    assert!(matches!(env.repo.lock_challenge(c.id + 100).await, Err(ChallengeRepoError::ChallengeNotFound)));

    let (mut tx, locked) = env.repo.lock_challenge(c.id).await.unwrap();
    tx.delete(locked.id).await.unwrap();
    drop(tx);
    assert_eq!(count(&env.pool, "challenges", "id = $1", &[c.id]).await, 1, "rolled back");

    assert!(matches!(env.broken.lock_challenge(c.id).await, Err(ChallengeRepoError::Db(_))));
}

/// The row lock serialises concurrent joins, so a participant cap checked inside it can never
/// be exceeded.
async fn with_locked_challenge_serialises_joins(env: &Env) {
    const CAPACITY: i64 = 5;
    const JOINERS: usize = 12;
    let creator = user(&env.pool).await;
    let c = seed(&creator, day(), 5).insert(&env.pool).await;
    let mut users = Vec::new();
    for _ in 0..JOINERS {
        users.push(user(&env.pool).await);
    }

    let start = Arc::new(tokio::sync::Barrier::new(JOINERS));
    let tasks: Vec<_> = users
        .into_iter()
        .map(|u| {
            let (repo, start, challenge_id) = (env.repo.clone(), start.clone(), c.id);
            tokio::spawn(async move {
                start.wait().await;
                let (mut tx, locked) = repo.lock_challenge(challenge_id).await?;
                if tx.count_participants(locked.id).await? >= CAPACITY {
                    return Ok(false);
                }
                // Widen the race window a check without a lock would lose.
                tokio::time::sleep(StdDuration::from_millis(2)).await;
                tx.add_participant(&new_participant(&locked, &u, t0(), day())).await?;
                tx.commit().await?;
                Ok::<_, ChallengeRepoError>(true)
            })
        })
        .collect();

    let (mut joined, mut full) = (0, 0);
    for task in tasks {
        match task.await.unwrap() {
            Ok(true) => joined += 1,
            Ok(false) => full += 1,
            Err(err) => panic!("unexpected error: {err}"),
        }
    }
    assert_eq!(joined, CAPACITY);
    assert_eq!(full, JOINERS as i64 - CAPACITY);
    assert_eq!(count(&env.pool, "challenge_participants", "challenge_id = $1", &[c.id]).await, CAPACITY);
}

async fn lock_user(env: &Env) {
    let u = user(&env.pool).await;
    let mut db = env.repo.conn().await.unwrap();
    assert!(matches!(db.lock_user(u.id + 100).await, Err(ChallengeRepoError::UserNotFound)));
    assert!(matches!(env.broken.conn().await.unwrap().lock_user(u.id).await, Err(ChallengeRepoError::Db(_))));

    let impatient = pool_with(&env.url, &[("lock_timeout", "200ms")]).await;
    let mut tx = env.repo.begin().await.unwrap();
    tx.lock_user(u.id).await.unwrap();

    // A second lock on the same user waits for the first transaction...
    let mut other = ChallengeRepository::new(impatient.clone()).begin().await.unwrap();
    let err = other.lock_user(u.id).await.expect_err("waits for the lock");
    assert!(err.to_string().contains("lock timeout"), "{err}");
    drop(other);

    // ...while rows referencing the user can still be written (foreign key checks only take KEY
    // SHARE locks).
    sqlx::query("INSERT INTO activities (user_id, name, duration_hours, activity_date) VALUES ($1, 'study', 1, $2)")
        .bind(u.id)
        .bind(day())
        .execute(&impatient)
        .await
        .expect("insert referencing the locked user");
    tx.commit().await.unwrap();
    impatient.close().await;
}

async fn delete_cascades(env: &Env) {
    let pool = &env.pool;
    let (alice, bob) = (user(pool).await, user(pool).await);
    let doomed = seed(&alice, day(), 5).insert(pool).await;
    let kept = seed(&alice, day(), 5).insert(pool).await;
    let mut db = env.repo.conn().await.unwrap();
    for c in [&doomed, &kept] {
        join(pool, c, &alice, day()).await;
        join(pool, c, &bob, day()).await;
        locked_day(pool, c, &bob, day(), 2.0, true).await;
        let cheer = NewChallengeCheer {
            challenge_id: c.id,
            from_user_id: alice.id,
            to_user_id: bob.id,
            cheer_date: day(),
            created_at: t0(),
        };
        assert!(db.create_cheer(&cheer).await.unwrap());
        invite(pool, c, &alice, &bob, t0()).await;
    }

    db.delete(doomed.id).await.unwrap();

    for table in ["challenge_participants", "challenge_days", "challenge_cheers", "challenge_invites"] {
        assert_eq!(count(pool, table, "challenge_id = $1", &[doomed.id]).await, 0, "{table} of the deleted challenge");
        assert_ne!(count(pool, table, "challenge_id = $1", &[kept.id]).await, 0, "{table} of the other challenge");
    }
    assert_eq!(db.find_by_id(doomed.id).await.unwrap(), None);
    db.delete(doomed.id).await.expect("deleting twice is a no-op");

    // Deleting a user removes their challenges and participations.
    sqlx::query("DELETE FROM users WHERE id = $1").bind(bob.id).execute(pool).await.unwrap();
    assert_eq!(count(pool, "challenge_participants", "user_id = $1", &[bob.id]).await, 0);
    assert_eq!(count(pool, "challenge_days", "user_id = $1", &[bob.id]).await, 0);
    assert_eq!(count(pool, "challenge_cheers", "to_user_id = $1", &[bob.id]).await, 0);
    assert_eq!(count(pool, "challenge_invites", "invitee_id = $1", &[bob.id]).await, 0);
    sqlx::query("DELETE FROM users WHERE id = $1").bind(alice.id).execute(pool).await.unwrap();
    assert_eq!(count(pool, "challenges", "creator_id = $1", &[alice.id]).await, 0);
}

async fn list_for_user(env: &Env) {
    let pool = &env.pool;
    let (me, other) = (user(pool).await, user(pool).await);
    let today = day();

    let active = seed(&other, plus(today, -3), 7).insert(pool).await;
    let upcoming = seed(&me, plus(today, 5), 3).insert(pool).await;
    let ends_today = seed(&me, plus(today, -2), 3).insert(pool).await;
    join(pool, &active, &other, active.start_date).await;
    let active_p = join(pool, &active, &me, plus(today, -1)).await;
    join(pool, &upcoming, &me, today).await;
    join(pool, &ends_today, &me, ends_today.start_date).await;

    // 22 ended challenges; the 20th and 22nd end on the same date.
    let mut ended = Vec::new();
    for i in 0..22 {
        let end = if i == 21 { plus(today, -20) } else { plus(today, -1 - i) };
        let c = seed(&me, plus(end, -2), 3).insert(pool).await;
        join(pool, &c, &me, c.start_date).await;
        ended.push(c);
    }
    let mut db = env.repo.conn().await.unwrap();
    let first_p = db.find_participant(ended[0].id, me.id).await.unwrap().expect("participant");
    let result =
        ChallengeFinalResult { participant_id: first_p.id, rank: 1, days_met: 3, total_hours: 7.5, completed: true };
    db.save_final_results(&[result]).await.unwrap();

    // Challenges I do not take part in are never listed.
    let not_mine = seed(&other, today, 3).insert(pool).await;
    join(pool, &not_mine, &other, today).await;

    let rows = db.list_for_user(me.id, today, 20).await.unwrap();
    assert_eq!(rows.len(), 23);
    let row = |id: i64| rows.iter().find(|r| r.challenge.id == id);
    for c in [&active, &upcoming, &ends_today] {
        assert!(row(c.id).is_some(), "open challenge {}", c.id);
    }
    assert!(row(not_mine.id).is_none());

    // The ended part holds the 20 most recent ones: by end date, and the newest of the two that
    // end on the same date (ended[19] and ended[21]) wins the last place.
    let mut ended_ids: Vec<i64> =
        rows.iter().filter(|r| r.challenge.end_date < today).map(|r| r.challenge.id).collect();
    let mut want: Vec<i64> = ended[..19].iter().map(|c| c.id).collect();
    want.push(ended[21].id);
    ended_ids.sort_unstable();
    want.sort_unstable();
    assert_eq!(ended_ids, want);

    let a = row(active.id).unwrap();
    assert_eq!(a.participant_count, 2);
    assert_eq!(a.joined_on, active_p.joined_on);
    assert_eq!(a.challenge.title, "Study 2h+");
    assert_eq!(a.challenge.creator_id, other.id);
    assert_eq!(a.challenge, active);
    assert_eq!((a.final_rank, a.completed), (None, None));

    let first = row(ended[0].id).unwrap();
    assert_eq!(first.participant_count, 1);
    assert_eq!(first.final_rank, Some(1));
    assert_eq!(first.final_days_met, Some(3));
    assert_eq!(first.final_total_hours, Some(7.5));
    assert_eq!(first.completed, Some(true));

    assert!(db.list_for_user(other.id + 100, today, 20).await.unwrap().is_empty(), "no challenges");
    assert!(env.broken.conn().await.unwrap().list_for_user(me.id, today, 20).await.is_err());
}

async fn count_open_for_user(env: &Env) {
    let pool = &env.pool;
    let (me, other) = (user(pool).await, user(pool).await);
    let today = day();
    for start in [plus(today, -2), plus(today, 3), plus(today, -4)] {
        let c = seed(&other, start, 5).insert(pool).await; // the last one ends today
        join(pool, &c, &me, today).await;
    }
    let ended = seed(&me, plus(today, -5), 5).insert(pool).await;
    join(pool, &ended, &me, ended.start_date).await;
    let not_mine = seed(&other, today, 5).insert(pool).await;
    join(pool, &not_mine, &other, today).await;

    let mut db = env.repo.conn().await.unwrap();
    assert_eq!(db.count_open_for_user(me.id, today).await.unwrap(), 3);
    assert_eq!(
        db.count_open_for_user(me.id, plus(today, 1)).await.unwrap(),
        2,
        "the challenge ending today is no longer open tomorrow"
    );
    assert!(env.broken.conn().await.unwrap().count_open_for_user(me.id, today).await.is_err());
}

async fn job_selection(env: &Env) {
    let pool = &env.pool;
    let u = user(pool).await;
    let through = day(); // today-2 for the job

    let unlocked = seed(&u, plus(through, -3), 7).insert(pool).await;
    let starts_at_through = seed(&u, through, 7).insert(pool).await;
    let partly_locked = seed(&u, plus(through, -5), 10).locked(plus(through, -1)).insert(pool).await;
    seed(&u, plus(through, -5), 10).locked(through).insert(pool).await; // locked up to through
    seed(&u, plus(through, 1), 7).insert(pool).await; // starts after through
    let ended_partly_locked = seed(&u, plus(through, -9), 5).locked(plus(through, -7)).insert(pool).await;
    let ended_locked = seed(&u, plus(through, -9), 5).locked(plus(through, -5)).insert(pool).await;
    let ended_never_locked = seed(&u, plus(through, -9), 5).insert(pool).await;
    seed(&u, plus(through, -20), 5).locked(plus(through, -16)).finalized(t0()).insert(pool).await;

    let mut db = env.repo.conn().await.unwrap();
    assert_eq!(
        db.challenge_ids_to_lock(through).await.unwrap(),
        [unlocked.id, starts_at_through.id, partly_locked.id, ended_partly_locked.id, ended_never_locked.id]
    );
    assert_eq!(db.challenge_ids_to_finalize().await.unwrap(), [ended_locked.id]);

    let mut broken = env.broken.conn().await.unwrap();
    assert!(broken.challenge_ids_to_lock(through).await.is_err());
    assert!(broken.challenge_ids_to_finalize().await.is_err());
}

async fn set_locked_through_and_mark_finalized(env: &Env) {
    let pool = &env.pool;
    let u = user(pool).await;
    let c = seed(&u, day(), 10).insert(pool).await;
    let mut db = env.repo.conn().await.unwrap();

    db.set_locked_through(c.id, plus(day(), 2), t0()).await.unwrap();
    let got = load_challenge(pool, c.id).await;
    assert_eq!(got.locked_through.map(ymd).as_deref(), Some("2026-03-11"));
    assert_eq!(got.updated_at, t0());

    db.set_locked_through(c.id, day(), t0() + Duration::hours(1)).await.unwrap();
    let got = load_challenge(pool, c.id).await;
    assert_eq!(got.locked_through.map(ymd).as_deref(), Some("2026-03-11"), "never moves backwards");
    assert_eq!(got.updated_at, t0());

    db.set_locked_through(c.id, plus(day(), 9), t0() + Duration::hours(2)).await.unwrap();
    assert_eq!(load_challenge(pool, c.id).await.locked_through.map(ymd).as_deref(), Some("2026-03-18"));

    db.mark_finalized(c.id, t0()).await.unwrap();
    db.mark_finalized(c.id, t0() + Duration::hours(1)).await.unwrap();
    assert_eq!(load_challenge(pool, c.id).await.finalized_at, Some(t0()), "finalized once");

    let mut broken = env.broken.conn().await.unwrap();
    assert!(broken.set_locked_through(c.id, day(), t0()).await.is_err());
    assert!(broken.mark_finalized(c.id, t0()).await.is_err());
    assert!(broken.delete(c.id).await.is_err());
}

// ==================== Participants ====================

async fn participants(env: &Env) {
    let pool = &env.pool;
    let alice = insert_user(pool, "alice", true, true).await;
    let bob = named(pool, "bob").await;
    let carol = named(pool, "carol").await;
    let c1 = seed(&alice, day(), 7).insert(pool).await;
    let c2 = seed(&bob, day(), 7).insert(pool).await;
    let mut db = env.repo.conn().await.unwrap();

    db.add_participant(&new_participant(&c1, &alice, t0() + Duration::hours(2), day())).await.unwrap();
    db.add_participant(&new_participant(&c1, &bob, t0(), plus(day(), -1))).await.unwrap();
    db.add_participant(&new_participant(&c2, &carol, t0(), day())).await.unwrap();
    assert!(db.add_participant(&new_participant(&c1, &bob, t0(), day())).await.is_err(), "a user takes part once");

    let p = db.find_participant(c1.id, bob.id).await.unwrap().expect("participant");
    assert_eq!(ymd(p.joined_on), "2026-03-08");
    assert_eq!(p.joined_at, t0());
    assert_eq!(db.find_participant(c1.id, carol.id).await.unwrap(), None);
    assert_eq!(db.count_participants(c1.id).await.unwrap(), 2);

    let rows = db.list_participants(&[c2.id, c1.id]).await.unwrap();
    let users: Vec<i64> = rows.iter().map(|r| r.user_id).collect();
    assert_eq!(users, [bob.id, alice.id, carol.id], "by challenge, then joining order");
    assert_eq!(rows[0].challenge_id, c1.id);
    let a = &rows[1];
    assert_eq!(a.username, "alice");
    assert_eq!(a.profile_pic, alice.profile_pic);
    assert_eq!(a.profile_pic_thumb, alice.profile_pic_thumb);
    assert!(a.is_verified);
    assert_ne!(a.id, 0);
    assert_eq!(ymd(a.joined_on), "2026-03-09");
    assert_eq!(rows[0].profile_pic, None);
    assert!(!rows[0].is_verified);

    assert!(db.list_participants(&[]).await.unwrap().is_empty());

    let mut broken = env.broken.conn().await.unwrap();
    assert!(broken.find_participant(c1.id, bob.id).await.is_err());
    assert!(broken.count_participants(c1.id).await.is_err());
    assert!(broken.list_participants(&[c1.id]).await.is_err());
}

async fn remove_participant(env: &Env) {
    let pool = &env.pool;
    let (alice, bob, carol) = (user(pool).await, user(pool).await, user(pool).await);
    let c = seed(&alice, day(), 7).insert(pool).await;
    let other = seed(&alice, day(), 7).insert(pool).await;
    for ch in [&c, &other] {
        join(pool, ch, &alice, day()).await;
        join(pool, ch, &bob, day()).await;
        locked_day(pool, ch, &alice, day(), 3.0, true).await;
        locked_day(pool, ch, &bob, day(), 3.0, true).await;
        locked_day(pool, ch, &bob, plus(day(), 1), 0.0, false).await;
        invite(pool, ch, &alice, &bob, t0()).await;
    }
    let mut db = env.repo.conn().await.unwrap();
    for (from, to) in [(&alice, &bob), (&bob, &alice)] {
        let cheer = NewChallengeCheer {
            challenge_id: c.id,
            from_user_id: from.id,
            to_user_id: to.id,
            cheer_date: day(),
            created_at: t0(),
        };
        db.create_cheer(&cheer).await.unwrap();
    }
    invite(pool, &c, &bob, &carol, t0()).await;

    let (cid, bid) = (c.id, bob.id);
    let bob_state = move || async move {
        (
            count(pool, "challenge_participants", "challenge_id = $1 AND user_id = $2", &[cid, bid]).await,
            count(pool, "challenge_days", "challenge_id = $1 AND user_id = $2", &[cid, bid]).await,
            count(pool, "challenge_invites", "challenge_id = $1 AND invitee_id = $2", &[cid, bid]).await,
        )
    };

    // A failure in any of the three deletes rolls the others back.
    sqlx::query("CREATE FUNCTION gt_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$")
        .execute(pool)
        .await
        .unwrap();
    for table in ["challenge_days", "challenge_invites", "challenge_participants"] {
        let trigger = format!(
            "CREATE TRIGGER gt_test_fail BEFORE DELETE ON {table} FOR EACH STATEMENT EXECUTE FUNCTION gt_test_fail()"
        );
        sqlx::query(&trigger).execute(pool).await.unwrap();
        let err = db.remove_participant(c.id, bob.id).await.expect_err("injected failure");
        assert!(err.to_string().contains("injected failure"), "{table}: {err}");
        sqlx::query(&format!("DROP TRIGGER gt_test_fail ON {table}")).execute(pool).await.unwrap();
        assert_eq!(bob_state().await, (1, 2, 1), "{table}");
    }
    sqlx::query("DROP FUNCTION gt_test_fail()").execute(pool).await.unwrap();

    // Inside a transaction it runs in a savepoint and goes with the outer rollback.
    let mut tx = env.repo.begin().await.unwrap();
    tx.remove_participant(c.id, bob.id).await.unwrap();
    assert_eq!(tx.count_participants(c.id).await.unwrap(), 1);
    drop(tx);
    assert_eq!(bob_state().await, (1, 2, 1), "rolled back with the transaction");

    db.remove_participant(c.id, bob.id).await.unwrap();

    assert_eq!(bob_state().await, (0, 0, 0), "their days go, and their invite, so they can be invited again");
    assert_eq!(count(pool, "challenge_days", "challenge_id = $1 AND user_id = $2", &[c.id, alice.id]).await, 1);
    assert_eq!(
        count(pool, "challenge_invites", "challenge_id = $1 AND inviter_id = $2", &[c.id, bob.id]).await,
        1,
        "invites they sent stay"
    );
    assert_eq!(
        count(pool, "challenge_days", "challenge_id = $1 AND user_id = $2", &[other.id, bob.id]).await,
        2,
        "other challenges are untouched"
    );
    assert_eq!(count(pool, "challenge_invites", "challenge_id = $1 AND invitee_id = $2", &[other.id, bob.id]).await, 1);
    assert_eq!(count(pool, "challenge_cheers", "challenge_id = $1", &[c.id]).await, 2, "cheers are kept");
}

async fn save_final_results(env: &Env) {
    let pool = &env.pool;
    let (alice, bob, carol) = (user(pool).await, user(pool).await, user(pool).await);
    let c = seed(&alice, day(), 60).insert(pool).await;
    let pa = join(pool, &c, &alice, day()).await;
    let pb = join(pool, &c, &bob, day()).await;
    join(pool, &c, &carol, day()).await;
    let mut db = env.repo.conn().await.unwrap();

    db.save_final_results(&[]).await.unwrap();
    db.save_final_results(&[
        ChallengeFinalResult { participant_id: pa.id, rank: 1, days_met: 55, total_hours: 1234.25, completed: true },
        ChallengeFinalResult { participant_id: pb.id, rank: 2, days_met: 0, total_hours: 0.0, completed: false },
    ])
    .await
    .unwrap();

    let rows = db.list_participants(&[c.id]).await.unwrap();
    assert_eq!(rows.len(), 3);
    let (a, b, cc) = (&rows[0], &rows[1], &rows[2]);
    assert_eq!(
        (a.final_rank, a.final_days_met, a.final_total_hours, a.completed),
        (Some(1), Some(55), Some(1234.25), Some(true))
    );
    assert_eq!(
        (b.final_rank, b.final_days_met, b.final_total_hours, b.completed),
        (Some(2), Some(0), Some(0.0), Some(false))
    );
    assert_eq!((cc.final_rank, cc.completed), (None, None), "participants not in the results are untouched");

    let result = ChallengeFinalResult { participant_id: pa.id, ..Default::default() };
    assert!(env.broken.conn().await.unwrap().save_final_results(&[result]).await.is_err());
}

// ==================== Days ====================

async fn activity_days(env: &Env) {
    let pool = &env.pool;
    let (a, b, outsider) = (named(pool, "ann").await, named(pool, "ben").await, named(pool, "out").await);
    let s = day();

    // Study challenge S..S+4 locked through S: live dates start at S+1. Ann joined before the
    // start; Ben joined on S+2.
    let study = seed(&a, s, 5).locked(s).insert(pool).await;
    join(pool, &study, &a, plus(s, -3)).await;
    join(pool, &study, &b, plus(s, 2)).await;
    // Sleep challenge S+1..S+3, never locked; only Ann takes part.
    let sleep = seed(&b, plus(s, 1), 3).goal("sleep", "at_most", 8.0).insert(pool).await;
    join(pool, &sleep, &a, s).await;

    let log = [
        (&a, "study", 2.0, -1), // before the start
        (&a, "study", 3.0, 0),  // locked
        (&a, "study", 1.5, 1),
        (&a, "sleep", 8.0, 1),
        (&a, "sleep", 7.0, 2), // nothing studied, but something logged
        (&a, "study", 15.0, 3),
        (&a, "study", 15.0, 3), // duplicate rows: capped at 24 hours
        (&a, "study", 2.0, 4),  // after "through"
        (&b, "study", 3.0, 1),  // before Ben joined
        (&b, "study", 0.0, 2),  // a zero-hour row is not "logged"
        (&b, "workout", 1.0, 3),
        (&outsider, "study", 5.0, 1),
    ];
    for (u, name, hours, offset) in log {
        activity(pool, u, name, hours, plus(s, offset)).await;
    }

    let through = plus(s, 3);
    let mut db = env.repo.conn().await.unwrap();
    let rows = db.activity_days(&[sleep.id, study.id], through).await.unwrap();
    let got: Vec<(i64, i64, NaiveDate, f64, bool)> =
        rows.iter().map(|r| (r.challenge_id, r.user_id, r.day_date, r.hours, r.logged)).collect();
    assert_eq!(
        got,
        [
            (study.id, a.id, plus(s, 1), 1.5, true),
            (study.id, a.id, plus(s, 2), 0.0, true),
            (study.id, a.id, plus(s, 3), 24.0, true),
            (study.id, b.id, plus(s, 2), 0.0, false),
            (study.id, b.id, plus(s, 3), 0.0, true),
            (sleep.id, a.id, plus(s, 1), 8.0, true),
            (sleep.id, a.id, plus(s, 2), 7.0, true),
            (sleep.id, a.id, plus(s, 3), 0.0, true),
        ]
    );

    assert!(db.activity_days(&[sleep.id], s).await.unwrap().is_empty(), "nothing before the start");
    assert!(db.activity_days(&[], through).await.unwrap().is_empty(), "no challenges");
    assert!(env.broken.conn().await.unwrap().activity_days(&[study.id], through).await.is_err());
}

async fn insert_and_list_days(env: &Env) {
    let pool = &env.pool;
    let (alice, bob) = (user(pool).await, user(pool).await);
    let c = seed(&alice, day(), 7).insert(pool).await;
    let other = seed(&alice, day(), 7).insert(pool).await;
    let mk = |challenge: &Challenge, user: &TestUser, offset: i64, hours: f64, met: bool| NewChallengeDay {
        challenge_id: challenge.id,
        user_id: user.id,
        day_date: plus(day(), offset),
        hours,
        logged: hours > 0.0,
        met,
        locked_at: t0(),
    };
    let mut db = env.repo.conn().await.unwrap();

    let first = [mk(&c, &bob, 1, 2.5, true), mk(&c, &alice, 0, 1.0, false), mk(&c, &bob, 0, 0.0, false)];
    assert_eq!(db.insert_days(&first).await.unwrap(), 3);
    // Re-locking is idempotent: stored days are never rewritten.
    let second = [mk(&c, &bob, 1, 9.0, false), mk(&c, &bob, 2, 3.0, true), mk(&other, &bob, 0, 4.0, true)];
    assert_eq!(db.insert_days(&second).await.unwrap(), 2);
    assert_eq!(db.insert_days(&[]).await.unwrap(), 0);

    let days = db.list_days(c.id).await.unwrap();
    let keys: Vec<(i64, String)> = days.iter().map(|d| (d.user_id, ymd(d.day_date))).collect();
    assert_eq!(
        keys,
        [
            (alice.id, "2026-03-09".to_string()),
            (bob.id, "2026-03-09".to_string()),
            (bob.id, "2026-03-10".to_string()),
            (bob.id, "2026-03-11".to_string()),
        ]
    );
    assert_eq!(days[2].hours, 2.5, "the first snapshot is kept");
    assert!(days[2].met && days[2].logged);
    assert!(!days[1].logged);
    assert_eq!(days[2].locked_at, t0());

    let mine = db.list_user_days(bob.id, &[other.id, c.id]).await.unwrap();
    let challenges: Vec<i64> = mine.iter().map(|d| d.challenge_id).collect();
    assert_eq!(challenges, [c.id, c.id, c.id, other.id]);
    assert_eq!(db.list_user_days(bob.id, &[other.id]).await.unwrap().len(), 1);
    assert!(db.list_user_days(bob.id, &[]).await.unwrap().is_empty());

    // More than one batch: all rows or none.
    let many: Vec<NewChallengeDay> = (10..610).map(|i| mk(&other, &alice, i, 1.0, false)).collect();
    let mut failing = many.clone();
    failing.push(NewChallengeDay { user_id: 999_999, ..mk(&other, &alice, 700, 1.0, false) });
    assert!(db.insert_days(&failing).await.is_err());
    assert_eq!(count(pool, "challenge_days", "challenge_id = $1 AND user_id = $2", &[other.id, alice.id]).await, 0);
    assert_eq!(db.insert_days(&many).await.unwrap(), 600);
    assert_eq!(db.insert_days(&many).await.unwrap(), 0);

    let mut broken = env.broken.conn().await.unwrap();
    assert!(broken.insert_days(&[mk(&c, &bob, 5, 1.0, false)]).await.is_err());
    assert!(broken.list_days(c.id).await.is_err());
    assert!(broken.list_user_days(bob.id, &[c.id]).await.is_err());
}

async fn locked_totals(env: &Env) {
    let pool = &env.pool;
    let (ann, ben, left) = (user(pool).await, user(pool).await, user(pool).await);
    let s = day();
    let c = seed(&ann, s, 7).locked(plus(s, 2)).insert(pool).await;
    join(pool, &c, &ann, plus(s, -1)).await;
    join(pool, &c, &ben, plus(s, 2)).await;
    let unlocked = seed(&ann, s, 7).insert(pool).await;
    join(pool, &unlocked, &ann, s).await;

    locked_day(pool, &c, &ann, plus(s, -1), 5.0, true).await; // before the start
    locked_day(pool, &c, &ann, s, 3.0, true).await;
    locked_day(pool, &c, &ann, plus(s, 1), 2.0, true).await;
    locked_day(pool, &c, &ann, plus(s, 2), 0.5, false).await;
    locked_day(pool, &c, &ann, plus(s, 3), 4.0, true).await; // after locked_through
    locked_day(pool, &c, &ben, plus(s, 1), 6.0, true).await; // before Ben's window
    locked_day(pool, &c, &ben, plus(s, 2), 2.25, true).await;
    locked_day(pool, &c, &left, s, 8.0, true).await; // not a participant
    locked_day(pool, &unlocked, &ann, s, 8.0, true).await; // nothing is locked there

    let mut db = env.repo.conn().await.unwrap();
    assert_eq!(
        db.locked_totals(&[c.id, unlocked.id]).await.unwrap(),
        [
            ChallengeLockedTotal { challenge_id: c.id, user_id: ann.id, days_met: 2, total_hours: 5.5 },
            ChallengeLockedTotal { challenge_id: c.id, user_id: ben.id, days_met: 1, total_hours: 2.25 },
        ]
    );
    assert!(db.locked_totals(&[]).await.unwrap().is_empty());
    assert!(env.broken.conn().await.unwrap().locked_totals(&[c.id]).await.is_err());
}

// ==================== Cheers and invites ====================

async fn cheers(env: &Env) {
    let pool = &env.pool;
    let (ann, ben, cat) = (user(pool).await, user(pool).await, user(pool).await);
    let c = seed(&ann, day(), 7).insert(pool).await;
    let mut db = env.repo.conn().await.unwrap();
    let cheer = |from: &TestUser, to: &TestUser, date: NaiveDate| NewChallengeCheer {
        challenge_id: c.id,
        from_user_id: from.id,
        to_user_id: to.id,
        cheer_date: date,
        created_at: t0(),
    };

    assert!(db.create_cheer(&cheer(&ann, &ben, day())).await.unwrap());
    assert!(!db.create_cheer(&cheer(&ann, &ben, day())).await.unwrap(), "once per day");
    assert!(db.create_cheer(&cheer(&ann, &ben, plus(day(), 1))).await.unwrap(), "again the next day");
    assert!(db.create_cheer(&cheer(&ann, &cat, day())).await.unwrap());
    assert!(db.create_cheer(&cheer(&ben, &ann, day())).await.unwrap());

    assert_eq!(db.cheered_user_ids(c.id, ann.id, day()).await.unwrap(), [ben.id, cat.id]);
    assert_eq!(db.cheered_user_ids(c.id, ann.id, plus(day(), 1)).await.unwrap(), [ben.id]);
    assert!(db.cheered_user_ids(c.id, cat.id, day()).await.unwrap().is_empty());
    assert_eq!(count(pool, "challenge_cheers", "challenge_id = $1", &[c.id]).await, 4);

    let mut broken = env.broken.conn().await.unwrap();
    assert!(broken.create_cheer(&cheer(&cat, &ann, day())).await.is_err());
    assert!(broken.cheered_user_ids(c.id, ann.id, day()).await.is_err());
}

async fn create_invites(env: &Env) {
    let pool = &env.pool;
    let me = named(pool, "me").await;
    let mate = named(pool, "mate").await;
    let (i_follow, follows_me) = (named(pool, "ifollow").await, named(pool, "followsme").await);
    let (pending, removed, stranger) =
        (named(pool, "pending").await, named(pool, "removed").await, named(pool, "stranger").await);
    let (participant, invited_before) = (named(pool, "participant").await, named(pool, "invited").await);
    let c = seed(&me, day(), 7).insert(pool).await;
    join(pool, &c, &me, day()).await;
    join(pool, &c, &mate, day()).await;
    join(pool, &c, &participant, day()).await;

    follow(pool, &me, &i_follow, FOLLOW_STATE_ACTIVE).await;
    follow(pool, &follows_me, &me, FOLLOW_STATE_ACTIVE).await;
    follow(pool, &me, &pending, FOLLOW_STATE_PENDING).await;
    follow(pool, &removed, &me, FOLLOW_STATE_REMOVED).await;
    follow(pool, &mate, &stranger, FOLLOW_STATE_ACTIVE).await; // someone else's friend
    follow(pool, &me, &participant, FOLLOW_STATE_ACTIVE).await;
    follow(pool, &me, &invited_before, FOLLOW_STATE_ACTIVE).await;
    invite(pool, &c, &mate, &invited_before, t0()).await;

    let at = t0() + Duration::hours(1);
    let ids = [
        follows_me.id,
        i_follow.id,
        pending.id,
        removed.id,
        stranger.id,
        participant.id,
        invited_before.id,
        me.id,
        99_999,
    ];
    let mut db = env.repo.conn().await.unwrap();
    let invites = db.create_invites(c.id, me.id, &ids, at).await.unwrap();
    assert_eq!(invitee_ids(&invites), [i_follow.id, follows_me.id], "ordered by invitee id");

    let sql = format!(
        "SELECT {} FROM challenge_invites WHERE challenge_id = $1 ORDER BY invitee_id",
        ChallengeInvite::COLUMNS
    );
    let stored: Vec<ChallengeInvite> = sqlx::query_as(&sql).bind(c.id).fetch_all(pool).await.unwrap();
    assert_eq!(stored.len(), 3);
    for inv in &stored {
        if inv.invitee_id == invited_before.id {
            assert_eq!(inv.inviter_id, mate.id, "the open invite is kept");
            continue;
        }
        assert_eq!((inv.inviter_id, inv.created_at), (me.id, at));
    }
    for inv in &invites {
        assert!(stored.contains(inv), "returns the stored invites");
        assert_eq!((inv.challenge_id, inv.inviter_id, inv.created_at), (c.id, me.id, at));
    }

    assert!(db.create_invites(c.id, me.id, &ids, at).await.unwrap().is_empty(), "a user has one invite per challenge");
    assert!(db.create_invites(c.id, me.id, &[], at).await.unwrap().is_empty());
    assert!(env.broken.conn().await.unwrap().create_invites(c.id, me.id, &ids, at).await.is_err());

    // After leaving, a user can be invited again.
    join(pool, &c, &i_follow, day()).await;
    db.remove_participant(c.id, i_follow.id).await.unwrap();
    let later = at + Duration::hours(1);
    let reinvited = db.create_invites(c.id, me.id, &[i_follow.id, follows_me.id], later).await.unwrap();
    assert_eq!(invitee_ids(&reinvited), [i_follow.id], "followsme still has an open invite");
    assert_ne!(reinvited[0].id, invites[0].id, "a new invite");
    assert_eq!(reinvited[0].created_at, later);
}

async fn delete_stale_invites(env: &Env) {
    let pool = &env.pool;
    let ann = named(pool, "ann").await;
    let c = seed(&ann, day(), 7).insert(pool).await;
    let other = seed(&ann, day(), 7).insert(pool).await;
    join(pool, &c, &ann, day()).await;
    let (invited_at, joined_at) = (t0(), t0() + Duration::hours(1));

    /// The "joined" notification record the creator got when `user` joined the challenge.
    async fn joined(
        pool: &PgPool,
        challenge: &Challenge,
        user: &TestUser,
        at: DateTime<Utc>,
        record: (i64, &str, &str),
    ) {
        let (recipient, notif_type, entity_type) = record;
        sqlx::query(
            "INSERT INTO notification_dedupes (user_id, actor_id, type, entity_type, entity_key, created_at) \
             VALUES ($1, $2, $3, $4, $5, $6)",
        )
        .bind(recipient)
        .bind(user.id)
        .bind(notif_type)
        .bind(entity_type)
        .bind(challenge.id.to_string())
        .bind(at)
        .execute(pool)
        .await
        .expect("insert dedupe");
    }
    let creator_joined = (ann.id, NOTIF_TYPE_CHALLENGE_JOINED, NOTIF_ENTITY_CHALLENGE);

    let left = named(pool, "left").await; // joined with the invite and left before leaving removed it
    let stale = invite(pool, &c, &ann, &left, invited_at).await;
    joined(pool, &c, &left, joined_at, creator_joined).await;

    let left_at_once = named(pool, "leftatonce").await; // joined in the same instant
    let stale_too = invite(pool, &c, &ann, &left_at_once, invited_at).await;
    joined(pool, &c, &left_at_once, invited_at, creator_joined).await;

    let open = named(pool, "open").await; // has not used the invite yet
    invite(pool, &c, &ann, &open, invited_at).await;

    let member = named(pool, "member").await; // joined with the invite and is still in
    invite(pool, &c, &ann, &member, invited_at).await;
    joined(pool, &c, &member, joined_at, creator_joined).await;
    join(pool, &c, &member, day()).await;

    let reinvited = named(pool, "reinvited").await; // joined, left, then got a new invite
    invite(pool, &c, &ann, &reinvited, joined_at + Duration::hours(1)).await;
    joined(pool, &c, &reinvited, joined_at, creator_joined).await;

    let elsewhere = named(pool, "elsewhere").await; // joined another challenge
    invite(pool, &c, &ann, &elsewhere, invited_at).await;
    joined(pool, &other, &elsewhere, joined_at, creator_joined).await;

    let cheered = named(pool, "cheered").await; // records of another kind
    invite(pool, &c, &ann, &cheered, invited_at).await;
    joined(pool, &c, &cheered, joined_at, (ann.id, NOTIF_TYPE_CHALLENGE_CHEER, NOTIF_ENTITY_CHALLENGE)).await;
    joined(pool, &c, &cheered, joined_at, (ann.id, NOTIF_TYPE_CHALLENGE_JOINED, NOTIF_ENTITY_CHALLENGE_DAY)).await;

    let not_the_creator = named(pool, "notthecreator").await; // someone else was notified
    invite(pool, &c, &ann, &not_the_creator, invited_at).await;
    joined(pool, &c, &not_the_creator, joined_at, (member.id, NOTIF_TYPE_CHALLENGE_JOINED, NOTIF_ENTITY_CHALLENGE))
        .await;

    let mut db = env.repo.conn().await.unwrap();
    assert_eq!(db.delete_stale_invites().await.unwrap(), 2);
    assert_eq!(count(pool, "challenge_invites", "id IN ($1, $2)", &[stale, stale_too]).await, 0);
    let kept: Vec<i64> =
        sqlx::query_scalar("SELECT invitee_id FROM challenge_invites WHERE challenge_id = $1 ORDER BY invitee_id")
            .bind(c.id)
            .fetch_all(pool)
            .await
            .unwrap();
    assert_eq!(kept, [open.id, member.id, reinvited.id, elsewhere.id, cheered.id, not_the_creator.id]);

    assert_eq!(db.delete_stale_invites().await.unwrap(), 0, "nothing left to delete");
    assert!(env.broken.conn().await.unwrap().delete_stale_invites().await.is_err());
}

async fn invite_candidates(env: &Env) {
    let pool = &env.pool;
    let me = named(pool, "me").await;
    let c = seed(&me, day(), 7).insert(pool).await;
    join(pool, &c, &me, day()).await;

    let friend = |name: &'static str, avatar: bool, verified: bool| {
        let me = me.clone();
        async move {
            let u = insert_user(pool, name, avatar, verified).await;
            follow(pool, &me, &u, FOLLOW_STATE_ACTIVE).await;
            u
        }
    };
    let amy = friend("amy", true, true).await;
    let anna = named(pool, "anna").await;
    follow(pool, &anna, &me, FOLLOW_STATE_ACTIVE).await; // follows me
    let anton = friend("anton", false, false).await;
    follow(pool, &anton, &me, FOLLOW_STATE_ACTIVE).await; // both directions: listed once
    friend("bob", false, false).await;
    let ava = friend("ava", false, false).await;
    join(pool, &c, &ava, day()).await; // already takes part
    let abe = named(pool, "abe").await;
    follow(pool, &me, &abe, FOLLOW_STATE_PENDING).await;
    let alf = named(pool, "alf").await;
    follow(pool, &alf, &me, FOLLOW_STATE_REMOVED).await;
    named(pool, "art").await; // no relationship
    follow(pool, &me, &me, FOLLOW_STATE_ACTIVE).await;
    let other = named(pool, "other").await;
    let andy = named(pool, "andy").await;
    follow(pool, &other, &andy, FOLLOW_STATE_ACTIVE).await; // not my friend
    invite(pool, &c, &me, &anna, t0()).await;

    let (challenge_id, viewer_id) = (c.id, me.id);
    let list = |prefix: &'static str, limit: i64| {
        let repo = env.repo.clone();
        async move {
            let mut db = repo.conn().await.unwrap();
            db.invite_candidates(challenge_id, viewer_id, prefix, limit).await.expect("candidates")
        }
    };

    let all = list("", 50).await;
    assert_eq!(candidate_names(&all), ["amy", "anna", "anton", "bob"]);
    assert_eq!(all[0].id, amy.id);
    assert_eq!(all[0].profile_pic, amy.profile_pic);
    assert_eq!(all[0].profile_pic_thumb, amy.profile_pic_thumb);
    assert!(all[0].is_verified);
    assert!(!all[0].invited);
    assert!(all[1].invited, "anna was invited already");
    assert_eq!(all[2].profile_pic, None);
    assert_eq!(all[2].id, anton.id);

    assert_eq!(candidate_names(&list("", 2).await), ["amy", "anna"], "limit");
    assert_eq!(candidate_names(&list("an", 50).await), ["anna", "anton"]);
    assert_eq!(candidate_names(&list("AN", 50).await), ["anna", "anton"], "case-insensitive");
    assert_eq!(candidate_names(&list("anton", 50).await), ["anton"]);
    assert!(list("antonio", 50).await.is_empty());
    assert!(list("ava", 50).await.is_empty(), "participants are excluded");
    assert!(list("me", 50).await.is_empty(), "the viewer is excluded");

    // Usernames are matched case-insensitively (created before usernames were lower-case only).
    friend("Bea", false, false).await;
    assert_eq!(candidate_names(&list("b", 50).await), ["Bea", "bob"]);
    assert_eq!(candidate_names(&list("bE", 50).await), ["Bea"]);

    // LIKE wildcards match literally.
    for name in ["z_z", "zxz", "z%z", r"z\z"] {
        friend(name, false, false).await;
    }
    assert_eq!(candidate_names(&list("z_", 50).await), ["z_z"]);
    assert_eq!(candidate_names(&list("z%", 50).await), ["z%z"]);
    assert_eq!(candidate_names(&list(r"z\", 50).await), [r"z\z"]);
    assert!(list("%", 50).await.is_empty());
    assert!(list("_", 50).await.is_empty());
    assert_eq!(list("z", 50).await.len(), 4);

    assert!(env.broken.conn().await.unwrap().invite_candidates(c.id, me.id, "", 20).await.is_err());
}
