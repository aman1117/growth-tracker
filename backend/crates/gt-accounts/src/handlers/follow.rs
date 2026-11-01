//! Follow actions, requests, lists, counts and relationship lookups (port of
//! `internal/handlers/follow.go`).

use std::collections::BTreeMap;
use std::sync::Arc;

use axum::extract::State;
use gt_core::body::JsonBody;
use gt_core::constants as c;
use gt_core::extract::{parse_go_int, AuthUser, QueryParams};
use gt_core::models::{FOLLOW_STATE_ACTIVE, FOLLOW_STATE_PENDING};
use gt_core::{gojson, response, ApiError, ApiResult};
use gt_notify::NotificationService;
use gt_users::{FollowError, FollowListCursor, UserRepository};

use crate::dto::{
    FollowActionResponse, FollowCountsDto, FollowCountsResponse, FollowListResponse, FollowRequestDto,
    FollowRequestListResponse, FollowUserDto, MutualsResponse, RelationshipLookupRequest, RelationshipLookupResponse,
};
use crate::state::AccountsState;
use crate::util::{parse_go_uint32, RawParams};

/// At most this many ids are looked up per relationship request.
const MAX_LOOKUP_IDS: usize = 100;

// ==================== Helpers ====================

/// Go handlers branched with `strings.Contains(err.Error(), code)`; matching on the message
/// (not just the variant) keeps that exact behavior.
fn has_code(err: &FollowError, code: &str) -> bool {
    err.to_string().contains(code)
}

/// Every follow handler rejects a missing user id (0) before anything else.
fn viewer_id(user: &AuthUser) -> Result<i64, ApiError> {
    match user.user_id {
        0 => Err(ApiError::unauthorized("Authentication required", c::ERR_CODE_UNAUTHORIZED)),
        id => Ok(id),
    }
}

/// Parses a path id like Go's `strconv.ParseUint(c.Params(name), 10, 32)`.
fn path_id(params: &RawParams, name: &str, invalid_message: &str) -> Result<i64, ApiError> {
    parse_go_uint32(params.get(name)).ok_or_else(|| ApiError::bad_request(invalid_message, c::ERR_CODE_INVALID_REQUEST))
}

fn server_error(message: &str) -> ApiError {
    ApiError::internal(message, c::ERR_CODE_SERVER_ERROR)
}

/// Go: `limit, _ := strconv.Atoi(c.Query("limit", "20"))` — anything unparsable becomes 0,
/// which the service then replaces with the default.
fn list_limit(query: &QueryParams) -> i64 {
    parse_go_int(query.get_or("limit", "20")).unwrap_or(0)
}

fn list_cursor(query: &QueryParams) -> Option<FollowListCursor> {
    FollowListCursor::decode(query.get("cursor"))
}

/// Go `edge.CreatedAt.Format(time.RFC3339)`: pgx decodes `TIMESTAMPTZ` in the process time zone,
/// so the offset is the local one (`Z` only on a UTC host).
fn rfc3339(at: &chrono::DateTime<chrono::Utc>) -> String {
    gojson::format_rfc3339_local(at)
}

/// A user of a follow list; deleted accounts are skipped.
async fn list_user(
    users: &UserRepository,
    user_id: i64,
    followed_at: String,
    with_thumb: bool,
) -> Option<FollowUserDto> {
    let user = users.find_by_id(user_id).await.ok().flatten()?;
    Some(FollowUserDto {
        id: user.id,
        username: user.username,
        profile_pic: user.profile_pic,
        // Go's mutuals list never set the thumbnail.
        profile_pic_thumb: if with_thumb { user.profile_pic_thumb } else { None },
        bio: user.bio,
        is_private: user.is_private,
        is_verified: user.is_verified,
        followed_at,
    })
}

fn next_cursor(has_more: bool, last: Option<(chrono::DateTime<chrono::Utc>, i64)>) -> String {
    match (has_more, last) {
        (true, Some((created_at, user_id))) => FollowListCursor::new(created_at, user_id).encode(),
        _ => String::new(),
    }
}

// ==================== Follow actions ====================

