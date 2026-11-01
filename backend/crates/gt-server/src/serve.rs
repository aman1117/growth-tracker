//! The HTTP listener. `axum::serve` has no timeouts, so this accept loop applies the Go
//! server's `SERVER_READ_TIMEOUT` / `SERVER_WRITE_TIMEOUT` (Fiber `ReadTimeout` /
//! `WriteTimeout`) and shuts down gracefully:
//!
//! * a client must send the complete request head within the read timeout (slow-loris
//!   protection); idle keep-alive connections are closed after the same time;
//! * a single socket write that makes no progress for the write timeout closes the connection
//!   (a stalled client), which never affects healthy WebSocket connections;
//! * every request carries `ConnectInfo<SocketAddr>` for the client IP extractor;
//! * on shutdown the listener stops accepting, in-flight requests finish (up to
//!   [`SHUTDOWN_GRACE`]) and upgraded WebSocket connections are closed.

use std::future::Future;
use std::net::SocketAddr;
use std::pin::pin;
use std::time::Duration;

use axum::extract::ConnectInfo;
use hyper::body::Incoming;
use hyper_util::rt::{TokioExecutor, TokioIo, TokioTimer};
use hyper_util::server::conn::auto::Builder;
use hyper_util::server::graceful::GracefulShutdown;
use hyper_util::service::TowerToHyperService;
use tokio::net::TcpListener;
use tokio_io_timeout::TimeoutStream;
use tower::ServiceExt;

use crate::http::AppService;

/// How long shutdown waits for in-flight requests before giving up on them.
pub const SHUTDOWN_GRACE: Duration = Duration::from_secs(10);

/// Connection timeouts (a zero duration disables the timeout, like Fiber).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Timeouts {
    pub read: Duration,
    pub write: Duration,
}

impl Timeouts {
    fn read(self) -> Option<Duration> {
        (!self.read.is_zero()).then_some(self.read)
    }

    fn write(self) -> Option<Duration> {
        (!self.write.is_zero()).then_some(self.write)
    }
}

/// Serves `app` on `listener` until `shutdown` resolves, then drains connections.
pub async fn serve(
    listener: TcpListener,
    app: AppService,
    timeouts: Timeouts,
    shutdown: impl Future<Output = ()> + Send,
) {
    let mut builder = Builder::new(TokioExecutor::new());
    builder.http1().timer(TokioTimer::new()).header_read_timeout(timeouts.read()).keep_alive(true);
    builder.http2().timer(TokioTimer::new()).enable_connect_protocol();

    let graceful = GracefulShutdown::new();
    let mut shutdown = pin!(shutdown);
    loop {
        let (stream, remote) = tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok(conn) => conn,
                Err(err) => {
                    if !is_connection_error(&err) {
                        // e.g. too many open files: back off instead of spinning
                        tracing::error!(error = %err, "Failed to accept connection; retrying in 1s");
                        tokio::time::sleep(Duration::from_secs(1)).await;
                    }
                    continue;
                }
            },
            () = &mut shutdown => break,
        };
        let _ = stream.set_nodelay(true);
        let mut io = TimeoutStream::new(stream);
        io.set_write_timeout(timeouts.write());

        let service = app.clone().map_request(move |req: hyper::Request<Incoming>| {
            let mut req = req.map(axum::body::Body::new);
            req.extensions_mut().insert(ConnectInfo(remote));
            req
        });
        let conn = builder
            .serve_connection_with_upgrades(TokioIo::new(Box::pin(io)), TowerToHyperService::new(service))
            .into_owned();
        let conn = graceful.watch(conn);
        tokio::spawn(async move {
            if let Err(err) = conn.await {
                tracing::debug!(error = %err, remote = %remote, "Connection closed with an error");
            }
        });
    }

    drop(listener);
    tokio::select! {
        () = graceful.shutdown() => tracing::info!("All connections closed"),
        () = tokio::time::sleep(SHUTDOWN_GRACE) => {
            tracing::warn!("Shutdown grace period of {}s elapsed; closing remaining connections", SHUTDOWN_GRACE.as_secs());
        }
    }
}

