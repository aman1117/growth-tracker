//! Mapping of stored comments to API DTOs.

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Utc};
use gt_core::models::{Comment, CommentMention, User};
use gt_core::timeutil::format_date;

use crate::dto::{CommentDto, MentionDto};
use crate::repository::CommentWithAuthor;

/// Go: `t.Format("2006-01-02T15:04:05Z")` of a `time.Now()` / pgx-decoded `TIMESTAMPTZ` value:
/// the wall clock in the process time zone, whole seconds, followed by a literal `Z` (so on a
/// non-UTC host the suffix does not match the clock, exactly as Go printed it).
pub fn format_created_at(t: &DateTime<Utc>) -> String {
    gt_core::gojson::format_local_literal_z(t)
}

pub fn mention_dto(mention: &CommentMention) -> MentionDto {
    MentionDto { user_id: mention.mentioned_user_id, username: mention.username.clone() }
}

/// DTO of a stored comment with its author (Go `buildCommentDTO`); `reply_to_username` is
/// left for the caller to fill.
pub fn build_comment_dto(c: &CommentWithAuthor, liked_by_me: bool, mentions: &[CommentMention]) -> CommentDto {
    let comment = &c.comment;
    CommentDto {
        id: comment.id,
        day_owner_id: comment.day_owner_id,
        day_date: format_date(&comment.day_date),
        author_id: comment.author_id,
        author_username: c.author_username.clone(),
        author_avatar: c.author_avatar.clone(),
        author_avatar_thumb: c.author_avatar_thumb.clone(),
        author_verified: c.author_verified,
        parent_comment_id: comment.parent_comment_id,
        root_comment_id: comment.root_comment_id,
        reply_to_user_id: comment.reply_to_user_id,
        reply_to_username: None,
        body: comment.body.clone(),
        like_count: comment.like_count,
        reply_count: comment.reply_count,
        is_edited: comment.is_edited,
        is_deleted: comment.is_deleted,
        liked_by_me,
        mentions: mentions.iter().map(mention_dto).collect(),
        created_at: format_created_at(&comment.created_at),
    }
}

/// DTOs of a page of comments (Go `enrichComments` after its lookups): `liked` holds the ids
/// the viewer liked, `mentions` the mentions per comment id and `reply_to_usernames` the
/// usernames of reply targets that could be resolved.
pub fn assemble_comment_dtos(
    comments: &[CommentWithAuthor],
    liked: &HashSet<i64>,
    mentions: &HashMap<i64, Vec<CommentMention>>,
    reply_to_usernames: &HashMap<i64, String>,
) -> Vec<CommentDto> {
    comments
        .iter()
        .map(|c| {
            let id = c.comment.id;
            let mut dto = build_comment_dto(c, liked.contains(&id), mentions.get(&id).map_or(&[], Vec::as_slice));
            dto.reply_to_username = c.comment.reply_to_user_id.and_then(|uid| reply_to_usernames.get(&uid).cloned());
            dto
        })
        .collect()
}

