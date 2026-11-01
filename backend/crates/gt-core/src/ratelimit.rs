//! In-memory fixed-window rate limiting with the semantics of Fiber's `limiter` middleware
//! (port of the limiters in `internal/middleware/middleware.go`).
//!
//! Each limiter instance has its own counters. A window starts on the first hit of a key and
//! lasts `window`; every hit (including rejected ones) counts. Allowed responses get
//! `X-RateLimit-Limit/Remaining/Reset`; rejected ones get `Retry-After` and a 429 JSON error.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::constants as c;
use crate::extract::{AuthUser, ClientIp};

/// Outcome of counting one request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Allowed { limit: u32, remaining: i64, reset_secs: u64 },
    Limited { retry_after_secs: u64 },
}

#[derive(Debug, Clone, Copy)]
struct Entry {
    hits: i64,
    /// Window end, unix seconds.
    exp: u64,
}

/// One rate limiter (Go: one `limiter.New(...)` instance).
#[derive(Debug)]
pub struct RateLimiter {
    name: &'static str,
    max: u32,
    window: Duration,
    message: &'static str,
    /// Key prefix for authenticated users (`user`, `upload`, ...); `None` keys by IP only.
    user_key_prefix: Option<&'static str>,
    state: Mutex<State>,
}

#[derive(Debug, Default)]
struct State {
    entries: HashMap<String, Entry>,
    last_sweep: u64,
}

const SWEEP_INTERVAL_SECS: u64 = 10;

fn unix_now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

impl RateLimiter {
    pub fn new(
        name: &'static str,
        max: u32,
        window: Duration,
        message: &'static str,
        user_key_prefix: Option<&'static str>,
    ) -> Self {
        Self { name, max, window, message, user_key_prefix, state: Mutex::new(State::default()) }
    }

    pub fn name(&self) -> &'static str {
        self.name
    }

    /// The 429 error message.
    pub fn message(&self) -> &'static str {
        self.message
    }

    /// Counter key: `<prefix>:<user_id>` for authenticated callers of user-keyed limiters,
    /// otherwise the client IP.
    pub fn key(&self, user: Option<&AuthUser>, ip: ClientIp) -> String {
        match (self.user_key_prefix, user) {
            (Some(prefix), Some(u)) if u.user_id > 0 => format!("{prefix}:{}", u.user_id),
            _ => ip.to_string(),
        }
    }

    /// Counts a request for `key`.
    pub fn hit(&self, key: &str) -> Decision {
        self.hit_at(key, unix_now())
    }

    fn hit_at(&self, key: &str, now: u64) -> Decision {
        let window = self.window.as_secs();
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if now.saturating_sub(state.last_sweep) >= SWEEP_INTERVAL_SECS {
            state.entries.retain(|_, e| e.exp > now);
            state.last_sweep = now;
        }
        let entry = state.entries.entry(key.to_string()).or_insert(Entry { hits: 0, exp: 0 });
        if entry.exp == 0 || now >= entry.exp {
            entry.hits = 0;
            entry.exp = now + window;
        }
        entry.hits += 1;
        let reset_secs = entry.exp - now;
        let remaining = i64::from(self.max) - entry.hits;
        if remaining < 0 {
            Decision::Limited { retry_after_secs: reset_secs }
        } else {
            Decision::Allowed { limit: self.max, remaining, reset_secs }
        }
    }
}

/// Every limiter used by the routes (Go creates each once in `Router.Setup`).
#[derive(Debug, Clone)]
pub struct RateLimiters {
    /// Login/register/change-password/resend-verification: 5/min per IP.
    pub auth: Arc<RateLimiter>,
    /// Password reset: 5 per 15 min per IP.
    pub password_reset: Arc<RateLimiter>,
    /// General API: 200/min per user.
    pub api: Arc<RateLimiter>,
    /// Uploads: 20/min per user.
    pub upload: Arc<RateLimiter>,
    /// Follow/unfollow: 120/min per user.
    pub follow: Arc<RateLimiter>,
    /// Autocomplete and search suggestions: 60/min per user.
    pub autocomplete: Arc<RateLimiter>,
    /// Comment create/reply/edit: 15/min per user.
    pub comment: Arc<RateLimiter>,
    /// Comment like/unlike: 60/min per user.
    pub comment_like: Arc<RateLimiter>,
    /// Challenge writes: 30/min per user.
    pub challenge_write: Arc<RateLimiter>,
}

