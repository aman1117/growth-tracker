//! Response helpers producing the same bodies, status codes and `Content-Type` headers as the Go
//! backend's `internal/response` package (Fiber's `c.JSON` sends `application/json`).

use axum::body::Body;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::Response;
use serde::Serialize;

use crate::gojson;

pub const CONTENT_TYPE_JSON: &str = "application/json";
pub const CONTENT_TYPE_TEXT: &str = "text/plain; charset=utf-8";

#[derive(Serialize)]
struct SuccessBody<'a> {
    success: bool,
    #[serde(skip_serializing_if = "str::is_empty")]
    message: &'a str,
}

#[derive(Serialize)]
struct DataBody<'a, T: Serialize + ?Sized> {
    success: bool,
    data: &'a T,
}

/// Sends `value` as JSON (Go `json.Marshal` encoding) with the given status.
pub fn json_status<T: Serialize + ?Sized>(status: StatusCode, value: &T) -> Response {
    match gojson::to_vec(value) {
        Ok(bytes) => {
            let mut resp = Response::new(Body::from(bytes));
            *resp.status_mut() = status;
            resp.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static(CONTENT_TYPE_JSON));
            resp
        }
        Err(err) => {
            tracing::error!(error = %err, "Failed to encode JSON response");
            text(StatusCode::INTERNAL_SERVER_ERROR, &err.to_string())
        }
    }
}

/// 200 with `value` as the whole body (Go: `response.JSON` / `c.JSON`).
pub fn json<T: Serialize + ?Sized>(value: &T) -> Response {
    json_status(StatusCode::OK, value)
}

/// 200 `{"success":true,"message":...}`; the message is omitted when empty.
pub fn success(message: &str) -> Response {
    json_status(StatusCode::OK, &SuccessBody { success: true, message })
}

/// 201 `{"success":true,"message":...}`.
pub fn created(message: &str) -> Response {
    json_status(StatusCode::CREATED, &SuccessBody { success: true, message })
}

/// 200 `{"success":true,"data":...}`.
pub fn data<T: Serialize + ?Sized>(value: &T) -> Response {
    json_status(StatusCode::OK, &DataBody { success: true, data: value })
}

/// Plain-text response (Go: `c.SendString` / `c.Status(..).SendString`).
pub fn text(status: StatusCode, body: &str) -> Response {
    let mut resp = Response::new(Body::from(body.to_owned()));
    *resp.status_mut() = status;
    resp.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static(CONTENT_TYPE_TEXT));
    resp
}

/// Empty response with only a status (Go: `c.SendStatus`). Fiber writes the status text as
/// the body for codes that have one, so this does too.
pub fn status(status: StatusCode) -> Response {
    text(status, status.canonical_reason().unwrap_or(""))
}
