//! Body helpers: dedupe hashing and notification previews.

use gt_core::constants::COMMENT_PREVIEW_LENGTH;
use sha2::{Digest, Sha256};

/// Lowercase hex SHA-256 of the (trimmed) body, used to reject duplicate submissions.
pub fn hash_body(body: &str) -> String {
    hex::encode(Sha256::digest(body.as_bytes()))
}

/// The first [`COMMENT_PREVIEW_LENGTH`] characters of `body` followed by `...` when it is
/// longer. Counts characters (Go runes), never splitting one.
pub fn truncate_comment_preview(body: &str) -> String {
    match body.char_indices().nth(COMMENT_PREVIEW_LENGTH) {
        None => body.to_string(),
        Some((cut, _)) => format!("{}...", &body[..cut]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_like_go() {
        assert_eq!(hash_body("hello"), "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
        assert_eq!(hash_body("").len(), 64);
        assert_ne!(hash_body("a"), hash_body("A"));
    }

    #[test]
    fn preview_counts_characters_not_bytes() {
        assert_eq!(truncate_comment_preview("short"), "short");
        let exact = "e".repeat(COMMENT_PREVIEW_LENGTH);
        assert_eq!(truncate_comment_preview(&exact), exact);
        assert_eq!(truncate_comment_preview(&format!("{exact}tail")), format!("{exact}..."));

        let accented = "é".repeat(COMMENT_PREVIEW_LENGTH);
        assert_eq!(truncate_comment_preview(&accented), accented, "the limit counts characters, not bytes");
        let got = truncate_comment_preview(&format!("a{accented}"));
        assert_eq!(got, format!("a{}...", "é".repeat(COMMENT_PREVIEW_LENGTH - 1)));

        // 105 characters; byte 100 falls inside an "é".
        let body = format!("{}{}", "a".repeat(95), "é".repeat(10));
        assert_eq!(truncate_comment_preview(&body), format!("{}{}...", "a".repeat(95), "é".repeat(5)));
    }
}
