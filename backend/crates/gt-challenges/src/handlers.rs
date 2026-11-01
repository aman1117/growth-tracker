//! HTTP handlers of the challenge routes (port of `handlers/challenge.go`).

use std::sync::Arc;

use axum::extract::State;
use axum::http::{StatusCode, Uri};
use gt_core::body::JsonBody;
use gt_core::constants as c;
use gt_core::extract::{parse_go_int, AuthUser, QueryParams};
use gt_core::{response, ApiError, ApiResult};

use crate::dto::{
    ChallengeCheerResponse, ChallengeInviteResponse, ChallengeListResponse, ChallengePreviewResponse,
    ChallengeResponse, CheerChallengeRequest, CreateChallengeRequest, InviteCandidatesResponse,
    InviteToChallengeRequest,
};
use crate::service::challenge::chain;
use crate::service::{ChallengeError, ChallengeService};
use crate::validator::normalize_invite_code;

/// Shared state of the challenge handlers.
pub(crate) type ChallengeState = Arc<ChallengeService>;

/// `GET /api/challenges`: the viewer's challenges.
pub(crate) async fn list_challenges(State(svc): State<ChallengeState>, user: AuthUser) -> ApiResult {
    require_user(&user)?;
    let challenges = svc
        .list(user.user_id)
        .await
        .map_err(|err| fail(err, &user, "Failed to load challenges", c::ERR_CODE_FETCH_FAILED, 0))?;
    Ok(response::json(&ChallengeListResponse { success: true, challenges }))
}

/// `POST /api/challenges`: creates a challenge (201).
pub(crate) async fn create_challenge(
    State(svc): State<ChallengeState>,
    user: AuthUser,
    JsonBody(body): JsonBody<CreateChallengeRequest>,
) -> ApiResult {
    require_user(&user)?;
    let req = body.map_err(|_| ApiError::invalid_request())?;
    let detail = svc
        .create(user.user_id, &req)
        .await
        .map_err(|err| fail(err, &user, "Failed to create challenge", c::ERR_CODE_CREATE_FAILED, 0))?;
    Ok(response::json_status(StatusCode::CREATED, &ChallengeResponse { success: true, challenge: Some(detail) }))
}

/// `GET /api/challenges/{id}`: a challenge with every participant's progress.
pub(crate) async fn get_challenge(State(svc): State<ChallengeState>, user: AuthUser, uri: Uri) -> ApiResult {
    let challenge_id = user_and_challenge(&user, &uri)?;
    let detail = svc
        .get_detail(user.user_id, challenge_id)
        .await
        .map_err(|err| fail(err, &user, "Failed to load challenge", c::ERR_CODE_FETCH_FAILED, challenge_id))?;
    Ok(response::json(&ChallengeResponse { success: true, challenge: Some(detail) }))
}

/// `DELETE /api/challenges/{id}`.
pub(crate) async fn delete_challenge(State(svc): State<ChallengeState>, user: AuthUser, uri: Uri) -> ApiResult {
    let challenge_id = user_and_challenge(&user, &uri)?;
    svc.delete(user.user_id, challenge_id)
        .await
        .map_err(|err| fail(err, &user, "Failed to delete challenge", c::ERR_CODE_DELETE_FAILED, challenge_id))?;
    Ok(response::success(""))
}

/// `POST /api/challenges/{id}/leave`.
pub(crate) async fn leave_challenge(State(svc): State<ChallengeState>, user: AuthUser, uri: Uri) -> ApiResult {
    let challenge_id = user_and_challenge(&user, &uri)?;
    svc.leave(user.user_id, challenge_id)
        .await
        .map_err(|err| fail(err, &user, "Failed to leave challenge", c::ERR_CODE_DELETE_FAILED, challenge_id))?;
    Ok(response::success(""))
}

