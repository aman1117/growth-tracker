//! `FollowService` (port of `internal/services/follow.go`): follow/unfollow, requests, lists,
//! relationship lookups (cached in Redis), counts (cached in Redis) and reconciliation. The
//! Redis follow-event pipeline lives in `follow_events.rs`.

use std::collections::HashMap;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use gt_core::config::FollowConfig;
use gt_core::constants as c;
use gt_core::models::{
    FollowEdgeByFollowee, FollowEdgeByFollower, FOLLOW_STATE_ACTIVE, FOLLOW_STATE_PENDING, FOLLOW_STATE_REMOVED,
    RELATIONSHIP_NONE,
};
use gt_core::redis as gt_redis;
use redis::AsyncCommands;

use crate::repository::{FollowListCursor, FollowRepository, UserRepository};

/// Follow errors. `Display` reproduces the Go error strings exactly (handlers matched on the
/// embedded code and returned the limit messages verbatim); use [`FollowError::code`] to branch.
#[derive(Debug, thiserror::Error)]
pub enum FollowError {
    #[error("CANNOT_FOLLOW_SELF: cannot follow yourself")]
    CannotFollowSelf,
    /// `follow` target does not exist.
    #[error("USER_NOT_FOUND: target user not found")]
    TargetUserNotFound,
    /// Follow list owner does not exist.
    #[error("USER_NOT_FOUND: user not found")]
    UserNotFound,
    /// `unfollow` without an ACTIVE or PENDING edge.
    #[error("NOT_FOLLOWING: not following this user")]
    NotFollowing,
    /// `remove_follower` for someone who does not follow the viewer.
    #[error("NOT_FOLLOWING: user is not following you")]
    NotAFollower,
    #[error("NO_FOLLOW_REQUEST: no pending request found")]
    NoFollowRequest,
    /// Follow lists of a private account the viewer does not follow.
    #[error("ACCOUNT_PRIVATE: this account is private")]
    AccountPrivate,
    #[error("FOLLOW_LIMIT_EXCEEDED: you have reached the maximum following limit of {0}")]
    FollowLimitExceeded(i64),
    #[error("DAILY_LIMIT_EXCEEDED: you have reached the daily follow limit of {0}")]
    DailyLimitExceeded(i64),
    /// A database failure, with the step that failed (e.g. `failed to create follow`).
    #[error("{context}: {source}")]
    Database {
        context: &'static str,
        #[source]
        source: sqlx::Error,
    },
}

impl FollowError {
    /// The API error code embedded in the message, if any (`None` for database failures).
    pub fn code(&self) -> Option<&'static str> {
        Some(match self {
            FollowError::CannotFollowSelf => c::ERR_CODE_CANNOT_FOLLOW_SELF,
            FollowError::TargetUserNotFound | FollowError::UserNotFound => c::ERR_CODE_USER_NOT_FOUND,
            FollowError::NotFollowing | FollowError::NotAFollower => c::ERR_CODE_NOT_FOLLOWING,
            FollowError::NoFollowRequest => c::ERR_CODE_NO_FOLLOW_REQUEST,
            FollowError::AccountPrivate => c::ERR_CODE_ACCOUNT_PRIVATE,
            FollowError::FollowLimitExceeded(_) => c::ERR_CODE_FOLLOW_LIMIT_EXCEEDED,
            FollowError::DailyLimitExceeded(_) => c::ERR_CODE_DAILY_LIMIT_EXCEEDED,
            FollowError::Database { .. } => return None,
        })
    }

    fn db(context: &'static str) -> impl FnOnce(sqlx::Error) -> FollowError {
        move |source| FollowError::Database { context, source }
    }
}

/// Outcome of [`FollowService::follow`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FollowResult {
    /// `ACTIVE` or `PENDING`.
    pub state: &'static str,
    pub message: &'static str,
}

/// A mutual follower with the time the viewer followed them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MutualEdge {
    pub user_id: i64,
    pub created_at: DateTime<Utc>,
}

