//! Service tests (port of the activity and tile config parts of
//! `internal/services/services_test.go` and of `internal/services/analytics_test.go`).

mod common;

use std::sync::Arc;

use chrono::{Datelike, NaiveDate, Utc};
use common::{broken_pool, create_user, day, insert_activity, insert_photo, insert_streak, photo_label, Stack, TestDb};
use gt_activity::dto::{ActivitySummary, DayActivityBreakdown, StreakInfo};
use gt_activity::{
    ActivityError, ActivityPhotoLabels, ActivityRepository, ActivityService, AnalyticsService, TileConfigError,
    TileConfigRepository, TileConfigService,
};
use gt_core::models::{FOLLOW_STATE_ACTIVE, NOTIF_TYPE_STREAK_MILESTONE};
use gt_notify::{NotificationRepository, NotificationService};
use gt_users::{FollowRepository, StreakRepository, StreakService, UserRepository};
use serde_json::{json, Map, Value};
use sqlx::PgPool;

/// "Today" for streak updates: Go compared the request date with `time.Now()` in the date's
/// (UTC) location.
fn today() -> NaiveDate {
    Utc::now().date_naive()
}

fn add(date: NaiveDate, days: i64) -> NaiveDate {
    date + chrono::Duration::days(days)
}

fn object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => panic!("not an object"),
    }
}

/// An activity service whose repositories use the given pools.
fn activity_service(
    activities: &PgPool,
    streaks: &PgPool,
    users: &PgPool,
    notifications: Option<&PgPool>,
) -> ActivityService {
    ActivityService::new(
        Arc::new(ActivityRepository::new(activities.clone())),
        Arc::new(StreakService::new(Arc::new(StreakRepository::new(streaks.clone())))),
        Arc::new(UserRepository::new(users.clone())),
        Arc::new(FollowRepository::new(users.clone())),
        notifications
            .map(|pool| Arc::new(NotificationService::new(Arc::new(NotificationRepository::new(pool.clone()))))),
    )
}

async fn hours_on(pool: &PgPool, user_id: i64, date: NaiveDate) -> Vec<(String, f32)> {
    sqlx::query_as(
        "SELECT name, duration_hours::float4 FROM activities WHERE user_id = $1 AND activity_date = $2 ORDER BY name",
    )
    .bind(user_id)
    .bind(date)
    .fetch_all(pool)
    .await
    .unwrap()
}

async fn notification_count(pool: &PgPool) -> i64 {
    common::count(pool, "SELECT count(*) FROM notifications").await
}

/// Lets background notification tasks finish.
async fn settle() {
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
}

// ==================== ActivityService ====================

