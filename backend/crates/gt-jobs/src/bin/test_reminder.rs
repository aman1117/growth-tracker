//! Manually triggers streak reminder notifications (port of `cmd/test_reminder/main.go`).
//!
//! Run with `cargo run --bin test_reminder` or
//! `docker compose --profile test-reminder up test-reminder`. Reads `DB_HOST`, `DB_PORT`,
//! `DB_NAME`, `DB_USERNAME`, `DB_PASSWORD` and `DB_SSLMODE` (local docker-compose defaults),
//! lists the users who have not logged today (IST) and asks before notifying them; when nobody
//! is missing it offers to send a test notification to a user id. Redis and Web Push are not
//! configured, so notifications are only stored.

use std::io::Write;
use std::sync::Arc;

use chrono::Local;
use gt_core::models::{Notification, NOTIF_TYPE_STREAK_AT_RISK};
use gt_core::timeutil;
use gt_jobs::cli::scan::{parse_scanned_uint, read_token};
use gt_jobs::cli::{self, DbParams, REMINDER_PRODUCTION_INDICATORS};
use gt_jobs::{go_fatal, go_log};
use gt_notify::{NotificationRepository, NotificationService};
use gt_users::{StreakRepository, UserRepository};
use sqlx::PgPool;

/// Go `fmt.Print(prompt)` followed by `fmt.Scan`: the next whitespace-separated token of stdin.
fn prompt(text: &str) -> String {
    print!("{text}");
    let _ = std::io::stdout().flush();
    read_token(&mut std::io::stdin().lock())
}

#[tokio::main]
async fn main() {
    gt_core::logging::init_console();
    go_log!("🔔 Testing Streak Reminder Notifications...");

    let db = DbParams::dev_from_env();
    if cli::looks_like_production(&db.host, REMINDER_PRODUCTION_INDICATORS) {
        go_fatal!("❌ REFUSING: DB_HOST '{}' appears to be production!", db.host);
    }

    go_log!("📊 Connecting to: {}@{}:{}/{}", db.user, db.host, db.port, db.name);
    let pool = match db.connect().await {
        Ok(pool) => pool,
        Err(err) => go_fatal!("❌ Failed to connect: {err:#}"),
    };
    go_log!("✅ Connected to database");

    let user_repo = UserRepository::new(pool.clone());
    let streak_repo = StreakRepository::new(pool.clone());
    let notifications = NotificationService::new(Arc::new(NotificationRepository::new(pool.clone())));

    let today = timeutil::format_date(&timeutil::today_ist());
    go_log!("📅 Checking for users who haven't logged on: {today}");

    let user_ids = match streak_repo.find_users_missed_streak(&today).await {
        Ok(ids) => ids,
        Err(err) => go_fatal!("❌ Failed to query: {err}"),
    };

    if user_ids.is_empty() {
        send_test_notification(&user_repo, &notifications, &today).await;
        std::process::exit(0);
    }

    go_log!("📋 Found {} users who haven't logged today", user_ids.len());
    for &user_id in &user_ids {
        if let Ok(Some(user)) = user_repo.find_by_id(user_id).await {
            go_log!("   - {} (ID: {})", user.username, user_id);
        }
    }

    let confirm = prompt("\n🚀 Send notifications to these users? (y/n): ");
    if confirm.to_lowercase() != "y" {
        go_log!("❌ Cancelled");
        std::process::exit(0);
    }

    let (mut success, mut failed) = (0, 0);
    for &user_id in &user_ids {
        match notifications.notify_streak_reminder(user_id, &today).await {
            Ok(()) => {
                go_log!("   ✅ Sent to user {user_id}");
                success += 1;
            }
            Err(err) => {
                go_log!("   ❌ Failed for user {user_id}: {err}");
                failed += 1;
            }
        }
    }

    go_log!("");
    go_log!("=== Complete: {success} sent, {failed} failed ===");
    go_log!("Check the notifications table or the frontend notification bell!");

    go_log!("");
    go_log!("📬 Recent streak_at_risk notifications:");
    for notif in recent_reminders(&pool).await {
        go_log!(
            "   [{}] User {}: {}",
            notif.created_at.with_timezone(&Local).format("%H:%M:%S"),
            notif.user_id,
            notif.body
        );
    }
}

/// Nobody to remind: offers to send a test reminder to a user id (0 or invalid input skips).
async fn send_test_notification(user_repo: &UserRepository, notifications: &NotificationService, today: &str) {
    go_log!("✅ All users have logged today! No reminders needed.");
    go_log!("");
    go_log!("💡 To test, you can:");
    go_log!("   1. Create a user who hasn't logged today");
    go_log!("   2. Or manually call NotifyStreakReminder for your user ID");

    // Like fmt.Scan into a uint: unparsable input leaves 0.
    let test_user_id =
        parse_scanned_uint(&prompt("\n🧪 Enter your user ID to send a test notification (or 0 to skip): "))
            .unwrap_or(0);
    if test_user_id == 0 {
        return;
    }

    let user = match i64::try_from(test_user_id) {
        Ok(id) => user_repo.find_by_id(id).await.ok().flatten(),
        Err(_) => None,
    };
    let Some(user) = user else {
        go_log!("❌ User {test_user_id} not found");
        std::process::exit(1);
    };
    go_log!("📤 Sending test notification to user: {} (ID: {})", user.username, test_user_id);

    if let Err(err) = notifications.notify_streak_reminder(user.id, today).await {
        go_fatal!("❌ Failed: {err}");
    }
    go_log!("✅ Test notification sent! Check the notification bell in the app.");
}

/// The five newest streak reminders (empty on error, as Go ignored it).
async fn recent_reminders(pool: &PgPool) -> Vec<Notification> {
    let sql =
        format!("SELECT {} FROM notifications WHERE type = $1 ORDER BY created_at DESC LIMIT 5", Notification::COLUMNS);
    sqlx::query_as::<_, Notification>(&sql).bind(NOTIF_TYPE_STREAK_AT_RISK).fetch_all(pool).await.unwrap_or_default()
}
