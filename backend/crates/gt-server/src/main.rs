//! Growth Tracker API server (port of `backend/cmd/server/main.go`).
//!
//! Startup order matches the Go server: configuration, logging, database + schema, Redis,
//! feature wiring, stale challenge invite cleanup, push publisher, follow counter subscriber,
//! cron jobs, then the HTTP listener on `0.0.0.0:$PORT`. Unlike Go, SIGTERM/Ctrl-C triggers a
//! graceful shutdown that finishes in-flight requests and flushes logs and queued pushes.

use std::sync::Arc;

use anyhow::Context;
use chrono::NaiveTime;
use gt_core::config::Config;
use gt_core::{db, logging, redis, CoreContext};
use gt_jobs::ScheduledJob;
use gt_server::serve::{self, Timeouts};
use gt_server::{http, scheduler, swagger};

#[tokio::main]
async fn main() {
    if let Err(err) = run().await {
        tracing::error!(error = ?err, "Server stopped with an error");
        eprintln!("fatal: {err:#}");
        std::process::exit(1);
    }
}

async fn run() -> anyhow::Result<()> {
    let config = Config::load();
    let log = logging::init(&config);

    let pool = db::connect(&config.database).await.context("Database connection failed")?;
    tracing::info!("Database connection established");
    db::migrate(&pool).await.context("Database migration failed")?;
    tracing::info!("Database migrations completed");

    if !config.redis.url.is_empty() {
        match redis::init(&config.redis.url).await {
            Ok(()) => tracing::info!("Redis connection established"),
            Err(err) => {
                tracing::warn!("Redis initialization failed: {err}");
                tracing::warn!("Password reset and other Redis features are unavailable until Redis connects");
            }
        }
    }

    let core = CoreContext::new(config.clone(), pool);
    let features = Features::new(&core).await;

    // Invites still held by people who left a challenge back when leaving kept them block
    // re-inviting; remove them (a no-op once they are gone).
    if let Err(err) = features.challenges.challenge_service.delete_stale_invites().await {
        tracing::warn!("Stale challenge invite cleanup failed; it runs again on the next start: {err}");
    }

    if features.photos.profile_pictures_enabled() {
        tracing::info!("Azure Blob Storage initialized");
    } else {
        tracing::warn!("Profile picture upload is disabled");
    }
    if features.users.email_service.is_some() {
        tracing::info!("Email service initialized");
    } else {
        tracing::warn!("Email notifications are disabled");
    }

    if config.azure_service_bus.connection_string.is_empty() {
        tracing::warn!("Push notifications disabled (Service Bus not configured)");
    } else {
        match gt_notify::push::init_push_publisher(&config) {
            Ok(()) => tracing::info!("Push publisher initialized"),
            Err(err) => {
                tracing::warn!("Push publisher initialization failed: {err}");
                tracing::warn!("Web Push notifications are disabled");
            }
        }
    }

    if redis::is_available() {
        let _ = features.users.follow_service.start_follow_counter_subscriber();
        tracing::info!("Follow counter subscriber started");
    }

    schedule_cron_jobs(&features);

    let app = http::app_service(http::finalize(features.router(&core)));
    let (listener, _) = serve::bind(&config.server.port).await?;
    tracing::info!("Server starting on http://localhost:{}", config.server.port);

    let timeouts = Timeouts { read: config.server.read_timeout, write: config.server.write_timeout };
    serve::serve(listener, app, timeouts, shutdown_signal()).await;

    tracing::info!("Server stopped; flushing background work");
    gt_notify::push::close_push_publisher().await;
    redis::close();
    log.flush().await;
    Ok(())
}

/// Every feature crate, wired like the Go dependency container (`internal/container`).
struct Features {
    users: gt_users::UsersContext,
    notify: gt_notify::NotifyContext,
    activity: gt_activity::ActivityContext,
    photos: gt_photos::PhotosContext,
    comments: gt_comments::CommentsContext,
    challenges: gt_challenges::ChallengesContext,
    chat: gt_chat::ChatContext,
    jobs: Arc<gt_jobs::JobsContext>,
}

impl Features {
    async fn new(core: &CoreContext) -> Self {
        let users = gt_users::UsersContext::new(core);
        let notify = gt_notify::NotifyContext::new(core);
        let activity = gt_activity::ActivityContext::new(core, &users, &notify);
        let photos = gt_photos::PhotosContext::new(core, &users, &notify);
        // Go created the blob container while building the container.
        photos.init().await;
        let comments = gt_comments::CommentsContext::new(core, &users, &notify);
        let challenges = gt_challenges::ChallengesContext::new(core, &users, &notify);
        let chat = gt_chat::ChatContext::new(core, &notify);
        let jobs = Arc::new(gt_jobs::JobsContext::new(core, &users, &notify));
        Self { users, notify, activity, photos, comments, challenges, chat, jobs }
    }

    /// All routes (Go: `routes.Router.Setup`).
    fn router(&self, core: &CoreContext) -> axum::Router {
        http::health_routes()
            .merge(swagger::routes())
            .merge(gt_accounts::routes(core, &self.users, &self.notify))
            .merge(gt_activity::routes(core, &self.users, &self.notify, &self.activity))
            .merge(gt_notify::routes(core, &self.notify))
            .merge(gt_photos::routes(core, &self.users, &self.notify, &self.photos))
            .merge(gt_comments::routes(core, &self.users, &self.notify, &self.comments))
            .merge(gt_challenges::routes(core, &self.users, &self.notify, &self.challenges))
            .merge(gt_chat::routes(core, &self.chat))
    }
}

/// Daily jobs at the Go server's IST times (00:00 streaks, 00:05 challenges, 22:00 reminders,
/// 03:00 notification cleanup, 04:00 follow tombstone cleanup).
fn schedule_cron_jobs(features: &Features) {
    for job in ScheduledJob::ALL {
        let jobs = features.jobs.clone();
        scheduler::spawn_daily(job.name(), job.ist_time(), move || {
            let jobs = jobs.clone();
            Box::pin(async move { jobs.run(job).await })
        });
    }

    let challenges = features.challenges.challenge_service.clone();
    let at = NaiveTime::from_hms_opt(0, 5, 0).expect("valid time");
    scheduler::spawn_daily("challenge_daily", at, move || {
        let challenges = challenges.clone();
        Box::pin(async move {
            match challenges.run_daily_job().await {
                Ok(()) => tracing::info!("Challenge daily job completed successfully"),
                Err(err) => tracing::error!("Challenge daily job failed: {err}"),
            }
        })
    });

    tracing::info!("Cron jobs scheduled");
}

/// Resolves on Ctrl+C or SIGTERM (container shutdown).
async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut sig) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            sig.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
    tracing::info!("Shutdown signal received");
}
