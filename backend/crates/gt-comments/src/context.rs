//! `CommentsContext`: the comment repositories and service, wired like
//! `internal/container/container.go`.

use std::sync::Arc;

use gt_core::CoreContext;
use gt_notify::NotifyContext;
use gt_users::UsersContext;

use crate::service::{CommentRepositories, CommentService};

/// Shared handles to the comment repositories and service. Cheap to clone.
#[derive(Debug, Clone)]
pub struct CommentsContext {
    pub repos: CommentRepositories,
    pub comment_service: Arc<CommentService>,
}

impl CommentsContext {
    /// Builds the repositories on the core pool and the service with the users' repositories
    /// and the notification service.
    pub fn new(core: &CoreContext, users: &UsersContext, notify: &NotifyContext) -> Self {
        let repos = CommentRepositories::new(core.pool.clone());
        let comment_service = Arc::new(CommentService::new(
            repos.clone(),
            users.user_repo.clone(),
            Some(users.follow_repo.clone()),
            Some(notify.notification_service.clone()),
        ));
        Self { repos, comment_service }
    }
}
