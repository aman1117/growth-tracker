//! Profile settings, user search and profiles (port of `internal/handlers/profile.go`).

use std::collections::HashSet;
use std::time::Instant;

use axum::extract::State;
use gt_core::body::JsonBody;
use gt_core::constants as c;
use gt_core::extract::{AuthUser, QueryParams};
use gt_core::models::{User, RELATIONSHIP_FOLLOWING, RELATIONSHIP_NONE};
use gt_core::{gojson, redis as gt_redis, response, validator, ApiError, ApiResult};
use gt_users::AutocompleteResult;
use serde_json::json;

use crate::dto::{
    AutocompleteResponse, AutocompleteSuggestion, AutocompleteSuggestionMeta, BioResponse, PrivacyResponse,
    ProfileResponse, PublicProfileResponse, SearchUsersRequest, UpdateBioRequest, UpdatePrivacyRequest, UserDto,
};
use crate::state::AccountsState;
use crate::util::{go_to_lower, parse_go_uint32, truncate_chars, RawParams};

const AUTOCOMPLETE_MAX_QUERY_CHARS: usize = 80;
const AUTOCOMPLETE_DEFAULT_LIMIT: i64 = 12;
const AUTOCOMPLETE_MAX_LIMIT: i64 = 20;

/// `POST /api/update-privacy`.
pub(crate) async fn update_privacy(
    State(state): State<AccountsState>,
    user: AuthUser,
    JsonBody(body): JsonBody<UpdatePrivacyRequest>,
) -> ApiResult {
    let Ok(req) = body else { return Err(ApiError::invalid_request()) };
    if let Err(err) = state.users.profile_service.update_privacy(user.user_id, req.is_private).await {
        tracing::error!(user_id = user.user_id, error = %err, "Privacy update failed");
        return Err(ApiError::internal("Failed to update privacy setting", c::ERR_CODE_UPDATE_FAILED));
    }
    tracing::info!(user_id = user.user_id, is_private = req.is_private, "Privacy updated");
    // A Go `fiber.Map`: keys marshal sorted.
    Ok(response::json(&json!({
        "success": true,
        "message": c::MSG_PRIVACY_UPDATED,
        "is_private": req.is_private,
    })))
}

/// `GET /api/get-privacy`.
pub(crate) async fn get_privacy(State(state): State<AccountsState>, user: AuthUser) -> ApiResult {
    let is_private = state.users.profile_service.get_privacy(user.user_id).await.map_err(|err| {
        tracing::error!(user_id = user.user_id, error = %err, "Failed to get privacy setting");
        ApiError::internal("Failed to get privacy setting", c::ERR_CODE_FETCH_FAILED)
    })?;
    Ok(response::json(&PrivacyResponse { success: true, is_private }))
}

/// `POST /api/update-bio`: trims the bio; an empty bio clears it.
pub(crate) async fn update_bio(
    State(state): State<AccountsState>,
    user: AuthUser,
    JsonBody(body): JsonBody<UpdateBioRequest>,
) -> ApiResult {
    let Ok(req) = body else { return Err(ApiError::invalid_request()) };
    let bio = validator::sanitize_bio(&req.bio);
    validator::validate_bio(&bio)?;

    if let Err(err) = state.users.profile_service.update_bio(user.user_id, &bio).await {
        tracing::error!(user_id = user.user_id, error = %err, "Bio update failed");
        return Err(ApiError::internal("Failed to update bio", c::ERR_CODE_UPDATE_FAILED));
    }
    tracing::info!(user_id = user.user_id, bio_length = bio.chars().count(), "Bio updated");
    Ok(response::json(&json!({
        "success": true,
        "message": c::MSG_BIO_UPDATED,
        "bio": bio,
    })))
}

/// `GET /api/get-bio`.
pub(crate) async fn get_bio(State(state): State<AccountsState>, user: AuthUser) -> ApiResult {
    let bio = state.users.profile_service.get_bio(user.user_id).await.map_err(|err| {
        tracing::error!(user_id = user.user_id, error = %err, "Failed to get bio");
        ApiError::internal("Failed to get bio", c::ERR_CODE_FETCH_FAILED)
    })?;
    Ok(response::json(&BioResponse { success: true, bio }))
}