/// `POST /api/challenges/{id}/cheers`: cheers another participant, once per IST day.
pub(crate) async fn cheer_participant(
    State(svc): State<ChallengeState>,
    user: AuthUser,
    uri: Uri,
    JsonBody(body): JsonBody<CheerChallengeRequest>,
) -> ApiResult {
    let challenge_id = user_and_challenge(&user, &uri)?;
    let req = body.map_err(|_| ApiError::invalid_request())?;
    if req.user_id == 0 {
        return Err(ApiError::bad_request("user_id is required", c::ERR_CODE_INVALID_REQUEST));
    }
    let already_cheered = svc
        .cheer(user.user_id, challenge_id, req.user_id)
        .await
        .map_err(|err| fail(err, &user, "Failed to cheer", c::ERR_CODE_CREATE_FAILED, challenge_id))?;
    Ok(response::json(&ChallengeCheerResponse { success: true, already_cheered }))
}

/// `GET /api/challenges/{id}/invite-candidates?q=&limit=`.
pub(crate) async fn get_invite_candidates(
    State(svc): State<ChallengeState>,
    user: AuthUser,
    uri: Uri,
    query: QueryParams,
) -> ApiResult {
    let challenge_id = user_and_challenge(&user, &uri)?;
    let mut limit = c::CHALLENGE_CANDIDATES_DEFAULT;
    let raw = query.get("limit");
    if !raw.is_empty() {
        let parsed = parse_go_int(raw)
            .filter(|parsed| *parsed >= 1)
            .ok_or_else(|| ApiError::bad_request("limit must be a positive integer", c::ERR_CODE_INVALID_REQUEST))?;
        limit = parsed.min(c::CHALLENGE_CANDIDATES_MAX);
    }
    let users = svc
        .invite_candidates(user.user_id, challenge_id, query.get("q"), limit)
        .await
        .map_err(|err| fail(err, &user, "Failed to load invite candidates", c::ERR_CODE_FETCH_FAILED, challenge_id))?;
    Ok(response::json(&InviteCandidatesResponse { success: true, users }))
}

/// `POST /api/challenges/{id}/invites`: invites 1-20 users.
pub(crate) async fn invite_users(
    State(svc): State<ChallengeState>,
    user: AuthUser,
    uri: Uri,
    JsonBody(body): JsonBody<InviteToChallengeRequest>,
) -> ApiResult {
    let challenge_id = user_and_challenge(&user, &uri)?;
    let req = body.map_err(|_| ApiError::invalid_request())?;
    let (invited, skipped) = svc
        .invite(user.user_id, challenge_id, &req.user_ids)
        .await
        .map_err(|err| fail(err, &user, "Failed to send invites", c::ERR_CODE_CREATE_FAILED, challenge_id))?;
    Ok(response::json(&ChallengeInviteResponse { success: true, invited, skipped }))
}

/// `GET /api/challenge-codes/{code}`: what an invite link shows.
pub(crate) async fn preview_challenge(State(svc): State<ChallengeState>, user: AuthUser, uri: Uri) -> ApiResult {
    let code = user_and_code(&user, &uri)?;
    let preview = svc
        .preview_by_code(user.user_id, &code)
        .await
        .map_err(|err| fail(err, &user, "Failed to load challenge", c::ERR_CODE_FETCH_FAILED, 0))?;
    Ok(response::json(&ChallengePreviewResponse { success: true, preview: Some(preview) }))
}

/// `POST /api/challenge-codes/{code}/join`.
pub(crate) async fn join_challenge(State(svc): State<ChallengeState>, user: AuthUser, uri: Uri) -> ApiResult {
    let code = user_and_code(&user, &uri)?;
    let detail = svc
        .join_by_code(user.user_id, &code)
        .await
        .map_err(|err| fail(err, &user, "Failed to join challenge", c::ERR_CODE_CREATE_FAILED, 0))?;
    Ok(response::json(&ChallengeResponse { success: true, challenge: Some(detail) }))
}

// ==================== Helpers ====================

/// Go: a zero `user_id` local is answered with 401 before anything else.
fn require_user(user: &AuthUser) -> Result<(), ApiError> {
    if user.user_id == 0 {
        return Err(ApiError::unauthorized("Authentication required", c::ERR_CODE_UNAUTHORIZED));
    }
    Ok(())
}