#[tokio::test]
async fn activity_service_create_or_update_activity() {
    let Some(db) = TestDb::new("svc_activity_create").await else { return };
    let pool = &db.pool;
    let stack = Stack::new(pool);
    let svc = activity_service(pool, pool, pool, Some(pool));
    let user = create_user(&stack, "user", false).await;
    let follower = create_user(&stack, "follower", false).await;
    common::follow(&stack, &follower, &user).await;
    let today = today();

    svc.create_or_update_activity(user.id, "study", 6.0, today, Some("chapter 3".into())).await.unwrap();
    svc.create_or_update_activity(user.id, "study", 10.0, today, Some("chapter 4".into()))
        .await
        .expect("logging the same activity replaces its hours");
    assert_eq!(hours_on(pool, user.id, today).await, vec![("study".to_string(), 10.0)]);
    let note: Option<String> = sqlx::query_scalar("SELECT note FROM activities WHERE user_id = $1 AND name = 'study'")
        .bind(user.id)
        .fetch_one(pool)
        .await
        .unwrap();
    assert_eq!(note.as_deref(), Some("chapter 4"));

    let streak =
        stack.users.streak_service.get_streak(user.id, today).await.unwrap().expect("logging today starts a streak");
    assert_eq!((streak.current, streak.longest), (1, 1));

    let err = svc.create_or_update_activity(user.id, "sleep", 14.5, today, None).await.unwrap_err();
    assert!(matches!(err, ActivityError::HoursExceeded));
    assert_eq!(err.to_string(), "total hours cannot be more than 24");
    assert_eq!(hours_on(pool, user.id, today).await.len(), 1);

    svc.create_or_update_activity(user.id, "sleep", 14.0, today, None).await.unwrap();
    let notifs = common::wait_notifications(pool, follower.id, NOTIF_TYPE_STREAK_MILESTONE, 1).await;
    assert_eq!(notifs.len(), 1, "followers hear when the day reaches 24 hours");
    assert_eq!(notifs[0].title, "Day Completed! 🎯");
    assert_eq!(notifs[0].metadata.as_ref().unwrap()["completed_date"], today.format("%Y-%m-%d").to_string());

    svc.create_or_update_activity(user.id, "sleep", 13.0, today, None).await.unwrap();
    svc.create_or_update_activity(user.id, "sleep", 14.0, today, None).await.unwrap();
    settle().await;
    assert_eq!(
        common::notifications(pool, follower.id, NOTIF_TYPE_STREAK_MILESTONE).await.len(),
        1,
        "dropping below 24 and back does not notify again"
    );
    let streak = stack.users.streak_service.get_streak(user.id, today).await.unwrap().unwrap();
    assert_eq!(streak.current, 1, "more logging on the same day keeps the streak");

    // Past days are saved without touching the streak.
    let past = add(today, -3);
    svc.create_or_update_activity(user.id, "family", 2.0, past, None).await.unwrap();
    assert_eq!(hours_on(pool, user.id, past).await, vec![("family".to_string(), 2.0)]);
    assert!(stack.users.streak_service.get_streak(user.id, past).await.unwrap().is_none());

    // Invalid values are rejected by the model.
    let other = create_user(&stack, "other", false).await;
    let err = svc.create_or_update_activity(other.id, "juggling", 1.0, today, None).await.unwrap_err();
    assert!(err.to_string().contains("invalid activity name"));
    svc.create_or_update_activity(other.id, "study", 1.0, today, None).await.unwrap();
    let err = svc.create_or_update_activity(other.id, "study", -1.0, today, None).await.unwrap_err();
    assert!(err.to_string().contains("duration_hours must be between 0 and 24"));
    assert_eq!(hours_on(pool, other.id, today).await, vec![("study".to_string(), 1.0)]);

    db.finish().await;
}

#[tokio::test]
async fn activity_service_database_failures() {
    let Some(db) = TestDb::new("svc_activity_failures").await else { return };
    let pool = &db.pool;
    let broken = broken_pool().await;
    let stack = Stack::new(pool);
    let user = create_user(&stack, "user", false).await;
    let follower = create_user(&stack, "follower", false).await;
    let today = today();

    let svc = activity_service(&broken, &broken, &broken, None);
    assert!(matches!(
        svc.create_or_update_activity(user.id, "study", 1.0, today, None).await,
        Err(ActivityError::Database(_))
    ));

    let streak_broken = activity_service(pool, &broken, pool, None);
    assert!(
        streak_broken.create_or_update_activity(user.id, "study", 1.0, today, None).await.is_err(),
        "streak failures are reported"
    );
    assert_eq!(hours_on(pool, user.id, today).await.len(), 1, "the activity itself is saved");

    let no_notifier = activity_service(pool, pool, pool, None);
    let lazy = create_user(&stack, "lazy", false).await;
    common::follow(&stack, &follower, &lazy).await;
    no_notifier.create_or_update_activity(lazy.id, "sleep", 24.0, today, None).await.unwrap();
    settle().await;
    assert_eq!(notification_count(pool).await, 0, "no notification service, no notification");
    db.finish().await;
}