/// Follow relationships, requests, lists and counters.
#[derive(Debug)]
pub struct FollowService {
    pub(super) repo: Arc<FollowRepository>,
    pub(super) user_repo: Arc<UserRepository>,
    pub(super) cfg: FollowConfig,
    /// Redis Pub/Sub channel for follow events (always `follow_events` outside tests).
    pub(super) event_channel: String,
}

/// `follow_rel:<viewer>:<target>` (cached relationship state).
pub(super) fn relationship_cache_key(viewer_id: i64, target_id: i64) -> String {
    format!("{}{viewer_id}:{target_id}", c::FOLLOW_REL_CACHE_PREFIX)
}

/// `follow_cnt:<user>` (hash with `followers` / `following`).
pub(super) fn count_cache_key(user_id: i64) -> String {
    format!("{}{user_id}", c::FOLLOW_COUNT_CACHE_PREFIX)
}

/// Go `fmt.Sscanf(value, "%d", &n)`: optional leading spaces and sign, then digits; 0 when it
/// does not parse.
fn scan_count(value: &str) -> i64 {
    let s = value.trim_start();
    let (sign, digits) = match s.strip_prefix('-') {
        Some(rest) => (-1, rest),
        None => (1, s.strip_prefix('+').unwrap_or(s)),
    };
    let end = digits.find(|ch: char| !ch.is_ascii_digit()).unwrap_or(digits.len());
    digits[..end].parse::<i64>().map(|n| sign * n).unwrap_or(0)
}

/// Go clamps follow list limits to the default when out of `1..=100`.
fn clamp_list_limit(limit: i64) -> i64 {
    if limit <= 0 || limit > c::FOLLOW_LIST_MAX_LIMIT {
        c::FOLLOW_LIST_DEFAULT_LIMIT
    } else {
        limit
    }
}

/// Fetching `limit + 1` rows tells whether there is another page.
fn split_page<T>(mut rows: Vec<T>, limit: i64) -> (Vec<T>, bool) {
    let limit = usize::try_from(limit).unwrap_or(0);
    let has_more = rows.len() > limit;
    rows.truncate(limit);
    (rows, has_more)
}

impl FollowService {
    /// Go `NewFollowService`: limits come from `cfg`; events use the `follow_events` channel.
    pub fn new(repo: Arc<FollowRepository>, user_repo: Arc<UserRepository>, cfg: FollowConfig) -> Self {
        Self { repo, user_repo, cfg, event_channel: c::FOLLOW_EVENT_CHANNEL.to_string() }
    }

    /// Uses another Pub/Sub channel for follow events (tests sharing a Redis server).
    #[doc(hidden)]
    pub fn with_event_channel(mut self, channel: impl Into<String>) -> Self {
        self.event_channel = channel.into();
        self
    }

    // ==================== Core operations ====================

    /// Follows `followee_id`: ACTIVE for public accounts, a PENDING request for private ones.
    /// Already following / already requested are successes with their own message. Enforces the
    /// total-following and daily follow limits.
    pub async fn follow(&self, follower_id: i64, followee_id: i64) -> Result<FollowResult, FollowError> {
        if follower_id == followee_id {
            return Err(FollowError::CannotFollowSelf);
        }
        let target = self
            .user_repo
            .find_by_id(followee_id)
            .await
            .map_err(FollowError::db("failed to fetch target user"))?
            .ok_or(FollowError::TargetUserNotFound)?;

        let existing = self
            .repo
            .get_edge(follower_id, followee_id)
            .await
            .map_err(FollowError::db("failed to check existing relationship"))?;
        let mut previous_state = None;
        if let Some(edge) = &existing {
            match edge.state.as_str() {
                FOLLOW_STATE_ACTIVE => {
                    return Ok(FollowResult { state: FOLLOW_STATE_ACTIVE, message: "Already following" });
                }
                FOLLOW_STATE_PENDING => {
                    return Ok(FollowResult { state: FOLLOW_STATE_PENDING, message: "Follow request already pending" });
                }
                FOLLOW_STATE_REMOVED => previous_state = Some(FOLLOW_STATE_REMOVED),
                _ => {}
            }
        }

        self.check_follow_limits(follower_id).await?;

        let state = if target.is_private { FOLLOW_STATE_PENDING } else { FOLLOW_STATE_ACTIVE };
        self.repo
            .create_follow_with_counters(follower_id, followee_id, state, previous_state)
            .await
            .map_err(FollowError::db("failed to create follow"))?;
        self.invalidate_relationship_cache(follower_id, followee_id).await;

        tracing::info!(follower_id, followee_id, state, "Follow action completed");
        let message = if state == FOLLOW_STATE_PENDING { "Follow request sent" } else { "Now following" };
        Ok(FollowResult { state, message })
    }

