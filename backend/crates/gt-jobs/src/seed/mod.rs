//! Local development seeder (port of `cmd/seed/main.go`): test users, activity and streak
//! history, badges and a follow graph with pending requests. The `seed` binary runs the steps
//! in order and turns their errors into Go-style fatal log lines.

mod data;

use chrono::{DateTime, Duration, Local, NaiveDate, NaiveTime, Utc};
use gt_core::badges;
use gt_core::models::{Streak, UserBadge, ACTIVITY_NAMES, FOLLOW_STATE_ACTIVE, FOLLOW_STATE_PENDING};
use gt_users::{BadgeRepository, StreakRepository};
use rand::Rng;
use sqlx::{PgPool, Postgres, QueryBuilder};

pub use data::{SeedDay, SeedUser, StreakHistory, StreakPattern, FOLLOWS, PENDING_REQUESTS, SEED_PASSWORD, SEED_USERS};

use crate::go_log;

/// A user created by [`seed_users`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeededUser {
    pub id: i64,
    pub email: String,
    pub username: String,
}

/// The seeder's "today": Go truncated `time.Now()` to a multiple of 24 hours (midnight UTC) and
/// stored that instant's local calendar date.
pub fn seed_today() -> NaiveDate {
    let utc_midnight = Utc::now().date_naive().and_time(NaiveTime::MIN).and_utc();
    utc_midnight.with_timezone(&Local).date_naive()
}

/// Number of users; 0 when the count fails (Go ignored the error).
pub async fn count_users(pool: &PgPool) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM users").fetch_one(pool).await.unwrap_or(0)
}

/// Creates the [`SEED_USERS`] in one statement, all with the bcrypt hash of [`SEED_PASSWORD`].
pub async fn seed_users(pool: &PgPool) -> anyhow::Result<Vec<SeededUser>> {
    go_log!("👤 Seeding test users...");
    let password_hash = gt_users::service::hash_password(SEED_PASSWORD).await?;
    let now = Utc::now();

    let mut builder: QueryBuilder<Postgres> = QueryBuilder::new(
        "INSERT INTO users (email, username, password_hash, bio, is_private, is_verified, created_at, updated_at) ",
    );
    builder.push_values(SEED_USERS.iter(), |mut row, user| {
        row.push_bind(user.email)
            .push_bind(user.username)
            .push_bind(password_hash.as_str())
            .push_bind(user.bio)
            .push_bind(user.is_private)
            .push_bind(user.is_verified)
            .push_bind(now)
            .push_bind(now);
    });
    builder.push(" RETURNING id");
    let ids: Vec<i64> = builder.build_query_scalar().fetch_all(pool).await?;

    let users: Vec<SeededUser> = SEED_USERS
        .iter()
        .zip(ids)
        .map(|(user, id)| SeededUser { id, email: user.email.to_string(), username: user.username.to_string() })
        .collect();
    go_log!("✅ Created {} test users", users.len());
    Ok(users)
}

/// Creates 2-4 random activities (1-4.75 hours each) and the streak record for every seeded day
/// of every user. Stops at the first database error.
pub async fn seed_activities<R: Rng + Send>(
    pool: &PgPool,
    users: &[SeededUser],
    rng: &mut R,
) -> Result<(), sqlx::Error> {
    go_log!("📝 Seeding activities and streaks...");
    let streak_repo = StreakRepository::new(pool.clone());
    let today = seed_today();

    for user in users {
        let pattern = StreakPattern::for_user(&user.username);
        let history = StreakHistory::build(today, &pattern);
        for day in &history.days {
            let activities = rng.gen_range(0..3) + 2;
            for _ in 0..activities {
                let name = ACTIVITY_NAMES[rng.gen_range(0..ACTIVITY_NAMES.len())];
                let duration = (rng.gen_range(0..4) + 1) as f32 + rng.gen_range(0..4) as f32 * 0.25;
                insert_activity(pool, user.id, name, duration, day.date).await?;
            }
            let mut streak =
                Streak { id: 0, user_id: user.id, current: day.current, longest: day.longest, activity_date: day.date };
            streak_repo.create(&mut streak).await?;
        }
        go_log!(
            "✅ User {}: {} days of activities (current streak: {}, longest: {})",
            user.username,
            pattern.logged_days(),
            history.current,
            history.longest
        );
    }
    Ok(())
}

