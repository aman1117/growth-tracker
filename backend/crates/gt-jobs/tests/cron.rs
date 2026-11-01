//! `CronService` against a real database (ports of the cron tests in
//! `internal/services/email_test.go`).

mod common;

use chrono::{Duration, Utc};
use common::*;
use futures::future::join_all;
use gt_core::models::{
    CRON_JOB_DAILY_STREAK, CRON_JOB_STATUS_COMPLETED, CRON_JOB_STATUS_FAILED, CRON_JOB_STREAK_REMINDER,
    NOTIF_TYPE_STREAK_AT_RISK,
};
use gt_core::timeutil;

// ==================== Daily streak job ====================

#[tokio::test]
async fn daily_job_opens_today_for_every_user_once() {
    let Some(db) = TestDb::new("daily_job").await else {
        return;
    };
    let pool = &db.pool;
    let today = timeutil::today_ist();
    let veteran = create_user(pool, "veteran").await;
    create_streak(pool, veteran.id, 3, 5, today - Duration::days(1)).await;
    let newcomer = create_user(pool, "newcomer").await;

    cron_service(Deps::all(pool)).run_daily_job().await.unwrap();

    assert_eq!(streaks_on(pool, veteran.id, today).await, vec![(0, 5)], "the record carries over");
    assert_eq!(streaks_on(pool, newcomer.id, today).await, vec![(0, 0)]);
    let logs = job_logs(pool, CRON_JOB_DAILY_STREAK).await;
    assert_eq!(logs.len(), 1);
    assert_eq!(logs[0].status, CRON_JOB_STATUS_COMPLETED);
    assert_eq!(logs[0].users_count, 2);
    assert_eq!(logs[0].instance_id, "cron-test");
    assert_eq!(logs[0].job_date, today);
    assert_eq!(logs[0].error, "");
    assert_recent(logs[0].completed_at);

    // Another replica (or a retry) finds today's job claimed and does nothing.
    let late = create_user(pool, "late").await;
    cron_service(Deps::all(pool)).with_instance_id("other").run_daily_job().await.unwrap();
    assert!(streaks_on(pool, late.id, today).await.is_empty());
    assert_eq!(job_logs(pool, CRON_JOB_DAILY_STREAK).await.len(), 1);
    db.finish().await;
}

#[tokio::test]
async fn daily_job_runs_on_one_replica_only() {
    let Some(db) = TestDb::new("daily_job_replicas").await else {
        return;
    };
    let pool = &db.pool;
    for name in ["a", "b", "c"] {
        create_user(pool, name).await;
    }

    let replicas: Vec<_> =
        (0..5).map(|i| cron_service(Deps::all(pool)).with_instance_id(format!("replica-{i}"))).collect();
    for result in join_all(replicas.iter().map(|svc| svc.run_daily_job())).await {
        result.unwrap();
    }

    assert_eq!(count(pool, "SELECT count(*) FROM streaks").await, 3, "one record per user");
    let logs = job_logs(pool, CRON_JOB_DAILY_STREAK).await;
    assert_eq!(logs.len(), 1);
    assert_eq!(logs[0].status, CRON_JOB_STATUS_COMPLETED);
    assert_eq!(logs[0].users_count, 3);
    assert!(logs[0].instance_id.starts_with("replica-"));
    db.finish().await;
}

#[tokio::test]
async fn daily_job_without_job_log_is_idempotent() {
    let Some(db) = TestDb::new("daily_job_untracked").await else {
        return;
    };
    let pool = &db.pool;
    let user = create_user(pool, "solo").await;
    let svc = cron_service(Deps { job_logs: None, ..Deps::all(pool) });

    svc.run_daily_job().await.unwrap();
    svc.run_daily_job().await.unwrap();

    assert_eq!(
        streaks_on(pool, user.id, timeutil::today_ist()).await.len(),
        1,
        "the per-user check keeps reruns idempotent"
    );
    assert_eq!(count(pool, "SELECT count(*) FROM cron_job_logs").await, 0);
    db.finish().await;
}

