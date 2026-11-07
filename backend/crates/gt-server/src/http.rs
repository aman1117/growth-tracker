//! HTTP plumbing shared by every route, reproducing the Go server's Fiber defaults:
//!
//! * routing ignores trailing slashes (`StrictRouting: false`) and the case of the path
//!   (`CaseSensitive: false`) while path parameters keep their original case, so only the
//!   static route segments are lowercased before routing; repeated slashes are NOT collapsed;
//! * bodies larger than 4 MiB get `413 Request Entity Too Large` (Fiber `BodyLimit`);
//! * unknown routes get `404 Cannot <METHOD> <path>` and known paths with another method get
//!   `405 Method Not Allowed` with an `Allow` header, both `text/plain`;
//! * `GET /` answers `API is running...`;
//! * a panicking handler yields `500` instead of dropping the connection.

use std::any::Any;
use std::convert::Infallible;

use axum::extract::{DefaultBodyLimit, Request};
use axum::http::{header, StatusCode, Uri};
use axum::middleware::Next;
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use gt_core::response;
use tower::util::BoxCloneSyncService;
use tower::ServiceBuilder;
use tower_http::catch_panic::CatchPanicLayer;

/// Fiber's default request body limit.
pub const BODY_LIMIT: usize = 4 * 1024 * 1024;

/// Every static segment of the registered routes (all lowercase). A request path segment that
/// equals one of them ignoring ASCII case is lowercased before routing.
const STATIC_SEGMENTS: &[&str] = &[
    "accept",
    "activity-photo",
    "activity-photos",
    "api",
    "auth",
    "autocomplete",
    "badges",
    "cancel",
    "challenge-codes",
    "challenges",
    "chats",
    "change-password",
    "cheers",
    "cleanup",
    "comments",
    "count",
    "create-activity",
    "days",
    "delivered",
    "decline",
    "follow",
    "follow-counts",
    "follow-requests",
    "followers",
    "following",
    "forgot-password",
    "get-activities",
    "get-bio",
    "get-daily-totals",
    "get-likes",
    "get-privacy",
    "get-streak",
    "get-week-analytics",
    "incoming",
    "interactions",
    "invite-candidates",
    "invites",
    "join",
    "leave",
    "like",
    "like-day",
    "like-status",
    "login",
    "lookup",
    "me",
    "messages",
    "mutuals",
    "notifications",
    "picture",
    "preferences",
    "profile",
    "push",
    "reaction",
    "read",
    "read-all",
    "recent",
    "reconcile",
    "register",
    "relationships",
    "replies",
    "resend-verification",
    "reset-password",
    "search",
    "subscriptions",
    "suggestions",
    "swagger",
    "tile-config",
    "typing",
    "unlike-day",
    "unread-count",
    "update-bio",
    "update-privacy",
    "update-username",
    "upload-picture",
    "user",
    "users",
    "validate",
    "vapid-public-key",
    "verify-email",
    "view",
    "viewers",
    "ws",
];

/// The request path exactly as received, kept for the 404 message.
#[derive(Clone, Debug)]
pub struct OriginalPath(pub String);

/// Health check (`GET /`).
pub fn health_routes() -> Router {
    Router::new().route("/", get(|| async { response::text(StatusCode::OK, "API is running...") }))
}

/// Adds the 404/405 fallbacks to the fully assembled router.
pub fn finalize(router: Router) -> Router {
    router.fallback(not_found).method_not_allowed_fallback(method_not_allowed)
}

/// The complete application service: Fiber-style global middleware (which runs before routing,
/// like `app.Use`) around the router.
pub type AppService = BoxCloneSyncService<Request, Response, Infallible>;

/// Wraps the finalized router with request logging, CORS, panic recovery, body limits, path
/// normalization and Fiber's `Allow` header format.
pub fn app_service(router: Router) -> AppService {
    let service = ServiceBuilder::new()
        .layer(axum::middleware::from_fn(read_body))
        .layer(DefaultBodyLimit::max(BODY_LIMIT))
        .map_request(normalize_path)
        .layer(gt_core::request_log::RequestLogLayer)
        .map_response(into_axum_response)
        .layer(CatchPanicLayer::custom(panic_response))
        .layer(axum::middleware::from_fn(crate::cors::cors))
        .map_response(fiber_allow_header)
        .layer(axum::middleware::from_fn(reject_empty_segments))
        .service(router);
    BoxCloneSyncService::new(service)
}

