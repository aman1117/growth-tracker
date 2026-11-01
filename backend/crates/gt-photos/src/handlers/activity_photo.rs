//! Activity photo (story) endpoints (port of `internal/handlers/activity_photo.go`).

use std::sync::Arc;

use axum::extract::State;
use axum::http::Uri;
use gt_core::constants as c;
use gt_core::error::{ApiError, ApiResult};
use gt_core::extract::{AuthUser, QueryParams, TraceId};
use gt_core::response;
use gt_core::timeutil::parse_date;

use super::detached;
use crate::dto::{
    InteractionsResponse, LikeStatusResponse, PhotoUploadResponse, PhotosResponse, StoriesResponse, SuccessResponse,
    ViewersResponse,
};
use crate::form::FormRequest;
use crate::service::{ActivityPhotoService, PhotoError, PhotoUpload};
use crate::validation::{
    no_image_error, parse_limit, parse_offset, parse_uint32, LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT, STORIES_DEFAULT_LIMIT,
    STORIES_MAX_LIMIT,
};

/// Handler state.
pub(crate) type PhotoState = State<Arc<ActivityPhotoService>>;

fn invalid_photo_id() -> ApiError {
    ApiError::bad_request("Invalid photo ID", c::ERR_CODE_INVALID_REQUEST)
}

fn invalid_date() -> ApiError {
    ApiError::bad_request("Invalid date format, use YYYY-MM-DD", c::ERR_CODE_INVALID_DATE)
}

fn photo_not_found() -> ApiError {
    ApiError::not_found("Photo not found", c::ERR_CODE_PHOTO_NOT_FOUND)
}

/// The `:id` of `/api/activity-photo/:id[/...]` exactly as sent (Fiber does not unescape
/// path parameters), parsed like Go's `strconv.ParseUint(id, 10, 32)`.
fn photo_id(uri: &Uri) -> Result<i64, ApiError> {
    let raw = uri.path().split('/').nth(3).unwrap_or("");
    parse_uint32(raw).ok_or_else(invalid_photo_id)
}

/// `POST /api/activity-photo`: multipart `image`, `activity_name`, `photo_date` and the
/// optional custom tile fields `activity_icon`, `activity_color`, `activity_label`.
pub(crate) async fn upload_photo(
    State(svc): PhotoState,
    user: AuthUser,
    TraceId(trace_id): TraceId,
    form: FormRequest,
) -> ApiResult {
    let user_id = user.user_id;
    let activity_name = form.value("activity_name");
    let photo_date_raw = form.value("photo_date");
    if activity_name.is_empty() || photo_date_raw.is_empty() {
        tracing::warn!(trace_id = %trace_id, user_id, "Photo upload failed - missing fields");
        return Err(ApiError::bad_request("activity_name and photo_date are required", c::ERR_CODE_MISSING_FIELDS));
    }
    let Some(photo_date) = parse_date(photo_date_raw) else {
        tracing::warn!(trace_id = %trace_id, user_id, date = photo_date_raw, "Photo upload failed - invalid date");
        return Err(invalid_date());
    };
    let file = match form.file("image") {
        Ok(file) => file.clone(),
        Err(err) => {
            tracing::warn!(trace_id = %trace_id, user_id, error = %err, "Photo upload failed - no image");
            return Err(no_image_error());
        }
    };
    let upload = PhotoUpload {
        activity_name: activity_name.to_string(),
        photo_date,
        activity_icon: form.value("activity_icon").to_string(),
        activity_color: form.value("activity_color").to_string(),
        activity_label: form.value("activity_label").to_string(),
    };

    detached(async move {
        let photo = match svc.upload(user_id, &upload, &file).await {
            Ok(photo) => photo,
            Err(PhotoError::AlreadyExists) => {
                return Err(ApiError::conflict(
                    "Photo already exists for this activity on this date",
                    c::ERR_CODE_CONFLICT,
                ));
            }
            Err(err) => {
                tracing::error!(trace_id = %trace_id, user_id, error = %err, "Photo upload failed");
                return Err(ApiError::bad_request(err.to_string(), c::ERR_CODE_INVALID_REQUEST));
            }
        };
        tracing::info!(
            trace_id = %trace_id,
            user_id,
            photo_id = photo.id,
            activity_name = %upload.activity_name,
            photo_date = %gt_core::timeutil::format_date(&upload.photo_date),
            "Activity photo uploaded"
        );
        Ok(response::json(&PhotoUploadResponse { photo, success: true }))
    })
    .await
}

