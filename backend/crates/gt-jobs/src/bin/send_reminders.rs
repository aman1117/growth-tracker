//! Sends a streak reminder notification to every user (port of `cmd/send_reminders/main.go`).
//!
//! Run with `cargo run --bin send_reminders` or
//! `docker compose --profile send-reminders run --rm send-reminders`. Reads `DB_HOST`,
//! `DB_PORT`, `DB_NAME`, `DB_USERNAME`, `DB_PASSWORD` and `DB_SSLMODE` (local docker-compose
//! defaults). Notifications are inserted directly (no real-time delivery or Web Push), dated
//! 2026-01-14 like the Go script.

use gt_core::models::NOTIF_TYPE_STREAK_AT_RISK;
use gt_jobs::cli::{self, DbParams, REMINDER_PRODUCTION_INDICATORS};
use gt_jobs::{go_fatal, go_log};
use gt_notify::{NewNotification, NotificationRepository};
use gt_users::UserRepository;
use serde_json::json;

/// The reminder date the Go script hard-coded into the metadata.
const REMINDER_DATE: &str = "2026-01-14";

#[tokio::main]
async fn main() {
    go_log!("🔔 Sending Streak Reminder Notifications to ALL users...");

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

    let users = match UserRepository::new(pool.clone()).get_all().await {
        Ok(users) => users,
        Err(err) => go_fatal!("❌ Failed to get users: {err}"),
    };
    go_log!("📋 Found {} users", users.len());

    let notifications = NotificationRepository::new(pool);
    let (mut success, mut failed) = (0, 0);
    for user in &users {
        let notif = NewNotification::new(
            user.id,
            NOTIF_TYPE_STREAK_AT_RISK,
            "Don't Lose Your Streak! 🔥",
            "You haven't logged today. Update now to keep your streak!",
            Some(json!({ "activity_type": "daily", "streak_count": 0, "date": REMINDER_DATE })),
        );
        match notifications.create(&notif).await {
            Ok(_) => {
                go_log!("   ✅ Sent to {} (ID: {})", user.username, user.id);
                success += 1;
            }
            Err(err) => {
                go_log!("   ❌ Failed for {} (ID: {}): {}", user.username, user.id, err);
                failed += 1;
            }
        }
    }

    go_log!("");
    go_log!("=== Complete: {success} sent, {failed} failed ===");
}