    /// Unfollows (or withdraws a pending request to) `followee_id`.
    pub async fn unfollow(&self, follower_id: i64, followee_id: i64) -> Result<(), FollowError> {
        let edge = self
            .repo
            .get_edge(follower_id, followee_id)
            .await
            .map_err(FollowError::db("failed to check existing relationship"))?;
        let previous_state = match edge {
            Some(edge) if edge.state != FOLLOW_STATE_REMOVED => edge.state,
            _ => return Err(FollowError::NotFollowing),
        };
        self.repo
            .remove_follow_with_counters(follower_id, followee_id, &previous_state)
            .await
            .map_err(FollowError::db("failed to unfollow"))?;
        self.invalidate_relationship_cache(follower_id, followee_id).await;
        tracing::info!(follower_id, followee_id, "Unfollow completed");
        Ok(())
    }

    /// Cancels the viewer's pending request to `target_id`.
    pub async fn cancel_request(&self, follower_id: i64, target_id: i64) -> Result<(), FollowError> {
        self.require_pending(follower_id, target_id).await?;
        self.repo
            .remove_follow_with_counters(follower_id, target_id, FOLLOW_STATE_PENDING)
            .await
            .map_err(FollowError::db("failed to cancel request"))?;
        self.invalidate_relationship_cache(follower_id, target_id).await;
        tracing::info!(follower_id, target_id, "Follow request cancelled");
        Ok(())
    }

    // ==================== Request management ====================

    async fn require_pending(&self, follower_id: i64, followee_id: i64) -> Result<(), FollowError> {
        self.repo
            .get_pending_edge(follower_id, followee_id)
            .await
            .map_err(FollowError::db("failed to check pending request"))?
            .map(|_| ())
            .ok_or(FollowError::NoFollowRequest)
    }

    /// Accepts `requester_id`'s pending request to the viewer.
    pub async fn accept_request(&self, viewer_id: i64, requester_id: i64) -> Result<(), FollowError> {
        self.require_pending(requester_id, viewer_id).await?;
        self.repo
            .accept_follow_with_counters(requester_id, viewer_id)
            .await
            .map_err(FollowError::db("failed to accept request"))?;
        self.invalidate_relationship_cache(requester_id, viewer_id).await;
        tracing::info!(viewer_id, requester_id, "Follow request accepted");
        Ok(())
    }

    /// Declines `requester_id`'s pending request to the viewer.
    pub async fn decline_request(&self, viewer_id: i64, requester_id: i64) -> Result<(), FollowError> {
        self.require_pending(requester_id, viewer_id).await?;
        self.repo
            .remove_follow_with_counters(requester_id, viewer_id, FOLLOW_STATE_PENDING)
            .await
            .map_err(FollowError::db("failed to decline request"))?;
        self.invalidate_relationship_cache(requester_id, viewer_id).await;
        tracing::info!(viewer_id, requester_id, "Follow request declined");
        Ok(())
    }

    /// Removes `follower_id` from the viewer's followers.
    pub async fn remove_follower(&self, viewer_id: i64, follower_id: i64) -> Result<(), FollowError> {
        self.repo
            .get_active_edge(follower_id, viewer_id)
            .await
            .map_err(FollowError::db("failed to check follow status"))?
            .ok_or(FollowError::NotAFollower)?;
        self.repo
            .remove_follow_with_counters(follower_id, viewer_id, FOLLOW_STATE_ACTIVE)
            .await
            .map_err(FollowError::db("failed to remove follower"))?;
        self.invalidate_relationship_cache(follower_id, viewer_id).await;
        tracing::info!(viewer_id, follower_id, "Follower removed");
        Ok(())
    }

