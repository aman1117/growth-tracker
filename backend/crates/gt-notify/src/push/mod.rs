//! Web Push: the Service Bus publisher used by the API server, the queue message format, the
//! Service Bus REST client and the Web Push (VAPID + aes128gcm) sender used by the push worker.
//!
//! Startup (Go: `services.InitPushPublisher` in `cmd/server/main.go`):
//!
//! ```ignore
//! if !config.azure_service_bus.connection_string.is_empty() {
//!     match gt_notify::push::init_push_publisher(&config) {
//!         Ok(()) => tracing::info!("Push publisher initialized"),
//!         Err(err) => {
//!             tracing::warn!("Push publisher initialization failed: {err}");
//!             tracing::warn!("Web Push notifications are disabled");
//!         }
//!     }
//! } else {
//!     tracing::warn!("Push notifications disabled (Service Bus not configured)");
//! }
//! ```
//!
//! Other features publish through [`available_publisher`] (Go: `GetPushPublisher()` +
//! `IsAvailable()`), e.g. story likes:
//!
//! ```ignore
//! if let Some(publisher) = gt_notify::push::available_publisher() {
//!     publisher.publish_push_notification(PushRequest { user_id, notification_type, .. })?;
//! }
//! ```

mod message;
mod publisher;
pub mod servicebus;
pub mod webpush;

pub use message::{
    generate_message_id, is_valid_deep_link, truncate_body, PushMessage, MAX_PUSH_BODY_CHARS, MAX_PUSH_PAYLOAD_BYTES,
};
pub use publisher::{
    available_publisher, build_outgoing_message, close_push_publisher, get_push_publisher, init_push_publisher,
    notification_data, set_push_publisher, PushPublishError, PushPublisher, PushRequest, PushTransport,
    DEFAULT_BATCH_SIZE, DEFAULT_BATCH_WAIT, DEFAULT_PUSH_TTL_SECONDS, DEFAULT_QUEUE_SIZE,
};
pub use servicebus::{OutgoingMessage, PropertyValue, ReceivedMessage, ServiceBusClient, ServiceBusError};
