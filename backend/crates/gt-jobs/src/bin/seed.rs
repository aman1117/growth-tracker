//! Database seeder for local development (port of `cmd/seed/main.go`).
//!
//! Run with `cargo run --bin seed` or `docker compose --profile seed up seed`. Reads `ENV`,
//! `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USERNAME`, `DB_PASSWORD` and `DB_SSLMODE` (local
//! docker-compose defaults) and refuses to run against anything that looks like production.

use gt_jobs::cli::{self, DbParams, SEED_PRODUCTION_INDICATORS};
use gt_jobs::seed;
use gt_jobs::{go_fatal, go_log};
use rand::rngs::StdRng;
use rand::SeedableRng;

#[tokio::main]
async fn main() {
    go_log!("🌱 Starting database seeder...");

    if cli::env_or("ENV", "development") == "production" {
        go_fatal!("❌ REFUSING TO SEED: ENV is set to 'production'. This seeder is for local development only!");
    }

    let db = DbParams::dev_from_env();
    if cli::looks_like_production(&db.host, SEED_PRODUCTION_INDICATORS) {
        go_fatal!("❌ REFUSING TO SEED: DB_HOST '{}' appears to be a production database!", db.host);
    }
    if db.name.to_lowercase().contains("prod") {
        go_fatal!("❌ REFUSING TO SEED: DB_NAME '{}' appears to be a production database!", db.name);
    }

    go_log!("📊 Connecting to database: {}@{}:{}/{} (sslmode={})", db.user, db.host, db.port, db.name, db.ssl_mode);
    let pool = match db.connect().await {
        Ok(pool) => pool,
        Err(err) => go_fatal!("❌ Failed to connect to database: {err:#}"),
    };
    go_log!("✅ Database connected");

    go_log!("📦 Running migrations...");
    if let Err(err) = gt_core::db::migrate(&pool).await {
        go_fatal!("❌ Migration failed: {err:#}");
    }

    let user_count = seed::count_users(&pool).await;
    if user_count > 0 {
        go_log!("ℹ️  Database already has {user_count} users. Skipping seed.");
        go_log!("✅ Seeder complete (no changes)");
        return;
    }

    let mut rng = StdRng::from_entropy();
    let users = match seed::seed_users(&pool).await {
        Ok(users) => users,
        Err(err) => go_fatal!("❌ Failed to seed users: {err:#}"),
    };
    if let Err(err) = seed::seed_activities(&pool, &users, &mut rng).await {
        go_fatal!("❌ Failed to seed activities: {err}");
    }
    seed::seed_badges(&pool, &users).await;
    seed::seed_follows(&pool, &users, &mut rng).await;

    go_log!("\n🎉 Database seeding complete!");
    go_log!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    go_log!("Test Users (password: {}):", seed::SEED_PASSWORD);
    for user in &users {
        go_log!("  • {} ({})", user.email, user.username);
    }
    go_log!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
}
