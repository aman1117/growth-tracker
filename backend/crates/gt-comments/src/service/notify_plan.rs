//! Who hears about a new comment (pure part of Go `sendCommentNotifications`).

use std::collections::HashSet;

/// Kind of a direct (non-mention) comment notification.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommentNotificationKind {
    /// `comment_received`: someone commented on the recipient's day.
    Received,
    /// `comment_reply`: someone replied to the recipient's comment.
    Reply,
}

/// Recipients of the notifications for a new comment. Nobody is notified twice and the author
/// is never notified.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct NotificationPlan {
    /// Direct notifications, in sending order.
    pub direct: Vec<(i64, CommentNotificationKind)>,
    /// Mentioned users not already notified, in mention order. Each still needs the privacy
    /// check (a private user is only notified when the author follows them).
    pub mentions: Vec<i64>,
}

/// Plans the notifications of a comment by `author_id` on `day_owner_id`'s day.
/// `parent_author_id` is the author of the parent comment for replies.
pub fn plan_comment_notifications(
    author_id: i64,
    day_owner_id: i64,
    parent_author_id: Option<i64>,
    mentioned_user_ids: &[i64],
) -> NotificationPlan {
    let mut notified = HashSet::from([author_id]);
    let mut direct = Vec::new();
    match parent_author_id {
        None => {
            if notified.insert(day_owner_id) {
                direct.push((day_owner_id, CommentNotificationKind::Received));
            }
        }
        Some(parent_author_id) => {
            if notified.insert(parent_author_id) {
                direct.push((parent_author_id, CommentNotificationKind::Reply));
            }
            if notified.insert(day_owner_id) {
                direct.push((day_owner_id, CommentNotificationKind::Received));
            }
        }
    }
    let mentions = mentioned_user_ids.iter().copied().filter(|id| notified.insert(*id)).collect();
    NotificationPlan { direct, mentions }
}

#[cfg(test)]
mod tests {
    use super::CommentNotificationKind::{Received, Reply};
    use super::*;

    const OWNER: i64 = 1;
    const ALICE: i64 = 2;
    const BOB: i64 = 3;

    #[test]
    fn own_top_level_comment_notifies_nobody() {
        assert_eq!(plan_comment_notifications(OWNER, OWNER, None, &[]), NotificationPlan::default());
    }

    #[test]
    fn top_level_comment_notifies_owner_and_mentions_once() {
        let plan = plan_comment_notifications(ALICE, OWNER, None, &[OWNER, ALICE, 10, 11, 10]);
        assert_eq!(plan.direct, vec![(OWNER, Received)]);
        assert_eq!(plan.mentions, vec![10, 11], "the owner, the author and repeats are skipped");
    }

    #[test]
    fn replies() {
        let plan = plan_comment_notifications(BOB, OWNER, Some(ALICE), &[]);
        assert_eq!(plan.direct, vec![(ALICE, Reply), (OWNER, Received)]);

        let own_thread = plan_comment_notifications(BOB, OWNER, Some(BOB), &[]);
        assert_eq!(own_thread.direct, vec![(OWNER, Received)], "reply to own comment only notifies the day owner");

        let to_owner = plan_comment_notifications(BOB, OWNER, Some(OWNER), &[ALICE]);
        assert_eq!(to_owner.direct, vec![(OWNER, Reply)], "a reply to the day owner is a single reply notification");
        assert_eq!(to_owner.mentions, vec![ALICE]);

        let owner_replies = plan_comment_notifications(OWNER, OWNER, Some(ALICE), &[]);
        assert_eq!(owner_replies.direct, vec![(ALICE, Reply)]);
    }
}
