//! Tile configuration handlers (Go: `handlers.TileConfigHandler`).

use axum::extract::State;
use gt_core::body::JsonBody;
use gt_core::constants as c;
use gt_core::extract::AuthUser;
use gt_core::models::TileConfig;
use gt_core::{response, ApiError, ApiResult};

use super::ActivityState;
use crate::dto::{go_interface_value, GetTileConfigByUsernameRequest, SaveTileConfigRequest, TileConfigResponse};
use crate::service::TileConfigError;

fn fetch_failed() -> ApiError {
    ApiError::internal("Failed to get tile configuration", c::ERR_CODE_FETCH_FAILED)
}

/// `{"success":true,"data":<config or null>}`; numbers read back as Go `float64`s.
fn config_response(config: Option<TileConfig>) -> TileConfigResponse {
    TileConfigResponse { success: true, data: config.and_then(|c| c.config).map(go_interface_value) }
}

/// `GET /api/tile-config`: the caller's configuration (`data` is `null` when none is saved).
pub(crate) async fn get_config(State(s): State<ActivityState>, user: AuthUser) -> ApiResult {
    // Never report a failure as "no config": the app would show the default tiles and its next
    // save would replace the user's real configuration.
    let config = s.tile_config.get_config(user.user_id).await.map_err(|err| {
        tracing::error!(user_id = user.user_id, error = %err, "Tile config fetch failed");
        fetch_failed()
    })?;
    Ok(response::json(&config_response(config)))
}

/// `POST /api/tile-config/user`: another user's configuration, subject to profile privacy.
pub(crate) async fn get_config_by_username(
    State(s): State<ActivityState>,
    user: AuthUser,
    JsonBody(body): JsonBody<GetTileConfigByUsernameRequest>,
) -> ApiResult {
    let req = body.map_err(|_| ApiError::invalid_request())?;
    if req.username.is_empty() {
        return Err(ApiError::bad_request("Username is required", c::ERR_CODE_MISSING_FIELDS));
    }
    let target = match s.auth.get_user_by_username(&req.username).await {
        Ok(Some(target)) => target,
        Ok(None) | Err(_) => {
            tracing::warn!(user_id = user.user_id, target_username = %req.username, "Tile config fetch failed - user not found");
            return Err(ApiError::not_found("User not found", c::ERR_CODE_USER_NOT_FOUND));
        }
    };
    if !s.profile.can_view_profile(Some(&target), user.user_id).await {
        tracing::debug!(user_id = user.user_id, target_username = %req.username, "Tile config access denied - private account");
        return Err(ApiError::private_account());
    }
    let config = s.tile_config.get_config(target.id).await.map_err(|err| {
        tracing::error!(user_id = user.user_id, target_user_id = target.id, error = %err, "Tile config fetch failed");
        fetch_failed()
    })?;
    Ok(response::json(&config_response(config)))
}

/// `POST /api/tile-config`: validates and saves the caller's configuration.
pub(crate) async fn save_config(
    State(s): State<ActivityState>,
    user: AuthUser,
    JsonBody(body): JsonBody<SaveTileConfigRequest>,
) -> ApiResult {
    let req = body.map_err(|err| {
        tracing::warn!(user_id = user.user_id, error = %err, "Tile config save failed - invalid request body");
        ApiError::invalid_request()
    })?;
    // Go decoded the configuration into interface{} values: every number is a float64.
    let config = req.config.map(crate::dto::go_interface_map);
    let has = |key: &str| config.as_ref().and_then(|m| m.get(key)).is_some_and(|v| !v.is_null());
    tracing::debug!(
        user_id = user.user_id,
        has_order = has("order"),
        has_sizes = has("sizes"),
        has_hidden = has("hidden"),
        has_colors = has("colors"),
        has_custom_tiles = has("customTiles"),
        "Attempting to save tile config"
    );

    match s.tile_config.save_config(user.user_id, config).await {
        Ok(()) => {
            tracing::info!(user_id = user.user_id, "Tile config saved successfully");
            Ok(response::success(c::MSG_TILE_CONFIG_SAVED))
        }
        Err(TileConfigError::Validation(err)) => {
            tracing::warn!(user_id = user.user_id, error = %err.message, code = err.code, "Tile config validation failed");
            Err(ApiError::bad_request(err.message, err.code))
        }
        Err(err) => {
            tracing::error!(user_id = user.user_id, error = %err, "Tile config save failed");
            Err(ApiError::internal("Failed to save tile configuration", c::ERR_CODE_SAVE_FAILED))
        }
    }
}
