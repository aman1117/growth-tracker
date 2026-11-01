use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{json, Value};

use crate::gojson;

// Notification types
pub const NOTIF_TYPE_LIKE_RECEIVED: &str = "like_received";
pub const NOTIF_TYPE_BADGE_UNLOCKED: &str = "badge_unlocked";
pub const NOTIF_TYPE_STREAK_MILESTONE: &str = "streak_milestone";
pub const NOTIF_TYPE_STREAK_AT_RISK: &str = "streak_at_risk";
pub const NOTIF_TYPE_SYSTEM_ANNOUNCE: &str = "system_announcement";
pub const NOTIF_TYPE_FOLLOW_REQUEST: &str = "follow_request";
pub const NOTIF_TYPE_FOLLOW_ACCEPTED: &str = "follow_accepted";
pub const NOTIF_TYPE_NEW_FOLLOWER: &str = "new_follower";
pub const NOTIF_TYPE_PHOTO_UPLOADED: &str = "photo_uploaded";
pub const NOTIF_TYPE_STORY_LIKED: &str = "story_liked";
pub const NOTIF_TYPE_COMMENT_RECEIVED: &str = "comment_received";
pub const NOTIF_TYPE_COMMENT_REPLY: &str = "comment_reply";
pub const NOTIF_TYPE_COMMENT_MENTION: &str = "comment_mention";
pub const NOTIF_TYPE_COMMENT_LIKED: &str = "comment_liked";
pub const NOTIF_TYPE_CHALLENGE_INVITE: &str = "challenge_invite";
pub const NOTIF_TYPE_CHALLENGE_JOINED: &str = "challenge_joined";
pub const NOTIF_TYPE_CHALLENGE_CHEER: &str = "challenge_cheer";
pub const NOTIF_TYPE_CHALLENGE_ENDED: &str = "challenge_ended";

// Entity types of challenge notification deduplication records
/// Key: challenge id (joined, ended).
pub const NOTIF_ENTITY_CHALLENGE: &str = "challenge";
/// Key: challenge id and date (cheer).
pub const NOTIF_ENTITY_CHALLENGE_DAY: &str = "challenge_day";
/// Key: invite id (invite).
pub const NOTIF_ENTITY_CHALLENGE_INVITE: &str = "challenge_invite";

/// A user notification (`notifications`).
#[derive(Debug, Clone, PartialEq, Serialize, sqlx::FromRow)]
pub struct Notification {
    pub id: i64,
    pub user_id: i64,
    #[serde(rename = "type")]
    #[sqlx(rename = "type")]
    pub notif_type: String,
    pub title: String,
    pub body: String,
    /// JSON object (Go `NotificationMetadata` map; `null` when unset). Keys marshal sorted.
    pub metadata: Option<Value>,
    #[serde(with = "gojson::time_opt")]
    pub read_at: Option<DateTime<Utc>>,
    #[serde(with = "gojson::time")]
    pub created_at: DateTime<Utc>,
}

impl Notification {
    pub const COLUMNS: &'static str =
        "id, user_id, type, title, COALESCE(body, '') AS body, metadata, read_at, created_at";

    pub fn is_read(&self) -> bool {
        self.read_at.is_some()
    }
}

/// "Only once ever" delivery record (`notification_dedupes`).
#[derive(Debug, Clone, PartialEq, sqlx::FromRow)]
pub struct NotificationDedupe {
    pub id: i64,
    pub user_id: i64,
    pub actor_id: i64,
    #[sqlx(rename = "type")]
    pub notif_type: String,
    pub entity_type: String,
    pub entity_key: String,
    pub created_at: DateTime<Utc>,
}

impl NotificationDedupe {
    pub const COLUMNS: &'static str = "id, user_id, actor_id, type, entity_type, entity_key, created_at";
}

// ==================== Metadata (Go `ToMap` always includes every key) ====================

/// `like_received`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LikeMetadata {
    pub liker_id: i64,
    pub liker_username: String,
    pub liker_avatar: String,
    pub liked_date: String,
}

