//! Analytics handler (Go: `handlers.AnalyticsHandler`).

use axum::extract::State;
use gt_core::body::JsonBody;
use gt_core::constants as c;
use gt_core::extract::AuthUser;
use gt_core::timeutil::parse_date;
use gt_core::{response, ApiError, ApiResult};

use super::ActivityState;
use crate::dto::GetWeekAnalyticsRequest;

/// `POST /api/get-week-analytics`: a user's analytics for the week starting at `week_start`.
pub(crate) async fn get_week_analytics(
    State(s): State<ActivityState>,
    user: AuthUser,
    JsonBody(body): JsonBody<GetWeekAnalyticsRequest>,
) -> ApiResult {
    let req = body.map_err(|_| ApiError::invalid_request())?;
    let week_start = parse_date(&req.week_start)
        .ok_or_else(|| ApiError::bad_request("Invalid week_start format, use YYYY-MM-DD", c::ERR_CODE_INVALID_DATE))?;
    let target = s.visible_user(&req.username, user.user_id, "Analytics").await?;

    let analytics = s.analytics.get_week_analytics(target.id, week_start).await.map_err(|err| {
        tracing::error!(user_id = target.id, error = %err, "Analytics fetch failed");
        ApiError::internal("Failed to fetch analytics", c::ERR_CODE_FETCH_FAILED)
    })?;
    Ok(response::json(&analytics))
}
