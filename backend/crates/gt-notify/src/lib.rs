//! In-app notifications, real-time WebSocket delivery and Web Push (port of the Go backend's
//! notification repository/service/handlers, the push publisher and `cmd/pushworker`).
//!
//! Server wiring:
//!
//! ```ignore
//! let notify = gt_notify::NotifyContext::new(&core);
//! let app = Router::new().merge(gt_notify::routes(&core, &notify));
//! // Other features create notifications through `notify.notification_service`.
//! ```

pub mod context;
pub mod dto;
mod gotime;
pub mod handlers;
mod json;
pub mod push;
pub mod repository;
pub mod routes;
pub mod service;
pub mod worker;

pub use context::NotifyContext;
pub use handlers::websocket::NotificationWsHandler;
pub use repository::{NewNotification, NewNotificationDedupe, NotificationRepository, PushRepository};
pub use routes::routes;
pub use service::{NotificationError, NotificationService, NotificationSubscription};
