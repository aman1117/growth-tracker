//! Responses Fiber's router produced on its own for the `/api/profile` group, whose auth
//! middleware runs before routing: `405 Method Not Allowed` for `/api/profile` with another
//! method and `404 Cannot <METHOD> <path>` below it, both `text/plain; charset=utf-8`.

use axum::http::{Method, StatusCode, Uri};
use axum::response::Response;
use gt_core::response;

/// Fiber's `ErrMethodNotAllowed`: the path exists for other methods.
pub(crate) async fn method_not_allowed() -> Response {
    response::text(StatusCode::METHOD_NOT_ALLOWED, "Method Not Allowed")
}

/// Fiber's "no route matched" error (`Cannot <METHOD> <path>`, path HTML-escaped).
pub(crate) async fn route_not_found(method: Method, uri: Uri) -> Response {
    response::text(StatusCode::NOT_FOUND, &format!("Cannot {method} {}", html_escape(uri.path())))
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
