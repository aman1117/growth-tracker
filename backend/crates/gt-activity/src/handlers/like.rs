//! Day like handlers (Go: `handlers.LikeHandler`), including the Redis likes cache.

use axum::extract::State;
use chrono::NaiveDate;
use gt_core::body::JsonBody;
use gt_core::constants as c;
use gt_core::extract::AuthUser;
use gt_core::gojson;
use gt_core::models::User;
use gt_core::timeutil::parse_date;
use gt_core::{redis, response, ApiError, ApiResult};

use super::ActivityState;
use crate::dates::format_date;
use crate::dto::{decode_cached_likers, GetLikesRequest, LikeActionResponse, LikeDayRequest, LikerDto, LikesResponse};
use crate::repository::{LikeDeleteError, LikeWithUser};

/// Both fields are required by every like endpoint.
fn require_fields(req: &LikeDayRequest) -> Result<(), ApiError> {
    if req.username.is_empty() || req.date.is_empty() {
        return Err(ApiError::bad_request("Username and date are required", c::ERR_CODE_MISSING_FIELDS));
    }
    Ok(())
}

fn parse_like_date(date: &str) -> Result<NaiveDate, ApiError> {
    parse_date(date)
        .ok_or_else(|| ApiError::bad_request("Invalid date format, use YYYY-MM-DD", c::ERR_CODE_INVALID_DATE))
}

/// The owner of the day: a failed lookup is `Failed to find user` (`DATABASE_ERROR`), a missing
/// user `User not found`, both `400`.
async fn find_day_owner(s: &ActivityState, user_id: i64, username: &str) -> Result<User, ApiError> {
    match s.auth.get_user_by_username(username).await {
        Ok(Some(user)) => Ok(user),
        Ok(None) => {
            tracing::warn!(user_id, target_username = %username, "Target user not found");
            Err(ApiError::bad_request("User not found", c::ERR_CODE_USER_NOT_FOUND))
        }
        Err(err) => {
            tracing::error!(user_id, target_username = %username, error = %err, "Failed to find target user");
            Err(ApiError::bad_request("Failed to find user", c::ERR_CODE_DATABASE_ERROR))
        }
    }
}

/// Drops the cached likers of a day; failures are only logged.
async fn invalidate_likes_cache(liked_user_id: i64, date: &str) {
    if !redis::is_available() {
        return;
    }
    if let Err(err) = redis::invalidate_likes_cache(liked_user_id, date).await {
        tracing::warn!(liked_user_id, date, error = %err, "Failed to invalidate likes cache");
    }
}

/// The day's like count; Go ignored errors here (reporting 0).
async fn count_likes(s: &ActivityState, liked_user_id: i64, date: NaiveDate) -> i64 {
    s.likes.count_likes_for_day(liked_user_id, date).await.unwrap_or(0)
}

fn action(liked: bool, new_count: i64) -> axum::response::Response {
    response::json(&LikeActionResponse { success: true, liked, new_count })
}

