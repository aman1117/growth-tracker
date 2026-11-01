//! Notification triggers called by the other features (Go: the `Notify*` methods).

use gt_core::models::{
    BadgeMetadata, ChallengeActorMetadata, ChallengeEndedMetadata, ChallengeInviteMetadata, CommentMetadata,
    DayCompletedMetadata, FollowMetadata, LikeMetadata, Notification, StreakMetadata, NOTIF_ENTITY_CHALLENGE,
    NOTIF_ENTITY_CHALLENGE_DAY, NOTIF_ENTITY_CHALLENGE_INVITE, NOTIF_TYPE_BADGE_UNLOCKED, NOTIF_TYPE_CHALLENGE_CHEER,
    NOTIF_TYPE_CHALLENGE_ENDED, NOTIF_TYPE_CHALLENGE_INVITE, NOTIF_TYPE_CHALLENGE_JOINED, NOTIF_TYPE_COMMENT_LIKED,
    NOTIF_TYPE_COMMENT_MENTION, NOTIF_TYPE_COMMENT_RECEIVED, NOTIF_TYPE_COMMENT_REPLY, NOTIF_TYPE_FOLLOW_ACCEPTED,
    NOTIF_TYPE_FOLLOW_REQUEST, NOTIF_TYPE_LIKE_RECEIVED, NOTIF_TYPE_NEW_FOLLOWER, NOTIF_TYPE_STREAK_AT_RISK,
    NOTIF_TYPE_STREAK_MILESTONE,
};
use serde_json::Value;

use super::{NotificationError, NotificationService};
use crate::push::{self, PushRequest};
use crate::repository::{NewNotification, NewNotificationDedupe};

/// Push TTL of the streak reminder: sent at 10 PM IST, the day ends at midnight.
const STREAK_REMINDER_PUSH_TTL: i64 = 7200;
/// Push TTL of day-completed notifications: relevant for the rest of the day.
const DAY_COMPLETED_PUSH_TTL: i64 = 14400;

/// Formats a `YYYY-MM-DD` date like Go's `Format("2 Jan, 2006")`; other strings are kept verbatim.
pub(crate) fn display_date(date: &str) -> String {
    gt_core::timeutil::parse_date(date).map(|d| d.format("%-d %b, %Y").to_string()).unwrap_or_else(|| date.to_string())
}

/// How a stored notification is handed to Web Push.
struct PushTarget {
    dedupe_key: String,
    deep_link: String,
    /// Go logs a failed hand-off for some types and silently ignores it for others.
    log_failure: bool,
}

impl NotificationService {
    /// Stores `notif` once per dedupe record (see [`store_once`](Self::store_once)) and, when it
    /// was created, invalidates the unread count, delivers it in real time and queues a Web
    /// Push. The side effects run after the commit (Go ran them inside the transaction
    /// callback, just before its commit).
    async fn notify_deduped(
        &self,
        dedupe: NewNotificationDedupe,
        notif: NewNotification,
        push: PushTarget,
    ) -> Result<(), NotificationError> {
        let created = match self.store_once(&dedupe, &notif).await {
            Ok(created) => created,
            Err(err) => {
                tracing::error!(
                    user_id = dedupe.user_id,
                    actor_id = dedupe.actor_id,
                    notif_type = %dedupe.notif_type,
                    entity_key = %dedupe.entity_key,
                    error = %err,
                    "Failed to create notification"
                );
                return Err(err.into());
            }
        };
        let Some(created) = created else {
            tracing::debug!(
                user_id = dedupe.user_id,
                actor_id = dedupe.actor_id,
                notif_type = %dedupe.notif_type,
                entity_key = %dedupe.entity_key,
                "Skipping duplicate notification"
            );
            return Ok(());
        };
        self.invalidate_unread_cache(created.user_id).await;
        self.publish_notification(&created).await;
        push_from_notification(&created, &push);
        tracing::info!(
            id = created.id,
            user_id = created.user_id,
            actor_id = dedupe.actor_id,
            notif_type = %created.notif_type,
            "Notification created"
        );
        Ok(())
    }

    /// Creates a notification (see [`create`](Self::create)) and hands it to Web Push.
    async fn create_and_push(
        &self,
        notif: NewNotification,
        push: PushTarget,
    ) -> Result<Notification, NotificationError> {
        let created = self.create(notif).await?;
        push_from_notification(&created, &push);
        Ok(created)
    }

