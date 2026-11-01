//! Request and response bodies of the comment endpoints (port of the comment DTOs in
//! `internal/dto/requests.go` and `internal/dto/responses.go`).
//!
//! Field order, `omitempty` and `null` behavior match the Go structs exactly; responses must be
//! encoded with `gt_core::response` (Go-compatible JSON).

use serde::{Deserialize, Deserializer, Serialize};

/// Go's `encoding/json` leaves a field untouched when the JSON value is `null`; serde would
/// reject it, so decode `null` as the default value instead.
fn null_as_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Option::unwrap_or_default)
}

// ==================== Requests ====================

/// `POST /api/days/{username}/{date}/comments` body.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct CreateCommentRequest {
    #[serde(deserialize_with = "null_as_default")]
    pub body: String,
}

/// `POST /api/days/{username}/{date}/comments/{commentId}/replies` body.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct CreateReplyRequest {
    #[serde(deserialize_with = "null_as_default")]
    pub body: String,
}

/// `PUT /api/comments/{commentId}` body.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct EditCommentRequest {
    #[serde(deserialize_with = "null_as_default")]
    pub body: String,
}

// ==================== Responses ====================

/// An `@mention` in a comment.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MentionDto {
    pub user_id: i64,
    pub username: String,
}

/// A comment as returned by the API. `mentions` is always an array (never `null`) and
/// `created_at` is formatted `YYYY-MM-DDTHH:MM:SSZ` (whole seconds).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CommentDto {
    pub id: i64,
    pub day_owner_id: i64,
    /// `YYYY-MM-DD`.
    pub day_date: String,
    pub author_id: i64,
    pub author_username: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author_avatar: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author_avatar_thumb: Option<String>,
    pub author_verified: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_comment_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root_comment_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to_user_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to_username: Option<String>,
    pub body: String,
    pub like_count: i64,
    pub reply_count: i64,
    pub is_edited: bool,
    pub is_deleted: bool,
    pub liked_by_me: bool,
    pub mentions: Vec<MentionDto>,
    pub created_at: String,
}

/// A page of comments (top-level comments of a day, or replies of a thread). `comments` is
/// always an array; `next_cursor` (the id of the last comment) is omitted on the last page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CommentsListResponse {
    pub success: bool,
    pub comments: Vec<CommentDto>,
    pub has_more: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<i64>,
}

/// `GET /api/days/{username}/{date}/comments/count` response.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct CommentCountResponse {
    pub success: bool,
    pub count: i64,
}

/// Response of comment create/edit actions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CommentActionResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comment: Option<CommentDto>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub message: String,
}

/// Response of comment like/unlike (Go `dto.LikeActionResponse`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct LikeActionResponse {
    pub success: bool,
    pub liked: bool,
    pub new_count: i64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use gt_core::gojson;

    fn sample() -> CommentDto {
        CommentDto {
            id: 7,
            day_owner_id: 1,
            day_date: "2026-03-09".into(),
            author_id: 2,
            author_username: "amy".into(),
            author_avatar: None,
            author_avatar_thumb: None,
            author_verified: false,
            parent_comment_id: None,
            root_comment_id: None,
            reply_to_user_id: None,
            reply_to_username: None,
            body: "nice <3 & more".into(),
            like_count: 0,
            reply_count: 0,
            is_edited: false,
            is_deleted: false,
            liked_by_me: false,
            mentions: vec![],
            created_at: "2026-03-09T10:00:00Z".into(),
        }
    }

    #[test]
    fn comment_dto_omits_nil_pointers_like_go() {
        assert_eq!(
            gojson::to_string(&sample()).unwrap(),
            r#"{"id":7,"day_owner_id":1,"day_date":"2026-03-09","author_id":2,"author_username":"amy","author_verified":false,"body":"nice \u003c3 \u0026 more","like_count":0,"reply_count":0,"is_edited":false,"is_deleted":false,"liked_by_me":false,"mentions":[],"created_at":"2026-03-09T10:00:00Z"}"#
        );
    }

    #[test]
    fn comment_dto_with_every_field() {
        let dto = CommentDto {
            author_avatar: Some("a.jpg".into()),
            author_avatar_thumb: Some(String::new()),
            author_verified: true,
            parent_comment_id: Some(3),
            root_comment_id: Some(1),
            reply_to_user_id: Some(9),
            reply_to_username: Some("bob".into()),
            like_count: 2,
            reply_count: 1,
            is_edited: true,
            liked_by_me: true,
            mentions: vec![MentionDto { user_id: 9, username: "bob".into() }],
            ..sample()
        };
        assert_eq!(
            gojson::to_string(&dto).unwrap(),
            r#"{"id":7,"day_owner_id":1,"day_date":"2026-03-09","author_id":2,"author_username":"amy","author_avatar":"a.jpg","author_avatar_thumb":"","author_verified":true,"parent_comment_id":3,"root_comment_id":1,"reply_to_user_id":9,"reply_to_username":"bob","body":"nice \u003c3 \u0026 more","like_count":2,"reply_count":1,"is_edited":true,"is_deleted":false,"liked_by_me":true,"mentions":[{"user_id":9,"username":"bob"}],"created_at":"2026-03-09T10:00:00Z"}"#
        );
    }

    #[test]
    fn list_count_action_and_like_responses() {
        let list = CommentsListResponse { success: true, comments: vec![], has_more: false, next_cursor: None };
        assert_eq!(gojson::to_string(&list).unwrap(), r#"{"success":true,"comments":[],"has_more":false}"#);
        let list = CommentsListResponse { next_cursor: Some(15), has_more: true, ..list };
        assert_eq!(
            gojson::to_string(&list).unwrap(),
            r#"{"success":true,"comments":[],"has_more":true,"next_cursor":15}"#
        );

        let count = CommentCountResponse { success: true, count: 12 };
        assert_eq!(gojson::to_string(&count).unwrap(), r#"{"success":true,"count":12}"#);

        let action = CommentActionResponse { success: true, comment: None, message: String::new() };
        assert_eq!(gojson::to_string(&action).unwrap(), r#"{"success":true}"#);
        let action = CommentActionResponse {
            success: true,
            comment: Some(sample()),
            message: "Comment created successfully".into(),
        };
        let json = gojson::to_string(&action).unwrap();
        assert!(json.starts_with(r#"{"success":true,"comment":{"id":7,"#));
        assert!(json.ends_with(r#""created_at":"2026-03-09T10:00:00Z"},"message":"Comment created successfully"}"#));

        let like = LikeActionResponse { success: true, liked: false, new_count: 0 };
        assert_eq!(gojson::to_string(&like).unwrap(), r#"{"success":true,"liked":false,"new_count":0}"#);
    }

    #[test]
    fn requests_decode_like_go() {
        let req: CreateCommentRequest = serde_json::from_str(r#"{"body":"hi","extra":1}"#).unwrap();
        assert_eq!(req.body, "hi");
        let req: CreateReplyRequest = serde_json::from_str(r#"{"body":null}"#).unwrap();
        assert_eq!(req.body, "");
        let req: EditCommentRequest = serde_json::from_str("{}").unwrap();
        assert_eq!(req.body, "");
        assert!(serde_json::from_str::<EditCommentRequest>(r#"{"body":5}"#).is_err());
    }
}