#[tokio::test]
async fn activity_service_notify_followers_of_day_completion() {
    let Some(db) = TestDb::new("svc_activity_notify").await else { return };
    let pool = &db.pool;
    let broken = broken_pool().await;
    let stack = Stack::new(pool);
    let date = day(2026, 5, 3);
    let user = create_user(&stack, "user", false).await;
    stack.users.user_repo.update_profile_pic(user.id, Some("https://img/u.jpg"), None).await.unwrap();
    let follower = create_user(&stack, "follower", false).await;
    common::follow(&stack, &follower, &user).await;

    activity_service(pool, pool, pool, Some(pool)).notify_followers_of_day_completion(user.id, date);
    let notifs = common::wait_notifications(pool, follower.id, NOTIF_TYPE_STREAK_MILESTONE, 1).await;
    assert_eq!(notifs.len(), 1);
    assert_eq!(notifs[0].body, "user logged all 24 hours on 3 May, 2026");
    assert_eq!(notifs[0].metadata.as_ref().unwrap()["completed_user_avatar"], "https://img/u.jpg");

    // Failures and edge cases notify nobody.
    let lonely = create_user(&stack, "lonely", false).await;
    let ghost_follower = create_user(&stack, "ghost_follower", false).await;
    stack.users.follow_repo.upsert_edge_dual_write(ghost_follower.id, 999_999, FOLLOW_STATE_ACTIVE).await.unwrap();
    let before = notification_count(pool).await;
    activity_service(pool, pool, pool, Some(pool)).notify_followers_of_day_completion(lonely.id, date);
    activity_service(pool, pool, pool, Some(pool)).notify_followers_of_day_completion(999_999, date);
    let user_lookup_fails = ActivityService::new(
        Arc::new(ActivityRepository::new(pool.clone())),
        stack.users.streak_service.clone(),
        Arc::new(UserRepository::new(broken.clone())),
        stack.users.follow_repo.clone(),
        Some(stack.notify.notification_service.clone()),
    );
    user_lookup_fails.notify_followers_of_day_completion(user.id, add(date, 1));
    let follower_lookup_fails = ActivityService::new(
        Arc::new(ActivityRepository::new(pool.clone())),
        stack.users.streak_service.clone(),
        stack.users.user_repo.clone(),
        Arc::new(FollowRepository::new(broken.clone())),
        Some(stack.notify.notification_service.clone()),
    );
    follower_lookup_fails.notify_followers_of_day_completion(user.id, add(date, 2));
    activity_service(pool, pool, pool, Some(&broken)).notify_followers_of_day_completion(user.id, add(date, 3));
    activity_service(pool, pool, pool, None).notify_followers_of_day_completion(user.id, date);
    settle().await;
    assert_eq!(notification_count(pool).await, before);
    db.finish().await;
}

#[tokio::test]
async fn activity_service_queries() {
    let Some(db) = TestDb::new("svc_activity_queries").await else { return };
    let pool = &db.pool;
    let stack = Stack::new(pool);
    let svc = activity_service(pool, pool, pool, None);
    let user = create_user(&stack, "user", false).await;
    let (d1, d2) = (day(2026, 3, 1), day(2026, 3, 2));
    insert_activity(pool, user.id, "study", 2.5, d1).await;
    insert_activity(pool, user.id, "sleep", 1.0, d1).await;
    insert_activity(pool, user.id, "workout", 2.25, d2).await;
    insert_activity(pool, user.id, "workout", 4.0, day(2026, 3, 9)).await;

    assert_eq!(svc.get_activities(user.id, d1, d2).await.unwrap().len(), 3);
    let totals = svc.get_daily_totals(user.id, d1, d2).await.unwrap();
    assert_eq!(totals.into_iter().collect::<Vec<_>>(), vec![("2026-03-01".into(), 3.5), ("2026-03-02".into(), 2.25)]);
    assert!(svc.get_daily_totals(user.id, day(2025, 1, 1), day(2025, 1, 7)).await.unwrap().is_empty());

    let broken = broken_pool().await;
    assert!(activity_service(&broken, &broken, &broken, None).get_daily_totals(user.id, d1, d2).await.is_err());
    db.finish().await;
}

