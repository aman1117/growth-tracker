//! Per-route middleware: JWT authentication followed by rate limiting, in the same order the Go
//! routes chain `authMiddleware` and a limiter.
//!
//! ```ignore
//! use axum::routing::{get, post};
//! Router::new()
//!     .route("/api/challenges", get(list).layer(guards.api()).merge(post(create).layer(guards.auth_limited(&guards.limiters.challenge_write))))
//! ```

use std::convert::Infallible;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use axum::extract::Request;
use axum::http::{HeaderName, HeaderValue};
use axum::response::{IntoResponse, Response};
use tower::{Layer, Service};

use crate::constants as c;
use crate::error::ApiError;
use crate::extract::{AuthUser, ClientIp};
use crate::jwt::TokenService;
use crate::ratelimit::{Decision, RateLimiter, RateLimiters};

/// Factory for [`Guard`] layers, shared by every feature crate.
#[derive(Clone)]
pub struct Guards {
    pub tokens: Arc<TokenService>,
    pub limiters: Arc<RateLimiters>,
}

impl Guards {
    pub fn new(tokens: Arc<TokenService>, limiters: Arc<RateLimiters>) -> Self {
        Self { tokens, limiters }
    }

    /// Authentication only (Go: `authMiddleware`).
    pub fn auth(&self) -> Guard {
        Guard { tokens: self.tokens.clone(), require_auth: true, limiter: None }
    }

    /// Authentication, then `limiter` (Go: `authMiddleware, someLimiter`).
    pub fn auth_limited(&self, limiter: &Arc<RateLimiter>) -> Guard {
        Guard { tokens: self.tokens.clone(), require_auth: true, limiter: Some(limiter.clone()) }
    }

    /// Rate limiting only, for public routes (Go: `authRateLimiter` on `/register`).
    pub fn limited(&self, limiter: &Arc<RateLimiter>) -> Guard {
        Guard { tokens: self.tokens.clone(), require_auth: false, limiter: Some(limiter.clone()) }
    }

    /// The most common combination: authentication + the general API limiter.
    pub fn api(&self) -> Guard {
        self.auth_limited(&self.limiters.api)
    }
}

/// Validates the `Authorization: Bearer <jwt>` header like Go's `middleware.Auth`.
pub fn authenticate(tokens: &TokenService, header: Option<&HeaderValue>) -> Result<AuthUser, ApiError> {
    let Some(raw) = header.map(HeaderValue::as_bytes).filter(|v| !v.is_empty()) else {
        return Err(ApiError::unauthorized("Missing Authorization Header", c::ERR_CODE_MISSING_AUTH_HEADER));
    };
    let raw = String::from_utf8_lossy(raw);
    let Some(token) = raw.strip_prefix(c::BEARER_PREFIX) else {
        return Err(ApiError::unauthorized("Invalid Authorization Header", c::ERR_CODE_INVALID_AUTH_HEADER));
    };
    let claims =
        tokens.parse(token.trim()).map_err(|_| ApiError::unauthorized("Invalid token", c::ERR_CODE_INVALID_TOKEN))?;
    let user_id = i64::try_from(claims.user_id)
        .map_err(|_| ApiError::unauthorized("Invalid token", c::ERR_CODE_INVALID_TOKEN))?;
    Ok(AuthUser { user_id, username: claims.username })
}

/// Tower layer applying authentication and/or a rate limiter.
#[derive(Clone)]
pub struct Guard {
    tokens: Arc<TokenService>,
    require_auth: bool,
    limiter: Option<Arc<RateLimiter>>,
}

impl<S> Layer<S> for Guard {
    type Service = GuardService<S>;

    fn layer(&self, inner: S) -> Self::Service {
        GuardService { inner, guard: self.clone() }
    }
}

#[derive(Clone)]
pub struct GuardService<S> {
    inner: S,
    guard: Guard,
}

static X_RATELIMIT_LIMIT: HeaderName = HeaderName::from_static("x-ratelimit-limit");
static X_RATELIMIT_REMAINING: HeaderName = HeaderName::from_static("x-ratelimit-remaining");
static X_RATELIMIT_RESET: HeaderName = HeaderName::from_static("x-ratelimit-reset");

