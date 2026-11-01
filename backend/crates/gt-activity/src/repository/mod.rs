//! Data access for activities, tile configurations and day likes (port of the matching parts
//! of `internal/repository/repository.go` and `like_repository.go`).
//!
//! Every repository is a cheap-to-clone handle on the shared [`sqlx::PgPool`]. Lookups that Go
//! answered with `(nil, nil)` return `Ok(None)`.

mod activity;
mod like;
mod photo_label;
mod tile_config;

pub use activity::{ActivityRepository, ActivityWriteError};
pub use like::{LikeDeleteError, LikeRepository, LikeWithUser};
pub use photo_label::ActivityPhotoLabels;
pub use tile_config::TileConfigRepository;