/// `POST /api/users/{id}/follow`: follows a public account or requests to follow a private one,
/// then notifies the target in the background.
pub(crate) async fn follow_user(State(state): State<AccountsState>, user: AuthUser, params: RawParams) -> ApiResult {
    let viewer_id = viewer_id(&user)?;
    let target_id = path_id(&params, "id", "Invalid target user ID")?;

    let result = state.users.follow_service.follow(viewer_id, target_id).await.map_err(|err| {
        if has_code(&err, c::ERR_CODE_CANNOT_FOLLOW_SELF) {
            ApiError::bad_request("Cannot follow yourself", c::ERR_CODE_CANNOT_FOLLOW_SELF)
        } else if has_code(&err, c::ERR_CODE_USER_NOT_FOUND) {
            ApiError::not_found("User not found", c::ERR_CODE_USER_NOT_FOUND)
        } else if has_code(&err, c::ERR_CODE_FOLLOW_LIMIT_EXCEEDED) {
            ApiError::bad_request(err.to_string(), c::ERR_CODE_FOLLOW_LIMIT_EXCEEDED)
        } else if has_code(&err, c::ERR_CODE_DAILY_LIMIT_EXCEEDED) {
            ApiError::bad_request(err.to_string(), c::ERR_CODE_DAILY_LIMIT_EXCEEDED)
        } else {
            tracing::error!(viewer_id, target_id, error = %err, "Failed to follow user");
            server_error("Failed to follow user")
        }
    })?;

    tokio::spawn(send_follow_notification(
        state.users.user_repo.clone(),
        state.notifications.clone(),
        viewer_id,
        target_id,
        result.state,
    ));

    Ok(response::json(&FollowActionResponse {
        success: true,
        state: result.state.to_string(),
        message: result.message.to_string(),
    }))
}

/// `DELETE /api/users/{id}/follow`: unfollows (or withdraws a pending request).
pub(crate) async fn unfollow_user(State(state): State<AccountsState>, user: AuthUser, params: RawParams) -> ApiResult {
    let viewer_id = viewer_id(&user)?;
    let target_id = path_id(&params, "id", "Invalid target user ID")?;

    if let Err(err) = state.users.follow_service.unfollow(viewer_id, target_id).await {
        if has_code(&err, c::ERR_CODE_NOT_FOLLOWING) {
            return Err(ApiError::bad_request("Not following this user", c::ERR_CODE_NOT_FOLLOWING));
        }
        tracing::error!(viewer_id, target_id, error = %err, "Failed to unfollow user");
        return Err(server_error("Failed to unfollow user"));
    }
    Ok(response::success("Unfollowed successfully"))
}

/// `POST /api/follow-requests/{targetId}/cancel`: cancels the caller's pending request.
pub(crate) async fn cancel_follow_request(
    State(state): State<AccountsState>,
    user: AuthUser,
    params: RawParams,
) -> ApiResult {
    let viewer_id = viewer_id(&user)?;
    let target_id = path_id(&params, "targetId", "Invalid target user ID")?;

    if let Err(err) = state.users.follow_service.cancel_request(viewer_id, target_id).await {
        if has_code(&err, c::ERR_CODE_NO_FOLLOW_REQUEST) {
            return Err(ApiError::bad_request("No pending request found", c::ERR_CODE_NO_FOLLOW_REQUEST));
        }
        tracing::error!(viewer_id, target_id, error = %err, "Failed to cancel follow request");
        return Err(server_error("Failed to cancel request"));
    }
    Ok(response::success("Follow request cancelled"))
}

// ==================== Request management ====================

/// `GET /api/me/follow-requests/incoming?cursor=&limit=`: pending requests, newest first.
pub(crate) async fn get_incoming_requests(
    State(state): State<AccountsState>,
    user: AuthUser,
    query: QueryParams,
) -> ApiResult {
    let viewer_id = viewer_id(&user)?;
    let cursor = list_cursor(&query);

    let (edges, has_more) = state
        .users
        .follow_service
        .get_pending_incoming_requests(viewer_id, list_limit(&query), cursor.as_ref())
        .await
        .map_err(|err| {
            tracing::error!(viewer_id, error = %err, "Failed to get incoming follow requests");
            server_error("Failed to get requests")
        })?;

    let mut requests = Vec::with_capacity(edges.len());
    for edge in &edges {
        let Ok(Some(requester)) = state.users.user_repo.find_by_id(edge.follower_id).await else { continue };
        requests.push(FollowRequestDto {
            id: requester.id,
            username: requester.username,
            profile_pic: requester.profile_pic,
            profile_pic_thumb: requester.profile_pic_thumb,
            bio: requester.bio,
            is_verified: requester.is_verified,
            requested_at: rfc3339(&edge.created_at),
        });
    }
    let last = edges.last().map(|e| (e.created_at, e.follower_id));

    Ok(response::json(&FollowRequestListResponse {
        success: true,
        requests,
        next_cursor: next_cursor(has_more, last),
        has_more,
    }))
}

