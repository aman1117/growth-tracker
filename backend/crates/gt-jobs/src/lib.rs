//! Scheduled jobs (streaks, reminders, cleanup) and maintenance CLIs.
//!
//! * [`CronService`] ports the Go `services.CronService` (`internal/services/email.go`): the
//!   midnight streak job, the 10 PM streak reminders and the notification cleanup, each claimed
//!   in `cron_job_logs` so only one replica does the work.
//! * [`JobsContext`] wires it from the other feature contexts and adds the follow tombstone
//!   cleanup that the Go server ran inline in `cmd/server/main.go`.
//! * The binaries in `src/bin` port the Go maintenance programs (`cmd/seed`,
//!   `cmd/send_reminders`, `cmd/test_reminder`, `migrations/seed_badges.go`); their shared
//!   plumbing lives in [`cli`], [`seed`] and [`badge_backfill`].
//!
//! Server wiring:
//!
//! ```ignore
//! let jobs = Arc::new(gt_jobs::JobsContext::new(&core, &users, &notify));
//! for job in gt_jobs::ScheduledJob::ALL {
//!     let jobs = jobs.clone();
//!     scheduler::spawn_daily(job.name(), job.ist_time(), move || {
//!         let jobs = jobs.clone();
//!         Box::pin(async move { jobs.run(job).await })
//!     });
//! }
//! ```

pub mod badge_backfill;
pub mod cli;
pub mod context;
pub mod seed;
pub mod service;

pub use context::{JobsContext, ScheduledJob};
pub use service::{cleanup_follow_tombstones, go_error_text, tombstone_cutoff, CronError, CronService};
