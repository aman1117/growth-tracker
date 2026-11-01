//! Group challenges: rules, invites, cheers, daily locking and finalization (port of the Go
//! backend's challenge repository, rules, service, job, validator, DTOs and handler).
//!
//! Server wiring:
//!
//! ```ignore
//! let challenges = gt_challenges::ChallengesContext::new(&core, &users, &notify);
//! let app = Router::new().merge(gt_challenges::routes(&core, &users, &notify, &challenges));
//! // Cron: challenges.challenge_service.run_daily_job() at 00:05 IST;
//! // startup: challenges.challenge_service.delete_stale_invites().
//! ```

pub mod context;
pub mod dto;
mod gostr;
mod handlers;
pub mod repository;
pub mod routes;
pub mod service;
pub mod validator;

pub use context::ChallengesContext;
pub use repository::ChallengeRepository;
pub use routes::routes;
pub use service::{ChallengeError, ChallengeService, DailyJobError};