#[tokio::test]
async fn daily_job_continues_when_claiming_fails() {
    let Some(db) = TestDb::new("daily_job_claim_fails").await else {
        return;
    };
    let pool = &db.pool;
    let user = create_user(pool, "solo").await;
    let svc = cron_service(Deps { job_logs: Some(broken_pool().await), ..Deps::all(pool) });

    svc.run_daily_job().await.unwrap();
    assert_eq!(streaks_on(pool, user.id, timeutil::today_ist()).await.len(), 1);
    db.finish().await;
}

#[tokio::test]
async fn daily_job_records_a_failure_to_load_users() {
    let Some(db) = TestDb::new("daily_job_users_fail").await else {
        return;
    };
    let pool = &db.pool;
    let svc = cron_service(Deps { users: broken_pool().await, ..Deps::all(pool) });

    assert!(svc.run_daily_job().await.is_err());
    let logs = job_logs(pool, CRON_JOB_DAILY_STREAK).await;
    assert_eq!(logs.len(), 1);
    assert_eq!(logs[0].status, CRON_JOB_STATUS_FAILED);
    assert_eq!(logs[0].users_count, 0);
    assert!(!logs[0].error.is_empty());
    assert_recent(logs[0].completed_at);
    db.finish().await;
}

#[tokio::test]
async fn daily_job_records_users_processed_before_a_failure() {
    let Some(db) = TestDb::new("daily_job_streak_fails").await else {
        return;
    };
    let pool = &db.pool;
    create_user(pool, "first").await;
    create_user(pool, "second").await;
    // Every streak insert after the first one fails.
    sqlx::query(
        "CREATE FUNCTION fail_second_streak() RETURNS trigger LANGUAGE plpgsql AS $$ \
         BEGIN IF (SELECT count(*) FROM streaks) >= 1 THEN RAISE EXCEPTION 'injected'; END IF; RETURN NEW; END $$",
    )
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "CREATE TRIGGER fail_second_streak BEFORE INSERT ON streaks FOR EACH ROW EXECUTE FUNCTION fail_second_streak()",
    )
    .execute(pool)
    .await
    .unwrap();

    let err = cron_service(Deps::all(pool)).run_daily_job().await.unwrap_err();
    assert_eq!(err.to_string(), "ERROR: injected (SQLSTATE P0001)", "Go's pgx error text");
    let logs = job_logs(pool, CRON_JOB_DAILY_STREAK).await;
    assert_eq!(logs.len(), 1);
    assert_eq!(logs[0].status, CRON_JOB_STATUS_FAILED);
    assert_eq!(logs[0].users_count, 1, "users processed before the failure");
    assert_eq!(logs[0].error, "ERROR: injected (SQLSTATE P0001)");
    db.finish().await;
}

// ==================== Streak reminders ====================

#[tokio::test]
async fn reminders_notify_users_who_have_not_logged_today() {
    let Some(db) = TestDb::new("reminders").await else {
        return;
    };
    let pool = &db.pool;
    let today = timeutil::today_ist();
    let idle = create_user(pool, "idle").await;
    create_streak(pool, idle.id, 0, 4, today).await;
    let active = create_user(pool, "active").await;
    create_streak(pool, active.id, 2, 4, today).await;
    let lapsed = create_user(pool, "lapsed").await;
    create_streak(pool, lapsed.id, 0, 1, today - Duration::days(1)).await;
    let svc = cron_service(Deps::all(pool));

    svc.send_streak_reminders().await.unwrap();

    let notifs = notifications_of(pool, idle.id).await;
    assert_eq!(notifs.len(), 1);
    assert_eq!(notifs[0].notif_type, NOTIF_TYPE_STREAK_AT_RISK);
    assert_eq!(notifs[0].title, "Don't Lose Your Streak! 🔥");
    assert!(notifications_of(pool, active.id).await.is_empty());
    assert!(notifications_of(pool, lapsed.id).await.is_empty());
    let logs = job_logs(pool, CRON_JOB_STREAK_REMINDER).await;
    assert_eq!(logs.len(), 1);
    assert_eq!(logs[0].status, CRON_JOB_STATUS_COMPLETED);
    assert_eq!(logs[0].users_count, 1);
    assert_eq!(logs[0].job_date, today);

    svc.send_streak_reminders().await.unwrap();
    assert_eq!(notifications_of(pool, idle.id).await.len(), 1, "a second run on the same day is skipped");
    db.finish().await;
}