    // ==================== Lists ====================

    /// A page of `target_user_id`'s followers (newest first) and whether more follow. Private
    /// accounts' lists need an accepted follow; `limit` outside `1..=100` becomes 20.
    pub async fn get_followers(
        &self,
        viewer_id: i64,
        target_user_id: i64,
        limit: i64,
        cursor: Option<&FollowListCursor>,
    ) -> Result<(Vec<FollowEdgeByFollowee>, bool), FollowError> {
        self.check_list_access(viewer_id, target_user_id).await?;
        let limit = clamp_list_limit(limit);
        let rows = self
            .repo
            .get_followers_paginated(target_user_id, limit + 1, cursor)
            .await
            .map_err(FollowError::db("failed to get followers"))?;
        Ok(split_page(rows, limit))
    }

    /// A page of the users `target_user_id` follows (same rules as [`FollowService::get_followers`]).
    pub async fn get_following(
        &self,
        viewer_id: i64,
        target_user_id: i64,
        limit: i64,
        cursor: Option<&FollowListCursor>,
    ) -> Result<(Vec<FollowEdgeByFollower>, bool), FollowError> {
        self.check_list_access(viewer_id, target_user_id).await?;
        let limit = clamp_list_limit(limit);
        let rows = self
            .repo
            .get_following_paginated(target_user_id, limit + 1, cursor)
            .await
            .map_err(FollowError::db("failed to get following"))?;
        Ok(split_page(rows, limit))
    }

    /// A page of pending requests to the viewer, newest first.
    pub async fn get_pending_incoming_requests(
        &self,
        viewer_id: i64,
        limit: i64,
        cursor: Option<&FollowListCursor>,
    ) -> Result<(Vec<FollowEdgeByFollowee>, bool), FollowError> {
        let limit = clamp_list_limit(limit);
        let rows = self
            .repo
            .get_pending_incoming_requests(viewer_id, limit + 1, cursor)
            .await
            .map_err(FollowError::db("failed to get pending requests"))?;
        Ok(split_page(rows, limit))
    }

    // ==================== Relationships ====================

    /// The viewer's relationship to each target (`FOLLOWING`, `REQUESTED`, `INCOMING_PENDING`,
    /// `NONE`), served from the `follow_rel:` Redis cache when possible and cached for 5 minutes
    /// otherwise. Redis failures fall back to the database. (Go's `map[uint]...` marshals with
    /// keys sorted as strings; sort accordingly when serializing.)
    pub async fn lookup_relationships(
        &self,
        viewer_id: i64,
        target_ids: &[i64],
    ) -> Result<HashMap<i64, String>, FollowError> {
        let mut result = HashMap::new();
        let mut uncached = Vec::new();
        if let Some(mut conn) = gt_redis::conn() {
            for &target_id in target_ids {
                let cached: Result<Option<String>, _> = conn.get(relationship_cache_key(viewer_id, target_id)).await;
                match cached {
                    Ok(Some(state)) => {
                        result.insert(target_id, state);
                    }
                    _ => uncached.push(target_id),
                }
            }
        } else {
            uncached.extend_from_slice(target_ids);
        }

        if !uncached.is_empty() {
            let from_db = self
                .repo
                .batch_lookup_relationships(viewer_id, &uncached)
                .await
                .map_err(FollowError::db("failed to lookup relationships"))?;
            for (target_id, state) in from_db {
                if let Some(mut conn) = gt_redis::conn() {
                    let _: Result<(), _> = redis::cmd("SET")
                        .arg(relationship_cache_key(viewer_id, target_id))
                        .arg(&state)
                        .arg("EX")
                        .arg(c::FOLLOW_REL_CACHE_TTL.as_secs())
                        .query_async(&mut conn)
                        .await;
                }
                result.insert(target_id, state);
            }
        }
        Ok(result)
    }

    /// The viewer's relationship to one target (`NONE` when unknown). On error Go returned
    /// `NONE` together with the error; callers that ignore errors should use `NONE`.
    pub async fn get_relationship_state(&self, viewer_id: i64, target_id: i64) -> Result<String, FollowError> {
        let mut relationships = self.lookup_relationships(viewer_id, &[target_id]).await?;
        Ok(relationships.remove(&target_id).unwrap_or_else(|| RELATIONSHIP_NONE.to_string()))
    }