/// `POST /api/like-day`: likes a user's day (followers only for private accounts) and notifies
/// the owner once per liker and day.
pub(crate) async fn like_day(
    State(s): State<ActivityState>,
    user: AuthUser,
    JsonBody(body): JsonBody<LikeDayRequest>,
) -> ApiResult {
    let req = body.map_err(|_| ApiError::invalid_request())?;
    require_fields(&req)?;
    let user_id = user.user_id;
    tracing::info!(
        current_user_id = user_id,
        current_username = %user.username,
        target_username = %req.username,
        date = %req.date,
        "LikeDay request received"
    );
    let date = parse_like_date(&req.date).inspect_err(|_| {
        tracing::warn!(user_id, date = %req.date, "Invalid date format");
    })?;
    let date_str = format_date(date);

    let target = find_day_owner(&s, user_id, &req.username).await?;
    tracing::info!(
        user_id,
        target_user_id = target.id,
        target_username = %target.username,
        target_is_private = target.is_private,
        "Target user found"
    );
    if !s.profile.can_view_profile(Some(&target), user_id).await {
        tracing::warn!(user_id, target_user_id = target.id, "Cannot like private account - not following");
        return Err(ApiError::forbidden("Cannot like a private account's day", c::ERR_CODE_ACCOUNT_PRIVATE));
    }

    let already_liked = s.likes.has_liked(user_id, target.id, date).await.map_err(|err| {
        tracing::error!(liker_id = user_id, liked_user_id = target.id, date = %date_str, error = %err, "Failed to check like status");
        ApiError::internal("Failed to process like", c::ERR_CODE_DATABASE_ERROR)
    })?;
    tracing::info!(liker_id = user_id, liked_user_id = target.id, date = %date_str, already_liked, "HasLiked check result");
    if already_liked {
        let count = count_likes(&s, target.id, date).await;
        tracing::info!(user_id, count, "User already liked this day, returning existing state");
        return Ok(action(true, count));
    }

    tracing::info!(liker_id = user_id, liked_user_id = target.id, date = %date_str, "Creating new like");
    s.likes.create(user_id, target.id, date).await.map_err(|err| {
        tracing::error!(liker_id = user_id, liked_user_id = target.id, date = %date_str, error = %err, "Failed to create like");
        ApiError::internal("Failed to like day", c::ERR_CODE_CREATE_FAILED)
    })?;
    invalidate_likes_cache(target.id, &date_str).await;

    // Liking your own day notifies nobody. The notification is sent before responding (Go
    // called it synchronously); its dedupe record makes unlike + re-like notify only once.
    if target.id != user_id {
        let liker_avatar = match s.profile.get_profile(user_id).await {
            Ok(Some(profile)) => profile.profile_pic.unwrap_or_default(),
            _ => String::new(),
        };
        if let Err(err) =
            s.notifications.notify_like_received(target.id, user_id, &user.username, &liker_avatar, &req.date).await
        {
            tracing::warn!(target_user_id = target.id, liker_id = user_id, error = %err, "Failed to create like notification");
        }
    }

    let count = count_likes(&s, target.id, date).await;
    tracing::info!(
        liker_id = user_id,
        liked_user_id = target.id,
        target_username = %req.username,
        date = %req.date,
        new_count = count,
        "Like created successfully"
    );
    Ok(action(true, count))
}

/// `POST /api/unlike-day`: removes the caller's like (no privacy check, like Go); a missing like
/// is not an error.
pub(crate) async fn unlike_day(
    State(s): State<ActivityState>,
    user: AuthUser,
    JsonBody(body): JsonBody<LikeDayRequest>,
) -> ApiResult {
    let req = body.map_err(|_| ApiError::invalid_request())?;
    require_fields(&req)?;
    let user_id = user.user_id;
    tracing::info!(
        current_user_id = user_id,
        current_username = %user.username,
        target_username = %req.username,
        date = %req.date,
        "UnlikeDay request received"
    );
    let date = parse_like_date(&req.date)?;
    let date_str = format_date(date);
    let target = find_day_owner(&s, user_id, &req.username).await?;

    tracing::info!(liker_id = user_id, liked_user_id = target.id, date = %date_str, "Attempting to delete like");
    match s.likes.delete(user_id, target.id, date).await {
        Ok(()) => {}
        Err(LikeDeleteError::NotFound) => {
            tracing::warn!(liker_id = user_id, liked_user_id = target.id, date = %date_str, "Like not found, nothing to delete");
            return Ok(action(false, count_likes(&s, target.id, date).await));
        }
        Err(LikeDeleteError::Database(err)) => {
            tracing::error!(liker_id = user_id, liked_user_id = target.id, date = %date_str, error = %err, "Failed to delete like");
            return Err(ApiError::internal("Failed to unlike day", c::ERR_CODE_DELETE_FAILED));
        }
    }
    invalidate_likes_cache(target.id, &date_str).await;

    let count = count_likes(&s, target.id, date).await;
    tracing::info!(
        liker_id = user_id,
        liked_user_id = target.id,
        target_username = %req.username,
        date = %req.date,
        new_count = count,
        "Like deleted successfully"
    );
    Ok(action(false, count))
}

fn to_liker_dto(like: LikeWithUser) -> LikerDto {
    LikerDto {
        id: like.liker_id,
        username: like.username,
        profile_pic: like.profile_pic,
        profile_pic_thumb: like.profile_pic_thumb,
        is_verified: like.is_verified,
        // Go: `CreatedAt.Format(time.RFC3339)` of the pgx-decoded (process-local) time.
        liked_at: gojson::format_rfc3339_local(&like.created_at),
    }
}

