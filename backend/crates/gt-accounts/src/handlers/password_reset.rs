//! Password reset by email (port of `internal/handlers/password_reset.go`).

use std::time::Duration;

use axum::extract::State;
use axum::response::Response;
use gt_core::body::JsonBody;
use gt_core::constants as c;
use gt_core::extract::QueryParams;
use gt_core::{redis as gt_redis, response, validator, ApiError, ApiResult};
use serde_json::json;

use crate::dto::{ForgotPasswordRequest, ResetPasswordRequest};
use crate::state::AccountsState;
use crate::util::Deadline;

/// Redis budget of forgot/reset password requests (Go: `context.WithTimeout(10s)`).
const RESET_TIMEOUT: Duration = Duration::from_secs(10);
/// Redis budget of token validation (Go: `context.WithTimeout(5s)`).
const VALIDATE_TIMEOUT: Duration = Duration::from_secs(5);

/// The answer to every forgot-password request, so it never reveals whether an account exists
/// (a Go `fiber.Map`: keys sorted).
fn forgot_password_response() -> Response {
    response::json(&json!({ "success": true, "message": c::MSG_PASSWORD_RESET_SENT }))
}

/// `POST /api/auth/forgot-password`: emails a single-use reset link (valid 15 minutes) when
/// the email belongs to an account. Always answers with the same success response.
pub(crate) async fn forgot_password(
    State(state): State<AccountsState>,
    JsonBody(body): JsonBody<ForgotPasswordRequest>,
) -> Response {
    let Ok(req) = body else { return forgot_password_response() };
    if req.email.is_empty() {
        return forgot_password_response();
    }
    let Ok(Some(user)) = state.users.auth_service.get_user_by_email(&req.email).await else {
        return forgot_password_response();
    };

    let deadline = Deadline::after(RESET_TIMEOUT);
    let (raw_token, token_hash) = gt_redis::generate_reset_token();
    if let Err(err) = deadline.run(gt_redis::store_reset_token(&token_hash, user.id)).await {
        tracing::error!(user_id = user.id, error = %err, "Error storing reset token");
        return forgot_password_response();
    }

    if let Some(email_service) = &state.users.email_service {
        if let Err(err) = email_service.send_password_reset_email(&user.email, &user.username, &raw_token).await {
            tracing::error!(user_id = user.id, error = %err, "Error sending reset email");
        }
    }
    forgot_password_response()
}

/// `POST /api/auth/reset-password`: sets a new password with a reset token (consumed even when
/// the update then fails).
pub(crate) async fn reset_password(
    State(state): State<AccountsState>,
    JsonBody(body): JsonBody<ResetPasswordRequest>,
) -> ApiResult {
    let Ok(req) = body else { return Err(ApiError::invalid_request()) };
    if req.token.is_empty() {
        return Err(ApiError::bad_request("Reset token is required", c::ERR_CODE_MISSING_TOKEN));
    }
    if req.new_password != req.confirm_password {
        return Err(ApiError::bad_request("Passwords do not match", c::ERR_CODE_PASSWORD_MISMATCH));
    }
    validator::validate_password_strength(&req.new_password)?;

    let deadline = Deadline::after(RESET_TIMEOUT);
    let user_id = deadline.run(gt_redis::consume_reset_token(&req.token)).await.map_err(|err| {
        tracing::error!(error = %err, "Error consuming reset token");
        ApiError::server_error()
    })?;
    if user_id == 0 {
        return Err(ApiError::bad_request("Invalid or expired reset token", c::ERR_CODE_INVALID_RESET_TOKEN));
    }

    if let Err(err) = state.users.auth_service.reset_password(user_id, &req.new_password).await {
        tracing::error!(user_id, error = %err, "Error updating password");
        return Err(ApiError::internal("Failed to update password", c::ERR_CODE_UPDATE_FAILED));
    }
    Ok(response::success(c::MSG_PASSWORD_RESET))
}

/// `GET /api/auth/reset-password/validate?token=`: whether a reset token is valid, without
/// consuming it. Errors read as invalid.
pub(crate) async fn validate_reset_token(query: QueryParams) -> Response {
    let token = query.get("token");
    let valid = if token.is_empty() {
        false
    } else {
        match Deadline::after(VALIDATE_TIMEOUT).run(gt_redis::validate_reset_token(token)).await {
            Ok(user_id) => user_id > 0,
            Err(err) => {
                tracing::error!(error = %err, "Error validating reset token");
                false
            }
        }
    };
    response::json(&json!({ "success": true, "valid": valid }))
}
