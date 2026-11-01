//! Shared plumbing of the maintenance binaries (`seed`, `send_reminders`, `test_reminder`,
//! `seed_badges`): Go-style log lines, environment lookups, production safety checks, database
//! connections and `fmt.Scan`-style prompts.

pub mod db;
pub mod golog;
pub mod scan;

pub use db::DbParams;

/// Hosts the dev seeder refuses to touch (substring match on the lowercased `DB_HOST`).
pub const SEED_PRODUCTION_INDICATORS: &[&str] = &["neon.tech", "azure", "aws", "prod", "production", "rds.amazonaws"];

/// Hosts the reminder tools refuse to touch.
pub const REMINDER_PRODUCTION_INDICATORS: &[&str] = &["neon.tech", "azure", "aws", "prod", "production"];

/// The variable's value, or `fallback` when it is unset or empty (the Go tools' `getEnv`).
pub fn env_or(key: &str, fallback: &str) -> String {
    match std::env::var(key) {
        Ok(value) if !value.is_empty() => value,
        _ => fallback.to_string(),
    }
}

/// Whether `host` looks like a production database: the lowercased host contains one of
/// `indicators`.
pub fn looks_like_production(host: &str, indicators: &[&str]) -> bool {
    let host = host.to_lowercase();
    indicators.iter().any(|indicator| host.contains(indicator))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_hosts_are_detected_case_insensitively() {
        assert!(looks_like_production("ep-cool-1.us-east-2.aws.NEON.TECH", SEED_PRODUCTION_INDICATORS));
        assert!(looks_like_production("db.Prod.internal", REMINDER_PRODUCTION_INDICATORS));
        assert!(looks_like_production("x.rds.amazonaws.com", SEED_PRODUCTION_INDICATORS));
        assert!(!looks_like_production("localhost", SEED_PRODUCTION_INDICATORS));
        assert!(!looks_like_production("postgres", REMINDER_PRODUCTION_INDICATORS));
    }
}
