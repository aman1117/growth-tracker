//! Comment endpoints. Each handler replicates the Go handler's order of checks and its
//! status codes, messages and error codes.

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, Uri};
use chrono::NaiveDate;
use gt_core::body::JsonBody;
use gt_core::constants as c;
use gt_core::extract::{AuthUser, QueryParams};
use gt_core::models::User;
use gt_core::{response, ApiError, ApiResult};

use super::params::{comment_id_param, day_params, parse_comment_id, parse_day_date, reply_parent_param};
use super::CommentsState;
use crate::dto::{
    CommentActionResponse, CommentCountResponse, CreateCommentRequest, CreateReplyRequest, EditCommentRequest,
    LikeActionResponse,
};
use crate::service::pagination::{clamp_list_limit, clamp_reply_limit, parse_cursor, parse_limit, DEFAULT_LIMIT_QUERY};
use crate::service::{CommentError, CommentSort, CreateComment};

const IDEMPOTENCY_HEADER: &str = "x-idempotency-key";

fn missing_day_params() -> ApiError {
    ApiError::bad_request("Username and date are required", c::ERR_CODE_MISSING_FIELDS)
}

fn validation(err: &CommentError) -> Option<(&str, &'static str)> {
    match err {
        CommentError::Validation(e) => Some((e.message.as_str(), e.code)),
        CommentError::Database { .. } => None,
    }
}

/// `X-Idempotency-Key` when present and non-empty (Go `c.Get`).
fn idempotency_key(headers: &HeaderMap) -> Option<String> {
    headers
        .get(IDEMPOTENCY_HEADER)
        .map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned())
        .filter(|key| !key.is_empty())
}

/// The owner of the day in the URL, if the caller may view it: 404 for an unknown user, 403
/// for a private account the caller does not follow.
async fn visible_day_owner(s: &CommentsState, username: &str, viewer_id: i64) -> Result<User, ApiError> {
    let owner = match s.auth.get_user_by_username(username).await {
        Ok(Some(owner)) => owner,
        Ok(None) | Err(_) => return Err(ApiError::not_found("User not found", c::ERR_CODE_USER_NOT_FOUND)),
    };
    if !s.profiles.can_view_profile(Some(&owner), viewer_id).await {
        return Err(ApiError::private_account());
    }
    Ok(owner)
}

/// Validates the day route parameters (presence, then date format).
fn parse_day(uri: &Uri) -> Result<(&str, NaiveDate), ApiError> {
    let (username, date) = day_params(uri);
    if username.is_empty() || date.is_empty() {
        return Err(missing_day_params());
    }
    Ok((username, parse_day_date(date)?))
}

/// `POST /api/days/{username}/{date}/comments`: a top-level comment (201).
pub(crate) async fn create_comment(
    State(s): State<CommentsState>,
    user: AuthUser,
    uri: Uri,
    headers: HeaderMap,
    body: JsonBody<CreateCommentRequest>,
) -> ApiResult {
    let (username, day_date) = parse_day(&uri)?;
    let owner = visible_day_owner(&s, username, user.user_id).await?;
    let req = body.into_result().map_err(|_| ApiError::invalid_request())?;
    let key = idempotency_key(&headers);

    let result = s
        .comments
        .create_comment(CreateComment {
            author_id: user.user_id,
            author_username: &user.username,
            day_owner_id: owner.id,
            day_owner_username: username,
            day_date,
            body: &req.body,
            parent_comment_id: None,
            idempotency_key: key.as_deref(),
        })
        .await;
    match result {
        Ok(comment) => Ok(created_response(comment)),
        Err(err) => Err(match validation(&err) {
            Some((message, code)) if code == c::ERR_CODE_DUPLICATE_COMMENT => ApiError::conflict(message, code),
            Some((message, code)) => ApiError::bad_request(message, code),
            None => {
                tracing::error!(user_id = user.user_id, day_owner = %username, error = %err, "CreateComment failed");
                ApiError::internal("Failed to create comment", c::ERR_CODE_CREATE_FAILED)
            }
        }),
    }
}

