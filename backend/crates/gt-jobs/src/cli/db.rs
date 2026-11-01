//! Database connection of the maintenance binaries, configured from discrete `DB_*` variables
//! like the Go tools (which built a DSN from them).

use std::str::FromStr;

use anyhow::Context;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions, PgSslMode};
use sqlx::{Connection, PgConnection, PgPool};

use super::env_or;

/// Connection parameters.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DbParams {
    pub host: String,
    pub port: String,
    pub name: String,
    pub user: String,
    pub password: String,
    pub ssl_mode: String,
}

impl DbParams {
    /// `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USERNAME`, `DB_PASSWORD` and `DB_SSLMODE` with the
    /// local docker-compose defaults (`localhost:5432`, `growth_tracker_dev`, `localdev` /
    /// `localdevpassword`, `disable`), as read by `seed`, `send_reminders` and `test_reminder`.
    pub fn dev_from_env() -> Self {
        Self {
            host: env_or("DB_HOST", "localhost"),
            port: env_or("DB_PORT", "5432"),
            name: env_or("DB_NAME", "growth_tracker_dev"),
            user: env_or("DB_USERNAME", "localdev"),
            password: env_or("DB_PASSWORD", "localdevpassword"),
            ssl_mode: env_or("DB_SSLMODE", "disable"),
        }
    }

    /// Connects (and verifies the connection, like GORM's ping on open). The first connection
    /// is opened directly so an unreachable server fails at once with the real cause (the pool
    /// would retry until its acquire timeout).
    pub async fn connect(&self) -> anyhow::Result<PgPool> {
        let port: u16 = self.port.parse().with_context(|| format!("invalid port {:?}", self.port))?;
        let ssl_mode =
            PgSslMode::from_str(&self.ssl_mode).with_context(|| format!("invalid sslmode {:?}", self.ssl_mode))?;
        let options = PgConnectOptions::new()
            .host(&self.host)
            .port(port)
            .database(&self.name)
            .username(&self.user)
            .password(&self.password)
            .ssl_mode(ssl_mode);
        let failed = |err: sqlx::Error| {
            anyhow::anyhow!(
                "failed to connect to `host={} user={} database={}`: {err}",
                self.host,
                self.user,
                self.name
            )
        };
        let probe = PgConnection::connect_with(&options).await.map_err(failed)?;
        let _ = probe.close().await;
        PgPoolOptions::new().max_connections(4).connect_with(options).await.map_err(failed)
    }
}
