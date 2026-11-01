//! PostgreSQL connection pool and schema management (port of `internal/database`).

use std::str::FromStr;
use std::time::Duration;

use anyhow::Context;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::{Executor, PgPool};

use crate::config::DatabaseConfig;

/// Idempotent DDL matching the schema the Go backend created (see `schema.sql`).
pub const SCHEMA_SQL: &str = include_str!("schema.sql");

/// Statements the Go server never required at startup (its manual autocomplete migration):
/// applied one by one after [`SCHEMA_SQL`], and a failure (e.g. a managed server that does not
/// allow the extension) is logged instead of stopping the server.
pub const OPTIONAL_SCHEMA: &[(&str, &str)] = &[
    ("pg_trgm extension", "CREATE EXTENSION IF NOT EXISTS pg_trgm"),
    (
        "trigram username index",
        "CREATE INDEX IF NOT EXISTS idx_users_username_trgm ON users USING gin (username gin_trgm_ops)",
    ),
];

/// Arbitrary key serializing concurrent schema runs across replicas.
const SCHEMA_LOCK_KEY: i64 = 0x6774_7363_6865_6d61; // "gtschema"

/// Opens the connection pool with the configured limits.
pub async fn connect(cfg: &DatabaseConfig) -> anyhow::Result<PgPool> {
    let options = PgConnectOptions::from_str(&cfg.dsn()).context("invalid database DSN")?;
    let max = u32::try_from(cfg.max_open_conns.max(1)).unwrap_or(100);
    let pool = PgPoolOptions::new()
        .max_connections(max)
        .min_connections(0)
        .acquire_timeout(Duration::from_secs(30))
        .idle_timeout(Some(cfg.conn_max_idle_time).filter(|d| !d.is_zero()))
        .max_lifetime(Some(cfg.conn_max_lifetime).filter(|d| !d.is_zero()))
        .connect_with(options)
        .await
        .context("failed to connect to PostgreSQL")?;
    Ok(pool)
}

/// Creates any missing tables, columns and indexes (the equivalent of GORM's `AutoMigrate`).
/// Safe to run on every start and from several replicas at once.
pub async fn migrate(pool: &PgPool) -> anyhow::Result<()> {
    let mut conn = pool.acquire().await.context("acquire connection for migration")?;
    sqlx::query("SELECT pg_advisory_lock($1)")
        .bind(SCHEMA_LOCK_KEY)
        .execute(&mut *conn)
        .await
        .context("take schema lock")?;
    // Every statement is `IF NOT EXISTS`; their "already exists, skipping" notices are noise.
    let _ = conn.execute("SET client_min_messages TO warning").await;
    let result = conn.execute(SCHEMA_SQL).await.map(|_| ()).context("apply schema");
    if result.is_ok() {
        for (name, statement) in OPTIONAL_SCHEMA {
            if let Err(err) = conn.execute(*statement).await {
                tracing::warn!(error = %err, "Optional schema step '{name}' failed; continuing without it");
            }
        }
    }
    let _ = conn.execute("RESET client_min_messages").await;
    let unlock = sqlx::query("SELECT pg_advisory_unlock($1)").bind(SCHEMA_LOCK_KEY).execute(&mut *conn).await;
    result?;
    unlock.context("release schema lock")?;
    Ok(())
}

/// Whether `err` is a unique-constraint violation (SQLSTATE 23505).
pub fn is_unique_violation(err: &sqlx::Error) -> bool {
    matches!(err, sqlx::Error::Database(db) if db.code().as_deref() == Some("23505"))
}

/// Whether `err` is a foreign-key violation (SQLSTATE 23503).
pub fn is_foreign_key_violation(err: &sqlx::Error) -> bool {
    matches!(err, sqlx::Error::Database(db) if db.code().as_deref() == Some("23503"))
}
