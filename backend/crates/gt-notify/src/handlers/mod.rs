//! HTTP and WebSocket handlers (port of `internal/handlers/notification.go`, `push.go` and
//! `websocket.go`).

pub(crate) mod fiber;
pub(crate) mod notification;
pub(crate) mod push;
pub mod websocket;

use std::sync::Arc;

use gt_core::config::Config;

use crate::repository::PushRepository;
use crate::service::NotificationService;
use websocket::NotificationWsHandler;

/// State shared by the notification, push and WebSocket handlers.
#[derive(Clone)]
pub(crate) struct NotifyState {
    pub notifications: Arc<NotificationService>,
    pub push_repo: Arc<PushRepository>,
    pub ws: Arc<NotificationWsHandler>,
    pub config: Arc<Config>,
}
