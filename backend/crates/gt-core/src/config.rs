//! Centralized configuration loaded from environment variables (and an optional `.env` file).
//!
//! Mirrors `internal/config/config.go`: same variable names, defaults and parsing rules, so an
//! existing deployment can switch binaries without touching its environment.

use std::sync::{Arc, OnceLock};
use std::time::Duration;

static CONFIG: OnceLock<Arc<Config>> = OnceLock::new();

/// Complete application configuration.
#[derive(Debug, Clone)]
pub struct Config {
    pub server: ServerConfig,
    pub database: DatabaseConfig,
    pub redis: RedisConfig,
    pub jwt: JwtConfig,
    pub azure_storage: AzureStorageConfig,
    pub azure_service_bus: AzureServiceBusConfig,
    pub web_push: WebPushConfig,
    pub push_worker: PushWorkerConfig,
    pub follow: FollowConfig,
    pub email: EmailConfig,
    pub axiom: AxiomConfig,
    pub pprof: PprofConfig,
    /// Authorizes maintenance endpoints (`X-Maintenance-Key` header). Empty disables them.
    pub maintenance_api_key: String,
    /// `development` or `production`.
    pub env: String,
}

#[derive(Debug, Clone)]
pub struct ServerConfig {
    pub port: String,
    pub frontend_url: String,
    pub read_timeout: Duration,
    pub write_timeout: Duration,
}

#[derive(Debug, Clone)]
pub struct DatabaseConfig {
    /// Full DSN; takes precedence over the individual components when set.
    pub url: String,
    pub host: String,
    pub port: String,
    pub name: String,
    pub username: String,
    pub password: String,
    pub ssl_mode: String,
    pub max_idle_conns: i64,
    pub max_open_conns: i64,
    pub conn_max_lifetime: Duration,
    pub conn_max_idle_time: Duration,
}

#[derive(Debug, Clone)]
pub struct RedisConfig {
    pub url: String,
}

#[derive(Debug, Clone)]
pub struct JwtConfig {
    pub secret_key: String,
    pub access_token_ttl: Duration,
    pub refresh_token_ttl: Duration,
}

#[derive(Debug, Clone)]
pub struct AzureStorageConfig {
    pub account_name: String,
    pub connection_string: String,
    pub container_name: String,
}

#[derive(Debug, Clone)]
pub struct AzureServiceBusConfig {
    pub connection_string: String,
    pub queue_name: String,
}

#[derive(Debug, Clone)]
pub struct WebPushConfig {
    pub vapid_public_key: String,
    pub vapid_private_key: String,
    /// Usually `mailto:you@example.com`.
    pub vapid_subject: String,
    /// Identifier for key rotation support.
    pub vapid_key_id: String,
}

#[derive(Debug, Clone)]
pub struct PushWorkerConfig {
    pub send_rate_limit: i64,
    pub max_concurrent: i64,
    pub dedupe_window_seconds: i64,
}

#[derive(Debug, Clone)]
pub struct FollowConfig {
    pub max_follows_per_minute: i64,
    pub max_follows_per_day: i64,
    pub max_total_following: i64,
    pub tombstone_retention_days: i64,
}

#[derive(Debug, Clone)]
pub struct EmailConfig {
    pub resend_api_key: String,
    pub from_address: String,
    pub from_name: String,
}

#[derive(Debug, Clone)]
pub struct AxiomConfig {
    pub dataset: String,
    pub api_token: String,
}

#[derive(Debug, Clone)]
pub struct PprofConfig {
    pub enabled: bool,
    pub prefix: String,
    pub token: String,
}

impl Config {
    /// Loads the configuration from the environment (after reading `.env` if present) and
    /// installs it as the global configuration returned by [`get`].
    pub fn load() -> Arc<Config> {
        // Like godotenv.Load: a missing .env is fine and real env vars win.
        let _ = dotenvy::dotenv();

        let config = Arc::new(Config::from_env());
        let _ = CONFIG.set(config.clone());
        CONFIG.get().cloned().unwrap_or(config)
    }

