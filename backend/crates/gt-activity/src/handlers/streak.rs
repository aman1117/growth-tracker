//! Streak handler (Go: `handlers.StreakHandler`).

use axum::extract::State;
use gt_core::body::JsonBody;
use gt_core::constants as c;
use gt_core::extract::AuthUser;
use gt_core::timeutil::parse_date;
use gt_core::{response, ApiError, ApiResult};

use super::ActivityState;
use crate::dates::format_date;
use crate::dto::{GetStreakRequest, StreakDto, StreakResponse};

/// `POST /api/get-streak`: a user's streak record for a day. Reading one's own streak awards
/// any newly earned badges, returned in `new_badges`.
pub(crate) async fn get_streak(
    State(s): State<ActivityState>,
    user: AuthUser,
    JsonBody(body): JsonBody<GetStreakRequest>,
) -> ApiResult {
    let req = body.map_err(|_| ApiError::invalid_request())?;
    let date = parse_date(&req.date)
        .ok_or_else(|| ApiError::bad_request("Invalid date format, use YYYY-MM-DD", c::ERR_CODE_INVALID_DATE))?;
    let target = s.visible_user(&req.username, user.user_id, "Streak").await?;

    let streak = match s.streak.get_streak(target.id, date).await {
        Ok(Some(streak)) => streak,
        Ok(None) | Err(_) => {
            tracing::debug!(user_id = target.id, username = %req.username, date = %req.date, "Streak not found");
            return Err(ApiError::bad_request("Failed to find streak", c::ERR_CODE_STREAK_NOT_FOUND));
        }
    };

    // Badge problems never fail the request (Go ignored the error).
    let new_badges = if target.id == user.user_id {
        s.badges.check_and_award_badges(target.id, streak.longest).await.unwrap_or_default()
    } else {
        Vec::new()
    };

    Ok(response::json(&StreakResponse {
        success: true,
        data: StreakDto {
            id: streak.id,
            current: streak.current,
            longest: streak.longest,
            date: format_date(streak.activity_date),
            new_badges,
        },
    }))
}
