//! Generates missing profile picture thumbnails (port of `cmd/backfill_profile_thumbs`).
//!
//! ```text
//! DB_HOST=... DB_NAME=... DB_USER=... DB_PASSWORD=... [DB_PORT=5432] [DB_SSL_MODE=require] \
//! AZURE_STORAGE_CONNECTION_STRING=... [AZURE_STORAGE_CONTAINER=profile-pictures] \
//!     cargo run --release -p gt-photos --bin backfill_profile_thumbs
//! ```
//!
//! Only the process environment is read (no `.env` file), as in Go. Progress is printed to
//! stderr in Go's `log` format.

use std::fmt::Display;
use std::time::Duration;

use gt_core::config::DatabaseConfig;
use gt_photos::backfill::Backfill;
use gt_photos::BlobClient;

/// Go `log.Printf`: local time prefix, one line on stderr.
fn log(message: impl Display) {
    eprintln!("{} {message}", chrono::Local::now().format("%Y/%m/%d %H:%M:%S"));
}

/// Go `log.Fatal`.
fn fatal(message: impl Display) -> ! {
    log(message);
    std::process::exit(1)
}

/// The variable, or `fallback` when unset or empty.
fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).ok().filter(|value| !value.is_empty()).unwrap_or_else(|| fallback.to_string())
}

#[tokio::main]
async fn main() {
    let db = DatabaseConfig {
        url: String::new(),
        host: env_or("DB_HOST", ""),
        port: env_or("DB_PORT", "5432"),
        name: env_or("DB_NAME", ""),
        username: env_or("DB_USER", ""),
        password: env_or("DB_PASSWORD", ""),
        ssl_mode: env_or("DB_SSL_MODE", "require"),
        max_idle_conns: 2,
        max_open_conns: 2,
        conn_max_lifetime: Duration::ZERO,
        conn_max_idle_time: Duration::ZERO,
    };
    let connection_string = env_or("AZURE_STORAGE_CONNECTION_STRING", "");
    let container = env_or("AZURE_STORAGE_CONTAINER", "profile-pictures");

    if db.host.is_empty() || db.name.is_empty() || db.username.is_empty() || db.password.is_empty() {
        fatal("Missing required DB environment variables");
    }
    if connection_string.is_empty() {
        fatal("AZURE_STORAGE_CONNECTION_STRING is required");
    }

    let pool =
        gt_core::db::connect(&db).await.unwrap_or_else(|err| fatal(format!("Failed to connect to database: {err:#}")));
    let blob = BlobClient::from_connection_string(&connection_string)
        .unwrap_or_else(|err| fatal(format!("Failed to create blob client: {err}")));
    let backfill = Backfill::new(pool, blob, container)
        .unwrap_or_else(|err| fatal(format!("Failed to create HTTP client: {err}")));

    log("Starting profile picture thumbnail backfill...");
    let summary =
        backfill.run(&mut |line| log(line)).await.unwrap_or_else(|err| fatal(format!("Failed to query users: {err}")));
    log(format!(
        "Backfill complete: {} processed, {} skipped/failed, {} total",
        summary.processed,
        summary.failed,
        summary.processed + summary.failed
    ));
}