/// `POST /api/me/follow-requests/{requesterId}/accept`; notifies the requester in the
/// background.
pub(crate) async fn accept_follow_request(
    State(state): State<AccountsState>,
    user: AuthUser,
    params: RawParams,
) -> ApiResult {
    let viewer_id = viewer_id(&user)?;
    let requester_id = path_id(&params, "requesterId", "Invalid requester ID")?;

    if let Err(err) = state.users.follow_service.accept_request(viewer_id, requester_id).await {
        if has_code(&err, c::ERR_CODE_NO_FOLLOW_REQUEST) {
            return Err(ApiError::bad_request("No pending request found", c::ERR_CODE_NO_FOLLOW_REQUEST));
        }
        tracing::error!(viewer_id, requester_id, error = %err, "Failed to accept follow request");
        return Err(server_error("Failed to accept request"));
    }

    tokio::spawn(send_accepted_notification(
        state.users.user_repo.clone(),
        state.notifications.clone(),
        viewer_id,
        requester_id,
    ));
    Ok(response::success("Follow request accepted"))
}

/// `POST /api/me/follow-requests/{requesterId}/decline`.
pub(crate) async fn decline_follow_request(
    State(state): State<AccountsState>,
    user: AuthUser,
    params: RawParams,
) -> ApiResult {
    let viewer_id = viewer_id(&user)?;
    let requester_id = path_id(&params, "requesterId", "Invalid requester ID")?;

    if let Err(err) = state.users.follow_service.decline_request(viewer_id, requester_id).await {
        if has_code(&err, c::ERR_CODE_NO_FOLLOW_REQUEST) {
            return Err(ApiError::bad_request("No pending request found", c::ERR_CODE_NO_FOLLOW_REQUEST));
        }
        tracing::error!(viewer_id, requester_id, error = %err, "Failed to decline follow request");
        return Err(server_error("Failed to decline request"));
    }
    Ok(response::success("Follow request declined"))
}

/// `DELETE /api/me/followers/{followerId}`: removes someone from the caller's followers.
pub(crate) async fn remove_follower(
    State(state): State<AccountsState>,
    user: AuthUser,
    params: RawParams,
) -> ApiResult {
    let viewer_id = viewer_id(&user)?;
    let follower_id = path_id(&params, "followerId", "Invalid follower ID")?;

    if let Err(err) = state.users.follow_service.remove_follower(viewer_id, follower_id).await {
        if has_code(&err, c::ERR_CODE_NOT_FOLLOWING) {
            return Err(ApiError::bad_request("User is not following you", c::ERR_CODE_NOT_FOLLOWING));
        }
        tracing::error!(viewer_id, follower_id, error = %err, "Failed to remove follower");
        return Err(server_error("Failed to remove follower"));
    }
    Ok(response::success("Follower removed"))
}

// ==================== Lists ====================

/// Maps list-access errors like Go's `GetFollowers`/`GetFollowing` (no logging).
fn list_error(err: &FollowError, failure: &str) -> ApiError {
    if has_code(err, c::ERR_CODE_ACCOUNT_PRIVATE) {
        ApiError::forbidden("This account is private", c::ERR_CODE_ACCOUNT_PRIVATE)
    } else if has_code(err, c::ERR_CODE_USER_NOT_FOUND) {
        ApiError::not_found("User not found", c::ERR_CODE_USER_NOT_FOUND)
    } else {
        server_error(failure)
    }
}

