//! Repository tests against PostgreSQL (ports of `user_repository_test.go`,
//! `recent_search_repository_test.go`, the streak/cron parts of
//! `activity_streak_cron_tile_test.go` and the badge part of `like_badge_repository_test.go`).
//! Skipped without `TEST_DATABASE_URL`.

mod common;

use chrono::{DateTime, Duration, NaiveDate, NaiveDateTime, TimeZone, Utc};
use common::{create_user, create_user_with, TestDb};
use gt_core::models::{
    CronJobLog, Streak, UserBadge, CRON_JOB_DAILY_STREAK, CRON_JOB_STATUS_COMPLETED, CRON_JOB_STATUS_RUNNING,
    CRON_JOB_STREAK_REMINDER, FOLLOW_STATE_ACTIVE, FOLLOW_STATE_PENDING,
};
use gt_users::repository::{
    AutocompleteResult, BadgeRepository, CronJobLogRepository, FollowRepository, RecentSearchRepository,
    StreakRepository, UserRepository,
};
use sqlx::PgPool;

fn day(d: u32) -> NaiveDate {
    NaiveDate::from_ymd_opt(2026, 3, d).unwrap()
}

fn names(results: &[AutocompleteResult]) -> Vec<&str> {
    results.iter().map(|r| r.username.as_str()).collect()
}

async fn set_followers(pool: &PgPool, user_id: i64, followers: i64) {
    sqlx::query(
        "INSERT INTO follow_counters (user_id, followers_count) VALUES ($1, $2) \
         ON CONFLICT (user_id) DO UPDATE SET followers_count = $2",
    )
    .bind(user_id)
    .bind(followers)
    .execute(pool)
    .await
    .unwrap();
}

// ==================== Users ====================

#[tokio::test]
async fn user_create_lookups_and_updates() {
    let Some(db) = TestDb::new("repo_users").await else { return };
    let repo = UserRepository::new(db.pool.clone());

    let alice = create_user(&repo, "Alice").await;
    let counter: (i64, i64, i64) = sqlx::query_as(
        "SELECT followers_count, following_count, pending_requests_count FROM follow_counters WHERE user_id = $1",
    )
    .bind(alice.id)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(counter, (0, 0, 0), "registration initializes the counters");
    assert!(!alice.is_private && !alice.is_verified && !alice.email_verified);
    assert!(repo.create("Alice@example.com", "other", "h").await.is_err(), "duplicate email");
    assert!(repo.create("x@example.com", "Alice", "h").await.is_err(), "duplicate username");
    let users: i64 = sqlx::query_scalar("SELECT count(*) FROM users").fetch_one(&db.pool).await.unwrap();
    assert_eq!(users, 1, "failed registrations roll back");

    assert_eq!(repo.find_by_id(alice.id).await.unwrap().unwrap().username, "Alice");
    assert!(repo.find_by_id(999_999).await.unwrap().is_none());
    assert_eq!(repo.find_by_identifier("Alice@example.com").await.unwrap().unwrap().id, alice.id);
    assert_eq!(repo.find_by_identifier("Alice").await.unwrap().unwrap().id, alice.id);
    assert!(repo.find_by_identifier("nobody").await.unwrap().is_none());
    assert_eq!(repo.find_by_email("Alice@example.com").await.unwrap().unwrap().id, alice.id);
    let bob = create_user(&repo, "bob").await;
    let mut found: Vec<i64> = repo
        .find_by_usernames(&["bob".into(), "Alice".into(), "ghost".into()])
        .await
        .unwrap()
        .iter()
        .map(|u| u.id)
        .collect();
    found.sort_unstable();
    assert_eq!(found, vec![alice.id, bob.id]);
    assert!(repo.find_by_usernames(&[]).await.unwrap().is_empty());
    assert_eq!(repo.get_all().await.unwrap().len(), 2);

    repo.update_username(alice.id, "alice2").await.unwrap();
    assert!(repo.update_username(alice.id, "bob").await.is_err(), "taken");
    repo.update_password(alice.id, "newhash").await.unwrap();
    repo.update_privacy(alice.id, true).await.unwrap();
    assert!(repo.get_privacy(alice.id).await.unwrap());
    repo.update_privacy(alice.id, false).await.unwrap();
    assert!(!repo.get_privacy(alice.id).await.unwrap());
    assert!(matches!(repo.get_privacy(999_999).await, Err(sqlx::Error::RowNotFound)));
    repo.update_bio(alice.id, "hello").await.unwrap();
    assert_eq!(repo.get_bio(alice.id).await.unwrap().as_deref(), Some("hello"));
    repo.update_bio(alice.id, "").await.unwrap();
    assert_eq!(repo.get_bio(alice.id).await.unwrap(), None);
    repo.update_profile_pic(alice.id, Some("https://x/p.jpg"), Some("https://x/t.jpg")).await.unwrap();
    repo.update_email_verified(alice.id, true).await.unwrap();
    let updated = repo.find_by_id(alice.id).await.unwrap().unwrap();
    assert_eq!(updated.username, "alice2");
    assert_eq!(updated.password_hash, "newhash");
    assert_eq!(updated.profile_pic.as_deref(), Some("https://x/p.jpg"));
    assert_eq!(updated.profile_pic_thumb.as_deref(), Some("https://x/t.jpg"));
    assert!(updated.email_verified);
    assert!(updated.updated_at >= alice.updated_at);
    repo.update_profile_pic(alice.id, None, None).await.unwrap();
    assert_eq!(repo.find_by_id(alice.id).await.unwrap().unwrap().profile_pic, None);

    // Search is a case-insensitive substring match.
    create_user(&repo, "carol_x").await;
    let mut hits: Vec<String> = repo.search_by_username("O").await.unwrap().into_iter().map(|u| u.username).collect();
    hits.sort();
    assert_eq!(hits, vec!["bob", "carol_x"]);
    db.finish().await;
}

