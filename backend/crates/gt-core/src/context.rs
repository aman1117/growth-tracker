//! Shared application context handed to every feature crate when it builds its services and
//! routes.

use std::sync::Arc;

use sqlx::PgPool;

use crate::config::Config;
use crate::guard::Guards;
use crate::jwt::TokenService;
use crate::ratelimit::RateLimiters;

/// Infrastructure every feature needs.
#[derive(Clone)]
pub struct CoreContext {
    pub config: Arc<Config>,
    pub pool: PgPool,
    pub tokens: Arc<TokenService>,
    pub guards: Guards,
}

impl CoreContext {
    pub fn new(config: Arc<Config>, pool: PgPool) -> Self {
        let tokens = Arc::new(TokenService::new(&config.jwt));
        let guards = Guards::new(tokens.clone(), Arc::new(RateLimiters::new()));
        Self { config, pool, tokens, guards }
    }
}
