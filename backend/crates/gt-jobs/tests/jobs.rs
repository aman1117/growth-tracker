//! `JobsContext` wiring, the follow tombstone cleanup and the Web Push side of the streak
//! reminders (in their own test binary because the push publisher is process-global).

mod common;

use std::sync::{Arc, Mutex};
use std::time::Duration as StdDuration;

use chrono::{Duration, Utc};
use common::*;
use gt_core::config::Config;
use gt_core::models::{CRON_JOB_DAILY_STREAK, CRON_JOB_STATUS_COMPLETED, CRON_JOB_STREAK_REMINDER};
use gt_core::{timeutil, CoreContext};
use gt_jobs::{JobsContext, ScheduledJob};
use gt_notify::push::{
    set_push_publisher, OutgoingMessage, PropertyValue, PushMessage, PushPublisher, PushTransport, ServiceBusError,
};
use gt_notify::NotifyContext;
use gt_users::UsersContext;
use sqlx::PgPool;

fn jobs(pool: &PgPool, retention_days: i64) -> JobsContext {
    let mut config = Config::from_env();
    config.jwt.secret_key = "gt-jobs-test-secret".into();
    config.follow.tombstone_retention_days = retention_days;
    let core = CoreContext::new(Arc::new(config), pool.clone());
    JobsContext::new(&core, &UsersContext::new(&core), &NotifyContext::new(&core))
}

async fn insert_edge(pool: &PgPool, follower_id: i64, followee_id: i64, state: &str, updated_days_ago: i64) {
    let updated_at = Utc::now() - Duration::days(updated_days_ago);
    for sql in [
        "INSERT INTO follow_edges_by_follower (follower_id, followee_id, state, updated_at) VALUES ($1, $2, $3, $4)",
        "INSERT INTO follow_edges_by_followee (follower_id, followee_id, state, updated_at) VALUES ($1, $2, $3, $4)",
    ] {
        sqlx::query(sql).bind(follower_id).bind(followee_id).bind(state).bind(updated_at).execute(pool).await.unwrap();
    }
}

#[tokio::test]
async fn tombstone_cleanup_keeps_recent_and_active_edges() {
    let Some(db) = TestDb::new("tombstones").await else {
        return;
    };
    let pool = &db.pool;
    let (a, b, c) = (create_user(pool, "a").await.id, create_user(pool, "b").await.id, create_user(pool, "c").await.id);
    insert_edge(pool, a, b, "REMOVED", 8).await;
    insert_edge(pool, a, c, "REMOVED", 6).await;
    insert_edge(pool, b, c, "ACTIVE", 30).await;

    // A non-positive retention means the default 7 days.
    assert_eq!(jobs(pool, 0).cleanup_follow_tombstones().await.unwrap(), 2, "one edge in each table");
    let remaining: Vec<(i64, i64)> = sqlx::query_as(
        "SELECT follower_id, followee_id FROM follow_edges_by_followee ORDER BY follower_id, followee_id",
    )
    .fetch_all(pool)
    .await
    .unwrap();
    assert_eq!(remaining, vec![(a, c), (b, c)]);

    jobs(pool, 5).run(ScheduledJob::FollowTombstoneCleanup).await;
    assert_eq!(count(pool, "SELECT count(*) FROM follow_edges_by_follower WHERE state = 'REMOVED'").await, 0);
    db.finish().await;
}

#[tokio::test]
async fn scheduled_daily_job_uses_the_wired_services() {
    let Some(db) = TestDb::new("scheduled_daily").await else {
        return;
    };
    let pool = &db.pool;
    let user = create_user(pool, "solo").await;
    let jobs = jobs(pool, 7);

    jobs.run(ScheduledJob::DailyStreak).await;
    jobs.run(ScheduledJob::NotificationCleanup).await;

    assert_eq!(streaks_on(pool, user.id, timeutil::today_ist()).await, vec![(0, 0)]);
    let logs = job_logs(pool, CRON_JOB_DAILY_STREAK).await;
    assert_eq!(logs.len(), 1);
    assert_eq!(logs[0].status, CRON_JOB_STATUS_COMPLETED);
    assert_eq!(logs[0].instance_id, jobs.cron_service.instance_id());
    db.finish().await;
}

/// Records every message sent to Service Bus.
#[derive(Debug, Default)]
struct Recorder {
    sent: Mutex<Vec<OutgoingMessage>>,
}

#[async_trait::async_trait]
impl PushTransport for Recorder {
    async fn send(&self, message: &OutgoingMessage) -> Result<(), ServiceBusError> {
        self.sent.lock().unwrap().push(message.clone());
        Ok(())
    }
}

#[tokio::test]
async fn reminders_queue_a_web_push_per_reminded_user() {
    let Some(db) = TestDb::new("reminder_push").await else {
        return;
    };
    let pool = &db.pool;
    let recorder = Arc::new(Recorder::default());
    let publisher = Arc::new(PushPublisher::with_transport(recorder.clone(), 10, 1, StdDuration::from_millis(10)));
    set_push_publisher(Some(publisher.clone()));
    let today = timeutil::today_ist();
    let idle = create_user(pool, "idle").await;
    create_streak(pool, idle.id, 0, 4, today).await;
    let active = create_user(pool, "active").await;
    create_streak(pool, active.id, 2, 4, today).await;

    jobs(pool, 7).run(ScheduledJob::StreakReminder).await;
    publisher.close().await;
    set_push_publisher(None);

    let notifs = notifications_of(pool, idle.id).await;
    assert_eq!(notifs.len(), 1);
    let sent = recorder.sent.lock().unwrap().clone();
    assert_eq!(sent.len(), 1);
    let push = PushMessage::from_json(&sent[0].body).unwrap();
    let dedupe_key = format!("streak_reminder:{}:{}", idle.id, timeutil::format_date(&today));
    assert_eq!(push.user_id, idle.id);
    assert_eq!(push.dedupe_key, dedupe_key);
    assert_eq!(push.deep_link, "/");
    assert_eq!(push.ttl_seconds, 7200);
    assert_eq!(push.data.unwrap()["notification_id"], notifs[0].id);
    assert!(sent[0].application_properties.contains(&("dedupe_key".to_string(), PropertyValue::Text(dedupe_key))));
    assert_eq!(job_logs(pool, CRON_JOB_STREAK_REMINDER).await[0].users_count, 1);
    db.finish().await;
}
