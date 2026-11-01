//! Badge handlers (Go: `handlers.BadgeHandler`).

use axum::extract::State;
use gt_core::body::JsonBody;
use gt_core::constants as c;
use gt_core::extract::AuthUser;
use gt_core::{response, ApiError, ApiResult};

use super::ActivityState;
use crate::dto::{BadgesResponse, GetBadgesByUsernameRequest};

fn badges_failed() -> ApiError {
    ApiError::internal("Failed to get badges", c::ERR_CODE_SERVER_ERROR)
}

/// `GET /api/badges`: every badge with the caller's earned ones marked.
pub(crate) async fn get_badges(State(s): State<ActivityState>, user: AuthUser) -> ApiResult {
    let badges = s.badges.get_user_badges(user.user_id).await.map_err(|err| {
        tracing::error!(user_id = user.user_id, error = %err, "Failed to get badges");
        badges_failed()
    })?;
    Ok(response::json(&BadgesResponse { success: true, badges }))
}

/// `POST /api/badges/user`: another user's badges (always public, even for private accounts).
pub(crate) async fn get_badges_by_username(
    State(s): State<ActivityState>,
    user: AuthUser,
    JsonBody(body): JsonBody<GetBadgesByUsernameRequest>,
) -> ApiResult {
    let req = body.map_err(|_| ApiError::invalid_request())?;
    let target = match s.auth.get_user_by_username(&req.username).await {
        Ok(Some(target)) => target,
        Ok(None) | Err(_) => {
            tracing::warn!(user_id = user.user_id, target_username = %req.username, "Badge fetch failed - user not found");
            return Err(ApiError::user_not_found());
        }
    };
    let badges = s.badges.get_user_badges(target.id).await.map_err(|err| {
        tracing::error!(user_id = user.user_id, target_username = %req.username, error = %err, "Failed to get badges");
        badges_failed()
    })?;
    Ok(response::json(&BadgesResponse { success: true, badges }))
}
