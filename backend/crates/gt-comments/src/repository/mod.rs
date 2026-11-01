//! Data access for comments (port of `internal/repository/comment_*_repository.go`).
//!
//! SQL mirrors what GORM generated for the Go repositories, including `First` ordering by
//! primary key, `Find` returning empty vectors, and `updated_at = NOW()` on GORM updates (but
//! not on `UpdateColumn`).

mod comment;
mod comment_dedupe;
mod comment_like;
mod comment_mention;

pub use comment::{CommentRepository, CommentWithAuthor, NewComment};
pub use comment_dedupe::{CommentDedupeRepository, NewCommentDedupe};
pub use comment_like::CommentLikeRepository;
pub use comment_mention::{CommentMentionRepository, NewCommentMention};

/// GORM's `Limit(n)` writes `LIMIT n` only for `n >= 0`; `LIMIT NULL` means "no limit".
fn gorm_limit(limit: i64) -> Option<i64> {
    (limit >= 0).then_some(limit)
}

/// `time.Now().Add(-window)`: the oldest creation time still inside a dedupe window.
fn cutoff(window: std::time::Duration) -> chrono::DateTime<chrono::Utc> {
    let window = chrono::Duration::from_std(window).unwrap_or(chrono::Duration::MAX);
    chrono::Utc::now().checked_sub_signed(window).unwrap_or(chrono::DateTime::<chrono::Utc>::MIN_UTC)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_follow_gorm() {
        assert_eq!(gorm_limit(21), Some(21));
        assert_eq!(gorm_limit(0), Some(0));
        assert_eq!(gorm_limit(-1), None);
    }

    #[test]
    fn cutoff_is_in_the_past() {
        let now = chrono::Utc::now();
        let c = cutoff(std::time::Duration::from_secs(60));
        assert!(c <= now - chrono::Duration::seconds(59));
        assert_eq!(cutoff(std::time::Duration::MAX), chrono::DateTime::<chrono::Utc>::MIN_UTC);
    }
}
