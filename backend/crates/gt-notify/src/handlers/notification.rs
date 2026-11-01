//! `/api/notifications` handlers (Go: `handlers.NotificationHandler`).

use axum::extract::{RawPathParams, State};
use axum::response::Response;
use gt_core::constants as c;
use gt_core::extract::{AuthUser, QueryParams};
use gt_core::{response, ApiError, ApiResult};

use super::NotifyState;
use crate::dto::{notifications_to_dtos, NotificationsResponse, UnreadCountResponse};
use crate::service::NotificationError;

const DEFAULT_PAGE_SIZE: i64 = 20;
const MAX_PAGE_SIZE: i64 = 50;

/// Go `strconv.ParseUint(id, 10, 32)` on the raw path segment.
fn parse_notification_id(raw: &str) -> Option<i64> {
    if raw.is_empty() || !raw.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    raw.parse::<u32>().ok().map(i64::from)
}

fn invalid_id() -> ApiError {
    ApiError::bad_request("Invalid notification ID", c::ERR_CODE_INVALID_REQUEST)
}

fn raw_id(params: &Result<RawPathParams, axum::extract::rejection::RawPathParamsRejection>) -> &str {
    params
        .as_ref()
        .ok()
        .and_then(|p| p.iter().find(|(name, _)| *name == "id").map(|(_, value)| value))
        .unwrap_or_default()
}

/// `GET /api/notifications?page=&page_size=`: newest first, page size 1..=50 (default 20).
pub(crate) async fn get_notifications(State(s): State<NotifyState>, user: AuthUser, query: QueryParams) -> ApiResult {
    let mut page = query.int_or("page", 1);
    let mut page_size = query.int_or("page_size", DEFAULT_PAGE_SIZE);
    if page < 1 {
        page = 1;
    }
    if page_size < 1 {
        page_size = DEFAULT_PAGE_SIZE;
    }
    if page_size > MAX_PAGE_SIZE {
        page_size = MAX_PAGE_SIZE;
    }
    tracing::info!(user_id = user.user_id, page, page_size, "GetNotifications request");

    let (notifications, total) =
        s.notifications.get_by_user_id(user.user_id, page, page_size).await.map_err(|err| {
            tracing::error!(user_id = user.user_id, error = %err, "Failed to get notifications");
            ApiError::internal("Failed to get notifications", c::ERR_CODE_FETCH_FAILED)
        })?;
    Ok(response::json(&NotificationsResponse {
        success: true,
        notifications: notifications_to_dtos(&notifications),
        total,
        page,
        page_size,
        has_more: page.wrapping_mul(page_size) < total,
    }))
}

/// `GET /api/notifications/unread-count`.
pub(crate) async fn get_unread_count(State(s): State<NotifyState>, user: AuthUser) -> ApiResult {
    let unread_count = s.notifications.get_unread_count(user.user_id).await.map_err(|err| {
        tracing::error!(user_id = user.user_id, error = %err, "Failed to get unread count");
        ApiError::internal("Failed to get unread count", c::ERR_CODE_FETCH_FAILED)
    })?;
    Ok(response::json(&UnreadCountResponse { success: true, unread_count }))
}

/// `PATCH /api/notifications/{id}/read`.
pub(crate) async fn mark_as_read(
    State(s): State<NotifyState>,
    user: AuthUser,
    params: Result<RawPathParams, axum::extract::rejection::RawPathParamsRejection>,
) -> ApiResult {
    let id = parse_notification_id(raw_id(&params)).ok_or_else(invalid_id)?;
    tracing::info!(user_id = user.user_id, notification_id = id, "MarkAsRead request");
    s.notifications.mark_as_read(id, user.user_id).await.map_err(|err| {
        tracing::error!(user_id = user.user_id, notification_id = id, error = %err, "Failed to mark notification as read");
        ApiError::internal("Failed to mark as read", c::ERR_CODE_UPDATE_FAILED)
    })?;
    Ok(response::success("Notification marked as read"))
}

/// `PATCH /api/notifications/read-all`.
pub(crate) async fn mark_all_as_read(State(s): State<NotifyState>, user: AuthUser) -> ApiResult {
    tracing::info!(user_id = user.user_id, "MarkAllAsRead request");
    s.notifications.mark_all_as_read(user.user_id).await.map_err(|err| {
        tracing::error!(user_id = user.user_id, error = %err, "Failed to mark all notifications as read");
        ApiError::internal("Failed to mark all as read", c::ERR_CODE_UPDATE_FAILED)
    })?;
    Ok(response::success("All notifications marked as read"))
}

/// `DELETE /api/notifications/{id}`.
pub(crate) async fn delete_notification(
    State(s): State<NotifyState>,
    user: AuthUser,
    params: Result<RawPathParams, axum::extract::rejection::RawPathParamsRejection>,
) -> ApiResult {
    delete_by_raw_id(&s, &user, raw_id(&params)).await
}

/// `DELETE` on a static sibling route (`/read-all`, `/unread-count`): Fiber matches it with
/// `/:id`, so the literal segment is parsed (and rejected) as an id.
pub(crate) async fn delete_literal(s: NotifyState, user: AuthUser, segment: &'static str) -> Response {
    match delete_by_raw_id(&s, &user, segment).await {
        Ok(resp) => resp,
        Err(err) => axum::response::IntoResponse::into_response(err),
    }
}

async fn delete_by_raw_id(s: &NotifyState, user: &AuthUser, raw: &str) -> ApiResult {
    let id = parse_notification_id(raw).ok_or_else(invalid_id)?;
    tracing::info!(user_id = user.user_id, notification_id = id, "DeleteNotification request");
    match s.notifications.delete(id, user.user_id).await {
        Ok(()) => Ok(response::success("Notification deleted")),
        Err(err) => {
            tracing::error!(user_id = user.user_id, notification_id = id, error = %err, "Failed to delete notification");
            Err(match err {
                NotificationError::NotFound => {
                    ApiError::not_found("Notification not found", c::ERR_CODE_NOTIFICATION_NOT_FOUND)
                }
                _ => ApiError::internal("Failed to delete notification", c::ERR_CODE_DELETE_FAILED),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_parse_like_parse_uint_32() {
        assert_eq!(parse_notification_id("42"), Some(42));
        assert_eq!(parse_notification_id("007"), Some(7));
        assert_eq!(parse_notification_id("4294967295"), Some(4_294_967_295));
        for bad in ["", "abc", "-1", "+1", "99999999999", "4294967296", "1.5", "%31"] {
            assert_eq!(parse_notification_id(bad), None, "{bad}");
        }
    }
}
