//! Comment business logic (port of `internal/services/comment_service.go`).
//!
//! [`CommentService`] orchestrates the repositories, users and notifications. The pure building
//! blocks live in small modules: body helpers ([`text`]), ranking ([`ranking`]), pagination
//! ([`pagination`]), authorization and validation rules ([`rules`]), DTO mapping
//! ([`mapping`]), notification planning ([`notify_plan`]) and the Redis comment count cache
//! ([`count_cache`]).

mod comment_service;
pub mod count_cache;
mod error;
pub mod mapping;
mod notifier;
pub mod notify_plan;
pub mod pagination;
pub mod ranking;
pub mod rules;
pub mod text;

pub use comment_service::{CommentRepositories, CommentService, CreateComment};
pub use count_cache::{comment_count_cache_key, get_comment_count, invalidate_count_cache};
pub use error::CommentError;
pub use notify_plan::{plan_comment_notifications, CommentNotificationKind, NotificationPlan};
pub use ranking::CommentSort;
pub use text::{hash_body, truncate_comment_preview};
