//! Growth Tracker HTTP API server: assembles the feature crates into one axum application with
//! the Go server's global behavior (CORS, routing defaults, documentation, cron jobs).

pub mod cors;
pub mod http;
pub mod scheduler;
pub mod serve;
pub mod swagger;
