//! Shared handler state.

use std::sync::Arc;

use gt_core::jwt::TokenService;
use gt_core::CoreContext;
use gt_notify::{NotificationService, NotifyContext};
use gt_users::UsersContext;

/// Everything the accounts handlers need (Go: the dependencies of `AuthHandler`,
/// `ProfileHandler`, `PasswordResetHandler`, `VerificationHandler`, `SearchSuggestionsHandler`
/// and `FollowHandler`). Cheap to clone.
#[derive(Clone)]
pub(crate) struct AccountsState {
    pub tokens: Arc<TokenService>,
    pub users: UsersContext,
    pub notifications: Arc<NotificationService>,
}

impl AccountsState {
    pub fn new(core: &CoreContext, users: &UsersContext, notify: &NotifyContext) -> Self {
        Self { tokens: core.tokens.clone(), users: users.clone(), notifications: notify.notification_service.clone() }
    }
}