    // ==================== Likes, badges, streaks ====================

    /// Someone liked a user's day. Sent once ever per (recipient, liker, date), so unlike +
    /// re-like does not notify twice (Go: `NotifyLikeReceived`).
    pub async fn notify_like_received(
        &self,
        recipient_user_id: i64,
        liker_id: i64,
        liker_username: &str,
        liker_avatar: &str,
        liked_date: &str,
    ) -> Result<(), NotificationError> {
        let metadata = LikeMetadata {
            liker_id,
            liker_username: liker_username.to_string(),
            liker_avatar: liker_avatar.to_string(),
            liked_date: liked_date.to_string(),
        };
        self.notify_deduped(
            NewNotificationDedupe::new(
                recipient_user_id,
                liker_id,
                NOTIF_TYPE_LIKE_RECEIVED,
                "day_like",
                format!("{recipient_user_id}:{liked_date}"),
            ),
            NewNotification::new(
                recipient_user_id,
                NOTIF_TYPE_LIKE_RECEIVED,
                "New Like!",
                format!("{liker_username} liked your {} activities", display_date(liked_date)),
                Some(metadata.to_map()),
            ),
            PushTarget {
                dedupe_key: format!("like:{recipient_user_id}:{liked_date}"),
                // The recipient's own day (home with a date), not the liker's profile
                deep_link: format!("/?date={liked_date}"),
                log_failure: true,
            },
        )
        .await
    }

    /// A user unlocked a badge (Go: `NotifyBadgeUnlocked`).
    pub async fn notify_badge_unlocked(
        &self,
        user_id: i64,
        badge_id: &str,
        badge_name: &str,
        badge_icon: &str,
    ) -> Result<(), NotificationError> {
        let metadata = BadgeMetadata {
            badge_id: badge_id.to_string(),
            badge_name: badge_name.to_string(),
            badge_icon: badge_icon.to_string(),
        };
        self.create_and_push(
            NewNotification::new(
                user_id,
                NOTIF_TYPE_BADGE_UNLOCKED,
                "Badge Unlocked! 🏆",
                format!("You earned the {badge_name} badge"),
                Some(metadata.to_map()),
            ),
            PushTarget {
                dedupe_key: format!("badge:{user_id}:{badge_id}"),
                deep_link: "/profile/badges".into(),
                log_failure: true,
            },
        )
        .await
        .map(drop)
    }

    /// A streak milestone was reached (Go: `NotifyStreakMilestone`; no push).
    pub async fn notify_streak_milestone(
        &self,
        user_id: i64,
        activity_type: &str,
        streak_count: i64,
    ) -> Result<(), NotificationError> {
        let metadata = StreakMetadata { activity_type: activity_type.to_string(), streak_count };
        self.create(NewNotification::new(
            user_id,
            NOTIF_TYPE_STREAK_MILESTONE,
            "Streak Milestone! 🔥",
            format!("You've maintained a {streak_count}-day {activity_type} streak!"),
            Some(metadata.to_map()),
        ))
        .await
        .map(drop)
    }

    /// A streak is about to break (Go: `NotifyStreakAtRisk`; no push).
    pub async fn notify_streak_at_risk(
        &self,
        user_id: i64,
        activity_type: &str,
        streak_count: i64,
    ) -> Result<(), NotificationError> {
        let metadata = StreakMetadata { activity_type: activity_type.to_string(), streak_count };
        self.create(NewNotification::new(
            user_id,
            NOTIF_TYPE_STREAK_AT_RISK,
            "Streak at Risk! ⚠️",
            format!("Don't lose your {streak_count}-day {activity_type} streak! Log today's activity."),
            Some(metadata.to_map()),
        ))
        .await
        .map(drop)
    }

