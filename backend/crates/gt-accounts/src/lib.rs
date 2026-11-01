//! Authentication, password reset, email verification, profiles, search and follow HTTP API.
//!
//! Port of the Go handlers `auth.go`, `profile.go`, `password_reset.go`, `verification.go`,
//! `search_suggestions.go` and `follow.go` with their DTOs and routes. Server wiring:
//!
//! ```ignore
//! let users = gt_users::UsersContext::new(&core);
//! let notify = gt_notify::NotifyContext::new(&core);
//! let app = Router::new().merge(gt_accounts::routes(&core, &users, &notify));
//! ```

pub mod dto;
mod handlers;
mod routes;
mod state;
mod util;

pub use routes::routes;
