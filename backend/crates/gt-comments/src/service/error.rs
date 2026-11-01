//! Errors of [`CommentService`](super::CommentService).

use gt_core::validator::ValidationError;

/// A failed comment operation. Business-rule failures carry the Go validation message and
/// error code (handlers map the codes to statuses); database failures are wrapped with the
/// operation, like Go's `fmt.Errorf("failed to ...: %w", err)`.
#[derive(Debug, thiserror::Error)]
pub enum CommentError {
    /// A rule was violated (e.g. `COMMENT_NOT_FOUND`, `DUPLICATE_COMMENT`, `COMMENT_FORBIDDEN`).
    #[error(transparent)]
    Validation(#[from] ValidationError),
    /// A database failure, e.g. `failed to create comment: ...`.
    #[error("{context}: {source}")]
    Database {
        context: &'static str,
        #[source]
        source: sqlx::Error,
    },
}

impl CommentError {
    /// The validation error code, `None` for database failures.
    pub fn code(&self) -> Option<&'static str> {
        match self {
            CommentError::Validation(e) => Some(e.code),
            CommentError::Database { .. } => None,
        }
    }

    pub(crate) fn db(context: &'static str) -> impl FnOnce(sqlx::Error) -> Self {
        move |source| CommentError::Database { context, source }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gt_core::constants as c;

    #[test]
    fn messages_match_go() {
        let err = CommentError::db("failed to create comment")(sqlx::Error::RowNotFound);
        assert!(err.to_string().starts_with("failed to create comment: "));
        assert_eq!(err.code(), None);
        let err = CommentError::from(ValidationError::new("Comment not found", c::ERR_CODE_COMMENT_NOT_FOUND));
        assert_eq!(err.to_string(), "Comment not found");
        assert_eq!(err.code(), Some(c::ERR_CODE_COMMENT_NOT_FOUND));
    }
}