    // ==================== Mutuals ====================

    /// Ids of users the viewer follows who also follow `target_user_id` (allowed for private
    /// targets: it only shows the viewer's own friends), newest follow first.
    pub async fn get_mutuals(
        &self,
        viewer_id: i64,
        target_user_id: i64,
        limit: i64,
        cursor: Option<&FollowListCursor>,
    ) -> Result<(Vec<i64>, bool), FollowError> {
        let limit = clamp_list_limit(limit);
        let ids = self
            .repo
            .get_mutual_follower_ids(viewer_id, target_user_id, limit + 1, cursor)
            .await
            .map_err(FollowError::db("failed to get mutuals"))?;
        Ok(split_page(ids, limit))
    }

    /// Like [`FollowService::get_mutuals`] with the follow time of each mutual, for cursors.
    pub async fn get_mutuals_with_timestamps(
        &self,
        viewer_id: i64,
        target_user_id: i64,
        limit: i64,
        cursor: Option<&FollowListCursor>,
    ) -> Result<(Vec<MutualEdge>, bool), FollowError> {
        let limit = clamp_list_limit(limit);
        let rows = self
            .repo
            .get_mutual_followers_with_timestamps(viewer_id, target_user_id, limit + 1, cursor)
            .await
            .map_err(FollowError::db("failed to get mutuals"))?;
        let (rows, has_more) = split_page(rows, limit);
        let edges = rows.into_iter().map(|r| MutualEdge { user_id: r.user_id, created_at: r.created_at }).collect();
        Ok((edges, has_more))
    }

    // ==================== Counts ====================

    /// `(followers, following)`, from the `follow_cnt:` Redis hash when present, otherwise from
    /// `follow_counters` (then cached for 5 minutes). Missing hash fields read as 0.
    pub async fn get_follow_counts(&self, user_id: i64) -> Result<(i64, i64), sqlx::Error> {
        let key = count_cache_key(user_id);
        if let Some(mut conn) = gt_redis::conn() {
            let cached: Result<HashMap<String, String>, _> = conn.hgetall(&key).await;
            if let Ok(cached) = cached {
                if !cached.is_empty() {
                    let field = |name: &str| cached.get(name).map(|v| scan_count(v)).unwrap_or(0);
                    return Ok((field("followers"), field("following")));
                }
            }
        }

        let (followers, following) = self.repo.get_follow_counts(user_id).await?;

        if let Some(mut conn) = gt_redis::conn() {
            let _: Result<(), _> = redis::cmd("HSET")
                .arg(&key)
                .arg("followers")
                .arg(followers)
                .arg("following")
                .arg(following)
                .query_async(&mut conn)
                .await;
            let _: Result<(), _> = conn.expire(&key, c::FOLLOW_COUNT_CACHE_TTL.as_secs() as i64).await;
        }
        Ok((followers, following))
    }

    /// Number of pending requests to the user (from the edges); 0 on error.
    pub async fn get_pending_requests_count(&self, user_id: i64) -> i64 {
        self.repo.count_pending_requests_for(user_id).await.unwrap_or(0)
    }

    /// Recomputes the user's counters from the edges and drops the cached counts.
    pub async fn reconcile_counters(&self, user_id: i64) -> Result<(), FollowError> {
        self.repo.reconcile_counters(user_id).await.map_err(FollowError::db("failed to reconcile counters"))?;
        if let Some(mut conn) = gt_redis::conn() {
            let _: Result<(), _> = conn.del(count_cache_key(user_id)).await;
        }
        tracing::info!(user_id, "Counters reconciled");
        Ok(())
    }

    // ==================== Helpers ====================