// ==================== TileConfigService ====================

const TILE_A: &str = "8a0d6c2e-1f3b-4c5d-9e7f-0a1b2c3d4e5f";
const TILE_B: &str = "1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b";

fn custom_tile(id: &str, name: &str) -> Value {
    json!({"id": id, "name": name, "icon": "Music", "color": "#22c55e"})
}

fn tile_service(pool: &PgPool, photos: Option<&PgPool>) -> TileConfigService {
    TileConfigService::new(
        Arc::new(TileConfigRepository::new(pool.clone())),
        Arc::new(UserRepository::new(pool.clone())),
        photos.map(|p| Arc::new(ActivityPhotoLabels::new(p.clone()))),
    )
}

#[tokio::test]
async fn tile_config_service_save_config() {
    let Some(db) = TestDb::new("svc_tile_config").await else { return };
    let pool = &db.pool;
    let stack = Stack::new(pool);
    let svc = tile_service(pool, Some(pool));
    let user = create_user(&stack, "user", false).await;
    let photo = insert_photo(pool, user.id, &format!("custom:{TILE_A}"), today(), Some("Guitar")).await;

    assert_eq!(svc.get_config(user.id).await.unwrap(), None);

    svc.save_config(user.id, Some(object(json!({"order": ["study"], "customTiles": [custom_tile(TILE_A, "Guitar")]}))))
        .await
        .unwrap();
    let cfg = svc.get_config_by_username("user").await.unwrap().unwrap();
    assert_eq!(cfg.config.unwrap()["order"], json!(["study"]));

    svc.save_config(
        user.id,
        Some(object(json!({"customTiles": [custom_tile(TILE_A, "Guitar"), custom_tile(TILE_B, "Chess")]}))),
    )
    .await
    .unwrap();
    assert_eq!(photo_label(pool, photo).await.as_deref(), Some("Guitar"), "unchanged names leave photos alone");

    svc.save_config(user.id, Some(object(json!({"customTiles": [custom_tile(TILE_A, "Piano")]})))).await.unwrap();
    assert_eq!(photo_label(pool, photo).await.as_deref(), Some("Piano"), "renamed tiles relabel their photos");
    let data = svc.get_config(user.id).await.unwrap().unwrap().config_data().unwrap();
    assert_eq!(data.custom_tiles.unwrap()[0].name, "Piano");

    let err = svc.save_config(user.id, Some(object(json!({"colors": {"study": "nope"}})))).await.unwrap_err();
    assert!(matches!(err, TileConfigError::Validation(ref v) if v.code == "INVALID_COLOR"));

    // A relabel failure aborts the save.
    common::fail_on(pool, "UPDATE", "activity_photos").await;
    let err = svc.save_config(user.id, Some(object(json!({"customTiles": [custom_tile(TILE_A, "Drums")]})))).await;
    assert!(matches!(err, Err(TileConfigError::Database(_))));
    common::stop_failing(pool, "UPDATE", "activity_photos").await;
    assert_eq!(photo_label(pool, photo).await.as_deref(), Some("Piano"));
    let stored = svc.get_config(user.id).await.unwrap().unwrap().config_data().unwrap();
    assert_eq!(stored.custom_tiles.unwrap()[0].name, "Piano", "the configuration is not saved");

    // Without a photo relabeler names change without relabeling.
    tile_service(pool, None)
        .save_config(user.id, Some(object(json!({"customTiles": [custom_tile(TILE_A, "Violin")]}))))
        .await
        .unwrap();
    assert_eq!(photo_label(pool, photo).await.as_deref(), Some("Piano"));

    // A corrupt stored config is replaced (and skips the relabeling).
    sqlx::query(r#"UPDATE tile_configs SET config = '{"customTiles":"corrupt"}' WHERE user_id = $1"#)
        .bind(user.id)
        .execute(pool)
        .await
        .unwrap();
    svc.save_config(user.id, Some(object(json!({"customTiles": [custom_tile(TILE_A, "Flute")]})))).await.unwrap();
    assert_eq!(photo_label(pool, photo).await.as_deref(), Some("Piano"));

    assert!(matches!(svc.get_config_by_username("nobody_at_all").await, Err(TileConfigError::UserNotFound)));
    db.finish().await;
}

// ==================== AnalyticsService ====================

fn analytics(activities: &PgPool, streaks: &PgPool) -> AnalyticsService {
    AnalyticsService::new(
        Arc::new(ActivityRepository::new(activities.clone())),
        Arc::new(StreakRepository::new(streaks.clone())),
    )
}

/// Monday of the current week; analytics takes the date of `time.Now()` (process time zone).
fn monday_this_week() -> NaiveDate {
    let now = gt_core::timeutil::today_local();
    add(now, -i64::from(now.weekday().num_days_from_monday()))
}

fn summary(items: &[(&str, f32)]) -> Vec<ActivitySummary> {
    items
        .iter()
        .map(|(name, total_hours)| ActivitySummary { name: (*name).into(), total_hours: *total_hours })
        .collect()
}

fn breakdown(items: &[(&str, f32)]) -> Vec<DayActivityBreakdown> {
    items.iter().map(|(name, hours)| DayActivityBreakdown { name: (*name).into(), hours: *hours }).collect()
}

#[tokio::test]
async fn analytics_past_week() {
    let Some(db) = TestDb::new("svc_analytics_past").await else { return };
    let pool = &db.pool;
    let stack = Stack::new(pool);
    let user = create_user(&stack, "user", false).await;
    let current = monday_this_week();
    let week = add(current, -14);

    // The selected week: Monday, Wednesday and Sunday.
    insert_activity(pool, user.id, "workout", 1.0, week).await;
    insert_activity(pool, user.id, "study", 2.0, week).await;
    insert_activity(pool, user.id, "sleep", 8.0, add(week, 2)).await;
    insert_activity(pool, user.id, "reels", 0.0, add(week, 2)).await;
    insert_activity(pool, user.id, "study", 1.0, add(week, 6)).await;
    // The week before, the current week, a day outside all three weeks and another user.
    insert_activity(pool, user.id, "study", 6.0, add(week, -6)).await;
    insert_activity(pool, user.id, "study", 3.0, current).await;
    insert_activity(pool, user.id, "study", 5.0, add(week, -8)).await;
    let other = create_user(&stack, "other", false).await;
    insert_activity(pool, other.id, "study", 4.0, week).await;

    let got = analytics(pool, pool).get_week_analytics(user.id, week).await.unwrap();
    assert!(got.success);
    assert!(!got.is_current_week);
    assert_eq!(got.total_hours_this_week, 12.0);
    assert_eq!(got.total_hours_prev_week, 6.0);
    assert_eq!(got.total_hours_current_week, 3.0);
    assert_eq!(got.percentage_change, 100.0);
    assert_eq!(got.percentage_vs_current, 300.0);

    assert_eq!(got.daily_breakdown.len(), 7);
    for (i, name) in ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].iter().enumerate() {
        assert_eq!(got.daily_breakdown[i].date, add(week, i as i64).format("%Y-%m-%d").to_string());
        assert_eq!(got.daily_breakdown[i].day_name, *name);
    }
    let days = &got.daily_breakdown;
    assert_eq!(days[0].total_hours, 3.0);
    assert_eq!(days[0].activities, breakdown(&[("study", 2.0), ("workout", 1.0)]), "sorted by hours");
    assert_eq!(days[2].total_hours, 8.0);
    assert_eq!(days[2].activities, breakdown(&[("sleep", 8.0)]), "zero-hour entries are left out");
    assert_eq!(days[6].activities, breakdown(&[("study", 1.0)]));
    assert_eq!(days[1].total_hours, 0.0);
    assert_eq!(days[1].activities, vec![], "empty days have an empty list, not null");

    assert_eq!(got.activity_summary, summary(&[("sleep", 8.0), ("study", 3.0), ("workout", 1.0)]));
    db.finish().await;
}