/// Converts a response with any body type (e.g. from `CatchPanic`) into an axum response.
fn into_axum_response<B>(resp: axum::http::Response<B>) -> Response
where
    B: axum::body::HttpBody<Data = bytes::Bytes> + Send + 'static,
    B::Error: Into<axum::BoxError>,
{
    resp.map(axum::body::Body::new)
}

/// Rewrites the request path before routing (applied outside the router).
pub fn normalize_path(mut req: Request) -> Request {
    let original = req.uri().path().to_string();
    let normalized = normalized_path(&original);
    req.extensions_mut().insert(OriginalPath(original.clone()));
    if normalized != original {
        let path_and_query = match req.uri().query() {
            Some(q) => format!("{normalized}?{q}"),
            None => normalized,
        };
        let mut parts = req.uri().clone().into_parts();
        if let Ok(pq) = path_and_query.parse() {
            parts.path_and_query = Some(pq);
            if let Ok(uri) = Uri::from_parts(parts) {
                *req.uri_mut() = uri;
            }
        }
    }
    req
}

fn normalized_path(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() {
        return "/".to_string();
    }
    trimmed
        .split('/')
        .map(|segment| {
            let lower = segment.to_ascii_lowercase();
            if lower != segment && STATIC_SEGMENTS.contains(&lower.as_str()) {
                lower
            } else {
                segment.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// Rewrites axum's `Allow: GET,HEAD` into Fiber's `Allow: GET, HEAD`.
fn fiber_allow_header(mut resp: Response) -> Response {
    if resp.status() == StatusCode::METHOD_NOT_ALLOWED {
        let formatted = resp
            .headers()
            .get(header::ALLOW)
            .and_then(|v| v.to_str().ok())
            .map(|v| v.split(',').map(str::trim).filter(|m| !m.is_empty()).collect::<Vec<_>>().join(", "));
        if let Some(Ok(value)) = formatted.map(|v| axum::http::HeaderValue::from_str(&v)) {
            resp.headers_mut().insert(header::ALLOW, value);
        }
    }
    resp
}

/// Reads the whole request body before anything else runs, like fasthttp: bodies over
/// [`BODY_LIMIT`] get `413`, and a response sent early (rate limit, auth failure) never leaves
/// unread bytes on the socket, which would make the OS reset the connection and destroy the
/// response before the client reads it.
async fn read_body(req: Request, next: Next) -> Response {
    let too_large = req
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<usize>().ok())
        .is_some_and(|len| len > BODY_LIMIT);
    if too_large {
        return response::text(StatusCode::PAYLOAD_TOO_LARGE, "Request Entity Too Large");
    }
    let (parts, body) = req.into_parts();
    let bytes = match axum::body::to_bytes(body, BODY_LIMIT).await {
        Ok(bytes) => bytes,
        Err(err) => {
            let over_limit = err.into_inner().downcast_ref::<http_body_util::LengthLimitError>().is_some();
            if over_limit {
                return response::text(StatusCode::PAYLOAD_TOO_LARGE, "Request Entity Too Large");
            }
            tracing::debug!(method = %parts.method, path = %parts.uri.path(), "Failed to read request body; client went away");
            return response::text(StatusCode::BAD_REQUEST, "Bad Request");
        }
    };
    next.run(Request::from_parts(parts, axum::body::Body::from(bytes))).await
}

/// Fiber never matches a route parameter against an empty segment (`/api/users//profile`), and
/// no static route has one, so such paths are `404 Cannot <METHOD> <path>` whatever the method.
async fn reject_empty_segments(req: Request, next: Next) -> Response {
    let path = req.uri().path();
    if path.len() > 1 && path[1..].split('/').any(str::is_empty) {
        return not_found(req).await;
    }
    next.run(req).await
}
async fn not_found(req: Request) -> Response {
    let path =
        req.extensions().get::<OriginalPath>().map(|p| p.0.clone()).unwrap_or_else(|| req.uri().path().to_string());
    response::text(StatusCode::NOT_FOUND, &format!("Cannot {} {}", req.method(), html_escape(&path)))
}

async fn method_not_allowed() -> Response {
    response::text(StatusCode::METHOD_NOT_ALLOWED, "Method Not Allowed")
}

fn panic_response(err: Box<dyn Any + Send + 'static>) -> Response {
    let detail = err
        .downcast_ref::<String>()
        .map(String::as_str)
        .or_else(|| err.downcast_ref::<&str>().copied())
        .unwrap_or("unknown panic");
    tracing::error!(panic = detail, "Handler panicked; returning 500");
    response::text(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error")
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
    use axum::body::{to_bytes, Body};
    use axum::routing::post;
    use tower::ServiceExt;

    fn app() -> AppService {
        app_service(finalize(
            health_routes()
                .route("/api/profile", get(|| async { "profile" }))
                .route("/api/login", post(|| async { "ok" })),
        ))
    }

    async fn body(resp: Response) -> String {
        String::from_utf8(to_bytes(resp.into_body(), usize::MAX).await.unwrap().to_vec()).unwrap()
    }

    #[test]
    fn normalizes_paths() {
        assert_eq!(normalized_path("/api/profile/"), "/api/profile");
        assert_eq!(normalized_path("/api/profile///"), "/api/profile");
        assert_eq!(normalized_path("//api//profile"), "//api//profile");
        assert_eq!(normalized_path("/API/Days/Alice/2026-01-01/Comments"), "/api/days/Alice/2026-01-01/comments");
        assert_eq!(normalized_path("/api/challenge-codes/ABCD2345"), "/api/challenge-codes/ABCD2345");
        assert_eq!(normalized_path("/"), "/");
        assert_eq!(normalized_path("///"), "/");
    }

    #[tokio::test]
    async fn fiber_like_routing() {
        let resp = app().oneshot(Request::get("/api/profile/").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        let resp = app().oneshot(Request::get("/api/nope/").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        assert_eq!(body(resp).await, "Cannot GET /api/nope/");

        let resp = app().oneshot(Request::get("/api/login").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(resp.status(), StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(resp.headers()["allow"], "POST");
        assert_eq!(body(resp).await, "Method Not Allowed");

        let resp = app().oneshot(Request::post("/api/profile").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(resp.status(), StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(resp.headers()["allow"], "GET, HEAD");

        let resp = app().oneshot(Request::get("/API/Profile/").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        let resp = app().oneshot(Request::get("/").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(resp.headers()["content-type"], "text/plain; charset=utf-8");
        assert_eq!(body(resp).await, "API is running...");

        // An empty segment never matches a route parameter.
        let with_param = app_service(finalize(Router::new().route("/api/users/{id}/profile", get(|| async { "p" }))));
        let resp = with_param.oneshot(Request::get("/api/users//profile").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        assert_eq!(body(resp).await, "Cannot GET /api/users//profile");

        // Chunked bodies over the limit are rejected while reading them.
        let chunks = futures::stream::iter(
            (0..5).map(|_| Ok::<_, std::io::Error>(bytes::Bytes::from(vec![b'x'; BODY_LIMIT / 4]))),
        );
        let resp = app().oneshot(Request::post("/api/login").body(Body::from_stream(chunks)).unwrap()).await.unwrap();
        assert_eq!(resp.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(body(resp).await, "Request Entity Too Large");

        let big = Request::post("/api/login")
            .header("content-length", (BODY_LIMIT + 1).to_string())
            .body(Body::empty())
            .unwrap();
        let resp = app().oneshot(big).await.unwrap();
        assert_eq!(resp.status(), StatusCode::PAYLOAD_TOO_LARGE);

        let preflight = Request::options("/api/login")
            .header("origin", "http://localhost:5173")
            .header("access-control-request-method", "POST")
            .body(Body::empty())
            .unwrap();
        let resp = app().oneshot(preflight).await.unwrap();
        assert_eq!(resp.status(), StatusCode::NO_CONTENT);
        assert!(resp.headers().get("allow").is_none());

        let resp = app()
            .oneshot(Request::get("/api/nope").header("origin", "http://x").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        assert_eq!(resp.headers()["access-control-allow-origin"], "*");
    }
}
