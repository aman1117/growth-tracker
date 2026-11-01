//! Wiring of the notification feature (Go: the notification/push parts of
//! `internal/container` and `cmd/server/main.go`).

use std::sync::Arc;

use gt_core::CoreContext;

use crate::handlers::websocket::NotificationWsHandler;
use crate::repository::{NotificationRepository, PushRepository};
use crate::service::NotificationService;

/// Repositories and services of the notification feature. Cheap to clone; other features keep
/// `notification_service` (or a clone of the `Arc`) to create notifications.
#[derive(Clone)]
pub struct NotifyContext {
    pub notification_repo: Arc<NotificationRepository>,
    pub push_repo: Arc<PushRepository>,
    pub notification_service: Arc<NotificationService>,
    pub ws_handler: Arc<NotificationWsHandler>,
}

impl NotifyContext {
    /// Builds the repositories and services on the shared pool. The Web Push publisher is a
    /// process-wide global initialized separately (see [`crate::push::init_push_publisher`]).
    pub fn new(core: &CoreContext) -> Self {
        let notification_repo = Arc::new(NotificationRepository::new(core.pool.clone()));
        let push_repo = Arc::new(PushRepository::new(core.pool.clone()));
        let notification_service = Arc::new(NotificationService::new(notification_repo.clone()));
        let ws_handler = Arc::new(NotificationWsHandler::new(notification_service.clone(), core.tokens.clone()));
        Self { notification_repo, push_repo, notification_service, ws_handler }
    }

    /// Replaces the WebSocket handler (e.g. one with shorter heartbeat timings in tests).
    pub fn with_ws_handler(mut self, ws_handler: Arc<NotificationWsHandler>) -> Self {
        self.ws_handler = ws_handler;
        self
    }
}
