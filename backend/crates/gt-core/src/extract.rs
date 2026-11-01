//! Request extractors and parsing helpers replicating Fiber's `c.Locals`, `c.IP()`,
//! `c.Query`, `c.QueryInt` and `c.ParamsInt` behavior.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use axum::extract::{ConnectInfo, FromRequestParts};
use axum::http::request::Parts;

use crate::error::ApiError;

pub use crate::config::parse_go_int;

/// The authenticated caller, inserted by the auth guard (Go: `c.Locals("user_id")`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthUser {
    pub user_id: i64,
    pub username: String,
}

impl<S: Send + Sync> FromRequestParts<S> for AuthUser {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        parts.extensions.get::<AuthUser>().cloned().ok_or_else(ApiError::unauthorized_access)
    }
}

/// The caller when authenticated, `None` otherwise (Go handlers that do
/// `userID, _ := c.Locals("user_id").(uint)`).
#[derive(Debug, Clone)]
pub struct MaybeAuthUser(pub Option<AuthUser>);

impl<S: Send + Sync> FromRequestParts<S> for MaybeAuthUser {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        Ok(MaybeAuthUser(parts.extensions.get::<AuthUser>().cloned()))
    }
}

/// The TCP peer address (Go: `c.IP()`, which ignores proxy headers by default).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClientIp(pub IpAddr);

impl ClientIp {
    pub fn from_parts(parts: &Parts) -> Self {
        parts
            .extensions
            .get::<ConnectInfo<SocketAddr>>()
            .map(|ConnectInfo(addr)| ClientIp(addr.ip()))
            .unwrap_or(ClientIp(IpAddr::V4(Ipv4Addr::UNSPECIFIED)))
    }
}

impl std::fmt::Display for ClientIp {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

impl<S: Send + Sync> FromRequestParts<S> for ClientIp {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        Ok(ClientIp::from_parts(parts))
    }
}

/// Per-request trace id (8 hex chars), inserted by the request logger.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TraceId(pub String);

impl<S: Send + Sync> FromRequestParts<S> for TraceId {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        Ok(parts.extensions.get::<TraceId>().cloned().unwrap_or_default())
    }
}

/// Query string parameters; for repeated keys the first value wins (fasthttp `Peek`).
/// Never rejects.
#[derive(Debug, Clone, Default)]
pub struct QueryParams(pub HashMap<String, String>);

impl QueryParams {
    pub fn parse(query: Option<&str>) -> Self {
        let mut map = HashMap::new();
        if let Some(q) = query {
            for (k, v) in url::form_urlencoded::parse(q.as_bytes()) {
                map.entry(k.into_owned()).or_insert_with(|| v.into_owned());
            }
        }
        QueryParams(map)
    }

    /// Go `c.Query(key)`: the value or `""`.
    pub fn get(&self, key: &str) -> &str {
        self.0.get(key).map(String::as_str).unwrap_or("")
    }

    /// Go `c.Query(key, default)`: the value, or `default` when missing or empty.
    pub fn get_or<'a>(&'a self, key: &str, default: &'a str) -> &'a str {
        match self.0.get(key) {
            Some(v) if !v.is_empty() => v,
            _ => default,
        }
    }

    /// Go `c.QueryInt(key, default)`: `strconv.Atoi` of the value, `default` on any error.
    pub fn int_or(&self, key: &str, default: i64) -> i64 {
        parse_go_int(self.get(key)).unwrap_or(default)
    }

    /// Go `c.QueryBool(key, default)`: `strconv.ParseBool`, `default` on error.
    pub fn bool_or(&self, key: &str, default: bool) -> bool {
        parse_go_bool(self.get(key)).unwrap_or(default)
    }
}

impl<S: Send + Sync> FromRequestParts<S> for QueryParams {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        Ok(QueryParams::parse(parts.uri.query()))
    }
}

/// Go `strconv.ParseBool`.
pub fn parse_go_bool(s: &str) -> Option<bool> {
    match s {
        "1" | "t" | "T" | "TRUE" | "true" | "True" => Some(true),
        "0" | "f" | "F" | "FALSE" | "false" | "False" => Some(false),
        _ => None,
    }
}

/// Go `strconv.ParseUint(s, 10, 64)` (no sign allowed), as `i64` ids.
pub fn parse_go_uint(s: &str) -> Option<i64> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse::<u64>().ok().and_then(|v| i64::try_from(v).ok())
}

/// Go `c.ParamsInt(name)` result: `strconv.Atoi` of the raw path segment.
pub fn params_int(raw: &str) -> Option<i64> {
    parse_go_int(raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_semantics() {
        let q = QueryParams::parse(Some("limit=5&limit=9&cursor=&q=a+b&bad=x"));
        assert_eq!(q.int_or("limit", 20), 5);
        assert_eq!(q.get_or("cursor", "none"), "none");
        assert_eq!(q.get("q"), "a b");
        assert_eq!(q.int_or("bad", 7), 7);
        assert_eq!(q.int_or("missing", 3), 3);
    }

    #[test]
    fn uint_and_bool_parsing() {
        assert_eq!(parse_go_uint("12"), Some(12));
        assert_eq!(parse_go_uint("-1"), None);
        assert_eq!(parse_go_uint("+1"), None);
        assert_eq!(parse_go_bool("T"), Some(true));
        assert_eq!(parse_go_bool("yes"), None);
    }
}
