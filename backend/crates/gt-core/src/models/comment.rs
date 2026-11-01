use chrono::{DateTime, NaiveDate, Utc};
use serde::Serialize;

use crate::gojson;

/// A comment on a user's day (`comments`). Top-level comments have no parent/root; replies
/// point at their parent and at the top-level (root) comment.
#[derive(Debug, Clone, PartialEq, Serialize, sqlx::FromRow)]
pub struct Comment {
    pub id: i64,
    pub day_owner_id: i64,
    #[serde(with = "gojson::date")]
    pub day_date: NaiveDate,
    pub author_id: i64,
    pub parent_comment_id: Option<i64>,
    pub root_comment_id: Option<i64>,
    pub reply_to_user_id: Option<i64>,
    pub body: String,
    pub like_count: i64,
    pub reply_count: i64,
    pub is_edited: bool,
    pub is_deleted: bool,
    #[serde(with = "gojson::time_opt", skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<DateTime<Utc>>,
    #[serde(with = "gojson::time")]
    pub created_at: DateTime<Utc>,
    #[serde(with = "gojson::time")]
    pub updated_at: DateTime<Utc>,
}

impl Comment {
    pub const COLUMNS: &'static str = "id, day_owner_id, day_date, author_id, parent_comment_id, root_comment_id, \
         reply_to_user_id, body, like_count, reply_count, is_edited, is_deleted, deleted_at, created_at, updated_at";

    /// Same as [`Comment::COLUMNS`] qualified by `alias` (for joins).
    pub fn columns_with_alias(alias: &str) -> String {
        format!(
            "{a}.id, {a}.day_owner_id, {a}.day_date, {a}.author_id, {a}.parent_comment_id, {a}.root_comment_id, \
             {a}.reply_to_user_id, {a}.body, {a}.like_count, {a}.reply_count, {a}.is_edited, {a}.is_deleted, \
             {a}.deleted_at, {a}.created_at, {a}.updated_at",
            a = alias
        )
    }

    pub fn is_top_level(&self) -> bool {
        self.parent_comment_id.is_none()
    }
}

/// A like on a comment (`comment_likes`).
#[derive(Debug, Clone, PartialEq, Serialize, sqlx::FromRow)]
pub struct CommentLike {
    pub id: i64,
    pub comment_id: i64,
    pub user_id: i64,
    #[serde(with = "gojson::time")]
    pub created_at: DateTime<Utc>,
}

impl CommentLike {
    pub const COLUMNS: &'static str = "id, comment_id, user_id, created_at";
}

/// An `@mention` in a comment (`comment_mentions`); `username` is a snapshot.
#[derive(Debug, Clone, PartialEq, Serialize, sqlx::FromRow)]
pub struct CommentMention {
    pub id: i64,
    pub comment_id: i64,
    pub mentioned_user_id: i64,
    pub username: String,
    #[serde(with = "gojson::time")]
    pub created_at: DateTime<Utc>,
}

impl CommentMention {
    pub const COLUMNS: &'static str = "id, comment_id, mentioned_user_id, username, created_at";
}

/// Duplicate-submission guard (`comment_dedupes`).
#[derive(Debug, Clone, PartialEq, sqlx::FromRow)]
pub struct CommentDedupe {
    pub id: i64,
    pub user_id: i64,
    pub day_owner_id: i64,
    pub day_date: NaiveDate,
    pub body_hash: String,
    pub idempotency_key: Option<String>,
    pub comment_id: i64,
    pub created_at: DateTime<Utc>,
}

impl CommentDedupe {
    pub const COLUMNS: &'static str =
        "id, user_id, day_owner_id, day_date, body_hash, idempotency_key, comment_id, created_at";
}
