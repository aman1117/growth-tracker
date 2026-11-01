//! Service tests against PostgreSQL (ports of `services_test.go` and `badge_test.go`), plus the
//! `UsersContext` wiring. Skipped without `TEST_DATABASE_URL`.

mod common;

use std::sync::Arc;

use chrono::{Duration, NaiveDate, TimeZone, Utc};
use common::{create_user, create_user_with, TestDb};
use gt_core::config::Config;
use gt_core::models::{Streak, FOLLOW_STATE_ACTIVE};
use gt_core::CoreContext;
use gt_users::repository::{
    BadgeRepository, FollowRepository, RecentSearchRepository, StreakRepository, UserRepository,
};
use gt_users::service::{
    AuthError, AuthService, BadgeService, ProfileService, SearchSuggestionsService, StreakService,
};
use gt_users::UsersContext;

const TOO_LONG_PASSWORD: &str = "0123456789012345678901234567890123456789012345678901234567890123456789012";

#[tokio::test]
async fn auth_service() {
    let Some(db) = TestDb::new("svc_auth").await else { return };
    let users = Arc::new(UserRepository::new(db.pool.clone()));
    let svc = AuthService::new(users.clone());

    svc.register("new@example.com", "newbie", "s3cret-pass").await.unwrap();
    let user = svc.get_user_by_email("new@example.com").await.unwrap().unwrap();
    assert_eq!(user.username, "newbie");
    assert!(user.password_hash.starts_with("$2a$10$"), "{}", user.password_hash);
    let counters: i64 = sqlx::query_scalar("SELECT count(*) FROM follow_counters WHERE user_id = $1")
        .bind(user.id)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(counters, 1);
    assert!(matches!(svc.register("new@example.com", "other", "s3cret-pass").await, Err(AuthError::Database(_))));
    assert!(matches!(
        svc.register("long@example.com", "long", TOO_LONG_PASSWORD).await,
        Err(AuthError::PasswordTooLong)
    ));

    for identifier in ["new@example.com", "newbie"] {
        assert_eq!(svc.authenticate(identifier, "s3cret-pass").await.unwrap().id, user.id);
    }
    assert_eq!(svc.authenticate("newbie", "wrong").await.unwrap_err().to_string(), "invalid password");
    assert_eq!(svc.authenticate("nobody@example.com", "x").await.unwrap_err().to_string(), "user not found");

    // A hash written by the Go backend logs in.
    let go_hash = "$2a$10$SkzLfruj2/DiHqW9dFWw4.EGXM.STQGFVEzR2vhHekx./2UCHh76q";
    users.create("go@example.com", "gouser", go_hash).await.unwrap();
    assert_eq!(svc.authenticate("gouser", "password123").await.unwrap().username, "gouser");

    // Lookups and username change.
    assert_eq!(svc.get_user_by_id(user.id).await.unwrap().unwrap().email, "new@example.com");
    svc.update_username(user.id, "renamed_user").await.unwrap();
    assert_eq!(svc.get_user_by_username("renamed_user").await.unwrap().unwrap().id, user.id);
    assert!(svc.get_user_by_username("newbie").await.unwrap().is_none());

    // Change password.
    let err = svc.change_password(user.id, "not-it", "brand-new-pass").await.unwrap_err();
    assert_eq!(err.to_string(), "current password is incorrect");
    let err = svc.change_password(999_999, "s3cret-pass", "brand-new-pass").await.unwrap_err();
    assert_eq!(err.to_string(), "user not found");
    let err = svc.change_password(user.id, "s3cret-pass", TOO_LONG_PASSWORD).await.unwrap_err();
    assert_eq!(err.to_string(), "bcrypt: password length exceeds 72 bytes");
    svc.change_password(user.id, "s3cret-pass", "brand-new-pass").await.unwrap();
    svc.authenticate("renamed_user", "brand-new-pass").await.unwrap();
    assert!(matches!(svc.authenticate("renamed_user", "s3cret-pass").await, Err(AuthError::InvalidPassword)));

    // Reset password.
    assert!(matches!(svc.reset_password(user.id, TOO_LONG_PASSWORD).await, Err(AuthError::PasswordTooLong)));
    svc.reset_password(user.id, "reset-pass-1").await.unwrap();
    svc.authenticate("new@example.com", "reset-pass-1").await.unwrap();
    db.finish().await;
}