/// `GET /api/profile`: the caller's full profile with follow counts.
pub(crate) async fn get_profile(State(state): State<AccountsState>, user: AuthUser) -> ApiResult {
    let Ok(Some(profile)) = state.users.profile_service.get_profile(user.user_id).await else {
        return Err(ApiError::not_found("User not found", c::ERR_CODE_USER_NOT_FOUND));
    };
    let (followers_count, following_count) =
        state.users.follow_service.get_follow_counts(user.user_id).await.unwrap_or((0, 0));

    Ok(response::json(&ProfileResponse {
        success: true,
        username: profile.username,
        email: profile.email,
        profile_pic: profile.profile_pic,
        profile_pic_thumb: profile.profile_pic_thumb,
        bio: profile.bio,
        is_private: profile.is_private,
        is_verified: profile.is_verified,
        email_verified: profile.email_verified,
        followers_count,
        following_count,
        relationship_state: String::new(),
    }))
}

/// `GET /api/users/{id}/profile`: another user's profile. Bio and last activity are only shown
/// for one's own profile, public profiles and private profiles the viewer follows. Records the
/// view as a recent search in the background.
pub(crate) async fn get_user_profile(
    State(state): State<AccountsState>,
    viewer: AuthUser,
    params: RawParams,
) -> ApiResult {
    let viewer_id = viewer.user_id;
    let Some(target_id) = parse_go_uint32(params.get("id")) else {
        return Err(ApiError::bad_request("Invalid user ID", c::ERR_CODE_INVALID_REQUEST));
    };
    let Ok(Some(target)) = state.users.profile_service.get_profile(target_id).await else {
        return Err(ApiError::not_found("User not found", c::ERR_CODE_USER_NOT_FOUND));
    };

    if viewer_id != target_id && viewer_id != 0 {
        let search = state.users.search_suggestions_service.clone();
        tokio::spawn(async move {
            if let Err(err) = search.save_recent_search(viewer_id, target_id).await {
                tracing::warn!(viewer_id, target_id, error = %err, "Failed to save recent search");
            }
        });
    }

    let follows = &state.users.follow_service;
    let (followers_count, following_count) = follows.get_follow_counts(target_id).await.unwrap_or((0, 0));
    let relationship_state = if viewer_id != target_id {
        follows.get_relationship_state(viewer_id, target_id).await.unwrap_or_else(|_| RELATIONSHIP_NONE.to_string())
    } else {
        RELATIONSHIP_NONE.to_string()
    };

    let can_view_private_info =
        viewer_id == target_id || !target.is_private || relationship_state == RELATIONSHIP_FOLLOWING;
    let last_logged_at = if can_view_private_info {
        match state.users.streak_service.get_latest_active_streak(target_id).await {
            Ok(Some(streak)) => Some(streak.activity_date),
            _ => None,
        }
    } else {
        None
    };

    Ok(response::json(&PublicProfileResponse {
        success: true,
        id: target.id,
        username: target.username,
        profile_pic: target.profile_pic,
        profile_pic_thumb: target.profile_pic_thumb,
        bio: if can_view_private_info { target.bio } else { None },
        is_private: target.is_private,
        is_verified: target.is_verified,
        followers_count,
        following_count,
        relationship_state,
        last_logged_at,
    }))
}

/// `POST /api/users`: case-insensitive username search. Bios are shown for public users and
/// private users the caller follows.
pub(crate) async fn search_users(
    State(state): State<AccountsState>,
    viewer: AuthUser,
    JsonBody(body): JsonBody<SearchUsersRequest>,
) -> ApiResult {
    let Ok(req) = body else { return Err(ApiError::invalid_request()) };
    // A blank query would match every user, so answer it without touching the database.
    if req.username.trim().is_empty() {
        return Ok(response::data(&Vec::<UserDto>::new()));
    }

    let users = state.users.profile_service.search_users(&req.username).await.map_err(|err| {
        tracing::error!(user_id = viewer.user_id, query = %req.username, error = %err, "User search failed");
        ApiError::bad_request("Failed to find users", c::ERR_CODE_FETCH_FAILED)
    })?;

    let private_ids: Vec<i64> = users.iter().filter(|u| u.is_private).map(|u| u.id).collect();
    let mut following = HashSet::new();
    if !private_ids.is_empty() && viewer.user_id != 0 {
        // A failed lookup hides every private bio.
        if let Ok(relationships) = state.users.follow_service.lookup_relationships(viewer.user_id, &private_ids).await {
            following
                .extend(relationships.into_iter().filter(|(_, rel)| rel == RELATIONSHIP_FOLLOWING).map(|(id, _)| id));
        }
    }

    tracing::debug!(user_id = viewer.user_id, query = %req.username, found = users.len(), "User search completed");
    let results: Vec<UserDto> = users.into_iter().map(|u| user_dto(u, &following)).collect();
    Ok(response::data(&results))
}