/// Accept errors caused by a single client (the next accept is unaffected).
fn is_connection_error(err: &std::io::Error) -> bool {
    matches!(
        err.kind(),
        std::io::ErrorKind::ConnectionRefused
            | std::io::ErrorKind::ConnectionAborted
            | std::io::ErrorKind::ConnectionReset
    )
}

/// Binds `0.0.0.0:<port>`.
pub async fn bind(port: &str) -> anyhow::Result<(TcpListener, SocketAddr)> {
    use anyhow::Context;
    let addr: SocketAddr = format!("0.0.0.0:{port}").parse().with_context(|| format!("invalid PORT {port:?}"))?;
    let listener = TcpListener::bind(addr).await.with_context(|| format!("Failed to bind {addr}"))?;
    Ok((listener, addr))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::routing::get;
    use axum::Router;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    async fn start(timeouts: Timeouts) -> (SocketAddr, tokio::sync::oneshot::Sender<()>, tokio::task::JoinHandle<()>) {
        let router = Router::new()
            .route("/", get(|ConnectInfo(addr): ConnectInfo<SocketAddr>| async move { addr.ip().to_string() }))
            .route(
                "/slow",
                get(|| async {
                    tokio::time::sleep(Duration::from_millis(300)).await;
                    "done"
                }),
            );
        let app = crate::http::app_service(crate::http::finalize(router));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let handle = tokio::spawn(serve(listener, app, timeouts, async {
            let _ = rx.await;
        }));
        (addr, tx, handle)
    }

    async fn get_raw(addr: SocketAddr, path: &str) -> String {
        let mut s = TcpStream::connect(addr).await.unwrap();
        s.write_all(format!("GET {path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).await.unwrap();
        out
    }

    #[tokio::test]
    async fn serves_requests_with_client_address() {
        let (addr, tx, handle) = start(Timeouts { read: Duration::from_secs(5), write: Duration::from_secs(5) }).await;
        let resp = get_raw(addr, "/").await;
        assert!(resp.starts_with("HTTP/1.1 200"), "{resp}");
        assert!(resp.ends_with("127.0.0.1"), "{resp}");
        tx.send(()).unwrap();
        handle.await.unwrap();
    }

    #[tokio::test]
    async fn closes_connections_that_never_send_a_request_head() {
        let (addr, tx, handle) =
            start(Timeouts { read: Duration::from_millis(200), write: Duration::from_secs(5) }).await;
        let mut s = TcpStream::connect(addr).await.unwrap();
        s.write_all(b"GET / HTTP/1.1\r\nHost:").await.unwrap();
        let mut buf = Vec::new();
        let read = tokio::time::timeout(Duration::from_secs(5), s.read_to_end(&mut buf)).await;
        assert!(read.is_ok(), "server must close the stalled connection");
        tx.send(()).unwrap();
        handle.await.unwrap();
    }

    #[tokio::test]
    async fn closes_idle_keep_alive_connections() {
        let (addr, tx, handle) =
            start(Timeouts { read: Duration::from_millis(300), write: Duration::from_secs(5) }).await;
        let mut s = TcpStream::connect(addr).await.unwrap();
        s.write_all(b"GET / HTTP/1.1\r\nHost: x\r\n\r\n").await.unwrap();
        let mut buf = [0u8; 1024];
        let n = s.read(&mut buf).await.unwrap();
        assert!(String::from_utf8_lossy(&buf[..n]).starts_with("HTTP/1.1 200"));
        // stay idle: the server closes the connection after the read timeout
        let closed = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                match s.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => continue,
                }
            }
        })
        .await;
        assert!(closed.is_ok(), "idle keep-alive connection must be closed");
        tx.send(()).unwrap();
        handle.await.unwrap();
    }

    #[tokio::test]
    async fn graceful_shutdown_finishes_in_flight_requests() {
        let (addr, tx, handle) = start(Timeouts { read: Duration::from_secs(5), write: Duration::from_secs(5) }).await;
        let request = tokio::spawn(get_raw(addr, "/slow"));
        tokio::time::sleep(Duration::from_millis(100)).await;
        tx.send(()).unwrap();
        let resp = request.await.unwrap();
        assert!(resp.starts_with("HTTP/1.1 200") && resp.ends_with("done"), "{resp}");
        handle.await.unwrap();
        assert!(TcpStream::connect(addr).await.is_err(), "listener is closed after shutdown");
    }
}
