//! Wiring of the chat feature.

use std::sync::Arc;

use gt_core::CoreContext;
use gt_notify::NotifyContext;

use crate::realtime::{ChatRealtime, NotifyRealtime};
use crate::repository::ChatRepository;
use crate::service::ChatService;

/// The chat repository and service. Cheap to clone.
#[derive(Debug, Clone)]
pub struct ChatContext {
    pub chat_repo: Arc<ChatRepository>,
    pub chat_service: Arc<ChatService>,
}

impl ChatContext {
    /// Builds the repository on the shared pool and the service delivering events through the
    /// notifications WebSocket and pushes through the Web Push publisher.
    pub fn new(core: &CoreContext, notify: &NotifyContext) -> Self {
        Self::with_realtime(core, Arc::new(NotifyRealtime::new(notify.ws_handler.clone())))
    }

    /// Same as [`ChatContext::new`] with another delivery (e.g. a recorder in tests).
    pub fn with_realtime(core: &CoreContext, realtime: Arc<dyn ChatRealtime>) -> Self {
        let chat_repo = Arc::new(ChatRepository::new(core.pool.clone()));
        let chat_service = Arc::new(ChatService::new(chat_repo.clone(), realtime));
        Self { chat_repo, chat_service }
    }
}
