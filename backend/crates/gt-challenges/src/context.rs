//! Wiring of the challenge feature (Go: the challenge parts of `internal/container`).

use std::sync::Arc;

use gt_core::CoreContext;
use gt_notify::NotifyContext;
use gt_users::UsersContext;

use crate::repository::ChallengeRepository;
use crate::service::ChallengeService;

/// The challenge repository and service. Cheap to clone; the server keeps
/// `challenge_service` to run the daily job and the stale invite cleanup.
#[derive(Debug, Clone)]
pub struct ChallengesContext {
    pub challenge_repo: Arc<ChallengeRepository>,
    pub challenge_service: Arc<ChallengeService>,
}

impl ChallengesContext {
    /// Builds the repository and service on the shared pool, with the cron job log (to claim
    /// the daily job) and the notification service.
    pub fn new(core: &CoreContext, users: &UsersContext, notify: &NotifyContext) -> Self {
        let challenge_repo = Arc::new(ChallengeRepository::new(core.pool.clone()));
        let challenge_service = Arc::new(ChallengeService::new(
            challenge_repo.clone(),
            Some(users.cron_job_log_repo.clone()),
            Some(notify.notification_service.clone()),
        ));
        Self { challenge_repo, challenge_service }
    }

    /// Replaces the service (e.g. one with a fixed clock in tests).
    pub fn with_service(mut self, challenge_service: Arc<ChallengeService>) -> Self {
        self.challenge_service = challenge_service;
        self
    }
}