    /// Reminds a user who has not logged today, with a push that expires after 2 hours (the
    /// 10 PM IST cron; the day ends at midnight) (Go: `NotifyStreakReminder`).
    pub async fn notify_streak_reminder(&self, user_id: i64, missed_date: &str) -> Result<(), NotificationError> {
        let metadata = StreakMetadata { activity_type: "daily".into(), streak_count: 0 };
        let notif = self
            .create(NewNotification::new(
                user_id,
                NOTIF_TYPE_STREAK_AT_RISK,
                "Don't Lose Your Streak! 🔥",
                "You haven't logged today. Update now to keep your streak!",
                Some(metadata.to_map()),
            ))
            .await?;
        if let Some(publisher) = push::available_publisher() {
            let result = publisher.publish_push_notification(PushRequest {
                user_id,
                notification_type: notif.notif_type.clone(),
                title: notif.title.clone(),
                body: notif.body.clone(),
                dedupe_key: format!("streak_reminder:{user_id}:{missed_date}"),
                deep_link: "/".into(),
                data: Some(push::notification_data(&notif)),
                ttl_seconds: STREAK_REMINDER_PUSH_TTL,
            });
            if let Err(err) = result {
                tracing::warn!(notif_id = notif.id, user_id, error = %err, "Failed to publish push notification for streak reminder");
            }
        }
        tracing::info!(user_id, missed_date, "Streak reminder notification sent");
        Ok(())
    }

    /// Tells every follower that a user logged all 24 hours of a day. Sent once per (user,
    /// date) however the hours change afterwards: a global dedupe record (actor = the user,
    /// recipient = the first follower) guards the whole batch. One follower failing does not
    /// stop the others (Go: `NotifyDayCompleted`).
    pub async fn notify_day_completed(
        &self,
        completed_user_id: i64,
        completed_username: &str,
        completed_user_avatar: &str,
        completed_date: &str,
        follower_ids: &[i64],
    ) -> Result<(), NotificationError> {
        let Some(&first_follower) = follower_ids.first() else { return Ok(()) };
        let entity_key = format!("day_completed:{completed_user_id}:{completed_date}");

        let existing = self
            .repo
            .find_dedupe_by_actor(completed_user_id, NOTIF_TYPE_STREAK_MILESTONE, &entity_key)
            .await
            .map_err(NotificationError::db("failed to check dedupe"))?;
        if existing.is_some() {
            tracing::debug!(completed_user_id, date = completed_date, "Skipping duplicate day completed notifications");
            return Ok(());
        }
        let created = self
            .repo
            .create_dedupe_record(&NewNotificationDedupe::new(
                first_follower,
                completed_user_id,
                NOTIF_TYPE_STREAK_MILESTONE,
                "day_completed",
                entity_key,
            ))
            .await
            .map_err(NotificationError::db("failed to create dedupe record"))?;
        if !created {
            tracing::debug!(completed_user_id, date = completed_date, "Dedupe record already exists (race condition)");
            return Ok(());
        }

        tracing::info!(
            completed_user_id,
            completed_username,
            date = completed_date,
            follower_count = follower_ids.len(),
            "Sending day completed notifications"
        );
        let body = format!("{completed_username} logged all 24 hours on {}", display_date(completed_date));
        let deep_link = format!("/user/{completed_username}?date={completed_date}");
        let metadata = DayCompletedMetadata {
            completed_user_id,
            completed_username: completed_username.to_string(),
            completed_user_avatar: completed_user_avatar.to_string(),
            completed_date: completed_date.to_string(),
        }
        .to_map();

        let (mut success, mut failed) = (0usize, 0usize);
        for &follower_id in follower_ids {
            let notif = NewNotification::new(
                follower_id,
                NOTIF_TYPE_STREAK_MILESTONE,
                "Day Completed! 🎯",
                body.clone(),
                Some(metadata.clone()),
            );
            let notif = match self.create(notif).await {
                Ok(notif) => notif,
                Err(err) => {
                    tracing::warn!(follower_id, completed_user_id, error = %err, "Failed to create day completed notification");
                    failed += 1;
                    continue;
                }
            };
            if let Some(publisher) = push::available_publisher() {
                let result = publisher.publish_push_notification(PushRequest {
                    user_id: follower_id,
                    notification_type: notif.notif_type.clone(),
                    title: notif.title.clone(),
                    body: notif.body.clone(),
                    dedupe_key: format!("day_completed:{follower_id}:{completed_user_id}:{completed_date}"),
                    deep_link: deep_link.clone(),
                    data: Some(push::notification_data(&notif)),
                    ttl_seconds: DAY_COMPLETED_PUSH_TTL,
                });
                if let Err(err) = result {
                    tracing::warn!(notif_id = notif.id, follower_id, error = %err, "Failed to publish push notification for day completed");
                }
            }
            success += 1;
        }
        tracing::info!(completed_user_id, date = completed_date, success, failed, "Day completed notifications sent");
        Ok(())
    }