#[tokio::test]
async fn autocomplete_ranking_escaping_and_limits() {
    let Some(db) = TestDb::new("repo_autocomplete").await else { return };
    let repo = UserRepository::new(db.pool.clone());

    let exact = create_user(&repo, "alex").await;
    sqlx::query("UPDATE users SET is_verified = true, is_private = true, profile_pic = 'p', profile_pic_thumb = 't' WHERE id = $1")
        .bind(exact.id)
        .execute(&db.pool)
        .await
        .unwrap();
    create_user(&repo, "alexab").await;
    let popular = create_user(&repo, "alexba").await;
    create_user(&repo, "xalex").await;
    create_user(&repo, "zzzz").await;
    set_followers(&db.pool, popular.id, 10).await;
    set_followers(&db.pool, exact.id, 3).await;
    // A user without a counters row (created outside the repository, like old Go data).
    sqlx::query("INSERT INTO users (email, username, password_hash) VALUES ('n@example.com', 'alexzz', 'h')")
        .execute(&db.pool)
        .await
        .unwrap();

    let results = repo.autocomplete_users("alex", 10).await.unwrap();
    assert_eq!(names(&results), vec!["alex", "alexba", "alexab", "alexzz", "xalex"]);
    let top = &results[0];
    assert_eq!(top.id, exact.id);
    assert!((top.score - 100.0).abs() < 1e-9);
    assert!(top.is_verified && top.is_private, "private accounts are still suggested");
    assert_eq!((top.profile_pic.as_deref(), top.profile_pic_thumb.as_deref()), (Some("p"), Some("t")));
    assert_eq!(top.followers_count, 3);
    assert!((results[1].score - results[2].score).abs() < 1e-9, "both prefix matches score the same");
    assert!(results[1].score >= 50.0 && results[1].score < 80.0);
    assert_eq!(results[1].followers_count, 10, "equal scores are ordered by follower count");
    assert_eq!(results[3].followers_count, 0, "users without a counters row have 0 followers");
    assert!(results[4].score > 0.15 * 30.0 && results[4].score < 30.0);

    let upper = repo.autocomplete_users("ALEX", 1).await.unwrap();
    assert_eq!(names(&upper), vec!["alex"], "exact matching ignores case");

    for q in ["%", "_", "\\", "%%"] {
        assert!(repo.autocomplete_users(q, 10).await.unwrap().is_empty(), "{q:?} matches literally");
    }
    create_user(&repo, "a_bob").await;
    create_user(&repo, "axbob").await;
    let hits = repo.autocomplete_users("a_b", 10).await.unwrap();
    assert!(names(&hits).contains(&"a_bob"));
    assert!(!names(&hits).contains(&"axbob"), "underscore is not a wildcard");

    for i in 1..=22 {
        create_user(&repo, &format!("sam{i:02}")).await;
    }
    for (limit, want) in [(-1, 12), (0, 12), (3, 3), (20, 20), (21, 20), (100, 20)] {
        assert_eq!(repo.autocomplete_users("sam", limit).await.unwrap().len(), want, "limit {limit}");
    }
    let ties = repo.autocomplete_users("sam", 3).await.unwrap();
    assert_eq!(names(&ties), vec!["sam01", "sam02", "sam03"], "ties ordered by username");
    db.finish().await;
}