/// `POST /api/days/{username}/{date}/comments/{commentId}/replies`: a reply (201).
pub(crate) async fn create_reply(
    State(s): State<CommentsState>,
    user: AuthUser,
    uri: Uri,
    headers: HeaderMap,
    body: JsonBody<CreateReplyRequest>,
) -> ApiResult {
    let (username, date) = day_params(&uri);
    let raw_parent_id = reply_parent_param(&uri);
    if username.is_empty() || date.is_empty() || raw_parent_id.is_empty() {
        return Err(ApiError::bad_request("Username, date, and comment ID are required", c::ERR_CODE_MISSING_FIELDS));
    }
    let day_date = parse_day_date(date)?;
    let parent_id = parse_comment_id(raw_parent_id)?;
    let owner = visible_day_owner(&s, username, user.user_id).await?;
    let req = body.into_result().map_err(|_| ApiError::invalid_request())?;
    let key = idempotency_key(&headers);

    let result = s
        .comments
        .create_comment(CreateComment {
            author_id: user.user_id,
            author_username: &user.username,
            day_owner_id: owner.id,
            day_owner_username: username,
            day_date,
            body: &req.body,
            parent_comment_id: Some(parent_id),
            idempotency_key: key.as_deref(),
        })
        .await;
    match result {
        Ok(comment) => Ok(created_response(comment)),
        Err(err) => Err(match validation(&err) {
            Some((message, code)) if code == c::ERR_CODE_DUPLICATE_COMMENT => ApiError::conflict(message, code),
            Some((message, code)) if code == c::ERR_CODE_PARENT_NOT_FOUND => ApiError::not_found(message, code),
            Some((message, code)) => ApiError::bad_request(message, code),
            None => {
                tracing::error!(user_id = user.user_id, parent_id, error = %err, "CreateReply failed");
                ApiError::internal("Failed to create reply", c::ERR_CODE_CREATE_FAILED)
            }
        }),
    }
}

fn created_response(comment: crate::dto::CommentDto) -> axum::response::Response {
    response::json_status(
        StatusCode::CREATED,
        &CommentActionResponse { success: true, comment: Some(comment), message: c::MSG_COMMENT_CREATED.to_string() },
    )
}

/// `DELETE /api/comments/{commentId}`: soft delete by the author or the day owner.
pub(crate) async fn delete_comment(State(s): State<CommentsState>, user: AuthUser, uri: Uri) -> ApiResult {
    let comment_id = parse_comment_id(comment_id_param(&uri))?;
    // The service takes the day owner from the comment (0).
    match s.comments.delete_comment(comment_id, user.user_id, 0).await {
        Ok(()) => Ok(response::success(c::MSG_COMMENT_DELETED)),
        Err(err) => Err(match validation(&err) {
            Some((message, code)) if code == c::ERR_CODE_COMMENT_FORBIDDEN => ApiError::forbidden(message, code),
            Some((message, code)) => ApiError::not_found(message, code),
            None => {
                tracing::error!(user_id = user.user_id, comment_id, error = %err, "DeleteComment failed");
                ApiError::internal("Failed to delete comment", c::ERR_CODE_DELETE_FAILED)
            }
        }),
    }
}

/// `PUT /api/comments/{commentId}`: edit by the author within the edit window.
pub(crate) async fn edit_comment(
    State(s): State<CommentsState>,
    user: AuthUser,
    uri: Uri,
    body: JsonBody<EditCommentRequest>,
) -> ApiResult {
    let comment_id = parse_comment_id(comment_id_param(&uri))?;
    let req = body.into_result().map_err(|_| ApiError::invalid_request())?;

    match s.comments.edit_comment(comment_id, user.user_id, &req.body).await {
        Ok(comment) => Ok(response::json(&CommentActionResponse {
            success: true,
            comment: Some(comment),
            message: c::MSG_COMMENT_EDITED.to_string(),
        })),
        Err(err) => Err(match validation(&err) {
            Some((message, code)) if code == c::ERR_CODE_COMMENT_FORBIDDEN => ApiError::forbidden(message, code),
            Some((message, code)) if code == c::ERR_CODE_COMMENT_NOT_FOUND => ApiError::not_found(message, code),
            Some((message, code)) => ApiError::bad_request(message, code),
            None => {
                tracing::error!(user_id = user.user_id, comment_id, error = %err, "EditComment failed");
                ApiError::internal("Failed to edit comment", c::ERR_CODE_UPDATE_FAILED)
            }
        }),
    }
}

/// `POST /api/comments/{commentId}/like` (idempotent).
pub(crate) async fn like_comment(State(s): State<CommentsState>, user: AuthUser, uri: Uri) -> ApiResult {
    let comment_id = parse_comment_id(comment_id_param(&uri))?;
    match s.comments.like_comment(comment_id, user.user_id, &user.username).await {
        Ok((liked, new_count)) => Ok(response::json(&LikeActionResponse { success: true, liked, new_count })),
        Err(err) => Err(match validation(&err) {
            Some((message, code)) => ApiError::bad_request(message, code),
            None => {
                tracing::error!(user_id = user.user_id, comment_id, error = %err, "LikeComment failed");
                ApiError::internal("Failed to like comment", c::ERR_CODE_CREATE_FAILED)
            }
        }),
    }
}

/// `DELETE /api/comments/{commentId}/like` (idempotent).
pub(crate) async fn unlike_comment(State(s): State<CommentsState>, user: AuthUser, uri: Uri) -> ApiResult {
    let comment_id = parse_comment_id(comment_id_param(&uri))?;
    match s.comments.unlike_comment(comment_id, user.user_id).await {
        Ok((liked, new_count)) => Ok(response::json(&LikeActionResponse { success: true, liked, new_count })),
        Err(err) => Err(match validation(&err) {
            Some((message, code)) => ApiError::bad_request(message, code),
            None => {
                tracing::error!(user_id = user.user_id, comment_id, error = %err, "UnlikeComment failed");
                ApiError::internal("Failed to unlike comment", c::ERR_CODE_DELETE_FAILED)
            }
        }),
    }
}

