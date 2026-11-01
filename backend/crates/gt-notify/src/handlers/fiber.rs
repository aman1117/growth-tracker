//! Responses Fiber's router and default error handler produce on their own, which the Go API
//! returned for these routes: `404 Cannot GET /path`, `405 Method Not Allowed` and
//! `426 Upgrade Required`, all as `text/plain; charset=utf-8`.

use axum::http::{Method, StatusCode, Uri};
use axum::response::Response;
use gt_core::response;

/// Fiber's "no route matched" error (`Cannot <METHOD> <path>`, path HTML-escaped).
pub(crate) fn not_found(method: &Method, uri: &Uri) -> Response {
    response::text(StatusCode::NOT_FOUND, &format!("Cannot {method} {}", html_escape(uri.path())))
}

/// Fiber's `ErrMethodNotAllowed`: the path exists for other methods.
pub(crate) async fn method_not_allowed() -> Response {
    response::text(StatusCode::METHOD_NOT_ALLOWED, "Method Not Allowed")
}

/// Handler for paths below a Fiber group whose middleware already ran (e.g. auth): no route.
pub(crate) async fn route_not_found(method: Method, uri: Uri) -> Response {
    not_found(&method, &uri)
}

/// Fiber's `ErrUpgradeRequired`.
pub(crate) fn upgrade_required() -> Response {
    response::text(StatusCode::UPGRADE_REQUIRED, "Upgrade Required")
}

/// Go `html.EscapeString`.
fn html_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '&' => out.push_str("&amp;"),
            '\'' => out.push_str("&#39;"),
            '"' => out.push_str("&#34;"),
            _ => out.push(ch),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_like_go() {
        assert_eq!(html_escape(r#"/a<b>&'""#), "/a&lt;b&gt;&amp;&#39;&#34;");
    }
}