    async fn check_follow_limits(&self, follower_id: i64) -> Result<(), FollowError> {
        let total =
            self.repo.count_following(follower_id).await.map_err(FollowError::db("failed to count following"))?;
        if total >= self.cfg.max_total_following {
            return Err(FollowError::FollowLimitExceeded(self.cfg.max_total_following));
        }
        let today = self
            .repo
            .count_daily_follows(follower_id)
            .await
            .map_err(FollowError::db("failed to count daily follows"))?;
        if today >= self.cfg.max_follows_per_day {
            return Err(FollowError::DailyLimitExceeded(self.cfg.max_follows_per_day));
        }
        Ok(())
    }

    /// Own lists and public accounts are visible to everyone; private accounts only to accepted
    /// followers.
    async fn check_list_access(&self, viewer_id: i64, target_user_id: i64) -> Result<(), FollowError> {
        if viewer_id == target_user_id {
            return Ok(());
        }
        let target = self
            .user_repo
            .find_by_id(target_user_id)
            .await
            .map_err(FollowError::db("failed to fetch target user"))?
            .ok_or(FollowError::UserNotFound)?;
        if !target.is_private {
            return Ok(());
        }
        self.repo
            .get_active_edge(viewer_id, target_user_id)
            .await
            .map_err(FollowError::db("failed to check follow status"))?
            .map(|_| ())
            .ok_or(FollowError::AccountPrivate)
    }

    /// Drops the cached relationship and both users' cached counts.
    pub(super) async fn invalidate_relationship_cache(&self, follower_id: i64, followee_id: i64) {
        let Some(mut conn) = gt_redis::conn() else { return };
        let _: Result<(), _> = conn.del(relationship_cache_key(follower_id, followee_id)).await;
        let _: Result<(), _> = conn.del(&[count_cache_key(follower_id), count_cache_key(followee_id)]).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_messages_match_go() {
        let cases: [(FollowError, &str); 9] = [
            (FollowError::CannotFollowSelf, "CANNOT_FOLLOW_SELF: cannot follow yourself"),
            (FollowError::TargetUserNotFound, "USER_NOT_FOUND: target user not found"),
            (FollowError::UserNotFound, "USER_NOT_FOUND: user not found"),
            (FollowError::NotFollowing, "NOT_FOLLOWING: not following this user"),
            (FollowError::NotAFollower, "NOT_FOLLOWING: user is not following you"),
            (FollowError::NoFollowRequest, "NO_FOLLOW_REQUEST: no pending request found"),
            (FollowError::AccountPrivate, "ACCOUNT_PRIVATE: this account is private"),
            (
                FollowError::FollowLimitExceeded(7500),
                "FOLLOW_LIMIT_EXCEEDED: you have reached the maximum following limit of 7500",
            ),
            (FollowError::DailyLimitExceeded(1), "DAILY_LIMIT_EXCEEDED: you have reached the daily follow limit of 1"),
        ];
        for (err, message) in cases {
            assert_eq!(err.to_string(), message);
            let code = err.code().unwrap();
            assert!(message.starts_with(&format!("{code}: ")), "{message}");
        }
        let db = FollowError::Database { context: "failed to unfollow", source: sqlx::Error::RowNotFound };
        assert!(db.to_string().starts_with("failed to unfollow: "));
        assert_eq!(db.code(), None);
    }

    #[test]
    fn list_limits_and_pages() {
        for (limit, want) in [(-1, 20), (0, 20), (1, 1), (100, 100), (101, 20)] {
            assert_eq!(clamp_list_limit(limit), want);
        }
        assert_eq!(split_page(vec![1, 2, 3], 2), (vec![1, 2], true));
        assert_eq!(split_page(vec![1, 2], 2), (vec![1, 2], false));
        assert_eq!(split_page(Vec::<i32>::new(), 2), (vec![], false));
    }

    #[test]
    fn cached_counts_parse_like_sscanf() {
        assert_eq!(scan_count("42"), 42);
        assert_eq!(scan_count(" 7"), 7);
        assert_eq!(scan_count("-3"), -3);
        assert_eq!(scan_count("12abc"), 12);
        assert_eq!(scan_count("abc"), 0);
        assert_eq!(scan_count(""), 0);
    }

    #[test]
    fn cache_keys_match_go() {
        assert_eq!(relationship_cache_key(3, 9), "follow_rel:3:9");
        assert_eq!(count_cache_key(12), "follow_cnt:12");
    }
}