async fn insert_activity(
    pool: &PgPool,
    user_id: i64,
    name: &str,
    duration: f32,
    date: NaiveDate,
) -> Result<(), sqlx::Error> {
    let now = Utc::now();
    sqlx::query(
        "INSERT INTO activities (user_id, name, duration_hours, note, created_at, updated_at, activity_date) \
         VALUES ($1, $2, $3, NULL, $4, $4, $5)",
    )
    .bind(user_id)
    .bind(name)
    .bind(duration)
    .bind(now)
    .bind(date)
    .execute(pool)
    .await
    .map(|_| ())
}

/// Awards every badge each user's longest streak qualifies for (earned now). Failures are
/// logged per badge.
pub async fn seed_badges(pool: &PgPool, users: &[SeededUser]) {
    go_log!("🏅 Seeding badges based on streaks...");
    let badge_repo = BadgeRepository::new(pool.clone());

    for user in users {
        // Go scanned the aggregate ignoring errors: no streaks (or a failure) means 0.
        let longest: i64 =
            sqlx::query_scalar::<_, Option<i64>>("SELECT MAX(longest) AS longest FROM streaks WHERE user_id = $1")
                .bind(user.id)
                .fetch_one(pool)
                .await
                .ok()
                .flatten()
                .unwrap_or(0);

        let eligible = badges::eligible_badge_keys(longest);
        for key in &eligible {
            let mut badge = UserBadge { id: 0, user_id: user.id, badge_key: key.to_string(), earned_at: Utc::now() };
            if let Err(err) = badge_repo.create(&mut badge).await {
                go_log!("⚠️  Could not create badge {} for user {}: {}", key, user.username, err);
            }
        }
        go_log!(
            "✅ User {}: awarded {} badge(s) for longest streak of {} days",
            user.username,
            eligible.len(),
            longest
        );
    }
}

/// One follow edge to create in both tables.
struct NewEdge {
    follower_id: i64,
    followee_id: i64,
    state: &'static str,
    created_at: DateTime<Utc>,
    accepted_at: Option<DateTime<Utc>>,
}

/// Creates the [`FOLLOWS`] (accepted) and [`PENDING_REQUESTS`] edges with staggered times,
/// then computes every user's follow counters and logs a summary. Failures are logged per edge.
pub async fn seed_follows<R: Rng + Send>(pool: &PgPool, users: &[SeededUser], rng: &mut R) {
    go_log!("👥 Seeding follow relationships...");
    let id_of = |username: &str| users.iter().find(|u| u.username == username).map_or(0, |u| u.id);
    let now = Utc::now();
    let (mut total_follows, mut total_pending) = (0, 0);

    for &(follower, followees) in FOLLOWS {
        for (i, followee) in followees.iter().enumerate() {
            let created_at = now - Duration::hours(rng.gen_range(0..30 * 24)) - Duration::minutes(i as i64);
            let accepted_at = created_at + Duration::minutes(rng.gen_range(0..60));
            let edge = NewEdge {
                follower_id: id_of(follower),
                followee_id: id_of(followee),
                state: FOLLOW_STATE_ACTIVE,
                created_at,
                accepted_at: Some(accepted_at),
            };
            if create_edges(pool, &edge, "Failed to create follow edge").await {
                total_follows += 1;
            }
        }
    }

    for &(follower, followees) in PENDING_REQUESTS {
        for (i, followee) in followees.iter().enumerate() {
            let created_at = now - Duration::hours(rng.gen_range(0..7 * 24)) - Duration::minutes(i as i64);
            let edge = NewEdge {
                follower_id: id_of(follower),
                followee_id: id_of(followee),
                state: FOLLOW_STATE_PENDING,
                created_at,
                accepted_at: None,
            };
            if create_edges(pool, &edge, "Failed to create pending request").await {
                total_pending += 1;
            }
        }
    }

    go_log!("📊 Updating follow counters...");
    for user in users {
        if let Err(err) = save_counter(pool, user.id).await {
            go_log!("⚠️  Failed to save counter for user {}: {}", user.username, err);
        }
    }

    go_log!("✅ Created {} active follows, {} pending requests", total_follows, total_pending);

    go_log!("\n📊 Follow Summary:");
    for user in users {
        let (followers, following, pending) = sqlx::query_as::<_, (i64, i64, i64)>(
            "SELECT followers_count, following_count, pending_requests_count FROM follow_counters \
             WHERE user_id = $1 ORDER BY user_id LIMIT 1",
        )
        .bind(user.id)
        .fetch_one(pool)
        .await
        .unwrap_or_default();
        go_log!(
            "  • {}: {} followers, {} following, {} pending requests",
            user.username,
            followers,
            following,
            pending
        );
    }
}

