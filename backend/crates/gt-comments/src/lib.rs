//! Day comments, replies, mentions and comment likes (port of the Go comment repositories,
//! DTOs, service, handler and routes).
//!
//! * [`repository`]: `comments`, `comment_likes`, `comment_mentions`, `comment_dedupes`;
//! * [`dto`]: request and response bodies (Go-compatible JSON);
//! * [`service`]: [`CommentService`] plus its pure rules, ranking, pagination, DTO mapping and
//!   the comment count cache;
//! * [`routes`]: the HTTP endpoints.
//!
//! Server wiring:
//!
//! ```ignore
//! let comments = gt_comments::CommentsContext::new(&core, &users, &notify);
//! let app = Router::new().merge(gt_comments::routes(&core, &users, &notify, &comments));
//! ```

pub mod context;
pub mod dto;
mod handlers;
pub mod repository;
pub mod routes;
pub mod service;

pub use context::CommentsContext;
pub use routes::routes;
pub use service::{CommentError, CommentRepositories, CommentService, CreateComment};