#[tokio::test]
async fn profile_service() {
    let Some(db) = TestDb::new("svc_profile").await else { return };
    let users = Arc::new(UserRepository::new(db.pool.clone()));
    let follows = Arc::new(FollowRepository::new(db.pool.clone()));
    let svc = ProfileService::new(users.clone(), follows.clone());
    let alice = create_user(&users, "alice").await;
    let alicia = create_user_with(&users, "alicia", true).await;
    let bob = create_user(&users, "bob").await;

    svc.update_privacy(alice.id, true).await.unwrap();
    assert!(svc.get_privacy(alice.id).await.unwrap());
    svc.update_privacy(alice.id, false).await.unwrap();
    assert!(!svc.get_privacy(alice.id).await.unwrap());
    svc.update_bio(alice.id, "Learning Rust 🚀").await.unwrap();
    assert_eq!(svc.get_bio(alice.id).await.unwrap().as_deref(), Some("Learning Rust 🚀"));
    svc.update_bio(alice.id, "").await.unwrap();
    assert_eq!(svc.get_bio(alice.id).await.unwrap(), None, "an empty bio is stored as NULL");
    svc.update_profile_pic(alice.id, Some("https://img/a.jpg"), Some("https://img/a_t.jpg")).await.unwrap();
    let profile = svc.get_profile(alice.id).await.unwrap().unwrap();
    assert_eq!(profile.profile_pic.as_deref(), Some("https://img/a.jpg"));
    assert_eq!(profile.profile_pic_thumb.as_deref(), Some("https://img/a_t.jpg"));
    svc.update_profile_pic(alice.id, None, None).await.unwrap();
    assert_eq!(svc.get_profile(alice.id).await.unwrap().unwrap().profile_pic, None);
    assert!(svc.get_privacy(999_999).await.is_err());
    assert!(svc.get_bio(999_999).await.is_err());

    let mut names: Vec<String> = svc.search_users("ALI").await.unwrap().into_iter().map(|u| u.username).collect();
    names.sort();
    assert_eq!(names, vec!["alice", "alicia"]);
    assert_eq!(svc.autocomplete_users("alice", 5).await.unwrap()[0].username, "alice");

    follows.create_follow_with_counters(bob.id, alicia.id, FOLLOW_STATE_ACTIVE, None).await.unwrap();
    assert!(!svc.can_view_profile(None, bob.id).await);
    assert!(svc.can_view_profile(Some(&alicia), alicia.id).await, "own profile");
    assert!(svc.can_view_profile(Some(&alice), 0).await, "public profiles are visible to everyone");
    assert!(svc.can_view_profile(Some(&alicia), bob.id).await, "accepted follower");
    assert!(!svc.can_view_profile(Some(&alicia), alice.id).await, "not a follower");
    assert!(!svc.can_view_profile(Some(&alicia), 0).await, "anonymous visitor");
    db.finish().await;
}

