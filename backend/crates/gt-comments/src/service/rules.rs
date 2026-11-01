//! Business rules of comments as pure functions. Errors carry the exact messages and codes the
//! Go service returned (handlers map the codes to HTTP statuses).

use chrono::{DateTime, NaiveDate, Utc};
use gt_core::constants as c;
use gt_core::models::Comment;
use gt_core::validator::ValidationError;

pub fn comment_not_found() -> ValidationError {
    ValidationError::new("Comment not found", c::ERR_CODE_COMMENT_NOT_FOUND)
}

pub fn duplicate_comment() -> ValidationError {
    ValidationError::new("Duplicate comment detected. Please wait before posting again.", c::ERR_CODE_DUPLICATE_COMMENT)
}

pub fn parent_not_found() -> ValidationError {
    ValidationError::new("Parent comment not found", c::ERR_CODE_PARENT_NOT_FOUND)
}

/// Where a reply attaches in its thread.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReplyTarget {
    pub parent_comment_id: i64,
    /// The top-level comment of the thread (replies to replies keep the thread root).
    pub root_comment_id: i64,
    /// Author of the parent comment.
    pub reply_to_user_id: i64,
}

/// Validates the parent of a reply. A parent on another day is reported like a missing one:
/// the caller's view permission was checked for this day only, and the response must not
/// reveal other threads.
pub fn resolve_reply_target(
    parent: Option<&Comment>,
    day_owner_id: i64,
    day_date: NaiveDate,
) -> Result<ReplyTarget, ValidationError> {
    match parent {
        Some(p) if p.day_owner_id == day_owner_id && p.day_date == day_date => Ok(ReplyTarget {
            parent_comment_id: p.id,
            root_comment_id: p.root_comment_id.unwrap_or(p.id),
            reply_to_user_id: p.author_id,
        }),
        _ => Err(parent_not_found()),
    }
}

/// The day owner used for delete authorization: the caller-supplied one, or the comment's own
/// when the caller passed `0` (the handler does not know it upfront).
pub fn effective_day_owner_id(comment: &Comment, day_owner_id: i64) -> i64 {
    if day_owner_id == 0 {
        comment.day_owner_id
    } else {
        day_owner_id
    }
}

/// A comment may be deleted (once) by its author or by the owner of the day.
pub fn check_can_delete(comment: &Comment, requester_id: i64, day_owner_id: i64) -> Result<(), ValidationError> {
    if comment.is_deleted {
        return Err(ValidationError::new("Comment already deleted", c::ERR_CODE_COMMENT_DELETED));
    }
    if comment.author_id != requester_id && effective_day_owner_id(comment, day_owner_id) != requester_id {
        return Err(ValidationError::new("Not authorized to delete this comment", c::ERR_CODE_COMMENT_FORBIDDEN));
    }
    Ok(())
}

/// Deleting a reply decrements its ancestors' reply counts only when it has no replies of its
/// own; otherwise it stays as a `[Deleted]` placeholder that keeps the thread visible.
pub fn decrements_ancestors_on_delete(comment: &Comment) -> bool {
    comment.parent_comment_id.is_some() && comment.reply_count == 0
}

/// Deleted comments cannot be liked.
pub fn check_can_like(comment: &Comment) -> Result<(), ValidationError> {
    if comment.is_deleted {
        return Err(ValidationError::new("Cannot like a deleted comment", c::ERR_CODE_COMMENT_DELETED));
    }
    Ok(())
}

/// Only the author may edit a non-deleted comment, within the edit window after creation.
pub fn check_can_edit(comment: &Comment, requester_id: i64, now: DateTime<Utc>) -> Result<(), ValidationError> {
    if comment.is_deleted {
        return Err(ValidationError::new("Cannot edit a deleted comment", c::ERR_CODE_COMMENT_DELETED));
    }
    if comment.author_id != requester_id {
        return Err(ValidationError::new("Not authorized to edit this comment", c::ERR_CODE_COMMENT_FORBIDDEN));
    }
    if edit_window_expired(comment.created_at, now) {
        return Err(ValidationError::new("Edit window has expired", c::ERR_CODE_COMMENT_EDIT_EXPIRED));
    }
    Ok(())
}

/// Go: `time.Since(createdAt) > CommentEditWindow`.
pub fn edit_window_expired(created_at: DateTime<Utc>, now: DateTime<Utc>) -> bool {
    match now.signed_duration_since(created_at).to_std() {
        Ok(elapsed) => elapsed > c::COMMENT_EDIT_WINDOW,
        Err(_) => false,
    }
}

/// Like count reported after a like: one more only when the like is new.
pub fn like_count_after_like(like_count: i64, created: bool) -> i64 {
    if created {
        like_count + 1
    } else {
        like_count
    }
}

