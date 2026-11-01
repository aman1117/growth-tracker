//! Job logic: the cron service (port of the `CronService` part of `internal/services/email.go`)
//! and the follow tombstone cleanup (the 4 AM job body of `cmd/server/main.go`).

mod cron;
mod error;
mod tombstone;

pub use cron::{instance_id_from, CronService};
pub use error::{go_error_text, CronError};
pub use tombstone::{cleanup_follow_tombstones, tombstone_cutoff};