impl RateLimiters {
    pub fn new() -> Self {
        let l = |name, max, window, message, prefix| Arc::new(RateLimiter::new(name, max, window, message, prefix));
        Self {
            auth: l("auth", c::RATE_LIMIT_AUTH_MAX_REQUESTS, c::RATE_LIMIT_AUTH_WINDOW, c::MSG_RATE_LIMIT_AUTH, None),
            password_reset: l(
                "password_reset",
                c::RATE_LIMIT_PASSWORD_MAX_REQUESTS,
                c::RATE_LIMIT_PASSWORD_WINDOW,
                c::MSG_RATE_LIMIT_PASSWORD,
                None,
            ),
            api: l(
                "api",
                c::RATE_LIMIT_API_MAX_REQUESTS,
                c::RATE_LIMIT_API_WINDOW,
                c::MSG_RATE_LIMIT_API,
                Some("user"),
            ),
            upload: l(
                "upload",
                c::RATE_LIMIT_UPLOAD_MAX_REQUESTS,
                c::RATE_LIMIT_UPLOAD_WINDOW,
                c::MSG_RATE_LIMIT_UPLOAD,
                Some("upload"),
            ),
            follow: l(
                "follow",
                c::RATE_LIMIT_FOLLOW_MAX_REQUESTS,
                c::RATE_LIMIT_FOLLOW_WINDOW,
                c::MSG_RATE_LIMIT_FOLLOW,
                Some("follow"),
            ),
            autocomplete: l(
                "autocomplete",
                c::RATE_LIMIT_AUTOCOMPLETE_MAX_REQUESTS,
                c::RATE_LIMIT_AUTOCOMPLETE_WINDOW,
                c::MSG_RATE_LIMIT_AUTOCOMPLETE,
                Some("autocomplete"),
            ),
            comment: l(
                "comment",
                c::RATE_LIMIT_COMMENT_MAX_REQUESTS,
                c::RATE_LIMIT_COMMENT_WINDOW,
                c::MSG_RATE_LIMIT_COMMENT,
                Some("comment"),
            ),
            comment_like: l(
                "comment_like",
                c::RATE_LIMIT_COMMENT_LIKE_MAX_REQUESTS,
                c::RATE_LIMIT_COMMENT_LIKE_WINDOW,
                c::MSG_RATE_LIMIT_COMMENT_LIKE,
                Some("comment_like"),
            ),
            challenge_write: l(
                "challenge_write",
                c::RATE_LIMIT_CHALLENGE_WRITE_MAX_REQUESTS,
                c::RATE_LIMIT_CHALLENGE_WRITE_WINDOW,
                c::MSG_RATE_LIMIT_CHALLENGE_WRITE,
                Some("challenge"),
            ),
        }
    }
}

impl Default for RateLimiters {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr};

    #[test]
    fn fixed_window_counts_and_resets() {
        let l = RateLimiter::new("t", 2, Duration::from_secs(60), "slow", Some("user"));
        assert_eq!(l.hit_at("k", 100), Decision::Allowed { limit: 2, remaining: 1, reset_secs: 60 });
        assert_eq!(l.hit_at("k", 110), Decision::Allowed { limit: 2, remaining: 0, reset_secs: 50 });
        assert_eq!(l.hit_at("k", 120), Decision::Limited { retry_after_secs: 40 });
        assert_eq!(l.hit_at("k", 160), Decision::Allowed { limit: 2, remaining: 1, reset_secs: 60 });
    }

    #[test]
    fn keys_by_user_or_ip() {
        let l = RateLimiter::new("t", 1, Duration::from_secs(1), "m", Some("upload"));
        let ip = ClientIp(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1)));
        let user = AuthUser { user_id: 9, username: "u".into() };
        assert_eq!(l.key(Some(&user), ip), "upload:9");
        assert_eq!(l.key(None, ip), "10.0.0.1");
        let by_ip = RateLimiter::new("t", 1, Duration::from_secs(1), "m", None);
        assert_eq!(by_ip.key(Some(&user), ip), "10.0.0.1");
    }
}
