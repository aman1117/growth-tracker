//! Notifications sent after comment actions (Go `sendCommentNotifications` and the like
//! notification of `LikeComment`). Runs in background tasks; failures are only logged.

use std::sync::Arc;

use chrono::NaiveDate;
use gt_core::models::{Comment, CommentMetadata, User};
use gt_core::timeutil::format_date;
use gt_notify::NotificationService;
use gt_users::repository::{FollowRepository, UserRepository};

use super::notify_plan::{plan_comment_notifications, CommentNotificationKind};
use super::text::truncate_comment_preview;
use crate::dto::MentionDto;

/// A comment that was just created, with what its notifications need.
#[derive(Debug, Clone)]
pub(crate) struct CreatedComment {
    pub comment: Comment,
    pub author_username: String,
    /// The author's row when it could be loaded (for the avatar).
    pub author: Option<User>,
    pub day_owner_username: String,
    pub day_date: NaiveDate,
    /// Author of the parent comment, for replies.
    pub parent_author_id: Option<i64>,
    pub mentions: Vec<MentionDto>,
}

/// Sends comment notifications. Cheap to clone into a spawned task.
#[derive(Debug, Clone)]
pub(crate) struct CommentNotifier {
    pub user_repo: Arc<UserRepository>,
    /// `None` skips the privacy check of mentions (Go: nil `followRepo`).
    pub follow_repo: Option<Arc<FollowRepository>>,
    /// `None` disables notifications (Go: nil `notifSvc`).
    pub notifications: Option<Arc<NotificationService>>,
}

impl CommentNotifier {
    pub fn is_enabled(&self) -> bool {
        self.notifications.is_some()
    }

    /// Notifies the day owner (top-level comments), the parent author and the day owner
    /// (replies) and the mentioned users who may be notified. Nobody is notified twice and the
    /// author never; a private mentioned user is only notified when the author follows them.
    pub async fn send_comment_notifications(&self, created: CreatedComment) {
        let Some(notifications) = &self.notifications else { return };
        let comment = &created.comment;
        let metadata = CommentMetadata {
            comment_id: comment.id,
            comment_preview: truncate_comment_preview(&comment.body),
            day_owner_username: created.day_owner_username.clone(),
            day_date: format_date(&created.day_date),
            author_id: comment.author_id,
            author_username: created.author_username.clone(),
            author_avatar: created.author.as_ref().and_then(|a| a.profile_pic.clone()).unwrap_or_default(),
        };
        let mention_ids: Vec<i64> = created.mentions.iter().map(|m| m.user_id).collect();
        let plan =
            plan_comment_notifications(comment.author_id, comment.day_owner_id, created.parent_author_id, &mention_ids);

        for (recipient, kind) in plan.direct {
            let result = match kind {
                CommentNotificationKind::Received => notifications.notify_comment_received(recipient, &metadata).await,
                CommentNotificationKind::Reply => notifications.notify_comment_reply(recipient, &metadata).await,
            };
            if let Err(err) = result {
                let message = match (kind, created.parent_author_id) {
                    (CommentNotificationKind::Reply, _) => "Failed to send comment_reply notification",
                    (CommentNotificationKind::Received, None) => "Failed to send comment_received notification",
                    (CommentNotificationKind::Received, Some(_)) => {
                        "Failed to send comment_received notification to day owner"
                    }
                };
                tracing::warn!(comment_id = comment.id, recipient, error = %err, "{message}");
            }
        }

        for mentioned_id in plan.mentions {
            if !self.may_notify_mention(comment.author_id, mentioned_id).await {
                continue;
            }
            // Go ignores the result of NotifyCommentMention.
            if let Err(err) = notifications.notify_comment_mention(mentioned_id, &metadata).await {
                tracing::debug!(comment_id = comment.id, mentioned_user_id = mentioned_id, error = %err, "Mention notification failed");
                continue;
            }
            tracing::debug!(comment_id = comment.id, mentioned_user_id = mentioned_id, "Mention notification sent");
        }
    }

    /// Unknown users are skipped; private users only when the commenter follows them (a
    /// failed follow lookup also skips).
    async fn may_notify_mention(&self, commenter_id: i64, mentioned_id: i64) -> bool {
        let Ok(Some(mentioned)) = self.user_repo.find_by_id(mentioned_id).await else {
            return false;
        };
        let Some(follow_repo) = &self.follow_repo else { return true };
        if mentioned.is_private && !matches!(follow_repo.is_following(commenter_id, mentioned_id).await, Ok(true)) {
            tracing::debug!(mentioned_user_id = mentioned_id, commenter_id, "Skipping mention notification (privacy)");
            return false;
        }
        true
    }

    /// Tells the comment's author that `liker_id` liked it.
    pub async fn send_comment_liked(&self, comment: &Comment, liker_id: i64, liker_username: &str) {
        let Some(notifications) = &self.notifications else { return };
        let liker = self.user_repo.find_by_id(liker_id).await.ok().flatten();
        let day_owner = self.user_repo.find_by_id(comment.day_owner_id).await.ok().flatten();
        let metadata = CommentMetadata {
            comment_id: comment.id,
            comment_preview: truncate_comment_preview(&comment.body),
            day_owner_username: day_owner.map(|u| u.username).unwrap_or_default(),
            day_date: format_date(&comment.day_date),
            author_id: liker_id,
            author_username: liker_username.to_string(),
            author_avatar: liker.and_then(|u| u.profile_pic).unwrap_or_default(),
        };
        let notifications = notifications.clone();
        let recipient = comment.author_id;
        tokio::spawn(async move {
            if let Err(err) = notifications.notify_comment_liked(recipient, &metadata).await {
                tracing::warn!(comment_id = metadata.comment_id, recipient, error = %err, "Failed to send comment_liked notification");
            }
        });
    }
}
