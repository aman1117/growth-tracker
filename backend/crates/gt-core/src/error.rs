//! The API error type. Every failed request is answered with the Go backend's envelope:
//! `{"success":false,"error":"<message>","error_code":"<CODE>"}`.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Serialize;

use crate::constants as c;
use crate::response;

/// Result type returned by HTTP handlers.
pub type ApiResult<T = Response> = Result<T, ApiError>;

/// An HTTP error response with a message and a machine-readable code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiError {
    pub status: StatusCode,
    pub message: String,
    pub code: String,
}

#[derive(Serialize)]
struct ErrorBody<'a> {
    success: bool,
    error: &'a str,
    error_code: &'a str,
}

impl ApiError {
    pub fn new(status: StatusCode, message: impl Into<String>, code: impl Into<String>) -> Self {
        Self { status, message: message.into(), code: code.into() }
    }

    pub fn bad_request(message: impl Into<String>, code: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, message, code)
    }

    pub fn unauthorized(message: impl Into<String>, code: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, message, code)
    }

    pub fn forbidden(message: impl Into<String>, code: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, message, code)
    }

    pub fn not_found(message: impl Into<String>, code: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, message, code)
    }

    pub fn conflict(message: impl Into<String>, code: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, message, code)
    }

    pub fn too_many_requests(message: impl Into<String>, code: impl Into<String>) -> Self {
        Self::new(StatusCode::TOO_MANY_REQUESTS, message, code)
    }

    pub fn internal(message: impl Into<String>, code: impl Into<String>) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, message, code)
    }

    /// 503 with `SERVER_ERROR` (Go: `response.ServiceUnavailable`).
    pub fn service_unavailable(message: impl Into<String>) -> Self {
        Self::new(StatusCode::SERVICE_UNAVAILABLE, message, c::ERR_CODE_SERVER_ERROR)
    }

    // ---- Common errors (Go: response.InvalidRequest, MissingFields, ...) ----

    pub fn invalid_request() -> Self {
        Self::bad_request("Invalid request body", c::ERR_CODE_INVALID_REQUEST)
    }

    pub fn missing_fields() -> Self {
        Self::bad_request("All fields are required", c::ERR_CODE_MISSING_FIELDS)
    }

    pub fn unauthorized_access() -> Self {
        Self::unauthorized("Unauthorized", c::ERR_CODE_UNAUTHORIZED)
    }

    pub fn private_account() -> Self {
        Self::forbidden("This account is private", c::ERR_CODE_ACCOUNT_PRIVATE)
    }

    pub fn user_not_found() -> Self {
        Self::bad_request("Failed to find user", c::ERR_CODE_USER_NOT_FOUND)
    }

    pub fn database_error() -> Self {
        Self::bad_request("Database Error", c::ERR_CODE_DATABASE_ERROR)
    }

    pub fn server_error() -> Self {
        Self::internal("An error occurred. Please try again.", c::ERR_CODE_SERVER_ERROR)
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} {}: {}", self.status.as_u16(), self.code, self.message)
    }
}

impl std::error::Error for ApiError {}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        response::json_status(self.status, &ErrorBody { success: false, error: &self.message, error_code: &self.code })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body_util_compat::body_string;

    mod http_body_util_compat {
        use axum::body::to_bytes;
        use axum::response::Response;

        pub async fn body_string(resp: Response) -> String {
            let bytes = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
            String::from_utf8(bytes.to_vec()).unwrap()
        }
    }

    #[tokio::test]
    async fn renders_go_error_envelope() {
        let resp = ApiError::invalid_request().into_response();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        assert_eq!(resp.headers()["content-type"], "application/json");
        assert_eq!(
            body_string(resp).await,
            r#"{"success":false,"error":"Invalid request body","error_code":"INVALID_REQUEST"}"#
        );
    }
}