/// Writes the edge to `follow_edges_by_follower` then `follow_edges_by_followee` (the Go
/// dual-write); logs and returns `false` at the first failure.
async fn create_edges(pool: &PgPool, edge: &NewEdge, failure: &str) -> bool {
    let tables = [
        ("follower", "INSERT INTO follow_edges_by_follower (follower_id, followee_id, state, created_at, accepted_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)"),
        ("followee", "INSERT INTO follow_edges_by_followee (followee_id, follower_id, state, created_at, accepted_at, updated_at) VALUES ($2, $1, $3, $4, $5, $6)"),
    ];
    let now = Utc::now();
    for (side, sql) in tables {
        let result = sqlx::query(sql)
            .bind(edge.follower_id)
            .bind(edge.followee_id)
            .bind(edge.state)
            .bind(edge.created_at)
            .bind(edge.accepted_at)
            .bind(now)
            .execute(pool)
            .await;
        if let Err(err) = result {
            go_log!("⚠️  {} ({}): {}", failure, side, err);
            return false;
        }
    }
    true
}

/// Upserts the user's counters from the edges (GORM `Save`). Count failures read as 0, as in Go.
async fn save_counter(pool: &PgPool, user_id: i64) -> Result<(), sqlx::Error> {
    let count = |sql: &'static str, state: &'static str| async move {
        sqlx::query_scalar::<_, i64>(sql).bind(user_id).bind(state).fetch_one(pool).await.unwrap_or(0)
    };
    let followers = count(
        "SELECT count(*) FROM follow_edges_by_followee WHERE followee_id = $1 AND state = $2",
        FOLLOW_STATE_ACTIVE,
    )
    .await;
    let following = count(
        "SELECT count(*) FROM follow_edges_by_follower WHERE follower_id = $1 AND state = $2",
        FOLLOW_STATE_ACTIVE,
    )
    .await;
    let pending = count(
        "SELECT count(*) FROM follow_edges_by_followee WHERE followee_id = $1 AND state = $2",
        FOLLOW_STATE_PENDING,
    )
    .await;

    sqlx::query(
        "INSERT INTO follow_counters (user_id, followers_count, following_count, pending_requests_count, updated_at) \
         VALUES ($1, $2, $3, $4, $5) \
         ON CONFLICT (user_id) DO UPDATE SET followers_count = EXCLUDED.followers_count, \
         following_count = EXCLUDED.following_count, pending_requests_count = EXCLUDED.pending_requests_count, \
         updated_at = EXCLUDED.updated_at",
    )
    .bind(user_id)
    .bind(followers)
    .bind(following)
    .bind(pending)
    .bind(Utc::now())
    .execute(pool)
    .await
    .map(|_| ())
}