/// `GET /api/users/{id}/followers?cursor=&limit=`: newest first; private accounts only for
/// accepted followers and the owner.
pub(crate) async fn get_followers(
    State(state): State<AccountsState>,
    user: AuthUser,
    params: RawParams,
    query: QueryParams,
) -> ApiResult {
    let viewer_id = viewer_id(&user)?;
    let target_id = path_id(&params, "id", "Invalid user ID")?;
    let cursor = list_cursor(&query);

    let (edges, has_more) = state
        .users
        .follow_service
        .get_followers(viewer_id, target_id, list_limit(&query), cursor.as_ref())
        .await
        .map_err(|err| list_error(&err, "Failed to get followers"))?;

    let mut users = Vec::with_capacity(edges.len());
    for edge in &edges {
        if let Some(dto) = list_user(&state.users.user_repo, edge.follower_id, rfc3339(&edge.created_at), true).await {
            users.push(dto);
        }
    }
    let last = edges.last().map(|e| (e.created_at, e.follower_id));
    Ok(response::json(&FollowListResponse { success: true, users, next_cursor: next_cursor(has_more, last), has_more }))
}

/// `GET /api/users/{id}/following?cursor=&limit=`: same rules as the followers list.
pub(crate) async fn get_following(
    State(state): State<AccountsState>,
    user: AuthUser,
    params: RawParams,
    query: QueryParams,
) -> ApiResult {
    let viewer_id = viewer_id(&user)?;
    let target_id = path_id(&params, "id", "Invalid user ID")?;
    let cursor = list_cursor(&query);

    let (edges, has_more) = state
        .users
        .follow_service
        .get_following(viewer_id, target_id, list_limit(&query), cursor.as_ref())
        .await
        .map_err(|err| list_error(&err, "Failed to get following"))?;

    let mut users = Vec::with_capacity(edges.len());
    for edge in &edges {
        if let Some(dto) = list_user(&state.users.user_repo, edge.followee_id, rfc3339(&edge.created_at), true).await {
            users.push(dto);
        }
    }
    let last = edges.last().map(|e| (e.created_at, e.followee_id));
    Ok(response::json(&FollowListResponse { success: true, users, next_cursor: next_cursor(has_more, last), has_more }))
}

// ==================== Relationships ====================

/// `POST /api/relationships/lookup`: the caller's relationship to up to 100 users.
pub(crate) async fn lookup_relationships(
    State(state): State<AccountsState>,
    user: AuthUser,
    JsonBody(body): JsonBody<RelationshipLookupRequest>,
) -> ApiResult {
    let viewer_id = viewer_id(&user)?;
    let Ok(mut req) = body else { return Err(ApiError::invalid_request()) };
    if req.target_ids.is_empty() {
        return Ok(response::json(&RelationshipLookupResponse { success: true, relationships: BTreeMap::new() }));
    }
    req.target_ids.truncate(MAX_LOOKUP_IDS);

    let failed = || server_error("Failed to lookup relationships");
    // Go accepted any uint, but ids beyond the int8 range made the database query fail.
    let target_ids: Vec<i64> =
        req.target_ids.iter().map(|id| i64::try_from(*id)).collect::<Result<_, _>>().map_err(|_| failed())?;
    let relationships =
        state.users.follow_service.lookup_relationships(viewer_id, &target_ids).await.map_err(|_| failed())?;

    Ok(response::json(&RelationshipLookupResponse {
        success: true,
        relationships: relationships.into_iter().map(|(id, state)| (id.to_string(), state)).collect(),
    }))
}

// ==================== Mutuals and counts ====================

/// `GET /api/users/{id}/mutuals?cursor=&limit=`: users the caller follows who also follow the
/// target (allowed for private targets), newest follow first.
pub(crate) async fn get_mutuals(
    State(state): State<AccountsState>,
    user: AuthUser,
    params: RawParams,
    query: QueryParams,
) -> ApiResult {
    let viewer_id = viewer_id(&user)?;
    let target_id = path_id(&params, "id", "Invalid user ID")?;
    let cursor = list_cursor(&query);

    let (edges, has_more) = state
        .users
        .follow_service
        .get_mutuals_with_timestamps(viewer_id, target_id, list_limit(&query), cursor.as_ref())
        .await
        .map_err(|err| {
            if has_code(&err, c::ERR_CODE_ACCOUNT_PRIVATE) {
                return ApiError::forbidden("This account is private", c::ERR_CODE_ACCOUNT_PRIVATE);
            }
            tracing::error!(viewer_id, target_id, error = %err, "Failed to get mutuals");
            server_error("Failed to get mutuals")
        })?;

    let mut users = Vec::with_capacity(edges.len());
    for edge in &edges {
        if let Some(dto) = list_user(&state.users.user_repo, edge.user_id, rfc3339(&edge.created_at), false).await {
            users.push(dto);
        }
    }
    let last = edges.last().map(|e| (e.created_at, e.user_id));
    Ok(response::json(&MutualsResponse { success: true, users, next_cursor: next_cursor(has_more, last), has_more }))
}

