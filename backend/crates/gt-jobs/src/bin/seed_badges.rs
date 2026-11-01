//! Awards existing users the badges their streaks earned (port of `migrations/seed_badges.go`).
//!
//! Run with `cargo run --bin seed_badges`. Like the Go script it reads `DB_HOST`, `DB_PORT`
//! (default 5432), `DB_NAME`, `DB_USER`, `DB_PASSWORD` and `DB_SSL_MODE` (default `require`);
//! host, name, user and password are required. Applies the schema first (the Go script
//! auto-migrated `user_badges`) and is idempotent.

use gt_jobs::badge_backfill;
use gt_jobs::cli::{env_or, DbParams};
use gt_jobs::{go_fatal, go_log};
use gt_users::BadgeRepository;

#[tokio::main]
async fn main() {
    let db = DbParams {
        host: env_or("DB_HOST", ""),
        port: env_or("DB_PORT", "5432"),
        name: env_or("DB_NAME", ""),
        user: env_or("DB_USER", ""),
        password: env_or("DB_PASSWORD", ""),
        ssl_mode: env_or("DB_SSL_MODE", "require"),
    };
    if db.host.is_empty() || db.name.is_empty() || db.user.is_empty() || db.password.is_empty() {
        go_fatal!("Missing required environment variables: DB_HOST, DB_NAME, DB_USER, DB_PASSWORD");
    }

    let pool = match db.connect().await {
        Ok(pool) => pool,
        Err(err) => go_fatal!("Failed to connect to database: {err:#}"),
    };

    if let Err(err) = gt_core::db::migrate(&pool).await {
        go_fatal!("Failed to migrate UserBadge table: {err:#}");
    }
    go_log!("✓ UserBadge table migrated");

    let user_streaks = match badge_backfill::load_user_streaks(&pool).await {
        Ok(rows) => rows,
        Err(err) => go_fatal!("Failed to get user streaks: {err}"),
    };
    go_log!("Found {} users with streaks to process", user_streaks.len());

    let badge_repo = BadgeRepository::new(pool.clone());
    let mut total = 0;
    for streak in &user_streaks {
        match badge_backfill::seed_badges_for_user(&pool, &badge_repo, streak.user_id, streak.max_longest).await {
            Ok(created) => {
                total += created;
                if created > 0 {
                    go_log!(
                        "✓ User {}: awarded {} badge(s) for longest streak of {} days",
                        streak.user_id,
                        created,
                        streak.max_longest
                    );
                }
            }
            Err(err) => go_log!("Error seeding badges for user {}: {}", streak.user_id, err),
        }
    }

    go_log!("\n=== Migration Complete ===");
    go_log!("Total badges created: {total}");
}
