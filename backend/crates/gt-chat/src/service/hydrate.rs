//! Pure mapping of stored rows to DTOs.

use std::collections::HashMap;

use crate::dto::{ChatUserDto, MessageDto, ReactionDto, ReplyPreviewDto};
use crate::repository::{ChatUser, Message, Reaction};
use crate::rules::{format_time, reply_preview};

pub(crate) fn user_dto(user: &ChatUser) -> ChatUserDto {
    ChatUserDto {
        id: user.id,
        username: user.username.clone(),
        profile_pic: user.profile_pic_thumb.clone().filter(|p| !p.is_empty()).or_else(|| user.profile_pic.clone()),
        is_verified: user.is_verified,
    }
}

/// Placeholder for a member whose account could not be loaded.
pub(crate) fn unknown_user_dto(id: i64) -> ChatUserDto {
    ChatUserDto { id, username: String::new(), profile_pic: None, is_verified: false }
}

/// Reactions per message, each list oldest first (the order of `rows`).
pub(crate) fn group_reactions(rows: Vec<Reaction>) -> HashMap<i64, Vec<ReactionDto>> {
    let mut grouped: HashMap<i64, Vec<ReactionDto>> = HashMap::new();
    for row in rows {
        grouped.entry(row.message_id).or_default().push(ReactionDto { user_id: row.user_id, emoji: row.emoji });
    }
    grouped
}

fn reply_dto(target: &Message) -> ReplyPreviewDto {
    ReplyPreviewDto {
        id: target.id,
        sender_id: target.sender_id,
        body: if target.is_deleted { String::new() } else { reply_preview(&target.body) },
        is_deleted: target.is_deleted,
    }
}

/// A message with its reply preview (`None` when the quoted message is gone) and reactions
/// (none once unsent).
pub(crate) fn message_dto(
    message: &Message,
    replies: &HashMap<i64, Message>,
    reactions: &HashMap<i64, Vec<ReactionDto>>,
) -> MessageDto {
    MessageDto {
        id: message.id,
        conversation_id: message.conversation_id,
        sender_id: message.sender_id,
        body: if message.is_deleted { String::new() } else { message.body.clone() },
        client_message_id: message.client_message_id.clone(),
        reply_to: message.reply_to_message_id.and_then(|id| replies.get(&id)).map(reply_dto),
        reactions: if message.is_deleted {
            Vec::new()
        } else {
            reactions.get(&message.id).cloned().unwrap_or_default()
        },
        is_deleted: message.is_deleted,
        created_at: format_time(&message.created_at),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    fn message(id: i64, body: &str, reply_to: Option<i64>, deleted: bool) -> Message {
        Message {
            id,
            conversation_id: 1,
            sender_id: 7,
            body: body.into(),
            reply_to_message_id: reply_to,
            client_message_id: Some(format!("c{id}")),
            is_deleted: deleted,
            created_at: Utc::now(),
        }
    }

    #[test]
    fn users_prefer_thumbnails() {
        let mut user = ChatUser {
            id: 1,
            username: "amy".into(),
            profile_pic: Some("full.jpg".into()),
            profile_pic_thumb: Some("thumb.jpg".into()),
            is_verified: true,
        };
        assert_eq!(user_dto(&user).profile_pic.as_deref(), Some("thumb.jpg"));
        user.profile_pic_thumb = Some(String::new());
        assert_eq!(user_dto(&user).profile_pic.as_deref(), Some("full.jpg"));
        user.profile_pic_thumb = None;
        user.profile_pic = None;
        assert_eq!(user_dto(&user).profile_pic, None);
        assert_eq!(unknown_user_dto(4).id, 4);
    }

    #[test]
    fn messages_carry_replies_and_reactions() {
        let now = Utc::now();
        let reactions = group_reactions(vec![
            Reaction { message_id: 2, user_id: 7, emoji: "👍".into(), created_at: now },
            Reaction { message_id: 2, user_id: 8, emoji: "❤️".into(), created_at: now },
        ]);
        let replies: HashMap<i64, Message> =
            [(1, message(1, "original", None, false)), (5, message(5, "secret", None, true))].into();

        let dto = message_dto(&message(2, "reply", Some(1), false), &replies, &reactions);
        assert_eq!(dto.reply_to.as_ref().map(|r| (r.id, r.body.as_str(), r.is_deleted)), Some((1, "original", false)));
        assert_eq!(
            dto.reactions,
            vec![ReactionDto { user_id: 7, emoji: "👍".into() }, ReactionDto { user_id: 8, emoji: "❤️".into() }]
        );
        assert_eq!(dto.client_message_id.as_deref(), Some("c2"));

        let to_deleted = message_dto(&message(6, "hm", Some(5), false), &replies, &reactions);
        assert_eq!(to_deleted.reply_to.map(|r| (r.body, r.is_deleted)), Some((String::new(), true)));

        let missing_target = message_dto(&message(7, "x", Some(99), false), &replies, &reactions);
        assert!(missing_target.reply_to.is_none());

        let unsent = message_dto(&message(2, "gone", None, true), &replies, &reactions);
        assert_eq!((unsent.body.as_str(), unsent.reactions.len(), unsent.is_deleted), ("", 0, true));
    }
}