impl LikeMetadata {
    pub fn to_map(&self) -> Value {
        json!({
            "liker_id": self.liker_id,
            "liker_username": self.liker_username,
            "liker_avatar": self.liker_avatar,
            "liked_date": self.liked_date,
        })
    }
}

/// `badge_unlocked`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BadgeMetadata {
    pub badge_id: String,
    pub badge_name: String,
    pub badge_icon: String,
}

impl BadgeMetadata {
    pub fn to_map(&self) -> Value {
        json!({ "badge_id": self.badge_id, "badge_name": self.badge_name, "badge_icon": self.badge_icon })
    }
}

/// Streak notifications.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StreakMetadata {
    pub activity_type: String,
    pub streak_count: i64,
}

impl StreakMetadata {
    pub fn to_map(&self) -> Value {
        json!({ "activity_type": self.activity_type, "streak_count": self.streak_count })
    }
}

/// Sent to followers when someone completes 24 hours of logging.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DayCompletedMetadata {
    pub completed_user_id: i64,
    pub completed_username: String,
    pub completed_user_avatar: String,
    pub completed_date: String,
}

impl DayCompletedMetadata {
    pub fn to_map(&self) -> Value {
        json!({
            "completed_user_id": self.completed_user_id,
            "completed_username": self.completed_username,
            "completed_user_avatar": self.completed_user_avatar,
            "completed_date": self.completed_date,
        })
    }
}

/// Comment notifications.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CommentMetadata {
    pub comment_id: i64,
    pub comment_preview: String,
    pub day_owner_username: String,
    pub day_date: String,
    pub author_id: i64,
    pub author_username: String,
    pub author_avatar: String,
}

impl CommentMetadata {
    pub fn to_map(&self) -> Value {
        json!({
            "comment_id": self.comment_id,
            "comment_preview": self.comment_preview,
            "day_owner_username": self.day_owner_username,
            "day_date": self.day_date,
            "author_id": self.author_id,
            "author_username": self.author_username,
            "author_avatar": self.author_avatar,
        })
    }
}

/// `challenge_joined` and `challenge_cheer`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ChallengeActorMetadata {
    pub challenge_id: i64,
    pub challenge_title: String,
    pub actor_id: i64,
    pub actor_username: String,
    pub actor_avatar: String,
}

impl ChallengeActorMetadata {
    pub fn to_map(&self) -> Value {
        json!({
            "challenge_id": self.challenge_id,
            "challenge_title": self.challenge_title,
            "actor_id": self.actor_id,
            "actor_username": self.actor_username,
            "actor_avatar": self.actor_avatar,
        })
    }
}

/// `challenge_invite`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ChallengeInviteMetadata {
    pub actor: ChallengeActorMetadata,
    pub invite_code: String,
}

impl ChallengeInviteMetadata {
    pub fn to_map(&self) -> Value {
        let mut map = self.actor.to_map();
        map["invite_code"] = Value::from(self.invite_code.clone());
        map
    }
}

/// `challenge_ended`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ChallengeEndedMetadata {
    pub challenge_id: i64,
    pub challenge_title: String,
    pub rank: i64,
    pub days_met: i64,
    pub days_possible: i64,
    pub completed: bool,
}

impl ChallengeEndedMetadata {
    pub fn to_map(&self) -> Value {
        json!({
            "challenge_id": self.challenge_id,
            "challenge_title": self.challenge_title,
            "rank": self.rank,
            "days_met": self.days_met,
            "days_possible": self.days_possible,
            "completed": self.completed,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metadata_keys_are_sorted_like_go_maps() {
        let m = LikeMetadata {
            liker_id: 3,
            liker_username: "a".into(),
            liker_avatar: String::new(),
            liked_date: "2026-01-01".into(),
        };
        assert_eq!(
            gojson::to_string(&m.to_map()).unwrap(),
            r#"{"liked_date":"2026-01-01","liker_avatar":"","liker_id":3,"liker_username":"a"}"#
        );
    }
}
