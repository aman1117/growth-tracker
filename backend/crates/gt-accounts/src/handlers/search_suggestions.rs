//! Recent searches and trending users for the search box (port of
//! `internal/handlers/search_suggestions.go`).

use std::collections::HashSet;
use std::time::Instant;

use axum::extract::State;
use gt_core::constants as c;
use gt_core::extract::AuthUser;
use gt_core::{gojson, redis as gt_redis, response, ApiError, ApiResult};
use gt_users::{RecentSearchResult, TrendingUserResult};

use crate::dto::{SearchSuggestionUser, SearchSuggestionsResponse};
use crate::state::AccountsState;
use crate::util::{parse_go_uint32, RawParams};

/// At most this many suggestions (recent + trending) are returned.
const MAX_SUGGESTIONS: usize = 6;
const RECENT_LIMIT: i64 = 5;

/// `trending:user:<id>`, the Redis key of a user's cached trending list.
pub(crate) fn trending_cache_key(user_id: i64) -> String {
    format!("trending:user:{user_id}")
}

fn invalid_user_context() -> ApiError {
    ApiError::bad_request("Invalid user context", c::ERR_CODE_INVALID_REQUEST)
}

/// `GET /api/search/suggestions`: up to 5 recent searches, then trending users (cached for
/// 5 minutes) that are not already listed, 6 users in total. Query failures degrade to empty
/// lists.
pub(crate) async fn get_search_suggestions(State(state): State<AccountsState>, user: AuthUser) -> ApiResult {
    let start = Instant::now();
    let user_id = user.user_id;
    if user_id == 0 {
        return Err(invalid_user_context());
    }
    let search = &state.users.search_suggestions_service;

    let recent_results = search.get_recent_searches(user_id, RECENT_LIMIT).await.unwrap_or_else(|err| {
        tracing::error!(user_id, error = %err, "Failed to get recent searches");
        Vec::new()
    });
    let recent: Vec<SearchSuggestionUser> = recent_results.into_iter().map(recent_user).collect();
    let recent_ids: HashSet<u64> = recent.iter().map(|u| u.id).collect();

    let cache_key = trending_cache_key(user_id);
    let mut trending = match cached_trending(&cache_key).await {
        // Users who became recent searches since the list was cached are dropped.
        Some(cached) => cached.into_iter().filter(|t| !recent_ids.contains(&t.id)).collect(),
        None => {
            // Fetch extra rows so deduplication still leaves enough to fill the list.
            let limit = if recent.len() < 5 { (MAX_SUGGESTIONS - recent.len() + 3) as i64 } else { 6 };
            let results = search.get_trending_users_for_user(user_id, limit).await.unwrap_or_else(|err| {
                tracing::error!(user_id, error = %err, "Failed to get trending users");
                Vec::new()
            });
            let trending: Vec<SearchSuggestionUser> =
                results.into_iter().map(trending_user).filter(|t| !recent_ids.contains(&t.id)).collect();
            if let Ok(data) = gojson::to_string(&trending) {
                let _ = gt_redis::set_trending_cache(&cache_key, &data).await;
            }
            trending
        }
    };
    trending.truncate(MAX_SUGGESTIONS.saturating_sub(recent.len()));

    tracing::info!(
        user_id,
        recent_count = recent.len(),
        trending_count = trending.len(),
        duration_ms = start.elapsed().as_millis() as u64,
        "Search suggestions retrieved"
    );
    Ok(response::json(&SearchSuggestionsResponse { recent, trending }))
}

/// The cached trending list; `None` on a miss, a Redis error, an undecodable entry or a cached
/// JSON `null` (Go: a nil slice also meant "not cached").
async fn cached_trending(key: &str) -> Option<Vec<SearchSuggestionUser>> {
    let cached = gt_redis::get_trending_cache(key).await.ok().filter(|c| !c.is_empty())?;
    match serde_json::from_str::<Option<Vec<SearchSuggestionUser>>>(&cached) {
        Ok(trending) => trending,
        Err(err) => {
            tracing::warn!(error = %err, "Failed to unmarshal trending cache");
            None
        }
    }
}

fn recent_user(r: RecentSearchResult) -> SearchSuggestionUser {
    SearchSuggestionUser {
        id: u64::try_from(r.id).unwrap_or_default(),
        username: r.username,
        profile_pic: r.profile_pic,
        profile_pic_thumb: r.profile_pic_thumb,
        is_verified: r.is_verified,
        followers_count: r.followers_count,
    }
}

fn trending_user(t: TrendingUserResult) -> SearchSuggestionUser {
    SearchSuggestionUser {
        id: u64::try_from(t.id).unwrap_or_default(),
        username: t.username,
        profile_pic: t.profile_pic,
        profile_pic_thumb: t.profile_pic_thumb,
        is_verified: t.is_verified,
        followers_count: t.followers_count,
    }
}

/// `DELETE /api/search/recent/{userId}`: removes one user from the caller's recent searches.
pub(crate) async fn delete_recent_search(
    State(state): State<AccountsState>,
    user: AuthUser,
    params: RawParams,
) -> ApiResult {
    let user_id = user.user_id;
    if user_id == 0 {
        return Err(invalid_user_context());
    }
    let target_id = match parse_go_uint32(params.get("userId")) {
        Some(id) if id != 0 => id,
        _ => return Err(ApiError::bad_request("Invalid user ID", c::ERR_CODE_INVALID_REQUEST)),
    };
    if let Err(err) = state.users.search_suggestions_service.delete_recent_search(user_id, target_id).await {
        tracing::error!(user_id, target_id, error = %err, "Failed to delete recent search");
        return Err(ApiError::internal("Failed to delete recent search", c::ERR_CODE_DELETE_FAILED));
    }
    tracing::info!(user_id, target_id, "Recent search deleted");
    Ok(response::success("Recent search deleted"))
}

/// `DELETE /api/search/recent`: clears the caller's recent searches.
pub(crate) async fn clear_recent_searches(State(state): State<AccountsState>, user: AuthUser) -> ApiResult {
    let user_id = user.user_id;
    if user_id == 0 {
        return Err(invalid_user_context());
    }
    if let Err(err) = state.users.search_suggestions_service.clear_recent_searches(user_id).await {
        tracing::error!(user_id, error = %err, "Failed to clear recent searches");
        return Err(ApiError::internal("Failed to clear recent searches", c::ERR_CODE_DELETE_FAILED));
    }
    tracing::info!(user_id, "Recent searches cleared");
    Ok(response::success("Recent searches cleared"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_key_matches_go() {
        assert_eq!(trending_cache_key(42), "trending:user:42");
    }
}