/// `DELETE /api/activity-photo/{id}` (owner only).
pub(crate) async fn delete_photo(
    State(svc): PhotoState,
    user: AuthUser,
    TraceId(trace_id): TraceId,
    uri: Uri,
) -> ApiResult {
    let photo_id = photo_id(&uri)?;
    let user_id = user.user_id;
    detached(async move {
        match svc.delete(photo_id, user_id).await {
            Ok(()) => {
                tracing::info!(trace_id = %trace_id, user_id, photo_id, "Activity photo deleted");
                Ok(response::success("Photo deleted successfully"))
            }
            Err(PhotoError::NotFound) => Err(photo_not_found()),
            Err(PhotoError::DeleteForbidden) => {
                Err(ApiError::forbidden("Not authorized to delete this photo", c::ERR_CODE_NOT_AUTHORIZED))
            }
            Err(err) => {
                tracing::error!(trace_id = %trace_id, user_id, error = %err, "Photo deletion failed");
                Err(ApiError::internal("Failed to delete photo", c::ERR_CODE_DELETE_FAILED))
            }
        }
    })
    .await
}

/// `GET /api/activity-photos?user_id=&date=`: a followed (or own) user's photos of a day;
/// viewing someone else's photos records the views.
pub(crate) async fn get_photos(
    State(svc): PhotoState,
    user: AuthUser,
    TraceId(trace_id): TraceId,
    query: QueryParams,
) -> ApiResult {
    let viewer_id = user.user_id;
    let (target_raw, date_raw) = (query.get("user_id"), query.get("date"));
    if target_raw.is_empty() || date_raw.is_empty() {
        return Err(ApiError::bad_request("user_id and date are required", c::ERR_CODE_MISSING_FIELDS));
    }
    let target_id = parse_uint32(target_raw)
        .ok_or_else(|| ApiError::bad_request("Invalid user_id", c::ERR_CODE_INVALID_REQUEST))?;
    let photo_date = parse_date(date_raw).ok_or_else(invalid_date)?;

    let can_view = svc.can_view_stories(viewer_id, target_id).await.map_err(|err| {
        tracing::error!(trace_id = %trace_id, user_id = viewer_id, error = %err, "Failed to check story access");
        ApiError::internal("Failed to check access", c::ERR_CODE_SERVER_ERROR)
    })?;
    if !can_view {
        return Err(ApiError::forbidden("You must follow this user to view their stories", c::ERR_CODE_NOT_AUTHORIZED));
    }

    let photos = svc.get_by_user_and_date(target_id, photo_date).await.map_err(|err| {
        tracing::error!(trace_id = %trace_id, user_id = viewer_id, error = %err, "Failed to get photos");
        ApiError::internal("Failed to get photos", c::ERR_CODE_FETCH_FAILED)
    })?;
    if viewer_id != target_id {
        for photo in &photos {
            // Best effort, as in Go.
            let _ = svc.record_view(viewer_id, photo.id).await;
        }
    }
    Ok(response::json(&PhotosResponse { photos, success: true }))
}