#[tokio::test]
async fn streak_service_add_streak() {
    let Some(db) = TestDb::new("svc_streak").await else { return };
    let users = UserRepository::new(db.pool.clone());
    let repo = Arc::new(StreakRepository::new(db.pool.clone()));
    let svc = StreakService::new(repo.clone());
    let today = Utc::now().date_naive();
    let yesterday = today.pred_opt().unwrap();
    let streak = |user_id: i64, current: i64, longest: i64, date: NaiveDate| {
        let repo = repo.clone();
        async move {
            let mut s = Streak { id: 0, user_id, current, longest, activity_date: date };
            repo.create(&mut s).await.unwrap();
            s
        }
    };

    // First activity starts a streak; repeat logging is idempotent.
    let user = create_user(&users, "first").await;
    svc.add_streak(user.id, today, false).await.unwrap();
    let s = svc.get_streak(user.id, today).await.unwrap().unwrap();
    assert_eq!((s.current, s.longest), (1, 1));
    svc.add_streak(user.id, today, false).await.unwrap();
    assert_eq!(svc.get_all_streaks(user.id).await.unwrap().len(), 1);

    // The day opened by the daily job counts once.
    let user = create_user(&users, "opened").await;
    streak(user.id, 0, 0, today).await;
    svc.add_streak(user.id, today, false).await.unwrap();
    svc.add_streak(user.id, today, false).await.unwrap();
    let all = svc.get_all_streaks(user.id).await.unwrap();
    assert_eq!(all.len(), 1, "the job's record is updated, not duplicated");
    assert_eq!((all[0].current, all[0].longest), (1, 1));

    // Continuing extends the streak and keeps the record.
    let user = create_user(&users, "continuing").await;
    streak(user.id, 3, 5, yesterday).await;
    streak(user.id, 0, 5, today).await;
    svc.add_streak(user.id, today, false).await.unwrap();
    svc.add_streak(user.id, today, false).await.unwrap();
    let s = svc.get_streak(user.id, today).await.unwrap().unwrap();
    assert_eq!((s.current, s.longest), (4, 5));

    // Beating the record raises it.
    let user = create_user(&users, "beating").await;
    streak(user.id, 5, 5, yesterday).await;
    let opened = streak(user.id, 0, 5, today).await;
    svc.add_streak(user.id, today, false).await.unwrap();
    let s = svc.get_streak(user.id, today).await.unwrap().unwrap();
    assert_eq!((s.id, s.current, s.longest), (opened.id, 6, 6));
    assert_eq!(svc.get_latest_streak(user.id).await.unwrap().unwrap().id, s.id);
    assert_eq!(svc.get_latest_active_streak(user.id).await.unwrap().unwrap().id, s.id);

    // Without today's record nothing changes.
    let user = create_user(&users, "missing").await;
    streak(user.id, 2, 2, today - Duration::days(2)).await;
    streak(user.id, 3, 3, yesterday).await;
    svc.add_streak(user.id, today, false).await.unwrap();
    assert_eq!(svc.get_latest_streak(user.id).await.unwrap().unwrap().current, 3);

    // Past dates are ignored outside the daily job.
    let user = create_user(&users, "past").await;
    svc.add_streak(user.id, yesterday, false).await.unwrap();
    assert!(svc.get_latest_streak(user.id).await.unwrap().is_none());

    // The daily job opens the day carrying the record, idempotently.
    let user = create_user(&users, "job").await;
    svc.add_streak(user.id, yesterday, true).await.unwrap();
    let opened = svc.get_streak(user.id, yesterday).await.unwrap().unwrap();
    assert_eq!((opened.current, opened.longest), (0, 0));
    streak(user.id, 9, 12, today - Duration::days(5)).await;
    sqlx::query("UPDATE streaks SET longest = 12 WHERE id = $1").bind(opened.id).execute(&db.pool).await.unwrap();
    svc.add_streak(user.id, today, true).await.unwrap();
    svc.add_streak(user.id, today, true).await.unwrap();
    let s = svc.get_streak(user.id, today).await.unwrap().unwrap();
    assert_eq!((s.current, s.longest), (0, 12));
    assert_eq!(svc.get_all_streaks(user.id).await.unwrap().len(), 3);
    assert_eq!(svc.get_latest_active_streak(user.id).await.unwrap().unwrap().current, 9);
    db.finish().await;
}

#[tokio::test]
async fn badge_service() {
    let Some(db) = TestDb::new("svc_badges").await else { return };
    let users = Arc::new(UserRepository::new(db.pool.clone()));
    let svc = BadgeService::new(Arc::new(BadgeRepository::new(db.pool.clone())), users.clone());
    let user = create_user(&users, "user").await;
    let keys = |badges: &[gt_users::BadgeDto]| badges.iter().map(|b| b.key.clone()).collect::<Vec<_>>();
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();

    assert!(svc.check_and_award_badges(user.id, 0).await.unwrap().is_empty(), "no streak, no badge");
    let awarded = svc.check_and_award_badges(user.id, 7).await.unwrap();
    assert_eq!(keys(&awarded), vec!["first_step", "spark_starter"]);
    assert_eq!(
        awarded[0],
        gt_users::BadgeDto {
            key: "first_step".into(),
            name: "First Step".into(),
            icon: "Footprints".into(),
            color: "#22c55e".into(),
            threshold: 1,
            earned: false,
            earned_at: today,
        }
    );
    assert!(svc.check_and_award_badges(user.id, 7).await.unwrap().is_empty(), "awarded once");
    assert_eq!(keys(&svc.check_and_award_badges(user.id, 30).await.unwrap()), vec!["flame_keeper", "iron_will"]);

    // Listing marks earned badges with their date in the process time zone (UTC in production).
    let other = create_user(&users, "other").await;
    let first_award = Utc.with_ymd_and_hms(2025, 3, 4, 23, 30, 0).unwrap();
    svc.award_badge_with_date(other.id, "spark_starter", first_award).await.unwrap();
    svc.award_badge_with_date(other.id, "spark_starter", Utc.with_ymd_and_hms(2025, 4, 4, 0, 0, 0).unwrap())
        .await
        .unwrap();
    let expected_date = gt_core::gojson::to_go_local(&first_award).format("%Y-%m-%d").to_string();
    let badges = svc.get_user_badges(other.id).await.unwrap();
    assert_eq!(
        keys(&badges),
        vec!["first_step", "spark_starter", "flame_keeper", "iron_will", "diamond_mind", "titan", "legendary"]
    );
    for b in &badges {
        if b.key == "spark_starter" {
            assert!(b.earned);
            assert_eq!(b.earned_at, expected_date, "awarding again keeps the original date");
        } else {
            assert!(!b.earned && b.earned_at.is_empty(), "{}", b.key);
        }
    }
    assert_eq!(svc.get_badges_by_username("other").await.unwrap(), Some(badges));
    assert_eq!(svc.get_badges_by_username("nobody").await.unwrap(), None);
    db.finish().await;
}