#[tokio::test]
async fn reminders_with_nobody_to_remind_complete_with_zero() {
    let Some(db) = TestDb::new("reminders_nobody").await else {
        return;
    };
    let pool = &db.pool;

    cron_service(Deps::all(pool)).send_streak_reminders().await.unwrap();
    let logs = job_logs(pool, CRON_JOB_STREAK_REMINDER).await;
    assert_eq!(logs.len(), 1);
    assert_eq!(logs[0].status, CRON_JOB_STATUS_COMPLETED);
    assert_eq!(logs[0].users_count, 0);
    db.finish().await;
}

#[tokio::test]
async fn reminders_continue_when_claiming_fails() {
    let Some(db) = TestDb::new("reminders_claim_fails").await else {
        return;
    };
    let pool = &db.pool;
    let user = create_user(pool, "solo").await;
    create_streak(pool, user.id, 0, 0, timeutil::today_ist()).await;
    let svc = cron_service(Deps { job_logs: Some(broken_pool().await), ..Deps::all(pool) });

    svc.send_streak_reminders().await.unwrap();
    assert_eq!(notifications_of(pool, user.id).await.len(), 1);
    db.finish().await;
}

#[tokio::test]
async fn failed_reminders_are_counted_but_not_fatal() {
    let Some(db) = TestDb::new("reminders_fail").await else {
        return;
    };
    let pool = &db.pool;
    let user = create_user(pool, "solo").await;
    create_streak(pool, user.id, 0, 0, timeutil::today_ist()).await;
    let svc = cron_service(Deps { notifs: Some(broken_pool().await), ..Deps::all(pool) });

    svc.send_streak_reminders().await.unwrap();
    let logs = job_logs(pool, CRON_JOB_STREAK_REMINDER).await;
    assert_eq!(logs.len(), 1);
    assert_eq!(logs[0].status, CRON_JOB_STATUS_COMPLETED);
    assert_eq!(logs[0].users_count, 0, "only successful reminders are counted");
    db.finish().await;
}

#[tokio::test]
async fn reminders_record_a_failure_to_find_users() {
    let Some(db) = TestDb::new("reminders_lookup_fails").await else {
        return;
    };
    let pool = &db.pool;
    let svc = cron_service(Deps { streaks: broken_pool().await, ..Deps::all(pool) });

    let err = svc.send_streak_reminders().await.unwrap_err();
    assert!(err.to_string().starts_with("failed to find users who missed streak: "), "{err}");
    let logs = job_logs(pool, CRON_JOB_STREAK_REMINDER).await;
    assert_eq!(logs.len(), 1);
    assert_eq!(logs[0].status, CRON_JOB_STATUS_FAILED);
    assert!(!logs[0].error.is_empty());
    db.finish().await;
}

// ==================== Notification cleanup ====================

#[tokio::test]
async fn cleanup_deletes_old_notifications() {
    let Some(db) = TestDb::new("notification_cleanup").await else {
        return;
    };
    let pool = &db.pool;
    let user = create_user(pool, "solo").await;
    seed_notification(pool, user.id, Utc::now() - Duration::days(100)).await;
    let recent = seed_notification(pool, user.id, Utc::now()).await;
    let svc = cron_service(Deps { job_logs: None, ..Deps::all(pool) });

    svc.cleanup_old_notifications().await.unwrap();
    let remaining: Vec<i64> = notifications_of(pool, user.id).await.iter().map(|n| n.id).collect();
    assert_eq!(remaining, vec![recent]);
    svc.cleanup_old_notifications().await.unwrap();

    let broken = cron_service(Deps { notifs: Some(broken_pool().await), ..Deps::all(pool) });
    let err = broken.cleanup_old_notifications().await.unwrap_err();
    assert!(err.to_string().starts_with("notification cleanup failed: "), "{err}");
    db.finish().await;
}
