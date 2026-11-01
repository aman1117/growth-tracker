//! Cross-origin resource sharing with the exact behavior of the Go server's Fiber `cors`
//! middleware configured with `AllowOrigins/AllowMethods/AllowHeaders/ExposeHeaders = "*"` and
//! `AllowCredentials = false`:
//!
//! * no `Origin` header: untouched;
//! * `OPTIONS` with `Origin` but no `Access-Control-Request-Method`: adds `Vary: Origin` and
//!   continues to routing;
//! * preflight: `204 No Content` with `Vary`, `Access-Control-Allow-Origin/Methods/Headers` and
//!   `Access-Control-Expose-Headers` all `*`;
//! * other requests with `Origin`: `Access-Control-Allow-Origin: *` and
//!   `Access-Control-Expose-Headers: *`.

use axum::body::Body;
use axum::extract::Request;
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::Next;
use axum::response::Response;

const WILDCARD: HeaderValue = HeaderValue::from_static("*");

/// Axum middleware function (`axum::middleware::from_fn(cors)`).
pub async fn cors(req: Request, next: Next) -> Response {
    let has_origin = req.headers().get(header::ORIGIN).is_some_and(|v| !v.is_empty());
    if !has_origin {
        return next.run(req).await;
    }

    if req.method() == Method::OPTIONS {
        let requested_method = req.headers().get(header::ACCESS_CONTROL_REQUEST_METHOD).is_some_and(|v| !v.is_empty());
        if !requested_method {
            let mut resp = next.run(req).await;
            add_vary(resp.headers_mut(), "Origin");
            return resp;
        }

        let mut resp = Response::new(Body::empty());
        *resp.status_mut() = StatusCode::NO_CONTENT;
        let headers = resp.headers_mut();
        add_vary(headers, "Access-Control-Request-Method");
        add_vary(headers, "Access-Control-Request-Headers");
        add_vary(headers, "Origin");
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, WILDCARD);
        headers.insert(header::ACCESS_CONTROL_ALLOW_METHODS, WILDCARD);
        headers.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, WILDCARD);
        headers.insert(header::ACCESS_CONTROL_EXPOSE_HEADERS, WILDCARD);
        return resp;
    }

    let mut resp = next.run(req).await;
    let headers = resp.headers_mut();
    headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, WILDCARD);
    headers.insert(header::ACCESS_CONTROL_EXPOSE_HEADERS, WILDCARD);
    resp
}

/// Appends `value` to `Vary` unless already present (fasthttp `Vary`).
fn add_vary(headers: &mut HeaderMap, value: &str) {
    let existing = headers.get(header::VARY).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    if existing.split(',').any(|v| v.trim().eq_ignore_ascii_case(value)) {
        return;
    }
    let combined = if existing.is_empty() { value.to_string() } else { format!("{existing}, {value}") };
    if let Ok(v) = HeaderValue::from_str(&combined) {
        headers.insert(header::VARY, v);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::routing::get;
    use axum::Router;
    use tower::ServiceExt;

    fn app() -> Router {
        Router::new().route("/x", get(|| async { "ok" })).layer(axum::middleware::from_fn(cors))
    }

    #[tokio::test]
    async fn preflight_is_204_with_wildcards() {
        let req = Request::builder()
            .method("OPTIONS")
            .uri("/x")
            .header("Origin", "https://app.example")
            .header("Access-Control-Request-Method", "POST")
            .header("Access-Control-Request-Headers", "authorization")
            .body(Body::empty())
            .unwrap();
        let resp = app().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::NO_CONTENT);
        let h = resp.headers();
        assert_eq!(h["access-control-allow-origin"], "*");
        assert_eq!(h["access-control-allow-methods"], "*");
        assert_eq!(h["access-control-allow-headers"], "*");
        assert_eq!(h["access-control-expose-headers"], "*");
        assert_eq!(h["vary"], "Access-Control-Request-Method, Access-Control-Request-Headers, Origin");
    }

    #[tokio::test]
    async fn simple_request_gets_origin_and_expose() {
        let req = Request::get("/x").header("Origin", "https://a").body(Body::empty()).unwrap();
        let resp = app().oneshot(req).await.unwrap();
        assert_eq!(resp.headers()["access-control-allow-origin"], "*");
        assert_eq!(resp.headers()["access-control-expose-headers"], "*");
        assert!(resp.headers().get("vary").is_none());
    }

    #[tokio::test]
    async fn no_origin_is_untouched() {
        let resp = app().oneshot(Request::get("/x").body(Body::empty()).unwrap()).await.unwrap();
        assert!(resp.headers().get("access-control-allow-origin").is_none());
    }
}
