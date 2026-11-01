//! Request logging middleware (port of `middleware.RequestLogger`): assigns an 8-character
//! `trace_id`, runs the request inside a span carrying it, and logs method, path, status,
//! duration and the authenticated user (error level for 5xx, warn for 4xx, info otherwise).

use std::convert::Infallible;
use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Instant;

use axum::extract::Request;
use axum::http::header::USER_AGENT;
use axum::response::Response;
use tower::{Layer, Service};
use tracing::Instrument;

use crate::constants as c;
use crate::extract::{AuthUser, ClientIp, TraceId};

#[derive(Clone, Copy, Debug, Default)]
pub struct RequestLogLayer;

impl<S> Layer<S> for RequestLogLayer {
    type Service = RequestLog<S>;

    fn layer(&self, inner: S) -> Self::Service {
        RequestLog { inner }
    }
}

#[derive(Clone)]
pub struct RequestLog<S> {
    inner: S,
}

/// A new trace id: the first 8 characters of a random UUID.
pub fn new_trace_id() -> String {
    uuid::Uuid::new_v4().to_string()[..c::TRACE_ID_LENGTH].to_string()
}

impl<S> Service<Request> for RequestLog<S>
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

        Box::pin(async move {
            let start = Instant::now();
            let trace_id = new_trace_id();
            req.extensions_mut().insert(TraceId(trace_id.clone()));
            let method = req.method().clone();
            let path = req.uri().path().to_string();
            let user_agent = req.headers().get(USER_AGENT).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
            let (parts, body) = req.into_parts();
            let ip = ClientIp::from_parts(&parts);
            let req = Request::from_parts(parts, body);

            let span = tracing::info_span!("request", trace_id = %trace_id);
            let resp = inner.call(req).instrument(span).await?;

            let status = resp.status().as_u16();
            let duration = start.elapsed().as_secs_f64();
            let user_id = resp.extensions().get::<AuthUser>().map(|u| u.user_id).unwrap_or(0);

            if status >= 500 {
                tracing::error!(
                    trace_id = %trace_id, method = %method, path = %path, status, duration,
                    user_id, ip = %ip, user_agent = %user_agent, "HTTP Request"
                );
            } else if status >= 400 {
                tracing::warn!(
                    trace_id = %trace_id, method = %method, path = %path, status, duration,
                    user_id, ip = %ip, "HTTP Request"
                );
            } else {
                tracing::info!(
                    trace_id = %trace_id, method = %method, path = %path, status, duration,
                    user_id, "HTTP Request"
                );
            }
            Ok(resp)
        })
    }
}
