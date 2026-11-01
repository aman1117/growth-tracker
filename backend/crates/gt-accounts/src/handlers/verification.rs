//! Email verification (port of `internal/handlers/verification.go`).

use std::time::Duration;

use axum::extract::State;
use gt_core::body::JsonBody;
use gt_core::constants as c;
use gt_core::extract::AuthUser;
use gt_core::{redis as gt_redis, response, ApiError, ApiResult};
use serde_json::json;

use crate::dto::VerifyEmailRequest;
use crate::state::AccountsState;
use crate::util::Deadline;

/// Redis budget of a verification request (Go: `context.WithTimeout(10s)`).
const VERIFY_TIMEOUT: Duration = Duration::from_secs(10);

/// `POST /api/auth/verify-email`: verifies the address with the single-use token from the
/// email. Verifying an already verified address succeeds again (`already_verified`).
pub(crate) async fn verify_email(
    State(state): State<AccountsState>,
    JsonBody(body): JsonBody<VerifyEmailRequest>,
) -> ApiResult {
    let Ok(req) = body else { return Err(ApiError::invalid_request()) };
    if req.token.is_empty() {
        return Err(ApiError::bad_request("Verification token is required", c::ERR_CODE_MISSING_TOKEN));
    }

    let deadline = Deadline::after(VERIFY_TIMEOUT);
    let user_id = deadline.run(gt_redis::consume_verify_token(&req.token)).await.map_err(|err| {
        tracing::error!(error = %err, "Error consuming verify token");
        ApiError::server_error()
    })?;
    if user_id == 0 {
        return Err(ApiError::bad_request("Invalid or expired verification link", c::ERR_CODE_INVALID_VERIFY_TOKEN));
    }

    let users = &state.users.user_repo;
    let user = users.find_by_id(user_id).await.map_err(|err| {
        tracing::error!(user_id, error = %err, "Error finding user for verification");
        ApiError::server_error()
    })?;
    let Some(user) = user else {
        return Err(ApiError::bad_request("User not found", c::ERR_CODE_USER_NOT_FOUND));
    };

    // Go `fiber.Map`s: keys marshal sorted.
    if user.email_verified {
        return Ok(response::json(&json!({
            "success": true,
            "message": c::MSG_EMAIL_VERIFIED,
            "already_verified": true,
        })));
    }

    if let Err(err) = users.update_email_verified(user_id, true).await {
        tracing::error!(user_id, error = %err, "Error updating email verified status");
        return Err(ApiError::internal("Failed to verify email", c::ERR_CODE_UPDATE_FAILED));
    }
    tracing::info!(user_id, username = %user.username, "Email verified successfully");
    Ok(response::json(&json!({ "success": true, "message": c::MSG_EMAIL_VERIFIED })))
}

/// `POST /api/auth/resend-verification`: emails a fresh verification link to the caller, at
/// most once per 2-minute cooldown.
pub(crate) async fn resend_verification_email(State(state): State<AccountsState>, auth: AuthUser) -> ApiResult {
    let user_id = auth.user_id;
    let user = state.users.user_repo.find_by_id(user_id).await.map_err(|err| {
        tracing::error!(user_id, error = %err, "Error finding user for resend verification");
        ApiError::server_error()
    })?;
    let Some(user) = user else {
        return Err(ApiError::bad_request("User not found", c::ERR_CODE_USER_NOT_FOUND));
    };
    if user.email_verified {
        return Err(ApiError::bad_request("Email is already verified", c::ERR_CODE_ALREADY_VERIFIED));
    }

    let deadline = Deadline::after(VERIFY_TIMEOUT);
    // Better to allow a resend than to block it when the cooldown cannot be checked.
    let in_cooldown = deadline.run(gt_redis::check_verify_resend_cooldown(user_id)).await.unwrap_or_else(|err| {
        tracing::warn!(user_id, error = %err, "Error checking resend cooldown");
        false
    });
    if in_cooldown {
        return Err(ApiError::bad_request(
            "Please wait before requesting another verification email",
            c::ERR_CODE_VERIFY_RESEND_COOLDOWN,
        ));
    }

    let (raw_token, token_hash) = gt_redis::generate_verify_token();
    if let Err(err) = deadline.run(gt_redis::store_verify_token(&token_hash, user_id)).await {
        tracing::error!(user_id, error = %err, "Error storing verify token");
        return Err(ApiError::server_error());
    }
    if let Err(err) = deadline.run(gt_redis::set_verify_resend_cooldown(user_id)).await {
        tracing::warn!(user_id, error = %err, "Error setting resend cooldown");
    }

    if let Some(email_service) = &state.users.email_service {
        if let Err(err) = email_service.send_verification_email(&user.email, &user.username, &raw_token).await {
            tracing::error!(user_id, error = %err, "Error sending verification email");
            return Err(ApiError::internal("Failed to send verification email", c::ERR_CODE_SERVER_ERROR));
        }
    }

    tracing::info!(user_id, "Verification email resent");
    Ok(response::success(c::MSG_VERIFICATION_EMAIL_SENT))
}