/// `GET /api/activity-photos/following?date=&limit=`: story groups of followed users.
pub(crate) async fn get_following_stories(
    State(svc): PhotoState,
    user: AuthUser,
    TraceId(trace_id): TraceId,
    query: QueryParams,
) -> ApiResult {
    let date_raw = query.get("date");
    if date_raw.is_empty() {
        return Err(ApiError::bad_request("date is required", c::ERR_CODE_MISSING_FIELDS));
    }
    let photo_date = parse_date(date_raw).ok_or_else(invalid_date)?;
    let limit = parse_limit(query.get("limit"), STORIES_DEFAULT_LIMIT, STORIES_MAX_LIMIT);

    let stories = svc.get_following_stories(user.user_id, photo_date, limit).await.map_err(|err| {
        tracing::error!(trace_id = %trace_id, user_id = user.user_id, error = %err, "Failed to get following stories");
        ApiError::internal("Failed to get stories", c::ERR_CODE_FETCH_FAILED)
    })?;
    Ok(response::json(&StoriesResponse { stories, success: true }))
}

/// `POST /api/activity-photo/{id}/view`.
pub(crate) async fn record_view(
    State(svc): PhotoState,
    user: AuthUser,
    TraceId(trace_id): TraceId,
    uri: Uri,
) -> ApiResult {
    let photo_id = photo_id(&uri)?;
    match svc.record_view(user.user_id, photo_id).await {
        Ok(()) => Ok(response::json(&SuccessResponse::OK)),
        Err(PhotoError::NotFound) => Err(photo_not_found()),
        Err(err) => {
            tracing::error!(trace_id = %trace_id, user_id = user.user_id, photo_id, error = %err, "Failed to record view");
            Err(ApiError::internal("Failed to record view", c::ERR_CODE_SERVER_ERROR))
        }
    }
}

/// `GET /api/activity-photo/{id}/viewers?limit=&offset=` (owner only).
pub(crate) async fn get_photo_viewers(
    State(svc): PhotoState,
    user: AuthUser,
    TraceId(trace_id): TraceId,
    uri: Uri,
    query: QueryParams,
) -> ApiResult {
    let photo_id = photo_id(&uri)?;
    let (limit, offset) = page(&query);
    match svc.get_viewers(photo_id, user.user_id, limit, offset).await {
        Ok((viewers, total)) => Ok(response::json(&ViewersResponse { success: true, total, viewers })),
        Err(PhotoError::NotFound) => Err(photo_not_found()),
        Err(PhotoError::ViewersForbidden) => {
            Err(ApiError::forbidden("Only the photo owner can view viewers", c::ERR_CODE_NOT_AUTHORIZED))
        }
        Err(err) => {
            tracing::error!(trace_id = %trace_id, user_id = user.user_id, error = %err, "Failed to get photo viewers");
            Err(ApiError::internal("Failed to get viewers", c::ERR_CODE_FETCH_FAILED))
        }
    }
}

/// `POST /api/activity-photo/{id}/like`.
pub(crate) async fn like_photo(
    State(svc): PhotoState,
    user: AuthUser,
    TraceId(trace_id): TraceId,
    uri: Uri,
) -> ApiResult {
    let photo_id = photo_id(&uri)?;
    let user_id = user.user_id;
    detached(async move {
        match svc.like_photo(user_id, photo_id).await {
            Ok(()) => {
                tracing::info!(trace_id = %trace_id, user_id, photo_id, "Photo liked");
                Ok(response::json(&SuccessResponse::OK))
            }
            Err(PhotoError::NotFound) => Err(photo_not_found()),
            Err(PhotoError::CannotLikeOwnPhoto) => {
                Err(ApiError::bad_request("Cannot like your own photo", c::ERR_CODE_INVALID_REQUEST))
            }
            Err(PhotoError::MustFollow) => {
                Err(ApiError::forbidden("You must follow this user to like their photos", c::ERR_CODE_NOT_AUTHORIZED))
            }
            Err(err) => {
                tracing::error!(trace_id = %trace_id, user_id, photo_id, error = %err, "Failed to like photo");
                Err(ApiError::internal("Failed to like photo", c::ERR_CODE_SERVER_ERROR))
            }
        }
    })
    .await
}

