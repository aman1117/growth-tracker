//! Errors of the photo services. Their messages are the Go error strings: several reach
//! clients verbatim (e.g. a failed upload answers `400` with the error text).

use std::fmt;

use sqlx::postgres::{PgDatabaseError, PgSeverity};

use crate::blob::BlobError;
use crate::image_processor::ImageProcessError;
use crate::validation::PhotoRuleError;

/// A database error rendered like pgx's `*pgconn.PgError` (`ERROR: <message> (SQLSTATE
/// <code>)`), the text the Go services embedded in their errors. Other failures (connection,
/// pool) keep sqlx's text.
#[derive(Debug)]
pub struct DbError(pub sqlx::Error);

impl From<sqlx::Error> for DbError {
    fn from(err: sqlx::Error) -> Self {
        Self(err)
    }
}

impl fmt::Display for DbError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if let sqlx::Error::Database(db) = &self.0 {
            if let Some(pg) = db.try_downcast_ref::<PgDatabaseError>() {
                return write!(f, "{}: {} (SQLSTATE {})", severity_name(pg.severity()), pg.message(), pg.code());
            }
        }
        self.0.fmt(f)
    }
}

impl std::error::Error for DbError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.0)
    }
}

fn severity_name(severity: PgSeverity) -> &'static str {
    match severity {
        PgSeverity::Panic => "PANIC",
        PgSeverity::Fatal => "FATAL",
        PgSeverity::Error => "ERROR",
        PgSeverity::Warning => "WARNING",
        PgSeverity::Notice => "NOTICE",
        PgSeverity::Debug => "DEBUG",
        PgSeverity::Info => "INFO",
        PgSeverity::Log => "LOG",
    }
}

/// The blob client could not be created from `AZURE_STORAGE_CONNECTION_STRING` (Go:
/// `failed to create blob client: %w` from `NewBlobHandler` / `NewActivityPhotoService`).
#[derive(Debug, thiserror::Error)]
#[error("failed to create blob client: {0}")]
pub struct BlobSetupError(#[source] pub BlobError);

/// Failures of [`crate::service::ActivityPhotoService`] (Go returned `fmt.Errorf` errors that
/// the handler compared by message).
#[derive(Debug, thiserror::Error)]
pub enum PhotoError {
    /// Date window or size limit.
    #[error(transparent)]
    Rule(#[from] PhotoRuleError),
    #[error("photo already exists for this activity on this date")]
    AlreadyExists,
    #[error("failed to process image: {0}")]
    Process(#[source] ImageProcessError),
    #[error("blob storage is not configured")]
    StorageNotConfigured,
    #[error("failed to upload full image: {0}")]
    UploadFull(#[source] BlobError),
    #[error("failed to upload thumbnail: {0}")]
    UploadThumbnail(#[source] BlobError),
    #[error("photo not found")]
    NotFound,
    #[error("not authorized to delete this photo")]
    DeleteForbidden,
    #[error("not authorized to view photo viewers")]
    ViewersForbidden,
    #[error("not authorized to view photo likers")]
    LikersForbidden,
    #[error("not authorized to view photo interactions")]
    InteractionsForbidden,
    #[error("cannot like own photo")]
    CannotLikeOwnPhoto,
    #[error("must follow user to like their photos")]
    MustFollow,
    /// A repository failure wrapped with context (`failed to save photo: ...`).
    #[error("{context}: {source}")]
    Database { context: &'static str, source: DbError },
    /// A repository failure returned as is (Go returned the error unwrapped).
    #[error(transparent)]
    Repository(DbError),
}

impl PhotoError {
    /// Wraps a repository error with Go's `fmt.Errorf("<context>: %w", err)` prefix.
    pub(crate) fn db(context: &'static str) -> impl FnOnce(sqlx::Error) -> PhotoError {
        move |err| PhotoError::Database { context, source: DbError(err) }
    }

    /// A repository error returned without context.
    pub(crate) fn repository(err: sqlx::Error) -> PhotoError {
        PhotoError::Repository(DbError(err))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_match_go() {
        assert_eq!(PhotoError::AlreadyExists.to_string(), "photo already exists for this activity on this date");
        assert_eq!(PhotoError::Rule(PhotoRuleError::TooOld).to_string(), "can only upload photos for the last 7 days");
        assert_eq!(
            PhotoError::Process(ImageProcessError::UnsupportedExtension(".txt".into())).to_string(),
            "failed to process image: unsupported file extension: .txt"
        );
        assert_eq!(
            PhotoError::UploadFull(BlobError::Timeout).to_string(),
            "failed to upload full image: context deadline exceeded"
        );
        let err = PhotoError::db("failed to save photo")(sqlx::Error::RowNotFound);
        assert_eq!(err.to_string(), format!("failed to save photo: {}", sqlx::Error::RowNotFound));
        assert_eq!(
            BlobSetupError(BlobError::Timeout).to_string(),
            "failed to create blob client: context deadline exceeded"
        );
    }
}
