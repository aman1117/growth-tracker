//! Notification business logic (port of `internal/services/notification.go`).
//!
//! The service is cheap to clone (it only holds an `Arc` of the repository), so callers can move
//! a clone into `tokio::spawn` for fire-and-forget notifications, as the Go code does with
//! goroutines:
//!
//! ```ignore
//! let notifications = notify.notification_service.clone();
//! tokio::spawn(async move {
//!     if let Err(err) = notifications.notify_new_follower(followee_id, follower_id, &username, &avatar).await {
//!         tracing::warn!(error = %err, "Failed to send new follower notification");
//!     }
//! });
//! ```

mod error;
mod notification;
mod realtime;
mod triggers;

pub use error::NotificationError;
pub use notification::NotificationService;
pub use realtime::{decode_notification, NotificationSubscription};
