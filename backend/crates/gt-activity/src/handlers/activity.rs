//! Activity handlers (Go: `handlers.ActivityHandler`).

use axum::extract::State;
use chrono::NaiveDate;
use gt_core::body::JsonBody;
use gt_core::constants as c;
use gt_core::extract::AuthUser;
use gt_core::models::{is_valid_activity_name, Activity};
use gt_core::timeutil::parse_date;
use gt_core::validator::validate_note;
use gt_core::{response, ApiError, ApiResult};

use super::ActivityState;
use crate::dates::format_date;
use crate::dto::{ActivityDto, CreateActivityRequest, GetActivitiesRequest, GetDailyTotalsRequest};
use crate::service::ActivityError;

/// Longest range served by `get-daily-totals`.
const MAX_DAILY_TOTALS_RANGE_DAYS: i64 = 93;

fn invalid_date(message: &str) -> ApiError {
    ApiError::bad_request(message, c::ERR_CODE_INVALID_DATE)
}

/// Parses and checks the `start_date`/`end_date` pair of the range endpoints.
fn parse_range(start: &str, end: &str) -> Result<(NaiveDate, NaiveDate), ApiError> {
    let start_date = parse_date(start).ok_or_else(|| invalid_date("Invalid start_date format, use YYYY-MM-DD"))?;
    let end_date = parse_date(end).ok_or_else(|| invalid_date("Invalid end_date format, use YYYY-MM-DD"))?;
    if start_date > end_date {
        return Err(ApiError::bad_request("Start date must be before end date", c::ERR_CODE_INVALID_DATE_RANGE));
    }
    Ok((start_date, end_date))
}

/// Notes are only shown to the owner.
fn to_activity_dtos(activities: Vec<Activity>, include_notes: bool) -> Vec<ActivityDto> {
    activities
        .into_iter()
        .map(|a| ActivityDto {
            id: a.id,
            name: a.name,
            duration_hours: a.duration_hours,
            date: format_date(a.activity_date),
            note: if include_notes { a.note } else { None },
        })
        .collect()
}

/// `POST /api/create-activity`: sets the caller's hours for an activity on a day.
pub(crate) async fn create_activity(
    State(s): State<ActivityState>,
    user: AuthUser,
    JsonBody(body): JsonBody<CreateActivityRequest>,
) -> ApiResult {
    let req = body.map_err(|_| ApiError::invalid_request())?;
    if req.username.is_empty() || req.activity.is_empty() || req.hours < 0.0 {
        return Err(ApiError::bad_request("Invalid request body", c::ERR_CODE_MISSING_FIELDS));
    }
    if req.username != user.username {
        return Err(ApiError::bad_request(
            "You are not authorized to create activity for this username",
            c::ERR_CODE_NOT_AUTHORIZED,
        ));
    }
    if !is_valid_activity_name(&req.activity) {
        return Err(ApiError::bad_request("Invalid activity name", c::ERR_CODE_INVALID_ACTIVITY));
    }
    validate_note(req.note.as_deref())?;
    let date = parse_date(&req.date).ok_or_else(|| invalid_date("Invalid date format, use YYYY-MM-DD"))?;

    match s.activity.create_or_update_activity(user.user_id, &req.activity, req.hours, date, req.note).await {
        Ok(()) => {
            tracing::debug!(user_id = user.user_id, activity = %req.activity, hours = req.hours, date = %req.date, "Activity updated");
            Ok(response::success(c::MSG_ACTIVITY_UPDATED))
        }
        Err(ActivityError::HoursExceeded) => {
            Err(ApiError::bad_request("Total hours cannot be more than 24", c::ERR_CODE_HOURS_EXCEEDED))
        }
        Err(err) => {
            tracing::error!(user_id = user.user_id, error = %err, "Failed to create/update activity");
            Err(ApiError::bad_request("Failed to update activity", c::ERR_CODE_UPDATE_FAILED))
        }
    }
}

/// `POST /api/get-activities`: a user's activities in a date range (notes only for the owner).
pub(crate) async fn get_activities(
    State(s): State<ActivityState>,
    user: AuthUser,
    JsonBody(body): JsonBody<GetActivitiesRequest>,
) -> ApiResult {
    let req = body.map_err(|_| ApiError::invalid_request())?;
    let (start_date, end_date) = parse_range(&req.start_date, &req.end_date)?;
    let target = s.visible_user(&req.username, user.user_id, "Activity").await?;

    let activities = s.activity.get_activities(target.id, start_date, end_date).await.map_err(|err| {
        tracing::error!(user_id = target.id, username = %req.username, error = %err, "Activity fetch failed");
        ApiError::bad_request("Failed to find activities", c::ERR_CODE_FETCH_FAILED)
    })?;
    let is_own_profile = target.id == user.user_id;
    Ok(response::data(&to_activity_dtos(activities, is_own_profile)))
}

/// `POST /api/get-daily-totals`: total hours per day for the calendar heat map (at most 93
/// days).
pub(crate) async fn get_daily_totals(
    State(s): State<ActivityState>,
    user: AuthUser,
    JsonBody(body): JsonBody<GetDailyTotalsRequest>,
) -> ApiResult {
    let req = body.map_err(|_| ApiError::invalid_request())?;
    let (start_date, end_date) = parse_range(&req.start_date, &req.end_date)?;
    if (end_date - start_date).num_days() > MAX_DAILY_TOTALS_RANGE_DAYS {
        return Err(ApiError::bad_request("Date range cannot exceed 93 days", c::ERR_CODE_INVALID_DATE_RANGE));
    }
    let target = s.visible_user(&req.username, user.user_id, "Daily totals").await?;

    let totals = s.activity.get_daily_totals(target.id, start_date, end_date).await.map_err(|err| {
        tracing::error!(user_id = target.id, username = %req.username, error = %err, "Daily totals fetch failed");
        ApiError::bad_request("Failed to fetch daily totals", c::ERR_CODE_FETCH_FAILED)
    })?;
    tracing::debug!(
        user_id = user.user_id,
        target_username = %req.username,
        start_date = %req.start_date,
        end_date = %req.end_date,
        days_with_data = totals.len(),
        "Daily totals fetched"
    );
    Ok(response::data(&totals))
}