/// `GET /api/users/{id}/follow-counts`: followers and following; the owner also gets the number
/// of pending requests.
pub(crate) async fn get_follow_counts(
    State(state): State<AccountsState>,
    user: AuthUser,
    params: RawParams,
) -> ApiResult {
    let viewer_id = viewer_id(&user)?;
    let target_id = path_id(&params, "id", "Invalid user ID")?;
    let follows = &state.users.follow_service;

    let (followers_count, following_count) = follows.get_follow_counts(target_id).await.map_err(|err| {
        tracing::error!(viewer_id, target_id, error = %err, "Failed to get follow counts");
        server_error("Failed to get counts")
    })?;
    let mut counts = FollowCountsDto { followers_count, following_count, pending_requests_count: 0 };

    // Go fetched the counts once more before reading the pending requests.
    if viewer_id == target_id && follows.get_follow_counts(viewer_id).await.is_ok() {
        counts.pending_requests_count = follows.get_pending_requests_count(viewer_id).await;
    }
    Ok(response::json(&FollowCountsResponse { success: true, counts }))
}

/// `POST /api/me/follow-counts/reconcile`: recomputes the caller's counters from the edges.
pub(crate) async fn reconcile_my_counters(State(state): State<AccountsState>, user: AuthUser) -> ApiResult {
    let viewer_id = viewer_id(&user)?;
    if let Err(err) = state.users.follow_service.reconcile_counters(viewer_id).await {
        tracing::error!(viewer_id, error = %err, "Failed to reconcile counters");
        return Err(server_error("Failed to reconcile counts"));
    }
    Ok(response::success("Follow counts reconciled"))
}

// ==================== Notifications ====================

/// Notifies the followee of a new follower (ACTIVE) or a follow request (PENDING). Missing users
/// and failures are skipped silently, as in Go.
async fn send_follow_notification(
    users: Arc<UserRepository>,
    notifications: Arc<NotificationService>,
    follower_id: i64,
    followee_id: i64,
    state: &'static str,
) {
    let Ok(Some(follower)) = users.find_by_id(follower_id).await else { return };
    let avatar = follower.profile_pic.unwrap_or_default();
    let _ = match state {
        FOLLOW_STATE_PENDING => {
            notifications.notify_follow_request(followee_id, follower_id, &follower.username, &avatar).await
        }
        FOLLOW_STATE_ACTIVE => {
            notifications.notify_new_follower(followee_id, follower_id, &follower.username, &avatar).await
        }
        _ => Ok(()),
    };
}

/// Tells the requester that the viewer accepted their follow request.
async fn send_accepted_notification(
    users: Arc<UserRepository>,
    notifications: Arc<NotificationService>,
    viewer_id: i64,
    requester_id: i64,
) {
    let Ok(Some(viewer)) = users.find_by_id(viewer_id).await else { return };
    let avatar = viewer.profile_pic.unwrap_or_default();
    let _ = notifications.notify_follow_accepted(requester_id, viewer_id, &viewer.username, &avatar).await;
}

#[cfg(test)]
mod tests {
    use axum::http::StatusCode;

    use super::*;

    #[test]
    fn list_limits_parse_like_atoi() {
        let q = |s: &str| QueryParams::parse(Some(s));
        assert_eq!(list_limit(&q("")), 20);
        assert_eq!(list_limit(&q("limit=")), 20);
        assert_eq!(list_limit(&q("limit=5")), 5);
        assert_eq!(list_limit(&q("limit=abc")), 0);
        assert_eq!(list_limit(&q("limit=-2")), -2);
    }

    #[test]
    fn status_codes_of_list_errors() {
        assert_eq!(list_error(&FollowError::AccountPrivate, "x").status, StatusCode::FORBIDDEN);
        assert_eq!(list_error(&FollowError::UserNotFound, "x").status, StatusCode::NOT_FOUND);
        let db = FollowError::Database { context: "failed to get followers", source: sqlx::Error::PoolClosed };
        let err = list_error(&db, "Failed to get followers");
        assert_eq!((err.status, err.message.as_str()), (StatusCode::INTERNAL_SERVER_ERROR, "Failed to get followers"));
    }
}
