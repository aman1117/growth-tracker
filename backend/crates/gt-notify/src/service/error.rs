/// Errors of [`NotificationService`](super::NotificationService). Messages match the Go errors
/// (`"failed to get notifications: ..."`, `"notification not found"`) because handlers and logs
/// rely on them.
#[derive(Debug, thiserror::Error)]
pub enum NotificationError {
    /// The notification does not exist or belongs to someone else (Go:
    /// `fmt.Errorf("notification not found")`, mapped to 404 by the handler).
    #[error("notification not found")]
    NotFound,
    /// A database failure wrapped with the operation, e.g. `failed to create notification: ...`.
    #[error("{context}: {source}")]
    Database {
        context: &'static str,
        #[source]
        source: sqlx::Error,
    },
    /// A database failure returned as is (Go returns transaction errors unwrapped).
    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),
    /// A Redis failure wrapped with the operation, e.g. `failed to track connection: ...`.
    #[error("{context}: {source}")]
    Redis {
        context: &'static str,
        #[source]
        source: redis::RedisError,
    },
}

impl NotificationError {
    pub(crate) fn db(context: &'static str) -> impl FnOnce(sqlx::Error) -> Self {
        move |source| Self::Database { context, source }
    }

    pub(crate) fn redis(context: &'static str) -> impl FnOnce(redis::RedisError) -> Self {
        move |source| Self::Redis { context, source }
    }
}
