//! Request body parsing with Fiber `BodyParser` semantics.
//!
//! Handlers receive [`JsonBody<T>`], which never rejects the request: it carries
//! `Result<T, BodyError>` so each handler can answer a malformed body exactly as the Go
//! handler did (usually `ApiError::invalid_request()`).

use axum::body::Bytes;
use axum::extract::{FromRequest, Request};
use axum::http::{header, HeaderMap};
use serde::de::DeserializeOwned;

/// Why a body could not be decoded.
#[derive(Debug, thiserror::Error)]
pub enum BodyError {
    /// The `Content-Type` is not JSON (Fiber: `422 Unprocessable Entity` error).
    #[error("Unprocessable Entity")]
    UnsupportedContentType,
    #[error("invalid JSON: {0}")]
    InvalidJson(#[from] serde_json::Error),
    #[error("failed to read body: {0}")]
    Read(String),
}

/// Decodes `body` the way Fiber's `c.BodyParser` decodes JSON into a Go struct: the media type
/// must end in `json`; unknown fields are ignored; a literal `null` yields the default value.
pub fn parse_json<T: DeserializeOwned + Default>(headers: &HeaderMap, body: &[u8]) -> Result<T, BodyError> {
    if !is_json_content_type(headers) {
        return Err(BodyError::UnsupportedContentType);
    }
    let trimmed = body.trim_ascii();
    if trimmed == b"null" {
        return Ok(T::default());
    }
    Ok(serde_json::from_slice(body)?)
}

/// Whether the request's media type ends with `json` (after vendor `+json` normalization).
pub fn is_json_content_type(headers: &HeaderMap) -> bool {
    let Some(value) = headers.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()) else {
        return false;
    };
    let lower = value.to_ascii_lowercase();
    let media = lower.split(';').next().unwrap_or("").trim_end();
    media.ends_with("json")
}

/// Extractor yielding the decoded body or the reason it could not be decoded.
pub struct JsonBody<T>(pub Result<T, BodyError>);

impl<T> JsonBody<T> {
    pub fn into_result(self) -> Result<T, BodyError> {
        self.0
    }
}

impl<S, T> FromRequest<S> for JsonBody<T>
where
    S: Send + Sync,
    T: DeserializeOwned + Default,
{
    type Rejection = std::convert::Infallible;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        let headers = req.headers().clone();
        match Bytes::from_request(req, state).await {
            Ok(bytes) => Ok(JsonBody(parse_json(&headers, &bytes))),
            Err(err) => Ok(JsonBody(Err(BodyError::Read(err.body_text())))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;
    use serde::Deserialize;

    #[derive(Debug, Default, Deserialize, PartialEq)]
    #[serde(default)]
    struct Req {
        username: String,
        hours: f32,
    }

    fn headers(ct: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(header::CONTENT_TYPE, HeaderValue::from_str(ct).unwrap());
        h
    }

    #[test]
    fn content_type_rules() {
        assert!(is_json_content_type(&headers("application/json")));
        assert!(is_json_content_type(&headers("application/json; charset=utf-8")));
        assert!(is_json_content_type(&headers("application/vnd.api+json")));
        assert!(!is_json_content_type(&headers("text/plain")));
        assert!(!is_json_content_type(&HeaderMap::new()));
    }

    #[test]
    fn decodes_like_go() {
        let h = headers("application/json");
        let r: Req = parse_json(&h, br#"{"username":"a","extra":1}"#).unwrap();
        assert_eq!(r, Req { username: "a".into(), hours: 0.0 });
        let r: Req = parse_json(&h, b"null").unwrap();
        assert_eq!(r, Req::default());
        assert!(parse_json::<Req>(&h, b"").is_err());
        assert!(parse_json::<Req>(&h, br#"{"hours":"2"}"#).is_err());
        assert!(parse_json::<Req>(&headers("text/plain"), b"{}").is_err());
    }
}