/// Go `sanitizeUsersWithFollowing` for one user.
fn user_dto(user: User, following: &HashSet<i64>) -> UserDto {
    let show_bio = !user.is_private || following.contains(&user.id);
    UserDto {
        id: user.id,
        username: user.username,
        profile_pic: user.profile_pic,
        profile_pic_thumb: user.profile_pic_thumb,
        bio: if show_bio { user.bio } else { None },
        is_private: user.is_private,
        is_verified: user.is_verified,
    }
}

/// `GET /api/autocomplete/users?q=&limit=`: ranked username suggestions, cached in Redis for
/// 60 s under the lower-cased query (without the request id).
pub(crate) async fn autocomplete_users(
    State(state): State<AccountsState>,
    user: AuthUser,
    query: QueryParams,
) -> ApiResult {
    let start = Instant::now();
    let request_id = uuid::Uuid::new_v4().to_string();

    let q = query.get("q").trim();
    if q.is_empty() {
        return Err(ApiError::bad_request("Query parameter 'q' is required", c::ERR_CODE_MISSING_FIELDS));
    }
    let q = truncate_chars(q, AUTOCOMPLETE_MAX_QUERY_CHARS);
    let limit = autocomplete_limit(query.get("limit"));
    let cache_key = go_to_lower(&q);

    if let Some(mut cached) = cached_autocomplete(&cache_key).await {
        cached.request_id = request_id;
        tracing::debug!(
            user_id = user.user_id,
            query = %q,
            request_id = %cached.request_id,
            results = cached.suggestions.as_ref().map_or(0, Vec::len),
            duration_ms = start.elapsed().as_millis() as u64,
            "Autocomplete cache hit"
        );
        return Ok(response::json(&cached));
    }

    let results = state.users.profile_service.autocomplete_users(&q, limit).await.map_err(|err| {
        tracing::error!(user_id = user.user_id, query = %q, request_id = %request_id, error = %err, "Autocomplete query failed");
        ApiError::internal("Failed to search users", c::ERR_CODE_FETCH_FAILED)
    })?;

    let suggestions: Vec<AutocompleteSuggestion> = results.into_iter().map(autocomplete_suggestion).collect();
    let count = suggestions.len();
    let mut resp = AutocompleteResponse { query: q, request_id: String::new(), suggestions: Some(suggestions) };
    // The request id is not cached; every response gets a fresh one.
    if let Ok(data) = gojson::to_string(&resp) {
        let _ = gt_redis::set_autocomplete_cache(&cache_key, &data).await;
    }
    resp.request_id = request_id;

    tracing::info!(
        user_id = user.user_id,
        query = %resp.query,
        request_id = %resp.request_id,
        results = count,
        duration_ms = start.elapsed().as_millis() as u64,
        "Autocomplete completed"
    );
    Ok(response::json(&resp))
}

/// Go: `limit` defaults to 12 and only values in `1..=20` are taken.
fn autocomplete_limit(raw: &str) -> i64 {
    match gt_core::extract::parse_go_int(raw) {
        Some(limit) if (1..=AUTOCOMPLETE_MAX_LIMIT).contains(&limit) => limit,
        _ => AUTOCOMPLETE_DEFAULT_LIMIT,
    }
}

/// The cached response for `key`; `None` on a miss, a Redis error or an undecodable entry.
async fn cached_autocomplete(key: &str) -> Option<AutocompleteResponse> {
    let cached = gt_redis::get_autocomplete_cache(key).await.ok().filter(|c| !c.is_empty())?;
    // `json.Unmarshal` of a JSON `null` succeeds and leaves the zero value.
    serde_json::from_str::<Option<AutocompleteResponse>>(&cached).ok().map(Option::unwrap_or_default)
}

fn autocomplete_suggestion(r: AutocompleteResult) -> AutocompleteSuggestion {
    AutocompleteSuggestion {
        text: r.username,
        kind: "user".to_string(),
        score: r.score,
        meta: AutocompleteSuggestionMeta {
            profile_pic: r.profile_pic,
            profile_pic_thumb: r.profile_pic_thumb,
            is_verified: r.is_verified,
            followers_count: r.followers_count,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn autocomplete_limit_matches_go() {
        for (raw, want) in [("", 12), ("1", 1), ("20", 20), ("0", 12), ("21", 12), ("-3", 12), ("abc", 12), ("+5", 5)] {
            assert_eq!(autocomplete_limit(raw), want, "{raw:?}");
        }
    }
}