    // ==================== Follows ====================

    /// Someone asked to follow a private account; sent once per (recipient, requester)
    /// (Go: `NotifyFollowRequest`).
    pub async fn notify_follow_request(
        &self,
        recipient_user_id: i64,
        requester_id: i64,
        requester_username: &str,
        requester_avatar: &str,
    ) -> Result<(), NotificationError> {
        let metadata = follow_metadata(requester_id, requester_username, requester_avatar);
        self.notify_deduped(
            NewNotificationDedupe::new(
                recipient_user_id,
                requester_id,
                NOTIF_TYPE_FOLLOW_REQUEST,
                "follow",
                format!("follow_request:{requester_id}"),
            ),
            NewNotification::new(
                recipient_user_id,
                NOTIF_TYPE_FOLLOW_REQUEST,
                "New Follow Request",
                format!("{requester_username} wants to follow you"),
                Some(metadata),
            ),
            PushTarget {
                dedupe_key: format!("follow_request:{recipient_user_id}:{requester_id}"),
                deep_link: format!("/user/{requester_username}"),
                log_failure: true,
            },
        )
        .await
    }

    /// A follow request was accepted (Go: `NotifyFollowAccepted`; not deduplicated).
    pub async fn notify_follow_accepted(
        &self,
        recipient_user_id: i64,
        accepter_id: i64,
        accepter_username: &str,
        accepter_avatar: &str,
    ) -> Result<(), NotificationError> {
        self.create_and_push(
            NewNotification::new(
                recipient_user_id,
                NOTIF_TYPE_FOLLOW_ACCEPTED,
                "Follow Request Accepted! 🎉",
                format!("{accepter_username} accepted your follow request"),
                Some(follow_metadata(accepter_id, accepter_username, accepter_avatar)),
            ),
            PushTarget {
                dedupe_key: format!("follow_accepted:{recipient_user_id}:{accepter_id}"),
                deep_link: format!("/user/{accepter_username}"),
                log_failure: true,
            },
        )
        .await
        .map(drop)
    }

    /// Someone started following a public account; sent once per (recipient, follower)
    /// (Go: `NotifyNewFollower`).
    pub async fn notify_new_follower(
        &self,
        recipient_user_id: i64,
        follower_id: i64,
        follower_username: &str,
        follower_avatar: &str,
    ) -> Result<(), NotificationError> {
        self.notify_deduped(
            NewNotificationDedupe::new(
                recipient_user_id,
                follower_id,
                NOTIF_TYPE_NEW_FOLLOWER,
                "follow",
                format!("new_follower:{follower_id}"),
            ),
            NewNotification::new(
                recipient_user_id,
                NOTIF_TYPE_NEW_FOLLOWER,
                "New Follower! 👋",
                format!("{follower_username} started following you"),
                Some(follow_metadata(follower_id, follower_username, follower_avatar)),
            ),
            PushTarget {
                dedupe_key: format!("new_follower:{recipient_user_id}:{follower_id}"),
                deep_link: format!("/user/{follower_username}"),
                log_failure: true,
            },
        )
        .await
    }

    // ==================== Comments ====================
    //
    // Go passes the comment fields as eight positional arguments
    // (`recipientUserID, authorID, authorUsername, authorAvatar, commentID, bodyPreview,
    // dayOwnerUsername, dayDate`); here they travel in `CommentMetadata`, the struct that ends up
    // as the notification metadata. For `notify_comment_liked` the author fields carry the liker.

    /// Someone commented on the recipient's day; once per comment (Go: `NotifyCommentReceived`).
    pub async fn notify_comment_received(
        &self,
        recipient_user_id: i64,
        comment: &CommentMetadata,
    ) -> Result<(), NotificationError> {
        self.notify_comment(
            recipient_user_id,
            comment,
            NOTIF_TYPE_COMMENT_RECEIVED,
            "day_comment",
            format!("comment:{}", comment.comment_id),
            "New Comment",
            format!("{} commented on your day", comment.author_username),
        )
        .await
    }