#[tokio::test]
async fn search_suggestions_service() {
    let Some(db) = TestDb::new("svc_search").await else { return };
    let users = UserRepository::new(db.pool.clone());
    let svc = SearchSuggestionsService::new(Arc::new(RecentSearchRepository::new(db.pool.clone())));
    let me = create_user(&users, "me").await;
    let alice = create_user(&users, "alice").await;
    let bob = create_user(&users, "bob").await;

    svc.save_recent_search(me.id, alice.id).await.unwrap();
    svc.save_recent_search(me.id, bob.id).await.unwrap();
    svc.save_recent_search(me.id, me.id).await.unwrap();
    let mut ids: Vec<i64> = svc.get_recent_searches(me.id, 10).await.unwrap().iter().map(|r| r.id).collect();
    ids.sort_unstable();
    assert_eq!(ids, vec![alice.id, bob.id]);
    svc.delete_recent_search(me.id, alice.id).await.unwrap();
    assert_eq!(
        svc.get_recent_searches(me.id, 10).await.unwrap().iter().map(|r| r.id).collect::<Vec<_>>(),
        vec![bob.id]
    );
    svc.clear_recent_searches(me.id).await.unwrap();
    assert!(svc.get_recent_searches(me.id, 10).await.unwrap().is_empty());

    let mut trending: Vec<i64> =
        svc.get_trending_users_for_user(me.id, 5).await.unwrap().iter().map(|u| u.id).collect();
    trending.sort_unstable();
    assert_eq!(trending, vec![alice.id, bob.id], "falls back to everyone else");
    db.finish().await;
}

#[tokio::test]
async fn users_context_wires_everything() {
    let Some(db) = TestDb::new("svc_context").await else { return };
    let mut config = Config::from_env();
    config.email.resend_api_key = String::new();
    config.server.frontend_url = "https://app.example.com".into();
    let core = CoreContext::new(Arc::new(config), db.pool.clone());
    let ctx = UsersContext::new(&core);

    let email = ctx.email_service.as_ref().expect("email is available (SMTP fallback)");
    assert_eq!(email.frontend_url(), "https://app.example.com");
    assert!(format!("{:?}", email.sender()).contains("SmtpEmailSender"));

    // Services share the repositories.
    ctx.auth_service.register("ctx@example.com", "ctxuser", "password1").await.unwrap();
    let user = ctx.user_repo.find_by_username("ctxuser").await.unwrap().unwrap();
    let other = create_user(&ctx.user_repo, "other").await;
    ctx.follow_service.follow(user.id, other.id).await.unwrap();
    assert_eq!(ctx.follow_service.get_follow_counts(other.id).await.unwrap(), (1, 0));
    assert!(ctx.profile_service.can_view_profile(Some(&other), user.id).await);
    ctx.streak_service.add_streak(user.id, Utc::now().date_naive(), false).await.unwrap();
    assert_eq!(ctx.streak_repo.find_latest_by_user(user.id).await.unwrap().unwrap().current, 1);
    assert_eq!(ctx.badge_service.check_and_award_badges(user.id, 1).await.unwrap().len(), 1);
    assert!(ctx.badge_repo.exists_by_user_and_key(user.id, "first_step").await.unwrap());
    ctx.search_suggestions_service.save_recent_search(user.id, other.id).await.unwrap();
    assert_eq!(ctx.recent_search_repo.get_recent_searches(user.id, 5).await.unwrap().len(), 1);
    assert!(ctx.cron_job_log_repo.try_claim_job("ctx", Utc::now().date_naive(), "test").await.unwrap().1);
    assert!(ctx.follow_repo.is_following(user.id, other.id).await.unwrap());
    db.finish().await;
}
