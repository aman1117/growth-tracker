//! Registration, login and credential changes (port of `internal/handlers/auth.go`).

use std::sync::Arc;
use std::time::Duration;

use axum::extract::State;
use gt_core::body::JsonBody;
use gt_core::constants as c;
use gt_core::extract::AuthUser;
use gt_core::models::User;
use gt_core::{gojson, redis as gt_redis, response, validator, ApiError, ApiResult};
use gt_users::{AuthError, EmailService};

use crate::dto::{
    ChangePasswordRequest, LoginRequest, LoginResponse, RegisterRequest, UpdateUsernameRequest, UsernameUpdateResponse,
};
use crate::state::AccountsState;
use crate::util::Deadline;

/// Budget for storing the verification token of a new user (Go: `context.WithTimeout(30s)`).
const REGISTRATION_VERIFY_TIMEOUT: Duration = Duration::from_secs(30);

/// `POST /api/register`: creates the user and emails a verification link in the background.
pub(crate) async fn register(
    State(state): State<AccountsState>,
    JsonBody(body): JsonBody<RegisterRequest>,
) -> ApiResult {
    let Ok(mut req) = body else { return Err(ApiError::invalid_request()) };
    if req.email.is_empty() || req.username.is_empty() || req.password.is_empty() {
        return Err(ApiError::missing_fields());
    }
    validator::validate_password(&req.password)?;
    validator::validate_username(&req.username)?;
    req.email = validator::sanitize_email(&req.email);
    req.username = validator::sanitize_username(&req.username);

    let auth = &state.users.auth_service;
    if let Err(err) = auth.register(&req.email, &req.username, &req.password).await {
        tracing::warn!(username = %req.username, error = %err, "Registration failed");
        return Err(ApiError::bad_request(
            "Could not create user (maybe email/username already used)",
            c::ERR_CODE_USER_EXISTS,
        ));
    }

    // Go looked the new user up even without an email service.
    let created = auth.get_user_by_email(&req.email).await;
    if let (Ok(Some(user)), Some(email_service)) = (created, state.users.email_service.clone()) {
        // Sending must not block (or fail) the registration.
        tokio::spawn(send_registration_verification(email_service, user));
    }

    tracing::info!(username = %req.username, "New user registered");
    Ok(response::created(c::MSG_USER_CREATED))
}

/// Issues a verification token for a new user and emails the link (Go: the registration
/// goroutine). Failures are only logged.
async fn send_registration_verification(email_service: Arc<EmailService>, user: User) {
    let deadline = Deadline::after(REGISTRATION_VERIFY_TIMEOUT);
    let (raw_token, token_hash) = gt_redis::generate_verify_token();
    if let Err(err) = deadline.run(gt_redis::store_verify_token(&token_hash, user.id)).await {
        tracing::warn!(user_id = user.id, error = %err, "Failed to store verify token during registration");
        return;
    }
    if let Err(err) = email_service.send_verification_email(&user.email, &user.username, &raw_token).await {
        tracing::warn!(user_id = user.id, error = %err, "Failed to send verification email during registration");
        return;
    }
    tracing::info!(user_id = user.id, username = %user.username, "Verification email sent for new user");
}

/// `POST /api/login`: authenticates by email or username and returns a bearer token.
pub(crate) async fn login(State(state): State<AccountsState>, JsonBody(body): JsonBody<LoginRequest>) -> ApiResult {
    let Ok(req) = body else { return Err(ApiError::invalid_request()) };
    if req.identifier.is_empty() || req.password.is_empty() {
        return Err(ApiError::missing_fields());
    }

    let user = match state.users.auth_service.authenticate(&req.identifier, &req.password).await {
        Ok(user) => user,
        Err(AuthError::UserNotFound) => {
            tracing::warn!("Login attempt with non-existent user");
            return Err(ApiError::bad_request("Invalid credentials", c::ERR_CODE_INVALID_CREDENTIALS));
        }
        // Go reported every other failure, database errors included, as a wrong password.
        Err(_) => {
            tracing::warn!("Invalid password attempt");
            return Err(ApiError::bad_request("Invalid password", c::ERR_CODE_INVALID_PASSWORD));
        }
    };

    let issued = state.tokens.generate(user.id, &user.username).map_err(|err| {
        tracing::error!(user_id = user.id, username = %user.username, error = %err, "Token generation failed");
        ApiError::bad_request("Failed to generate token", c::ERR_CODE_TOKEN_GEN_FAILED)
    })?;

    tracing::info!(user_id = user.id, username = %user.username, "User logged in");
    Ok(response::json(&LoginResponse {
        success: true,
        access_token: issued.token,
        token_type: "Bearer".to_string(),
        expires_at: gojson::format_rfc3339_seconds(&issued.expires_at),
        expires_in: issued.expires_in,
    }))
}

/// `POST /api/update-username`.
pub(crate) async fn update_username(
    State(state): State<AccountsState>,
    user: AuthUser,
    JsonBody(body): JsonBody<UpdateUsernameRequest>,
) -> ApiResult {
    let Ok(req) = body else { return Err(ApiError::invalid_request()) };
    let new_username = validator::sanitize_username(&req.new_username);
    if new_username.is_empty() {
        return Err(ApiError::bad_request("Username is required", c::ERR_CODE_MISSING_FIELDS));
    }
    validator::validate_username(&new_username)?;

    if let Err(err) = state.users.auth_service.update_username(user.user_id, &new_username).await {
        tracing::warn!(user_id = user.user_id, new_username = %new_username, error = %err, "Username update failed");
        return Err(ApiError::bad_request("Username already taken or update failed", c::ERR_CODE_USERNAME_TAKEN));
    }

    tracing::info!(user_id = user.user_id, new_username = %new_username, "Username updated");
    Ok(response::json(&UsernameUpdateResponse {
        success: true,
        message: c::MSG_USERNAME_UPDATED.to_string(),
        new_username,
    }))
}

/// `POST /api/change-password`.
pub(crate) async fn change_password(
    State(state): State<AccountsState>,
    user: AuthUser,
    JsonBody(body): JsonBody<ChangePasswordRequest>,
) -> ApiResult {
    let Ok(req) = body else { return Err(ApiError::invalid_request()) };
    if req.current_password.is_empty() || req.new_password.is_empty() {
        return Err(ApiError::missing_fields());
    }
    validator::validate_password(&req.new_password)?;

    let auth = &state.users.auth_service;
    // Only used to enrich the logs, as in Go.
    let username = auth.get_user_by_id(user.user_id).await.ok().flatten().map(|u| u.username).unwrap_or_default();

    match auth.change_password(user.user_id, &req.current_password, &req.new_password).await {
        Ok(()) => {
            tracing::info!(user_id = user.user_id, username = %username, "Password changed successfully");
            Ok(response::success(c::MSG_PASSWORD_CHANGED))
        }
        Err(AuthError::IncorrectCurrentPassword) => {
            tracing::warn!(user_id = user.user_id, username = %username, "Invalid current password for password change");
            Err(ApiError::bad_request("Current password is incorrect", c::ERR_CODE_INVALID_PASSWORD))
        }
        Err(err) => {
            tracing::error!(user_id = user.user_id, username = %username, error = %err, "Failed to change password");
            Err(ApiError::internal("Failed to update password", c::ERR_CODE_UPDATE_FAILED))
        }
    }
}