/// `DELETE /api/activity-photo/{id}/like`.
pub(crate) async fn unlike_photo(
    State(svc): PhotoState,
    user: AuthUser,
    TraceId(trace_id): TraceId,
    uri: Uri,
) -> ApiResult {
    let photo_id = photo_id(&uri)?;
    let user_id = user.user_id;
    detached(async move {
        match svc.unlike_photo(user_id, photo_id).await {
            Ok(()) => {
                tracing::info!(trace_id = %trace_id, user_id, photo_id, "Photo unliked");
                Ok(response::json(&SuccessResponse::OK))
            }
            Err(PhotoError::NotFound) => Err(photo_not_found()),
            Err(err) => {
                tracing::error!(trace_id = %trace_id, user_id, photo_id, error = %err, "Failed to unlike photo");
                Err(ApiError::internal("Failed to unlike photo", c::ERR_CODE_SERVER_ERROR))
            }
        }
    })
    .await
}

/// `GET /api/activity-photo/{id}/interactions?limit=&offset=` (owner only).
pub(crate) async fn get_photo_interactions(
    State(svc): PhotoState,
    user: AuthUser,
    TraceId(trace_id): TraceId,
    uri: Uri,
    query: QueryParams,
) -> ApiResult {
    let photo_id = photo_id(&uri)?;
    let (limit, offset) = page(&query);
    match svc.get_photo_interactions(photo_id, user.user_id, limit, offset).await {
        Ok((interactions, total)) => Ok(response::json(&InteractionsResponse {
            interactions: interactions.map(|list| list.into_iter().map(Into::into).collect()),
            success: true,
            total,
        })),
        Err(PhotoError::NotFound) => Err(photo_not_found()),
        Err(PhotoError::InteractionsForbidden) => {
            Err(ApiError::forbidden("Only the photo owner can view interactions", c::ERR_CODE_NOT_AUTHORIZED))
        }
        Err(err) => {
            tracing::error!(trace_id = %trace_id, user_id = user.user_id, error = %err, "Failed to get photo interactions");
            Err(ApiError::internal("Failed to get interactions", c::ERR_CODE_FETCH_FAILED))
        }
    }
}

/// `GET /api/activity-photo/{id}/like-status`: whether the caller liked the photo and its
/// like count (the photo's existence is not checked, as in Go).
pub(crate) async fn get_photo_like_status(
    State(svc): PhotoState,
    user: AuthUser,
    TraceId(trace_id): TraceId,
    uri: Uri,
) -> ApiResult {
    let photo_id = photo_id(&uri)?;
    let liked = svc.has_liked_photo(user.user_id, photo_id).await.map_err(|err| {
        tracing::error!(trace_id = %trace_id, user_id = user.user_id, photo_id, error = %err, "Failed to get like status");
        ApiError::internal("Failed to get like status", c::ERR_CODE_FETCH_FAILED)
    })?;
    let like_count = svc.get_photo_like_count(photo_id).await.map_err(|err| {
        tracing::error!(trace_id = %trace_id, user_id = user.user_id, photo_id, error = %err, "Failed to get like count");
        ApiError::internal("Failed to get like count", c::ERR_CODE_FETCH_FAILED)
    })?;
    Ok(response::json(&LikeStatusResponse { like_count, liked, success: true }))
}

/// `limit` (1..=100, default 20) and `offset` (>= 0, default 0) of the owner lists.
fn page(query: &QueryParams) -> (i64, i64) {
    (parse_limit(query.get("limit"), LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT), parse_offset(query.get("offset")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn photo_id_uses_the_raw_path_segment() {
        let id = |path: &str| photo_id(&path.parse::<Uri>().unwrap()).ok();
        assert_eq!(id("/api/activity-photo/42"), Some(42));
        assert_eq!(id("/api/activity-photo/42/like"), Some(42));
        assert_eq!(id("/api/activity-photo/4294967295/view"), Some(4_294_967_295));
        assert_eq!(id("/api/activity-photo/4294967296"), None);
        assert_eq!(id("/api/activity-photo/%34%32"), None);
        assert_eq!(id("/api/activity-photo/-1"), None);
        assert_eq!(id("/api/activity-photo/abc"), None);
    }
}