    /// Builds a configuration from the current environment without touching global state.
    pub fn from_env() -> Config {
        Config {
            env: env_or("ENV", "development"),
            server: ServerConfig {
                port: env_or("PORT", "8000"),
                frontend_url: env_or("FRONTEND_BASE_URL", "http://localhost:5173"),
                read_timeout: duration_or("SERVER_READ_TIMEOUT", Duration::from_secs(30)),
                write_timeout: duration_or("SERVER_WRITE_TIMEOUT", Duration::from_secs(30)),
            },
            database: DatabaseConfig {
                url: env("DATABASE_URL"),
                host: env("DB_HOST"),
                port: env_or("DB_PORT", "5432"),
                name: env("DB_NAME"),
                username: env("DB_USERNAME"),
                password: env("DB_PASSWORD"),
                ssl_mode: env_or("DB_SSLMODE", "require"),
                max_idle_conns: int_or("DB_MAX_IDLE_CONNS", 10),
                max_open_conns: int_or("DB_MAX_OPEN_CONNS", 100),
                conn_max_lifetime: duration_or("DB_CONN_MAX_LIFETIME", Duration::from_secs(3600)),
                conn_max_idle_time: duration_or("DB_CONN_MAX_IDLE_TIME", Duration::from_secs(600)),
            },
            redis: RedisConfig { url: env("REDIS_URL") },
            jwt: JwtConfig {
                secret_key: env_required("JWT_SECRET_KEY"),
                access_token_ttl: minutes_or("TTL_ACCESS_TOKEN", 24 * 60),
                refresh_token_ttl: minutes_or("TTL_REFRESH_TOKEN", 7 * 24 * 60),
            },
            azure_storage: AzureStorageConfig {
                account_name: env("AZURE_STORAGE_ACCOUNT_NAME"),
                connection_string: env("AZURE_STORAGE_CONNECTION_STRING"),
                container_name: env_or("AZURE_STORAGE_CONTAINER", "profile-pictures"),
            },
            azure_service_bus: AzureServiceBusConfig {
                connection_string: env("AZURE_SERVICEBUS_CONNECTION_STRING"),
                queue_name: env_or("AZURE_SERVICEBUS_QUEUE_NAME", "push-notifications"),
            },
            web_push: WebPushConfig {
                vapid_public_key: env("VAPID_PUBLIC_KEY"),
                vapid_private_key: env("VAPID_PRIVATE_KEY"),
                vapid_subject: env_or("VAPID_SUBJECT", "mailto:aman@amancodes.dev"),
                vapid_key_id: env_or("VAPID_KEY_ID", "default"),
            },
            push_worker: PushWorkerConfig {
                send_rate_limit: int_or("PUSH_SEND_RATE_LIMIT", 100),
                max_concurrent: int_or("PUSH_MAX_CONCURRENT", 10),
                dedupe_window_seconds: int_or("PUSH_DEDUPE_WINDOW_SECONDS", 60),
            },
            follow: FollowConfig {
                max_follows_per_minute: int_or("FOLLOW_MAX_PER_MINUTE", 60),
                max_follows_per_day: int_or("FOLLOW_MAX_PER_DAY", 5000),
                max_total_following: int_or("FOLLOW_MAX_TOTAL", 7500),
                tombstone_retention_days: int_or("FOLLOW_TOMBSTONE_RETENTION_DAYS", 7),
            },
            email: EmailConfig {
                resend_api_key: env("RESEND_API_KEY"),
                from_address: env_or("EMAIL_FROM_ADDRESS", "noreply@example.com"),
                from_name: env_or("EMAIL_FROM_NAME", "Growth Tracker"),
            },
            axiom: AxiomConfig { dataset: env("AXIOM_DATASET"), api_token: env("AXIOM_API_TOKEN") },
            pprof: PprofConfig {
                enabled: bool_or("PPROF_ENABLED", true),
                prefix: env_or("PPROF_PREFIX", "/debug/pprof"),
                token: env("PPROF_TOKEN"),
            },
            maintenance_api_key: env("MAINTENANCE_API_KEY"),
        }
    }

    pub fn is_production(&self) -> bool {
        self.env == "production"
    }

    pub fn is_development(&self) -> bool {
        self.env == "development"
    }
}

impl DatabaseConfig {
    /// PostgreSQL connection string: `DATABASE_URL` when set, otherwise built from the
    /// components with the user name, password and database name percent-encoded.
    pub fn dsn(&self) -> String {
        if !self.url.is_empty() {
            return self.url.clone();
        }
        let mut url = url::Url::parse("postgresql://localhost").expect("static URL parses");
        let _ = url.set_host(Some(&self.host));
        if let Ok(port) = self.port.parse::<u16>() {
            let _ = url.set_port(Some(port));
        }
        let _ = url.set_username(&self.username);
        let _ = url.set_password(Some(&self.password));
        url.set_path(&format!("/{}", self.name));
        url.query_pairs_mut().append_pair("sslmode", &self.ssl_mode);
        url.to_string()
    }
}

/// Returns the global configuration. Panics if [`Config::load`] has not run, which is a
/// programming error in a binary's startup sequence.
pub fn get() -> Arc<Config> {
    CONFIG.get().cloned().expect("config::Config::load must run before config::get")
}

/// Returns the global configuration when it has been loaded.
pub fn try_get() -> Option<Arc<Config>> {
    CONFIG.get().cloned()
}

fn env(key: &str) -> String {
    std::env::var(key).unwrap_or_default()
}

