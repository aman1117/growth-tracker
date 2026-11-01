//! Push notification worker (port of `cmd/pushworker`): consumes the Service Bus queue the API
//! server publishes to and delivers Web Push notifications.
//!
//! Configuration (environment, same as Go): `AZURE_SERVICEBUS_CONNECTION_STRING` (required),
//! `AZURE_SERVICEBUS_QUEUE_NAME` (default `push-notifications`), `VAPID_PUBLIC_KEY` and
//! `VAPID_PRIVATE_KEY` (required), `VAPID_SUBJECT`, `PUSH_SEND_RATE_LIMIT` (default 100/s),
//! `PUSH_MAX_CONCURRENT` (default 10), `PUSH_DEDUPE_WINDOW_SECONDS` (default 60), the database
//! settings (`DATABASE_URL` or `DB_*`) and `PORT` for the health server (`/healthz`, `/readyz`).

use std::sync::Arc;
use std::time::Duration;

use gt_core::config::Config;
use gt_core::logging::LogHandle;
use gt_notify::push::ServiceBusClient;
use gt_notify::repository::PushRepository;
use gt_notify::worker::{health_router, WebPushSender, Worker};
use tracing::Instrument;

const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(30);

#[tokio::main]
async fn main() {
    let cfg = Config::load();
    let logs = gt_core::logging::init(&cfg);
    let span = tracing::info_span!("pushworker", service = "pushworker");
    run(cfg, &logs).instrument(span).await;
    logs.flush().await;
}

/// Go `log.Fatal`: logs the error and exits with status 1.
async fn fatal(logs: &LogHandle, message: String) -> ! {
    tracing::error!("{message}");
    logs.flush().await;
    std::process::exit(1);
}

async fn run(cfg: Arc<Config>, logs: &LogHandle) {
    if cfg.azure_service_bus.connection_string.is_empty() {
        fatal(logs, "AZURE_SERVICEBUS_CONNECTION_STRING is required".into()).await;
    }
    if cfg.web_push.vapid_public_key.is_empty() || cfg.web_push.vapid_private_key.is_empty() {
        fatal(logs, "VAPID keys are required".into()).await;
    }

    let pool = match gt_core::db::connect(&cfg.database).await {
        Ok(pool) => pool,
        Err(err) => fatal(logs, format!("Database connection failed: {err}")).await,
    };
    tracing::info!("Database connection established");
    if let Err(err) = gt_core::db::migrate(&pool).await {
        fatal(logs, format!("Database migration failed: {err}")).await;
    }
    tracing::info!("Database migrations completed");

    let push_repo = Arc::new(PushRepository::new(pool.clone()));
    let bus = &cfg.azure_service_bus;
    let receiver = match ServiceBusClient::from_connection_string(&bus.connection_string, &bus.queue_name) {
        Ok(client) => Arc::new(client),
        Err(err) => fatal(logs, format!("Failed to create worker: failed to create Service Bus client: {err}")).await,
    };
    let sender = Arc::new(WebPushSender::new(&cfg.web_push));
    let worker = Arc::new(Worker::new(cfg.push_worker.clone(), push_repo, receiver, sender));

    // Like Go, 8001 is only used when PORT resolves to an empty string (the config default is 8000).
    let port = if cfg.server.port.is_empty() { "8001" } else { cfg.server.port.as_str() };
    let listener = match tokio::net::TcpListener::bind(format!("0.0.0.0:{port}")).await {
        Ok(listener) => listener,
        Err(err) => fatal(logs, format!("Health server failed: {err}")).await,
    };
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let app = health_router(worker.clone());
    let server = tokio::spawn(
        async move {
            let shutdown = async {
                let _ = shutdown_rx.await;
            };
            axum::serve(listener, app).with_graceful_shutdown(shutdown).await
        }
        .in_current_span(),
    );
    tracing::info!(port = %port, "Health server started");

    worker.start();
    shutdown_signal().await;
    tracing::info!("Shutdown signal received");

    worker.stop(SHUTDOWN_TIMEOUT).await;
    let _ = shutdown_tx.send(());
    match server.await {
        Ok(Ok(())) => {}
        Ok(Err(err)) => tracing::warn!(error = %err, "Error shutting down health server"),
        Err(err) => tracing::warn!(error = %err, "Error shutting down health server"),
    }
    pool.close().await;
    tracing::info!("Push worker shutdown complete");
}

/// SIGINT (Ctrl+C) or, on Unix, SIGTERM.
async fn shutdown_signal() {
    let ctrl_c = async {
        if let Err(err) = tokio::signal::ctrl_c().await {
            tracing::warn!(error = %err, "Failed to listen for Ctrl+C");
            std::future::pending::<()>().await;
        }
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(err) => {
                tracing::warn!(error = %err, "Failed to listen for SIGTERM");
                std::future::pending::<()>().await;
            }
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {}
        _ = terminate => {}
    }
}