    /// Someone replied to the recipient's comment; once per reply (Go: `NotifyCommentReply`).
    pub async fn notify_comment_reply(
        &self,
        recipient_user_id: i64,
        comment: &CommentMetadata,
    ) -> Result<(), NotificationError> {
        self.notify_comment(
            recipient_user_id,
            comment,
            NOTIF_TYPE_COMMENT_REPLY,
            "comment_reply",
            format!("reply:{}", comment.comment_id),
            "New Reply",
            format!("{} replied to your comment", comment.author_username),
        )
        .await
    }

    /// The recipient was @mentioned in a comment; once per (comment, recipient) (Go:
    /// `NotifyCommentMention`).
    pub async fn notify_comment_mention(
        &self,
        recipient_user_id: i64,
        comment: &CommentMetadata,
    ) -> Result<(), NotificationError> {
        self.notify_comment(
            recipient_user_id,
            comment,
            NOTIF_TYPE_COMMENT_MENTION,
            "comment_mention",
            format!("mention:{}:{recipient_user_id}", comment.comment_id),
            "You were mentioned",
            format!("{} mentioned you in a comment", comment.author_username),
        )
        .await
    }

    /// Someone (the `author_*` fields) liked the recipient's comment; once per (comment, liker)
    /// (Go: `NotifyCommentLiked`).
    pub async fn notify_comment_liked(
        &self,
        recipient_user_id: i64,
        comment: &CommentMetadata,
    ) -> Result<(), NotificationError> {
        self.notify_comment(
            recipient_user_id,
            comment,
            NOTIF_TYPE_COMMENT_LIKED,
            "comment_like",
            format!("comment_like:{}:{}", comment.comment_id, comment.author_id),
            "Comment Liked",
            format!("{} liked your comment", comment.author_username),
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn notify_comment(
        &self,
        recipient_user_id: i64,
        comment: &CommentMetadata,
        notif_type: &str,
        entity_type: &str,
        entity_key: String,
        title: &str,
        body: String,
    ) -> Result<(), NotificationError> {
        let deep_link = format!("/user/{}?date={}&comments=true", comment.day_owner_username, comment.day_date);
        self.notify_deduped(
            NewNotificationDedupe::new(
                recipient_user_id,
                comment.author_id,
                notif_type,
                entity_type,
                entity_key.clone(),
            ),
            NewNotification::new(recipient_user_id, notif_type, title, body, Some(comment.to_map())),
            // The push dedupe key is the entity key for every comment type.
            PushTarget { dedupe_key: entity_key, deep_link, log_failure: false },
        )
        .await
    }

    // ==================== Challenges ====================

    /// The invitee was invited to a challenge; links to the invite page. Sent once per invite,
    /// so someone invited again after leaving is notified again (Go: `NotifyChallengeInvite`,
    /// whose positional arguments travel in `invite`: the inviter is the actor).
    pub async fn notify_challenge_invite(
        &self,
        invitee_id: i64,
        invite_id: i64,
        invite: &ChallengeInviteMetadata,
    ) -> Result<(), NotificationError> {
        let actor = &invite.actor;
        self.notify_deduped(
            NewNotificationDedupe::new(
                invitee_id,
                actor.actor_id,
                NOTIF_TYPE_CHALLENGE_INVITE,
                NOTIF_ENTITY_CHALLENGE_INVITE,
                invite_id.to_string(),
            ),
            NewNotification::new(
                invitee_id,
                NOTIF_TYPE_CHALLENGE_INVITE,
                "Challenge invite 🏆",
                format!("{} invited you to “{}”", actor.actor_username, actor.challenge_title),
                Some(invite.to_map()),
            ),
            PushTarget {
                dedupe_key: format!(
                    "challenge_invite:{invitee_id}:{}:{}:{invite_id}",
                    actor.actor_id, actor.challenge_id
                ),
                deep_link: format!("/c/{}", invite.invite_code),
                log_failure: true,
            },
        )
        .await
    }

    /// Someone (the actor) joined the creator's challenge; once per (creator, joiner,
    /// challenge), so leaving and joining again does not notify twice (Go: `NotifyChallengeJoined`).
    pub async fn notify_challenge_joined(
        &self,
        creator_id: i64,
        joiner: &ChallengeActorMetadata,
    ) -> Result<(), NotificationError> {
        self.notify_deduped(
            NewNotificationDedupe::new(
                creator_id,
                joiner.actor_id,
                NOTIF_TYPE_CHALLENGE_JOINED,
                NOTIF_ENTITY_CHALLENGE,
                joiner.challenge_id.to_string(),
            ),
            NewNotification::new(
                creator_id,
                NOTIF_TYPE_CHALLENGE_JOINED,
                "New challenger 🏁",
                format!("{} joined “{}”", joiner.actor_username, joiner.challenge_title),
                Some(joiner.to_map()),
            ),
            PushTarget {
                dedupe_key: format!("challenge_joined:{creator_id}:{}:{}", joiner.actor_id, joiner.challenge_id),
                deep_link: format!("/challenges/{}", joiner.challenge_id),
                log_failure: true,
            },
        )
        .await
    }

    /// Another participant (the actor) cheered the recipient on; once per (recipient, cheerer,
    /// challenge, date) (Go: `NotifyChallengeCheer`).
    pub async fn notify_challenge_cheer(
        &self,
        recipient_id: i64,
        cheer_date: &str,
        cheerer: &ChallengeActorMetadata,
    ) -> Result<(), NotificationError> {
        self.notify_deduped(
            NewNotificationDedupe::new(
                recipient_id,
                cheerer.actor_id,
                NOTIF_TYPE_CHALLENGE_CHEER,
                NOTIF_ENTITY_CHALLENGE_DAY,
                format!("{}:{cheer_date}", cheerer.challenge_id),
            ),
            NewNotification::new(
                recipient_id,
                NOTIF_TYPE_CHALLENGE_CHEER,
                "You got a cheer 👏",
                format!("{} cheered you on in “{}”", cheerer.actor_username, cheerer.challenge_title),
                Some(cheerer.to_map()),
            ),
            PushTarget {
                dedupe_key: format!(
                    "challenge_cheer:{recipient_id}:{}:{}:{cheer_date}",
                    cheerer.actor_id, cheerer.challenge_id
                ),
                deep_link: format!("/challenges/{}", cheerer.challenge_id),
                log_failure: true,
            },
        )
        .await
    }

    /// A participant's final result once a challenge is finalized; once per (recipient,
    /// challenge), sent by the system (actor 0) (Go: `NotifyChallengeEnded`).
    pub async fn notify_challenge_ended(
        &self,
        recipient_id: i64,
        result: &ChallengeEndedMetadata,
    ) -> Result<(), NotificationError> {
        let title = if result.completed { "Challenge complete 🎉" } else { "Challenge ended" };
        self.notify_deduped(
            NewNotificationDedupe::new(
                recipient_id,
                0,
                NOTIF_TYPE_CHALLENGE_ENDED,
                NOTIF_ENTITY_CHALLENGE,
                result.challenge_id.to_string(),
            ),
            NewNotification::new(
                recipient_id,
                NOTIF_TYPE_CHALLENGE_ENDED,
                title,
                format!(
                    "“{}” is over: you finished #{} with {}/{} days.",
                    result.challenge_title, result.rank, result.days_met, result.days_possible
                ),
                Some(result.to_map()),
            ),
            PushTarget {
                dedupe_key: format!("challenge_ended:{recipient_id}:{}", result.challenge_id),
                deep_link: format!("/challenges/{}", result.challenge_id),
                log_failure: true,
            },
        )
        .await
    }
}

fn follow_metadata(actor_id: i64, username: &str, avatar: &str) -> Value {
    FollowMetadata { actor_id, actor_username: username.to_string(), actor_avatar: avatar.to_string() }.to_map()
}

/// Queues a Web Push for a stored notification when the publisher is available. The in-app
/// notification is already delivered, so failures are only logged (or ignored, like Go does for
/// comment notifications).
fn push_from_notification(notif: &Notification, target: &PushTarget) {
    let Some(publisher) = push::available_publisher() else { return };
    if let Err(err) = publisher.publish_from_notification(notif, &target.dedupe_key, &target.deep_link) {
        if target.log_failure {
            tracing::warn!(
                notif_id = notif.id,
                notif_type = %notif.notif_type,
                error = %err,
                "Failed to publish push notification; the in-app notification is still delivered"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_display_like_go() {
        assert_eq!(display_date("2026-01-02"), "2 Jan, 2026");
        assert_eq!(display_date("2026-02-10"), "10 Feb, 2026");
        assert_eq!(display_date("yesterday"), "yesterday");
        assert_eq!(display_date("2026-1-02"), "2026-1-02");
    }
}
