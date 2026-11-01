//! Shared infrastructure for the Growth Tracker backend.
//!
//! Every feature crate builds on this one. It mirrors the Go backend's `internal/config`,
//! `internal/logger`, `internal/response`, `internal/middleware`, `internal/constants`,
//! `internal/validator`, `internal/database`, `pkg/redis` and `pkg/models` packages, and adds
//! the glue needed to reproduce the Go API byte-for-byte (see [`gojson`]).

pub mod badges;
pub mod body;
pub mod config;
pub mod constants;
pub mod context;
pub mod db;
pub mod error;
pub mod extract;
pub mod gojson;
pub mod guard;
pub mod jwt;
pub mod logging;
pub mod models;
pub mod ratelimit;
pub mod redis;
pub mod request_log;
pub mod response;
pub mod timeutil;
pub mod validator;

pub use context::CoreContext;
pub use error::{ApiError, ApiResult};
