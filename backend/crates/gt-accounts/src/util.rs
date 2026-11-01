//! Request parsing and Go-compatibility helpers shared by the handlers.

use std::convert::Infallible;
use std::future::Future;
use std::time::Duration;

use anyhow::anyhow;
use axum::extract::{FromRequestParts, MatchedPath};
use axum::http::request::Parts;
use tokio::time::Instant;

/// Path parameters exactly as they appear in the request path, i.e. NOT percent-decoded, like
/// Fiber's `c.Params` with its default `UnescapePath: false` (`/api/users/%32/profile` yields
/// `%32`, which then fails id parsing as it did in Go). axum's `Path` and `RawPathParams` both
/// decode, so the values are cut from the URI using the matched route template.
#[derive(Debug, Default)]
pub(crate) struct RawParams(Vec<(String, String)>);

impl RawParams {
    /// Splits `path` along `template` (`/api/users/{id}/follow`) and collects the `{name}`
    /// segments. Catch-all parameters are ignored.
    pub fn from_template(template: &str, path: &str) -> Self {
        let params = template
            .split('/')
            .zip(path.split('/'))
            .filter_map(|(pattern, segment)| {
                let name = pattern.strip_prefix('{')?.strip_suffix('}')?;
                (!name.starts_with('*')).then(|| (name.to_string(), segment.to_string()))
            })
            .collect();
        Self(params)
    }

    /// Go `c.Params(name)`: the raw value, or `""` when the route has no such parameter.
    pub fn get(&self, name: &str) -> &str {
        self.0.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_str()).unwrap_or("")
    }
}

impl<S: Send + Sync> FromRequestParts<S> for RawParams {
    type Rejection = Infallible;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        Ok(match parts.extensions.get::<MatchedPath>() {
            Some(template) => RawParams::from_template(template.as_str(), parts.uri.path()),
            None => RawParams::default(),
        })
    }
}

/// Go `strconv.ParseUint(s, 10, 32)`: ASCII digits only (no sign), at most `u32::MAX`.
pub(crate) fn parse_go_uint32(s: &str) -> Option<i64> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse::<u32>().ok().map(i64::from)
}

/// Go's `truncateString`: at most `max_chars` characters (never splits a character).
pub(crate) fn truncate_chars(s: &str, max_chars: usize) -> String {
    match s.char_indices().nth(max_chars) {
        Some((byte_index, _)) => s[..byte_index].to_string(),
        None => s.to_string(),
    }
}

/// Go `strings.ToLower`: per-character simple case mapping. Unlike `str::to_lowercase` it maps
/// `İ` to a single `i` and never applies the final-sigma rule, so cache keys match Go's.
pub(crate) fn go_to_lower(s: &str) -> String {
    s.chars().map(|ch| ch.to_lowercase().next().unwrap_or(ch)).collect()
}

/// A deadline shared by several operations (Go: one `context.WithTimeout` used for every Redis
/// call of a handler).
pub(crate) struct Deadline(Instant);

impl Deadline {
    pub fn after(timeout: Duration) -> Self {
        Self(Instant::now() + timeout)
    }

    /// Runs `operation`, failing with Go's `context deadline exceeded` once the deadline passes.
    pub async fn run<T>(&self, operation: impl Future<Output = anyhow::Result<T>>) -> anyhow::Result<T> {
        tokio::time::timeout_at(self.0, operation).await.map_err(|_| anyhow!("context deadline exceeded"))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_params_follow_the_template() {
        let params = RawParams::from_template("/api/users/{id}/follow", "/api/users/%32/follow");
        assert_eq!(params.get("id"), "%32");
        assert_eq!(params.get("missing"), "");
        let params = RawParams::from_template("/api/profile/{*rest}", "/api/profile/a/b");
        assert_eq!(params.get("rest"), "");
    }

    #[test]
    fn uint32_parsing_matches_strconv() {
        assert_eq!(parse_go_uint32("42"), Some(42));
        assert_eq!(parse_go_uint32("0007"), Some(7));
        assert_eq!(parse_go_uint32("4294967295"), Some(4_294_967_295));
        for bad in ["", "-1", "+1", "1.5", "abc", "4294967296", "99999999999", " 1", "%31"] {
            assert_eq!(parse_go_uint32(bad), None, "{bad}");
        }
    }

    #[test]
    fn truncates_by_character() {
        assert_eq!(truncate_chars("abc", 2), "ab");
        assert_eq!(truncate_chars("abc", 3), "abc");
        assert_eq!(truncate_chars(&"é".repeat(100), 80), "é".repeat(80));
        assert_eq!(truncate_chars(&"🚀".repeat(81), 80).chars().count(), 80);
    }

    #[test]
    fn lowercases_like_go() {
        assert_eq!(go_to_lower("GoPher"), "gopher");
        assert_eq!(go_to_lower("İSTANBUL"), "istanbul");
        assert_eq!(go_to_lower("ΟΔΟΣ"), "οδοσ");
    }
}