impl<S> Service<Request> for GuardService<S>
where
    S: Service<Request, Response = Response, Error = Infallible> + Clone + Send + 'static,
    S::Future: Send + 'static,
{
    type Response = Response;
    type Error = Infallible;
    type Future = Pin<Box<dyn Future<Output = Result<Response, Infallible>> + Send>>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, mut req: Request) -> Self::Future {
        let clone = self.inner.clone();
        let mut inner = std::mem::replace(&mut self.inner, clone);
        let guard = self.guard.clone();

        Box::pin(async move {
            if guard.require_auth {
                match authenticate(&guard.tokens, req.headers().get(axum::http::header::AUTHORIZATION)) {
                    Ok(user) => {
                        req.extensions_mut().insert(user);
                    }
                    Err(err) => return Ok(err.into_response()),
                }
            }
            let user = req.extensions().get::<AuthUser>().cloned();

            let mut rate_headers = None;
            if let Some(limiter) = &guard.limiter {
                let (parts, body) = req.into_parts();
                let ip = ClientIp::from_parts(&parts);
                req = Request::from_parts(parts, body);
                match limiter.hit(&limiter.key(user.as_ref(), ip)) {
                    Decision::Limited { retry_after_secs } => {
                        tracing::warn!(
                            ip = %ip,
                            path = %req.uri().path(),
                            method = %req.method(),
                            limiter = limiter.name(),
                            "Rate limit exceeded"
                        );
                        let mut resp = ApiError::too_many_requests(limiter.message(), c::ERR_CODE_RATE_LIMIT_EXCEEDED)
                            .into_response();
                        resp.headers_mut().insert(axum::http::header::RETRY_AFTER, retry_after_secs.into());
                        attach_user(&mut resp, user);
                        return Ok(resp);
                    }
                    Decision::Allowed { limit, remaining, reset_secs } => {
                        rate_headers = Some((limit, remaining, reset_secs));
                    }
                }
            }

            let mut resp = inner.call(req).await?;
            if let Some((limit, remaining, reset_secs)) = rate_headers {
                let headers = resp.headers_mut();
                headers.insert(X_RATELIMIT_LIMIT.clone(), limit.into());
                headers.insert(X_RATELIMIT_REMAINING.clone(), remaining.into());
                headers.insert(X_RATELIMIT_RESET.clone(), reset_secs.into());
            }
            attach_user(&mut resp, user);
            Ok(resp)
        })
    }
}

/// Exposes the caller to outer middleware (the request logger reads it from the response).
fn attach_user(resp: &mut Response, user: Option<AuthUser>) {
    if let Some(user) = user {
        resp.extensions_mut().insert(user);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::JwtConfig;
    use std::time::Duration;

    fn tokens() -> TokenService {
        TokenService::new(&JwtConfig {
            secret_key: "k".into(),
            access_token_ttl: Duration::from_secs(60),
            refresh_token_ttl: Duration::from_secs(60),
        })
    }

    #[test]
    fn auth_header_errors_match_go() {
        let t = tokens();
        let err = authenticate(&t, None).unwrap_err();
        assert_eq!(err.code, c::ERR_CODE_MISSING_AUTH_HEADER);
        let err = authenticate(&t, Some(&HeaderValue::from_static("Token abc"))).unwrap_err();
        assert_eq!(err.code, c::ERR_CODE_INVALID_AUTH_HEADER);
        let err = authenticate(&t, Some(&HeaderValue::from_static("Bearer nope"))).unwrap_err();
        assert_eq!(err.code, c::ERR_CODE_INVALID_TOKEN);
        let issued = t.generate(5, "sam").unwrap();
        let header = HeaderValue::from_str(&format!("Bearer  {} ", issued.token)).unwrap();
        assert_eq!(authenticate(&t, Some(&header)).unwrap(), AuthUser { user_id: 5, username: "sam".into() });
    }

    #[tokio::test]
    async fn per_method_guards_on_one_path() {
        use axum::body::Body;
        use axum::routing::{get, post};
        use axum::Router;
        use tower::ServiceExt;

        let t = Arc::new(tokens());
        let limiters = Arc::new(RateLimiters::new());
        let guards = Guards::new(t.clone(), limiters);
        let one_per_window = Arc::new(RateLimiter::new("t", 1, Duration::from_secs(60), "slow", Some("user")));

        async fn whoami(user: AuthUser) -> String {
            user.username
        }
        let app: Router = Router::new().route(
            "/api/things",
            get(whoami).layer(guards.auth()).merge(post(|| async { "public" }).layer(guards.limited(&one_per_window))),
        );

        let token = t.generate(1, "amy").unwrap().token;
        let resp = app
            .clone()
            .oneshot(
                axum::http::Request::get("/api/things")
                    .header("Authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        assert_eq!(resp.extensions().get::<AuthUser>().unwrap().user_id, 1);

        let resp =
            app.clone().oneshot(axum::http::Request::get("/api/things").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(resp.status(), 401);

        let post_req = || axum::http::Request::post("/api/things").body(Body::empty()).unwrap();
        let resp = app.clone().oneshot(post_req()).await.unwrap();
        assert_eq!(resp.status(), 200);
        assert_eq!(resp.headers()["x-ratelimit-remaining"], "0");
        let resp = app.clone().oneshot(post_req()).await.unwrap();
        assert_eq!(resp.status(), 429);
        assert_eq!(resp.headers()["retry-after"], "60");
    }
}