/// Distinct reply-target user ids of a page, in order of first appearance.
pub fn reply_to_user_ids(comments: &[CommentWithAuthor]) -> Vec<i64> {
    let mut ids: Vec<i64> = Vec::new();
    for id in comments.iter().filter_map(|c| c.comment.reply_to_user_id) {
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    ids
}

/// DTO returned right after creating a comment. The author name comes from the caller's
/// token; avatar and verification come from `author` when it could be loaded.
pub fn created_comment_dto(
    comment: &Comment,
    author_username: &str,
    author: Option<&User>,
    mentions: Vec<MentionDto>,
) -> CommentDto {
    CommentDto {
        id: comment.id,
        day_owner_id: comment.day_owner_id,
        day_date: format_date(&comment.day_date),
        author_id: comment.author_id,
        author_username: author_username.to_string(),
        author_avatar: author.and_then(|a| a.profile_pic.clone()),
        author_avatar_thumb: author.and_then(|a| a.profile_pic_thumb.clone()),
        author_verified: author.is_some_and(|a| a.is_verified),
        parent_comment_id: comment.parent_comment_id,
        root_comment_id: comment.root_comment_id,
        reply_to_user_id: comment.reply_to_user_id,
        reply_to_username: None,
        body: comment.body.clone(),
        like_count: 0,
        reply_count: 0,
        is_edited: false,
        is_deleted: false,
        liked_by_me: false,
        mentions,
        created_at: format_created_at(&comment.created_at),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::service::ranking::tests::comment_at;
    use chrono::TimeZone;

    fn mention(comment_id: i64, user_id: i64, username: &str) -> CommentMention {
        CommentMention {
            id: user_id,
            comment_id,
            mentioned_user_id: user_id,
            username: username.into(),
            created_at: Utc::now(),
        }
    }

    /// Expected `created_at` of `t`: the process-local wall clock plus a literal `Z`.
    fn local_literal_z(t: &DateTime<Utc>) -> String {
        format!("{}Z", gt_core::gojson::to_go_local(t).format("%Y-%m-%dT%H:%M:%S"))
    }

    #[test]
    fn created_at_is_local_wall_clock_with_literal_z() {
        let t = Utc.with_ymd_and_hms(2026, 3, 9, 7, 5, 3).unwrap() + chrono::Duration::microseconds(456);
        let got = format_created_at(&t);
        assert_eq!(got, local_literal_z(&t));
        assert_eq!(got.len(), "2026-03-09T07:05:03Z".len(), "whole seconds, no offset");
        assert!(got.ends_with('Z'));
        // On a UTC host (production) this is the plain UTC clock.
        if gt_core::gojson::to_go_local(&t).offset().local_minus_utc() == 0 {
            assert_eq!(got, "2026-03-09T07:05:03Z");
        }
    }

    #[test]
    fn builds_dtos_from_rows() {
        let created = Utc.with_ymd_and_hms(2026, 3, 9, 12, 0, 0).unwrap();
        let mut row = comment_at(5, 3, created, true);
        row.author_avatar = Some("a.jpg".into());
        row.comment.parent_comment_id = Some(1);
        row.comment.root_comment_id = Some(1);
        row.comment.reply_to_user_id = Some(8);
        row.comment.is_edited = true;

        let dto = build_comment_dto(&row, true, &[mention(5, 8, "bob")]);
        assert_eq!(dto.id, 5);
        assert_eq!(dto.day_date, "2026-03-09");
        assert_eq!(dto.author_username, "author");
        assert_eq!(dto.author_avatar.as_deref(), Some("a.jpg"));
        assert!(dto.author_verified && dto.liked_by_me && dto.is_edited);
        assert_eq!((dto.parent_comment_id, dto.root_comment_id, dto.reply_to_user_id), (Some(1), Some(1), Some(8)));
        assert_eq!(dto.like_count, 3);
        assert_eq!(dto.mentions, vec![MentionDto { user_id: 8, username: "bob".into() }]);
        assert_eq!(dto.created_at, local_literal_z(&created));
        assert_eq!(dto.reply_to_username, None);
    }

    #[test]
    fn assembles_a_page() {
        let t = Utc::now();
        let top = comment_at(1, 0, t, false);
        let mut reply = comment_at(2, 0, t, false);
        reply.comment.reply_to_user_id = Some(7);
        let mut orphan = comment_at(3, 0, t, false);
        orphan.comment.reply_to_user_id = Some(99);
        let rows = vec![top, reply, orphan];

        assert_eq!(reply_to_user_ids(&rows), vec![7, 99]);
        let liked = HashSet::from([2]);
        let mentions = HashMap::from([(1, vec![mention(1, 4, "amy"), mention(1, 5, "cy")])]);
        let usernames = HashMap::from([(7, "seven".to_string())]);
        let dtos = assemble_comment_dtos(&rows, &liked, &mentions, &usernames);

        assert_eq!(dtos.iter().map(|d| d.id).collect::<Vec<_>>(), vec![1, 2, 3]);
        assert_eq!(dtos.iter().map(|d| d.liked_by_me).collect::<Vec<_>>(), vec![false, true, false]);
        assert_eq!(dtos[0].mentions.len(), 2);
        assert!(dtos[1].mentions.is_empty());
        assert_eq!(dtos[1].reply_to_username.as_deref(), Some("seven"));
        assert_eq!(dtos[2].reply_to_username, None, "unresolved reply targets are omitted");
    }

    #[test]
    fn created_dto_uses_loaded_author_when_present() {
        let now = Utc.with_ymd_and_hms(2026, 3, 10, 8, 30, 0).unwrap();
        let comment = Comment {
            parent_comment_id: Some(4),
            root_comment_id: Some(4),
            reply_to_user_id: Some(6),
            ..comment_at(9, 5, now, false).comment
        };
        let author = User {
            id: 2,
            email: "a@x.io".into(),
            username: "stored_name".into(),
            password_hash: String::new(),
            profile_pic: Some("p.jpg".into()),
            profile_pic_thumb: Some("t.jpg".into()),
            bio: None,
            is_private: false,
            is_verified: true,
            email_verified: true,
            created_at: now,
            updated_at: now,
        };
        let mentions = vec![MentionDto { user_id: 3, username: "cy".into() }];

        let dto = created_comment_dto(&comment, "token_name", Some(&author), mentions.clone());
        assert_eq!(dto.author_username, "token_name");
        assert_eq!((dto.author_avatar.as_deref(), dto.author_avatar_thumb.as_deref()), (Some("p.jpg"), Some("t.jpg")));
        assert!(dto.author_verified);
        assert_eq!(dto.like_count, 0, "a new comment has no likes");
        assert_eq!(dto.mentions, mentions);
        assert_eq!(dto.created_at, local_literal_z(&now));
        assert_eq!(dto.parent_comment_id, Some(4));

        let dto = created_comment_dto(&comment, "token_name", None, vec![]);
        assert_eq!((dto.author_avatar, dto.author_verified), (None, false));
    }
}