#[tokio::test]
async fn analytics_current_week() {
    let Some(db) = TestDb::new("svc_analytics_current").await else { return };
    let pool = &db.pool;
    let stack = Stack::new(pool);
    let user = create_user(&stack, "user", false).await;
    let week = monday_this_week();
    insert_activity(pool, user.id, "study", 2.5, week).await;

    let got = analytics(pool, pool).get_week_analytics(user.id, week).await.unwrap();
    assert!(got.is_current_week);
    assert_eq!(got.total_hours_this_week, 2.5);
    assert_eq!(got.total_hours_prev_week, 0.0);
    assert_eq!(got.percentage_change, 100.0, "any activity after an empty week counts as +100%");
    assert_eq!(got.total_hours_current_week, 0.0, "only past weeks are compared with the current one");
    assert_eq!(got.percentage_vs_current, 0.0);
    db.finish().await;
}

#[tokio::test]
async fn analytics_empty_weeks() {
    let Some(db) = TestDb::new("svc_analytics_empty").await else { return };
    let pool = &db.pool;
    let stack = Stack::new(pool);
    let svc = analytics(pool, pool);
    let user = create_user(&stack, "user", false).await;
    let week = add(monday_this_week(), -35);

    let got = svc.get_week_analytics(user.id, week).await.unwrap();
    assert_eq!(got.total_hours_this_week, 0.0);
    assert_eq!(got.percentage_change, 0.0);
    assert_eq!(got.percentage_vs_current, 0.0);
    assert_eq!(got.activity_summary, vec![]);
    assert_eq!(got.streak, StreakInfo::default());
    assert!(got.daily_breakdown.iter().all(|d| d.activities.is_empty()));

    insert_activity(pool, user.id, "family", 4.0, add(week, 3)).await;
    let got = svc.get_week_analytics(user.id, week).await.unwrap();
    assert_eq!(got.percentage_change, 100.0);
    assert_eq!(got.percentage_vs_current, 100.0, "compared with an empty current week");
    db.finish().await;
}

