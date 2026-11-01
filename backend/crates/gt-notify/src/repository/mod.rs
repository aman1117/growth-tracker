//! Data access for notifications and Web Push (port of `internal/repository/notification_repository.go`
//! and `push_repository.go`).

mod notification;
mod push;

pub use notification::{NewNotification, NewNotificationDedupe, NotificationRepository, PartialDeleteError};
pub use push::{NewPushDeliveryLog, NewPushSubscription, PushRepository, UpsertSubscriptionError};

/// GORM `Limit(n)`: a negative limit means "no limit" (`LIMIT NULL` in PostgreSQL).
fn gorm_limit(limit: i64) -> Option<i64> {
    (limit >= 0).then_some(limit)
}

/// GORM `Offset(n)`: only positive offsets are rendered.
fn gorm_offset(offset: i64) -> i64 {
    offset.max(0)
}
