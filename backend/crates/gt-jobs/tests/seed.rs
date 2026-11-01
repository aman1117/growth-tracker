//! The development seeder and the badge backfill against a real database.

mod common;

use chrono::{Duration, NaiveDate, NaiveTime, Utc};
use common::*;
use gt_jobs::{badge_backfill, seed};
use gt_users::BadgeRepository;
use rand::rngs::StdRng;
use rand::SeedableRng;
use sqlx::PgPool;

async fn badge_keys(pool: &PgPool, user_id: i64) -> Vec<String> {
    sqlx::query_scalar("SELECT badge_key FROM user_badges WHERE user_id = $1 ORDER BY id")
        .bind(user_id)
        .fetch_all(pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn seeder_creates_the_local_dev_fixtures() {
    let Some(db) = TestDb::new("seed").await else {
        return;
    };
    let pool = &db.pool;
    let mut rng = StdRng::seed_from_u64(7);
    assert_eq!(seed::count_users(pool).await, 0);

    let users = seed::seed_users(pool).await.unwrap();
    seed::seed_activities(pool, &users, &mut rng).await.unwrap();
    seed::seed_badges(pool, &users).await;
    seed::seed_follows(pool, &users, &mut rng).await;

    assert_eq!(seed::count_users(pool).await, 10);
    let id = |name: &str| users.iter().find(|u| u.username == name).unwrap().id;
    let user_repo = gt_users::UserRepository::new(pool.clone());
    let alice = user_repo.find_by_username("alice").await.unwrap().unwrap();
    assert_eq!(alice.email, "alice@local.dev");
    assert!(alice.is_verified && !alice.is_private && !alice.email_verified);
    assert_eq!(alice.bio.as_deref(), Some("📚 Student | 💪 Fitness enthusiast | Building better habits daily"));
    assert!(gt_users::service::verify_password("password123", &alice.password_hash).await);
    assert!(user_repo.find_by_username("charlie").await.unwrap().unwrap().is_private);

    // Streak history: alice logged every day for 16 days, bob broke a 45-day streak.
    let today = seed::seed_today();
    let streak = |user_id: i64| async move {
        sqlx::query_as::<_, (i64, i64)>(
            "SELECT current, longest FROM streaks WHERE user_id = $1 AND activity_date = $2",
        )
        .bind(user_id)
        .bind(today)
        .fetch_one(pool)
        .await
        .unwrap()
    };
    assert_eq!(streak(id("alice")).await, (16, 16));
    assert_eq!(streak(id("bob")).await, (1, 45));
    let days: i64 = sqlx::query_scalar("SELECT count(DISTINCT activity_date) FROM activities WHERE user_id = $1")
        .bind(id("bob"))
        .fetch_one(pool)
        .await
        .unwrap();
    assert_eq!(days, 46);
    let (min, max): (f32, f32) =
        sqlx::query_as("SELECT MIN(duration_hours)::float4, MAX(duration_hours)::float4 FROM activities")
            .fetch_one(pool)
            .await
            .unwrap();
    assert!(min >= 1.0 && max <= 4.75, "{min}..{max}");

    assert_eq!(badge_keys(pool, id("alice")).await, ["first_step", "spark_starter", "flame_keeper"]);
    assert_eq!(badge_keys(pool, id("fiona")).await.len(), 4, "longest 63 days");

    assert_eq!(count(pool, "SELECT count(*) FROM follow_edges_by_follower WHERE state = 'ACTIVE'").await, 45);
    assert_eq!(count(pool, "SELECT count(*) FROM follow_edges_by_followee WHERE state = 'PENDING'").await, 6);
    let counters = |user_id: i64| async move {
        sqlx::query_as::<_, (i64, i64, i64)>(
            "SELECT followers_count, following_count, pending_requests_count FROM follow_counters WHERE user_id = $1",
        )
        .bind(user_id)
        .fetch_one(pool)
        .await
        .unwrap()
    };
    assert_eq!(counters(id("alice")).await, (9, 7, 0));
    assert_eq!(counters(id("charlie")).await, (1, 2, 3));
    assert_eq!(counters(id("george")).await, (0, 2, 3));
    db.finish().await;
}

#[tokio::test]
async fn badge_backfill_dates_badges_by_first_achievement() {
    let Some(db) = TestDb::new("badge_backfill").await else {
        return;
    };
    let pool = &db.pool;
    let day = |d: u32| NaiveDate::from_ymd_opt(2026, 3, d).unwrap();
    let user = create_user(pool, "streaker").await;
    for (offset, longest) in [(1, 1), (2, 5), (3, 7), (4, 7)] {
        create_streak(pool, user.id, longest, longest, day(offset)).await;
    }
    let fresh = create_user(pool, "fresh").await;
    create_streak(pool, fresh.id, 0, 0, day(1)).await;
    let badge_repo = BadgeRepository::new(pool.clone());
    badge_repo
        .create(&mut gt_core::models::UserBadge {
            id: 0,
            user_id: user.id,
            badge_key: "first_step".into(),
            earned_at: Utc::now(),
        })
        .await
        .unwrap();

    let streaks = badge_backfill::load_user_streaks(pool).await.unwrap();
    assert_eq!(streaks.len(), 1, "users without a positive streak are skipped");
    assert_eq!((streaks[0].user_id, streaks[0].max_longest, streaks[0].first_streak_at), (user.id, 7, Some(day(1))));

    assert_eq!(badge_backfill::seed_badges_for_user(pool, &badge_repo, user.id, 7).await.unwrap(), 1);
    let badges = badge_repo.find_by_user_id(user.id).await.unwrap();
    let spark = badges.iter().find(|b| b.badge_key == "spark_starter").unwrap();
    assert_eq!(spark.earned_at, day(3).and_time(NaiveTime::MIN).and_utc(), "first day the streak reached 7");
    assert!(
        (Utc::now() - badges.iter().find(|b| b.badge_key == "first_step").unwrap().earned_at) < Duration::minutes(1)
    );

    assert_eq!(badge_backfill::seed_badges_for_user(pool, &badge_repo, user.id, 7).await.unwrap(), 0, "idempotent");
    assert_eq!(badge_backfill::seed_badges_for_user(pool, &badge_repo, fresh.id, 0).await.unwrap(), 0);
    db.finish().await;
}
