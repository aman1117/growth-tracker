//! Domain entities (port of `pkg/models`).
//!
//! Conventions shared by every crate:
//! * ids and Go `int`/`uint` columns are `i64`;
//! * `NUMERIC` columns are never decoded directly: select them cast to `float4` (Go `float32`
//!   fields) or `float8` (Go `float64` fields). Each model's `COLUMNS` constant already does
//!   this, so `format!("SELECT {} FROM users WHERE ...", User::COLUMNS)` decodes cleanly;
//! * `TIMESTAMPTZ` -> `DateTime<Utc>`, `DATE` -> `NaiveDate`, `TIMESTAMP` (no zone, only in
//!   `story_likes` / `recent_searches`) -> `NaiveDateTime` interpreted as UTC;
//! * JSON field names, `omitempty` and `null` behavior follow the Go `json` tags exactly.

mod activity;
mod challenge;
mod comment;
mod follow;
mod misc;
mod notification;
mod photo;
mod push;
mod tile_config;
mod user;

pub use activity::*;
pub use challenge::*;
pub use comment::*;
pub use follow::*;
pub use misc::*;
pub use notification::*;
pub use photo::*;
pub use push::*;
pub use tile_config::*;
pub use user::*;