/// Like count reported after an unlike: one less only when a like was removed (never below 0).
pub fn like_count_after_unlike(like_count: i64, removed: bool) -> i64 {
    if removed && like_count > 0 {
        like_count - 1
    } else {
        like_count
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    fn day() -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 3, 10).unwrap()
    }

    fn comment(id: i64, author_id: i64) -> Comment {
        let now = Utc::now();
        Comment {
            id,
            day_owner_id: 1,
            day_date: day(),
            author_id,
            parent_comment_id: None,
            root_comment_id: None,
            reply_to_user_id: None,
            body: "body".into(),
            like_count: 0,
            reply_count: 0,
            is_edited: false,
            is_deleted: false,
            deleted_at: None,
            created_at: now,
            updated_at: now,
        }
    }

    #[test]
    fn replies_attach_to_the_thread_root() {
        let top = comment(10, 2);
        assert_eq!(
            resolve_reply_target(Some(&top), 1, day()),
            Ok(ReplyTarget { parent_comment_id: 10, root_comment_id: 10, reply_to_user_id: 2 })
        );
        let reply = Comment { parent_comment_id: Some(10), root_comment_id: Some(10), ..comment(11, 3) };
        assert_eq!(
            resolve_reply_target(Some(&reply), 1, day()),
            Ok(ReplyTarget { parent_comment_id: 11, root_comment_id: 10, reply_to_user_id: 3 })
        );
    }

    #[test]
    fn parents_elsewhere_are_not_found() {
        let top = comment(10, 2);
        let code = |r: Result<ReplyTarget, ValidationError>| r.unwrap_err().code;
        assert_eq!(code(resolve_reply_target(None, 1, day())), c::ERR_CODE_PARENT_NOT_FOUND);
        assert_eq!(code(resolve_reply_target(Some(&top), 5, day())), c::ERR_CODE_PARENT_NOT_FOUND);
        let tomorrow = day().succ_opt().unwrap();
        let err = resolve_reply_target(Some(&top), 1, tomorrow).unwrap_err();
        assert_eq!(err.message, "Parent comment not found");
    }

    #[test]
    fn delete_rules() {
        let base = comment(10, 2);
        assert!(check_can_delete(&base, 2, 0).is_ok(), "author");
        assert!(check_can_delete(&base, 1, 0).is_ok(), "day owner taken from the comment");
        assert!(check_can_delete(&base, 7, 7).is_ok(), "explicit day owner");
        let err = check_can_delete(&base, 3, 0).unwrap_err();
        assert_eq!(
            (err.message.as_str(), err.code),
            ("Not authorized to delete this comment", c::ERR_CODE_COMMENT_FORBIDDEN)
        );
        let deleted = Comment { is_deleted: true, ..base.clone() };
        let err = check_can_delete(&deleted, 2, 0).unwrap_err();
        assert_eq!((err.message.as_str(), err.code), ("Comment already deleted", c::ERR_CODE_COMMENT_DELETED));
        assert_eq!(effective_day_owner_id(&base, 0), 1);
        assert_eq!(effective_day_owner_id(&base, 4), 4);
    }

    #[test]
    fn only_leaf_replies_decrement_ancestors() {
        let top = comment(10, 2);
        assert!(!decrements_ancestors_on_delete(&top));
        let leaf = Comment { parent_comment_id: Some(10), ..comment(11, 2) };
        assert!(decrements_ancestors_on_delete(&leaf));
        let with_children = Comment { reply_count: 1, ..leaf };
        assert!(!decrements_ancestors_on_delete(&with_children));
    }

    #[test]
    fn edit_rules() {
        let now = Utc::now();
        let base = comment(10, 2);
        assert!(check_can_edit(&base, 2, now).is_ok());
        assert_eq!(check_can_edit(&base, 3, now).unwrap_err().code, c::ERR_CODE_COMMENT_FORBIDDEN);
        let deleted = Comment { is_deleted: true, ..base.clone() };
        assert_eq!(check_can_edit(&deleted, 3, now).unwrap_err().code, c::ERR_CODE_COMMENT_DELETED);
        let stale = Comment { created_at: now - Duration::minutes(61), ..base.clone() };
        let err = check_can_edit(&stale, 2, now).unwrap_err();
        assert_eq!((err.message.as_str(), err.code), ("Edit window has expired", c::ERR_CODE_COMMENT_EDIT_EXPIRED));
        assert!(!edit_window_expired(now - Duration::hours(1), now), "exactly one hour is still allowed");
        assert!(!edit_window_expired(now + Duration::minutes(5), now), "clock skew never expires");
    }

    #[test]
    fn like_rules_and_counts() {
        let base = comment(10, 2);
        assert!(check_can_like(&base).is_ok());
        let err = check_can_like(&Comment { is_deleted: true, ..base }).unwrap_err();
        assert_eq!((err.message.as_str(), err.code), ("Cannot like a deleted comment", c::ERR_CODE_COMMENT_DELETED));
        assert_eq!(like_count_after_like(3, true), 4);
        assert_eq!(like_count_after_like(3, false), 3);
        assert_eq!(like_count_after_unlike(3, true), 2);
        assert_eq!(like_count_after_unlike(0, true), 0);
        assert_eq!(like_count_after_unlike(3, false), 3);
    }

    #[test]
    fn fixed_errors() {
        assert_eq!(comment_not_found().code, c::ERR_CODE_COMMENT_NOT_FOUND);
        assert_eq!(duplicate_comment().message, "Duplicate comment detected. Please wait before posting again.");
        assert_eq!(parent_not_found().code, c::ERR_CODE_PARENT_NOT_FOUND);
    }
}