fn env_required(key: &str) -> String {
    let value = env(key);
    if value.is_empty() {
        // Same leniency as the Go service: warn instead of refusing to start.
        println!("Warning: Required environment variable {key} is not set");
    }
    value
}

fn env_or(key: &str, default: &str) -> String {
    match std::env::var(key) {
        Ok(v) if !v.is_empty() => v,
        _ => default.to_string(),
    }
}

fn int_or(key: &str, default: i64) -> i64 {
    match std::env::var(key) {
        Ok(v) if !v.is_empty() => parse_go_int(&v).unwrap_or(default),
        _ => default,
    }
}

fn duration_or(key: &str, default: Duration) -> Duration {
    match std::env::var(key) {
        Ok(v) if !v.is_empty() => parse_go_duration(&v).unwrap_or(default),
        _ => default,
    }
}

fn minutes_or(key: &str, default_minutes: i64) -> Duration {
    let minutes = match std::env::var(key) {
        Ok(v) if !v.is_empty() => parse_go_int(&v).unwrap_or(default_minutes),
        _ => default_minutes,
    };
    Duration::from_secs((minutes.max(0) as u64) * 60)
}

fn bool_or(key: &str, default: bool) -> bool {
    match std::env::var(key) {
        Ok(v) if !v.is_empty() => match v.to_lowercase().as_str() {
            "true" | "1" | "yes" | "on" => true,
            "false" | "0" | "no" | "off" => false,
            _ => default,
        },
        _ => default,
    }
}

/// Parses an integer like Go's `strconv.Atoi` (optional sign, decimal digits only).
pub fn parse_go_int(s: &str) -> Option<i64> {
    let digits = s.strip_prefix(['+', '-']).unwrap_or(s);
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse::<i64>().ok()
}

/// Parses a duration string like Go's `time.ParseDuration` (e.g. `30s`, `1h30m`, `250ms`).
/// Negative durations are rejected because none of the settings accept them.
pub fn parse_go_duration(s: &str) -> Option<Duration> {
    let s = s.strip_prefix('+').unwrap_or(s);
    if s == "0" {
        return Some(Duration::ZERO);
    }
    if s.is_empty() || s.starts_with('-') {
        return None;
    }
    let mut total_nanos: f64 = 0.0;
    let mut rest = s;
    while !rest.is_empty() {
        let number_len = rest.find(|c: char| !(c.is_ascii_digit() || c == '.')).unwrap_or(rest.len());
        if number_len == 0 {
            return None;
        }
        let value: f64 = rest[..number_len].parse().ok()?;
        rest = &rest[number_len..];
        let unit_len = rest.find(|c: char| c.is_ascii_digit() || c == '.').unwrap_or(rest.len());
        let unit_nanos = match &rest[..unit_len] {
            "ns" => 1.0,
            "us" | "µs" | "μs" => 1e3,
            "ms" => 1e6,
            "s" => 1e9,
            "m" => 60e9,
            "h" => 3600e9,
            _ => return None,
        };
        rest = &rest[unit_len..];
        total_nanos += value * unit_nanos;
    }
    Some(Duration::from_nanos(total_nanos as u64))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_go_durations() {
        assert_eq!(parse_go_duration("30s"), Some(Duration::from_secs(30)));
        assert_eq!(parse_go_duration("1h30m"), Some(Duration::from_secs(5400)));
        assert_eq!(parse_go_duration("250ms"), Some(Duration::from_millis(250)));
        assert_eq!(parse_go_duration("1.5h"), Some(Duration::from_secs(5400)));
        assert_eq!(parse_go_duration("0"), Some(Duration::ZERO));
        assert_eq!(parse_go_duration("10"), None);
        assert_eq!(parse_go_duration("abc"), None);
        assert_eq!(parse_go_duration("-5s"), None);
    }

    #[test]
    fn parses_go_ints() {
        assert_eq!(parse_go_int("42"), Some(42));
        assert_eq!(parse_go_int("-7"), Some(-7));
        assert_eq!(parse_go_int("4.2"), None);
        assert_eq!(parse_go_int(" 4"), None);
    }

    #[test]
    fn dsn_escapes_components() {
        let cfg = DatabaseConfig {
            url: String::new(),
            host: "db.example.com".into(),
            port: "5432".into(),
            name: "growth".into(),
            username: "user@x".into(),
            password: "p@ss/word#1".into(),
            ssl_mode: "require".into(),
            max_idle_conns: 1,
            max_open_conns: 1,
            conn_max_lifetime: Duration::ZERO,
            conn_max_idle_time: Duration::ZERO,
        };
        assert_eq!(cfg.dsn(), "postgresql://user%40x:p%40ss%2Fword%231@db.example.com:5432/growth?sslmode=require");
    }
}