/// `GET /api/days/{username}/{date}/comments?sort=top|newest&cursor=&limit=`.
pub(crate) async fn get_comments(
    State(s): State<CommentsState>,
    user: AuthUser,
    uri: Uri,
    query: QueryParams,
) -> ApiResult {
    let (username, day_date) = parse_day(&uri)?;
    let owner = visible_day_owner(&s, username, user.user_id).await?;

    let sort = CommentSort::from_query(query.get_or("sort", "top"));
    let cursor = parse_cursor(query.get("cursor"));
    let limit = parse_limit(query.get_or("limit", DEFAULT_LIMIT_QUERY), clamp_list_limit);

    match s.comments.get_top_level_comments(owner.id, user.user_id, day_date, sort, cursor, limit).await {
        Ok(page) => Ok(response::json(&page)),
        Err(err) => {
            tracing::error!(day_owner = %username, date = %day_date, error = %err, "GetComments failed");
            Err(ApiError::internal("Failed to get comments", c::ERR_CODE_FETCH_FAILED))
        }
    }
}

/// `GET /api/comments/{commentId}/replies?cursor=&limit=`: the thread of a comment, checking
/// that the caller may view the day it belongs to.
pub(crate) async fn get_replies(
    State(s): State<CommentsState>,
    user: AuthUser,
    uri: Uri,
    query: QueryParams,
) -> ApiResult {
    let comment_id = parse_comment_id(comment_id_param(&uri))?;

    let root = match s.comments.get_comment_by_id(comment_id).await {
        Ok(Some(root)) => root,
        Ok(None) | Err(_) => return Err(ApiError::not_found("Comment not found", c::ERR_CODE_COMMENT_NOT_FOUND)),
    };
    // An owner that cannot be loaded skips the check, as in Go.
    if let Ok(Some(owner)) = s.auth.get_user_by_id(root.day_owner_id).await {
        if !s.profiles.can_view_profile(Some(&owner), user.user_id).await {
            return Err(ApiError::private_account());
        }
    }

    let cursor = parse_cursor(query.get("cursor"));
    let limit = parse_limit(query.get_or("limit", DEFAULT_LIMIT_QUERY), clamp_reply_limit);

    match s.comments.get_replies(comment_id, user.user_id, cursor, limit).await {
        Ok(page) => Ok(response::json(&page)),
        Err(err) => {
            tracing::error!(comment_id, error = %err, "GetReplies failed");
            Err(ApiError::internal("Failed to get replies", c::ERR_CODE_FETCH_FAILED))
        }
    }
}

/// `GET /api/days/{username}/{date}/comments/count`: non-deleted comments, replies included.
pub(crate) async fn get_comment_count(State(s): State<CommentsState>, user: AuthUser, uri: Uri) -> ApiResult {
    let (username, day_date) = parse_day(&uri)?;
    let owner = visible_day_owner(&s, username, user.user_id).await?;

    match s.comments.get_comment_count(owner.id, day_date).await {
        Ok(count) => Ok(response::json(&CommentCountResponse { success: true, count })),
        Err(err) => {
            tracing::error!(day_owner = %username, date = %day_date, error = %err, "GetCommentCount failed");
            Err(ApiError::internal("Failed to get comment count", c::ERR_CODE_FETCH_FAILED))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_route_parameters_are_reported_like_go() {
        let uri: Uri = "/api/days//2026-03-09/comments".parse().unwrap();
        let err = parse_day(&uri).unwrap_err();
        assert_eq!(
            (err.status.as_u16(), err.message.as_str(), err.code.as_str()),
            (400, "Username and date are required", c::ERR_CODE_MISSING_FIELDS)
        );
        let uri: Uri = "/api/days/amy/09-03-2026/comments".parse().unwrap();
        assert_eq!(parse_day(&uri).unwrap_err().code, c::ERR_CODE_INVALID_DATE);
        let uri: Uri = "/api/days/amy/2026-03-09/comments".parse().unwrap();
        assert_eq!(parse_day(&uri).unwrap(), ("amy", NaiveDate::from_ymd_opt(2026, 3, 9).unwrap()));
    }

    #[test]
    fn idempotency_header() {
        let mut headers = HeaderMap::new();
        assert_eq!(idempotency_key(&headers), None);
        headers.insert("X-Idempotency-Key", "".parse().unwrap());
        assert_eq!(idempotency_key(&headers), None);
        headers.insert("X-Idempotency-Key", "retry-1".parse().unwrap());
        assert_eq!(idempotency_key(&headers).as_deref(), Some("retry-1"));
    }
}