fn user_and_challenge(user: &AuthUser, uri: &Uri) -> Result<i64, ApiError> {
    require_user(user)?;
    parse_challenge_id(raw_param(uri))
        .ok_or_else(|| ApiError::bad_request("Invalid challenge ID", c::ERR_CODE_INVALID_REQUEST))
}

fn user_and_code(user: &AuthUser, uri: &Uri) -> Result<String, ApiError> {
    require_user(user)?;
    parse_invite_code(raw_param(uri))
        .ok_or_else(|| ApiError::bad_request("Invalid invite code", c::ERR_CODE_INVALID_REQUEST))
}

/// The raw, still percent-encoded `:id` / `:code` parameter, like Fiber's `c.Params` (the Go
/// server does not unescape paths; axum's path extractors would). Both live in the fourth
/// segment: `/api/challenges/{id}...` and `/api/challenge-codes/{code}...`.
fn raw_param(uri: &Uri) -> &str {
    uri.path().split('/').nth(3).unwrap_or_default()
}

/// Go `strconv.ParseUint(raw, 10, 32)`, rejecting 0: a positive 32-bit challenge id.
pub(crate) fn parse_challenge_id(raw: &str) -> Option<i64> {
    if raw.is_empty() || !raw.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    raw.parse::<u32>().ok().filter(|id| *id != 0).map(i64::from)
}

/// Go `url.PathUnescape` followed by `validator.NormalizeInviteCode`.
pub(crate) fn parse_invite_code(raw: &str) -> Option<String> {
    let unescaped = path_unescape(raw)?;
    normalize_invite_code(&String::from_utf8(unescaped).ok()?)
}

/// Go `url.PathUnescape`: `%XX` escapes are decoded (a malformed one is an error), `+` stays.
fn path_unescape(raw: &str) -> Option<Vec<u8>> {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = bytes.get(i + 1..i + 3)?;
            let hi = (hex[0] as char).to_digit(16)?;
            let lo = (hex[1] as char).to_digit(16)?;
            out.push((hi * 16 + lo) as u8);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    Some(out)
}

/// Maps a service error to its response; unexpected errors are logged and answered with
/// `fail_message`/`fail_code` and status 500.
fn fail(err: ChallengeError, user: &AuthUser, fail_message: &str, fail_code: &str, challenge_id: i64) -> ApiError {
    if let Some(api) = err.api_error() {
        return api;
    }
    tracing::error!(
        user_id = user.user_id,
        challenge_id,
        error = %chain(&err),
        action = "responded with 500; the client may retry",
        "{fail_message}"
    );
    ApiError::internal(fail_message, fail_code)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn challenge_ids_parse_like_parse_uint_32() {
        assert_eq!(parse_challenge_id("12"), Some(12));
        assert_eq!(parse_challenge_id("0005"), Some(5));
        assert_eq!(parse_challenge_id("4294967295"), Some(4_294_967_295));
        for bad in ["", "abc", "0", "-1", "+5", "1.5", "4294967296", "99999999999999999999", "%31", " 1"] {
            assert_eq!(parse_challenge_id(bad), None, "{bad}");
        }
    }

    #[test]
    fn invite_codes_are_path_unescaped_then_normalized() {
        assert_eq!(parse_invite_code("abcdefgh").as_deref(), Some("ABCDEFGH"));
        assert_eq!(parse_invite_code("%41BCDEFGH").as_deref(), Some("ABCDEFGH"));
        assert_eq!(parse_invite_code("%20abcdefgh%20").as_deref(), Some("ABCDEFGH"));
        for bad in
            ["ABC", "ABCDEFG0", "ABCDEFGHJ", "ABCD%20EFG", "%ZZ", "%4", "ABCD%2FEFG", "+ABCDEFGH", "%C3", "ABCDEFG%"]
        {
            assert_eq!(parse_invite_code(bad), None, "{bad}");
        }
    }
}
