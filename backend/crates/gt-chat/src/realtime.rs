//! How the chat reaches users outside the request: WebSocket events and Web Push. Behind a
//! trait so tests can record what was sent.

use std::sync::Arc;

use async_trait::async_trait;
use gt_notify::push::{self, PushRequest};
use gt_notify::NotificationWsHandler;
use serde_json::Value;

/// Delivery channels used by [`crate::ChatService`]. Every method is best-effort.
#[async_trait]
pub trait ChatRealtime: Send + Sync {
    /// Sends `{"type": event_type, "payload": payload}` to every connection of the user.
    async fn send(&self, user_id: i64, event_type: &str, payload: &Value);

    /// Whether the user currently has the app open (an open WebSocket).
    async fn is_connected(&self, user_id: i64) -> bool;

    /// Queues a Web Push.
    fn push(&self, request: PushRequest);
}

/// Production delivery: the notifications WebSocket (fanned out through Redis) and the
/// Service Bus push publisher.
pub struct NotifyRealtime {
    ws: Arc<NotificationWsHandler>,
}

impl NotifyRealtime {
    pub fn new(ws: Arc<NotificationWsHandler>) -> Self {
        Self { ws }
    }
}

#[async_trait]
impl ChatRealtime for NotifyRealtime {
    async fn send(&self, user_id: i64, event_type: &str, payload: &Value) {
        self.ws.send_user_event(user_id, event_type, payload).await;
    }

    async fn is_connected(&self, user_id: i64) -> bool {
        self.ws.is_user_connected(user_id).await
    }

    fn push(&self, request: PushRequest) {
        let Some(publisher) = push::available_publisher() else {
            tracing::debug!(user_id = request.user_id, "Push publisher unavailable; skipping chat push");
            return;
        };
        let user_id = request.user_id;
        if let Err(err) = publisher.publish_push_notification(request) {
            tracing::warn!(user_id, error = %err, "Failed to queue chat push; the message is still delivered in-app");
        }
    }
}