// ==================== Recent searches ====================

async fn searched_at(pool: &PgPool, user_id: i64, searched_user_id: i64) -> NaiveDateTime {
    sqlx::query_scalar("SELECT searched_at FROM recent_searches WHERE user_id = $1 AND searched_user_id = $2")
        .bind(user_id)
        .bind(searched_user_id)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn set_searched_at(pool: &PgPool, user_id: i64, searched_user_id: i64, expr: &str) -> NaiveDateTime {
    sqlx::query(&format!(
        "UPDATE recent_searches SET searched_at = {expr} WHERE user_id = $1 AND searched_user_id = $2"
    ))
    .bind(user_id)
    .bind(searched_user_id)
    .execute(pool)
    .await
    .unwrap();
    searched_at(pool, user_id, searched_user_id).await
}

#[tokio::test]
async fn recent_searches_upsert_throttle_and_limits() {
    let Some(db) = TestDb::new("repo_recent").await else { return };
    let users = UserRepository::new(db.pool.clone());
    let repo = RecentSearchRepository::new(db.pool.clone());
    let me = create_user(&users, "me").await;
    let other = create_user(&users, "other").await;
    let a = create_user(&users, "a").await;
    let b = create_user(&users, "b").await;
    sqlx::query("UPDATE users SET is_verified = NULL WHERE id = $1").bind(b.id).execute(&db.pool).await.unwrap();
    set_followers(&db.pool, b.id, 4).await;

    repo.save_recent_search(me.id, a.id).await.unwrap();
    set_searched_at(&db.pool, me.id, a.id, "NOW() - INTERVAL '5 minutes'").await;
    repo.save_recent_search(me.id, b.id).await.unwrap();
    let got = repo.get_recent_searches(me.id, 10).await.unwrap();
    assert_eq!(got.iter().map(|r| r.id).collect::<Vec<_>>(), vec![b.id, a.id], "newest first");
    assert_eq!((got[0].username.as_str(), got[0].followers_count, got[0].is_verified), ("b", 4, false));

    // Invalid ids and self-searches are ignored.
    repo.save_recent_search(0, a.id).await.unwrap();
    repo.save_recent_search(me.id, 0).await.unwrap();
    repo.save_recent_search(me.id, me.id).await.unwrap();
    assert_eq!(repo.get_recent_searches(me.id, 10).await.unwrap().len(), 2);
    assert!(repo.get_recent_searches(0, 5).await.unwrap().is_empty());

    // Throttle: within 60 seconds the timestamp is kept, afterwards refreshed; one row per pair.
    let before = set_searched_at(&db.pool, me.id, a.id, "NOW() - INTERVAL '10 seconds'").await;
    repo.save_recent_search(me.id, a.id).await.unwrap();
    assert_eq!(searched_at(&db.pool, me.id, a.id).await, before);
    let before = set_searched_at(&db.pool, me.id, a.id, "NOW() - INTERVAL '2 minutes'").await;
    repo.save_recent_search(me.id, a.id).await.unwrap();
    assert!(searched_at(&db.pool, me.id, a.id).await > before + Duration::minutes(1));
    let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM recent_searches WHERE user_id = $1")
        .bind(me.id)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(rows, 2);

    // Delete and clear only touch the given user.
    repo.save_recent_search(other.id, a.id).await.unwrap();
    repo.delete_recent_search(me.id, a.id).await.unwrap();
    repo.delete_recent_search(0, b.id).await.unwrap();
    repo.delete_recent_search(me.id, 0).await.unwrap();
    assert_eq!(repo.get_recent_searches(me.id, 10).await.unwrap().iter().map(|r| r.id).collect::<Vec<_>>(), vec![b.id]);
    repo.clear_recent_searches(me.id).await.unwrap();
    repo.clear_recent_searches(0).await.unwrap();
    assert!(repo.get_recent_searches(me.id, 10).await.unwrap().is_empty());
    assert_eq!(repo.get_recent_searches(other.id, 10).await.unwrap().len(), 1);

    // Limits.
    for i in 0..12 {
        let u = create_user(&users, &format!("target{i}")).await;
        repo.save_recent_search(me.id, u.id).await.unwrap();
    }
    for (limit, want) in [(-1, 5), (0, 5), (3, 3), (10, 10), (11, 10), (50, 10)] {
        assert_eq!(repo.get_recent_searches(me.id, limit).await.unwrap().len(), want, "limit {limit}");
    }
    for (limit, want) in [(-1, 6), (0, 6), (4, 4), (10, 10), (11, 10), (50, 10)] {
        assert_eq!(repo.get_trending_users_for_user(me.id, limit).await.unwrap().len(), want, "limit {limit}");
    }
    db.finish().await;
}

#[tokio::test]
async fn trending_users_personalized_then_global() {
    let Some(db) = TestDb::new("repo_trending").await else { return };
    let pool = &db.pool;
    let users = UserRepository::new(pool.clone());
    let follows = FollowRepository::new(pool.clone());
    let repo = RecentSearchRepository::new(pool.clone());

    let me = create_user(&users, "me").await;
    let f1 = create_user(&users, "f1").await;
    let f2 = create_user(&users, "f2").await;
    let f3 = create_user(&users, "f3").await;
    let k = create_user(&users, "k").await;
    let t1 = create_user(&users, "t1").await;
    let t2 = create_user(&users, "t2").await;
    let t3 = create_user_with(&users, "t3", true).await;
    let t4 = create_user_with(&users, "t4", true).await;
    let t5 = create_user(&users, "t5").await;
    let t6 = create_user(&users, "t6").await;
    sqlx::query("UPDATE users SET is_verified = true WHERE id = ANY($1)")
        .bind(vec![t2.id, t6.id])
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("UPDATE users SET profile_pic = 'p1', profile_pic_thumb = 't1' WHERE id = $1")
        .bind(t1.id)
        .execute(pool)
        .await
        .unwrap();

    for (follower, followee, state) in [
        (f1.id, me.id, FOLLOW_STATE_ACTIVE),
        (f2.id, me.id, FOLLOW_STATE_ACTIVE),
        (f3.id, me.id, FOLLOW_STATE_PENDING),
        (me.id, k.id, FOLLOW_STATE_ACTIVE),
        (k.id, t4.id, FOLLOW_STATE_ACTIVE),
        (f2.id, t1.id, FOLLOW_STATE_ACTIVE),
    ] {
        follows.upsert_edge_dual_write(follower, followee, state).await.unwrap();
    }
    for (liker, liked) in [(&f1, &t1), (&f1, &t3), (&f2, &t4), (&f1, &k), (&f3, &t5), (&f1, &t6)] {
        sqlx::query("INSERT INTO likes (liker_id, liked_user_id, liked_date) VALUES ($1, $2, $3)")
            .bind(liker.id)
            .bind(liked.id)
            .bind(day(9))
            .execute(pool)
            .await
            .unwrap();
    }
    sqlx::query("UPDATE likes SET created_at = NOW() - INTERVAL '8 days' WHERE liked_user_id = $1")
        .bind(t6.id)
        .execute(pool)
        .await
        .unwrap();
    let photo_id: i64 = sqlx::query_scalar(
        "INSERT INTO activity_photos (user_id, activity_name, photo_date, photo_url, thumbnail_url) \
         VALUES ($1, 'study', $2, 'u', 't') RETURNING id",
    )
    .bind(t2.id)
    .bind(day(9))
    .fetch_one(pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO story_likes (liker_id, photo_id) VALUES ($1, $2)")
        .bind(f1.id as i32)
        .bind(photo_id as i32)
        .execute(pool)
        .await
        .unwrap();
    for (user, followers) in [(&t5, 50), (&f1, 3), (&f2, 2), (&f3, 1), (&t1, 7)] {
        set_followers(pool, user.id, followers).await;
    }

    let got = repo.get_trending_users_for_user(me.id, 3).await.unwrap();
    assert_eq!(
        got.iter().map(|r| r.id).collect::<Vec<_>>(),
        vec![t2.id, t1.id, t4.id],
        "verified first, then interactions"
    );
    assert_eq!(got.iter().map(|r| r.interaction_count).collect::<Vec<_>>(), vec![1, 2, 1]);
    let row = &got[1];
    assert_eq!(
        (
            row.username.as_str(),
            row.profile_pic.as_deref(),
            row.profile_pic_thumb.as_deref(),
            row.is_verified,
            row.followers_count
        ),
        ("t1", Some("p1"), Some("t1"), false, 7)
    );

    let got = repo.get_trending_users_for_user(me.id, 10).await.unwrap();
    assert_eq!(
        got.iter().map(|r| r.id).collect::<Vec<_>>(),
        vec![t2.id, t1.id, t4.id, t6.id, t5.id, f1.id, f2.id, f3.id],
        "global padding: verified then followers; never self, followed users or private accounts without mutuals"
    );
    assert!(got[3..].iter().all(|r| r.interaction_count == 0));
    assert!(repo.get_trending_users_for_user(0, 5).await.unwrap().is_empty());
    db.finish().await;
}

// ==================== Streaks ====================

#[tokio::test]
async fn streak_queries() {
    let Some(db) = TestDb::new("repo_streaks").await else { return };
    let users = UserRepository::new(db.pool.clone());
    let repo = StreakRepository::new(db.pool.clone());
    let user = create_user(&users, "user").await;
    let other = create_user(&users, "other").await;

    assert!(repo.find_latest_by_user(user.id).await.unwrap().is_none());
    assert!(repo.find_latest_active_by_user(user.id).await.unwrap().is_none());
    assert!(repo.find_previous_by_user(user.id).await.unwrap().is_none());

    let s = |current, longest, d| Streak { id: 0, user_id: user.id, current, longest, activity_date: day(d) };
    repo.create(&mut s(1, 1, 7)).await.unwrap();
    assert!(repo.find_previous_by_user(user.id).await.unwrap().is_none(), "a single record has no previous one");
    let mut second = s(2, 2, 8);
    repo.create(&mut second).await.unwrap();
    assert_ne!(second.id, 0);
    repo.create(&mut s(0, 2, 9)).await.unwrap();
    repo.create(&mut Streak { id: 0, user_id: other.id, current: 9, longest: 9, activity_date: day(20) })
        .await
        .unwrap();

    let latest = repo.find_latest_by_user(user.id).await.unwrap().unwrap();
    assert_eq!((latest.activity_date, latest.current), (day(9), 0));
    let active = repo.find_latest_active_by_user(user.id).await.unwrap().unwrap();
    assert_eq!((active.activity_date, active.current), (day(8), 2));
    assert_eq!(repo.find_previous_by_user(user.id).await.unwrap().unwrap().activity_date, day(8));

    // The most recently written row wins for a date.
    let mut dup = s(5, 5, 8);
    repo.create(&mut dup).await.unwrap();
    assert_eq!(repo.find_by_user_and_date(user.id, day(8)).await.unwrap().unwrap().id, dup.id);
    assert!(repo.find_by_user_and_date(user.id, day(10)).await.unwrap().is_none());

    // Update writes every column; id 0 inserts.
    second.current = 6;
    second.longest = 6;
    repo.update(&mut second).await.unwrap();
    let all = repo.find_all_by_user(user.id).await.unwrap();
    assert_eq!(all.len(), 4);
    assert_eq!(all.first().unwrap().activity_date, day(7), "oldest first");
    assert!(all.iter().any(|r| r.id == second.id && r.current == 6 && r.longest == 6));
    let mut fresh = s(1, 1, 11);
    repo.update(&mut fresh).await.unwrap();
    assert_ne!(fresh.id, 0);

    // Users who missed: current = 0 on the date, reported once.
    let missed = create_user(&users, "missed").await;
    for _ in 0..2 {
        repo.create(&mut Streak { id: 0, user_id: missed.id, current: 0, longest: 3, activity_date: day(9) })
            .await
            .unwrap();
    }
    let mut ids = repo.find_users_missed_streak("2026-03-09").await.unwrap();
    ids.sort_unstable();
    assert_eq!(ids, vec![user.id, missed.id]);
    assert!(repo.find_users_missed_streak("2026-01-01").await.unwrap().is_empty());
    assert!(repo.find_users_missed_streak("not a date").await.is_err());
    db.finish().await;
}

// ==================== Cron job logs ====================

#[tokio::test]
async fn cron_job_claims_are_unique() {
    let Some(db) = TestDb::new("repo_cron").await else { return };
    let repo = CronJobLogRepository::new(db.pool.clone());

    let (first, claimed) = repo.try_claim_job(CRON_JOB_DAILY_STREAK, day(9), "replica-a").await.unwrap();
    assert!(claimed);
    assert_ne!(first.id, 0);
    assert_eq!(first.status, CRON_JOB_STATUS_RUNNING);
    assert_eq!((first.instance_id.as_str(), first.job_date, first.users_count), ("replica-a", day(9), 0));
    assert!((Utc::now() - first.started_at).num_seconds().abs() < 60);
    assert_eq!(first.completed_at, None);

    let (second, claimed) = repo.try_claim_job(CRON_JOB_DAILY_STREAK, day(9), "replica-b").await.unwrap();
    assert!(!claimed, "a job can be claimed once per day");
    assert_eq!((second.id, second.instance_id.as_str()), (first.id, "replica-a"));
    assert!(repo.try_claim_job(CRON_JOB_DAILY_STREAK, day(10), "replica-b").await.unwrap().1, "next day");
    assert!(repo.try_claim_job(CRON_JOB_STREAK_REMINDER, day(9), "replica-b").await.unwrap().1, "other job");

    // Concurrent replicas: exactly one wins.
    let claims = futures::future::join_all((0..8).map(|i| {
        let repo = repo.clone();
        async move { repo.try_claim_job("race", day(9), &format!("replica-{i}")).await.unwrap() }
    }))
    .await;
    assert_eq!(claims.iter().filter(|(_, won)| *won).count(), 1);
    let winner = claims.iter().find(|(_, won)| *won).unwrap().0.id;
    assert!(claims.iter().all(|(log, _)| log.id == winner));
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM cron_job_logs").fetch_one(&db.pool).await.unwrap();
    assert_eq!(count, 4);
    db.finish().await;
}

#[tokio::test]
async fn cron_job_logs_completed_and_recent() {
    let Some(db) = TestDb::new("repo_cron_logs").await else { return };
    let repo = CronJobLogRepository::new(db.pool.clone());
    let t0: DateTime<Utc> = Utc.with_ymd_and_hms(2026, 3, 1, 12, 0, 0).unwrap();
    let log = |job: &str, date, started_at, completed_at, status: &str, users_count, instance: &str| CronJobLog {
        id: 0,
        job_name: job.into(),
        job_date: date,
        started_at,
        completed_at,
        status: status.into(),
        users_count,
        error: String::new(),
        instance_id: instance.into(),
    };
    let mut completed =
        log(CRON_JOB_DAILY_STREAK, day(8), t0, Some(t0 + Duration::minutes(1)), CRON_JOB_STATUS_COMPLETED, 5, "a");
    let mut running =
        log(CRON_JOB_DAILY_STREAK, day(9), t0 + Duration::hours(24), None, CRON_JOB_STATUS_RUNNING, 0, "b");
    let mut other =
        log(CRON_JOB_STREAK_REMINDER, day(9), t0 + Duration::hours(48), None, CRON_JOB_STATUS_COMPLETED, 0, "c");
    let mut defaulted = log("defaults", day(9), t0, None, "", 0, "d");
    for l in [&mut completed, &mut running, &mut other, &mut defaulted] {
        repo.create(l).await.unwrap();
    }
    assert_eq!(defaulted.status, CRON_JOB_STATUS_RUNNING, "empty status takes the column default");

    let got = repo.find_by_job_name_and_date(CRON_JOB_DAILY_STREAK, day(8)).await.unwrap().unwrap();
    assert_eq!((got.id, got.users_count), (completed.id, 5));
    assert!(
        repo.find_by_job_name_and_date(CRON_JOB_DAILY_STREAK, day(9)).await.unwrap().is_none(),
        "only completed runs"
    );
    // GORM wrote Go's zero time for an unset CompletedAt.
    assert_eq!(
        repo.find_recent_by_job_name("defaults", 1).await.unwrap()[0].completed_at,
        Some(gt_core::gojson::go_zero_time())
    );

    running.status = CRON_JOB_STATUS_COMPLETED.into();
    running.completed_at = Some(running.started_at + Duration::minutes(1));
    running.users_count = 7;
    repo.update(&mut running).await.unwrap();
    assert_eq!(repo.find_by_job_name_and_date(CRON_JOB_DAILY_STREAK, day(9)).await.unwrap().unwrap().users_count, 7);

    let recent = repo.find_recent_by_job_name(CRON_JOB_DAILY_STREAK, 10).await.unwrap();
    assert_eq!(recent.iter().map(|l| l.id).collect::<Vec<_>>(), vec![running.id, completed.id], "newest first");
    assert_eq!(repo.find_recent_by_job_name(CRON_JOB_DAILY_STREAK, 1).await.unwrap()[0].id, running.id);
    assert_eq!(repo.find_recent_by_job_name(CRON_JOB_DAILY_STREAK, -1).await.unwrap().len(), 2, "negative: no limit");
    db.finish().await;
}

// ==================== Badges ====================

#[tokio::test]
async fn badge_repository() {
    let Some(db) = TestDb::new("repo_badges").await else { return };
    let users = UserRepository::new(db.pool.clone());
    let repo = BadgeRepository::new(db.pool.clone());
    let user = create_user(&users, "user").await;
    let other = create_user(&users, "other").await;
    let t0 = Utc.with_ymd_and_hms(2020, 3, 1, 12, 0, 0).unwrap();

    let mut defaulted =
        UserBadge { id: 0, user_id: user.id, badge_key: "spark".into(), earned_at: gt_core::gojson::go_zero_time() };
    repo.create(&mut defaulted).await.unwrap();
    assert_ne!(defaulted.id, 0);
    assert!((Utc::now() - defaulted.earned_at).num_seconds().abs() < 60, "zero earned_at takes now()");

    let mut batch = vec![
        UserBadge { id: 0, user_id: user.id, badge_key: "flame".into(), earned_at: t0 },
        UserBadge { id: 0, user_id: other.id, badge_key: "spark".into(), earned_at: t0 + Duration::days(1) },
    ];
    repo.create_batch(&mut batch).await.unwrap();
    assert!(batch.iter().all(|b| b.id != 0));
    repo.create_batch(&mut []).await.unwrap();
    let mut dup = vec![
        UserBadge { id: 0, user_id: other.id, badge_key: "flame".into(), earned_at: t0 },
        UserBadge { id: 0, user_id: user.id, badge_key: "spark".into(), earned_at: t0 },
    ];
    assert!(repo.create_batch(&mut dup).await.is_err(), "duplicate key");
    assert!(!repo.exists_by_user_and_key(other.id, "flame").await.unwrap(), "the batch is all or nothing");

    let mine = repo.find_by_user_id(user.id).await.unwrap();
    assert_eq!(mine.iter().map(|b| b.badge_key.as_str()).collect::<Vec<_>>(), vec!["flame", "spark"], "earliest first");
    assert_eq!(mine[0].earned_at, t0);
    assert_eq!(repo.find_by_user_ids(&[user.id, other.id]).await.unwrap().len(), 3);
    assert!(repo.exists_by_user_and_key(user.id, "flame").await.unwrap());
    let mut keys = repo.get_earned_badge_keys(user.id).await.unwrap();
    keys.sort();
    assert_eq!(keys, vec!["flame", "spark"]);
    repo.delete_by_user_id(user.id).await.unwrap();
    assert!(repo.find_by_user_id(user.id).await.unwrap().is_empty());
    assert_eq!(repo.find_by_user_id(other.id).await.unwrap().len(), 1);
    db.finish().await;
}