#[tokio::test]
async fn analytics_streak_info() {
    let Some(db) = TestDb::new("svc_analytics_streaks").await else { return };
    let pool = &db.pool;
    let stack = Stack::new(pool);
    let user = create_user(&stack, "user", false).await;
    let today = today();
    for (current, longest, offset) in [(1, 1, -10), (2, 2, -9), (0, 2, -8), (1, 2, -4), (2, 2, -3), (0, 2, -1)] {
        insert_streak(pool, user.id, current, longest, add(today, offset)).await;
    }

    let got = analytics(pool, pool).get_week_analytics(user.id, monday_this_week()).await.unwrap();
    assert_eq!(
        got.streak,
        StreakInfo {
            current: 0,
            longest: 2,
            longest_start: add(today, -4).format("%Y-%m-%d").to_string(),
            longest_end: add(today, -3).format("%Y-%m-%d").to_string(),
        },
        "the latest of equally long streaks is reported"
    );

    let broken = broken_pool().await;
    let got = analytics(pool, &broken)
        .get_week_analytics(user.id, monday_this_week())
        .await
        .expect("streak lookups are best effort");
    assert_eq!(got.streak, StreakInfo::default());
    db.finish().await;
}

#[tokio::test]
async fn analytics_activity_query_failures() {
    let broken = broken_pool().await;
    let past_week = add(monday_this_week(), -7);
    assert!(analytics(&broken, &broken).get_week_analytics(1, past_week).await.is_err());
}
