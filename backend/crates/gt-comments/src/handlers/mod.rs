//! HTTP handlers of the comment endpoints (port of `internal/handlers/comment.go`).

mod comment;
mod params;

use std::sync::Arc;

use gt_users::service::{AuthService, ProfileService};

use crate::service::CommentService;

pub(crate) use comment::{
    create_comment, create_reply, delete_comment, edit_comment, get_comment_count, get_comments, get_replies,
    like_comment, unlike_comment,
};

/// Handler state (Go `CommentHandler`).
#[derive(Clone)]
pub(crate) struct CommentsState {
    pub comments: Arc<CommentService>,
    pub auth: Arc<AuthService>,
    pub profiles: Arc<ProfileService>,
}