/// The cached likers of a day, `None` on a miss, an unreadable entry or without Redis.
async fn cached_likers(liked_user_id: i64, date: &str) -> Option<Vec<LikerDto>> {
    if !redis::is_available() {
        return None;
    }
    let cached = match redis::get_likes_cache(liked_user_id, date).await {
        Ok(cached) => cached,
        Err(err) => {
            tracing::warn!(liked_user_id, date, error = %err, "Failed to get likes from cache");
            return None;
        }
    };
    if cached.is_empty() {
        return None;
    }
    match decode_cached_likers(&cached) {
        Ok(likers) => {
            tracing::info!(
                liked_user_id,
                date,
                likes_count = likers.as_ref().map_or(0, Vec::len),
                "GetLikes cache hit"
            );
            likers
        }
        Err(err) => {
            tracing::warn!(liked_user_id, date, error = %err, "Failed to unmarshal cached likes data");
            None
        }
    }
}

/// Caches the likers of a day (the exact JSON Go stored); failures are only logged.
async fn cache_likers(liked_user_id: i64, date: &str, likers: &[LikerDto]) {
    if !redis::is_available() {
        return;
    }
    let data = match gojson::to_string(likers) {
        Ok(data) => data,
        Err(err) => {
            tracing::warn!(liked_user_id, date, error = %err, "Failed to marshal likes data for caching");
            return;
        }
    };
    match redis::set_likes_cache(liked_user_id, date, &data).await {
        Ok(()) => tracing::info!(liked_user_id, date, likes_count = likers.len(), "GetLikes cached successfully"),
        Err(err) => tracing::warn!(liked_user_id, date, error = %err, "Failed to set likes cache"),
    }
}

/// `POST /api/get-likes`: who liked a day (newest first; followers only for private accounts)
/// and whether the caller did. The likers are cached in Redis; the caller's flag never is.
pub(crate) async fn get_likes(
    State(s): State<ActivityState>,
    user: AuthUser,
    JsonBody(body): JsonBody<GetLikesRequest>,
) -> ApiResult {
    let req = body.map_err(|_| ApiError::invalid_request())?;
    require_fields(&req)?;
    let user_id = user.user_id;
    tracing::info!(
        current_user_id = user_id,
        current_username = %user.username,
        target_username = %req.username,
        date = %req.date,
        "GetLikes request received"
    );
    let date = parse_like_date(&req.date)?;
    let target = find_day_owner(&s, user_id, &req.username).await?;
    tracing::info!(
        user_id,
        target_user_id = target.id,
        target_username = %target.username,
        target_is_private = target.is_private,
        "Target user found"
    );
    if !s.profile.can_view_profile(Some(&target), user_id).await {
        tracing::warn!(user_id, target_user_id = target.id, "Cannot view likes for private account - not following");
        return Err(ApiError::forbidden("Cannot view likes for a private account", c::ERR_CODE_ACCOUNT_PRIVATE));
    }

    let date_str = format_date(date);
    let likers = match cached_likers(target.id, &date_str).await {
        Some(likers) => likers,
        None => {
            let likes = s.likes.get_likes_for_day(target.id, date).await.map_err(|err| {
                tracing::error!(liked_user_id = target.id, date = %date_str, error = %err, "Failed to get likes");
                ApiError::internal("Failed to get likes", c::ERR_CODE_FETCH_FAILED)
            })?;
            let likers: Vec<LikerDto> = likes.into_iter().map(to_liker_dto).collect();
            cache_likers(target.id, &date_str, &likers).await;
            likers
        }
    };

    let user_has_liked = match s.likes.has_liked(user_id, target.id, date).await {
        Ok(liked) => liked,
        Err(err) => {
            tracing::error!(liker_id = user_id, liked_user_id = target.id, date = %date_str, error = %err, "Failed to check if user has liked");
            false
        }
    };
    tracing::info!(
        current_user_id = user_id,
        target_user_id = target.id,
        date = %date_str,
        likes_count = likers.len(),
        user_has_liked,
        "GetLikes result"
    );
    let count = i64::try_from(likers.len()).unwrap_or(i64::MAX);
    Ok(response::json(&LikesResponse { success: true, data: likers, count, user_has_liked }))
}
