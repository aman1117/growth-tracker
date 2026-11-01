//! `FollowRepository` (port of `internal/repository/follow_repository.go`).
//!
//! Every follow edge is stored twice (`follow_edges_by_follower` for "who does X follow?",
//! `follow_edges_by_followee` for "who follows X?"); writes keep both tables and the
//! `follow_counters` row in one transaction. Unfollowed edges stay as `REMOVED` tombstones until
//! [`FollowRepository::cleanup_old_tombstones`] deletes them.

use std::collections::HashMap;

use base64::alphabet;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use base64::Engine;
use chrono::{DateTime, Duration, Utc};
use gt_core::gojson;
use gt_core::models::{
    FollowCounter, FollowEdgeByFollowee, FollowEdgeByFollower, FOLLOW_STATE_ACTIVE, FOLLOW_STATE_PENDING,
    FOLLOW_STATE_REMOVED, RELATIONSHIP_FOLLOWING, RELATIONSHIP_INCOMING_PENDING, RELATIONSHIP_NONE,
    RELATIONSHIP_REQUESTED,
};
use serde::Serialize;
use serde_json::Value;
use sqlx::{PgPool, Postgres, Transaction};

use super::go_limit;

// ==================== Cursor ====================

/// Position in a follow list: the `(created_at, user_id)` of the last row already returned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FollowListCursor {
    pub created_at: DateTime<Utc>,
    pub user_id: i64,
}

/// Go `encoding/base64.URLEncoding`: URL-safe alphabet, padded, lenient about trailing bits.
const GO_URL_ENCODING: GeneralPurpose = GeneralPurpose::new(
    &alphabet::URL_SAFE,
    GeneralPurposeConfig::new()
        .with_encode_padding(true)
        .with_decode_padding_mode(DecodePaddingMode::RequireCanonical)
        .with_decode_allow_trailing_bits(true),
);

#[derive(Serialize)]
struct CursorData {
    #[serde(with = "gojson::time")]
    c: DateTime<Utc>,
    u: i64,
}

impl FollowListCursor {
    /// A cursor positioned after the row (`created_at`, `user_id`).
    pub fn new(created_at: DateTime<Utc>, user_id: i64) -> Self {
        Self { created_at, user_id }
    }

    /// The opaque `next_cursor` string: base64url (padded) of `{"c":"<RFC 3339>","u":<id>}`,
    /// byte-identical to Go's `encodeCursor` in `handlers/follow.go`.
    pub fn encode(&self) -> String {
        let data = CursorData { c: self.created_at, u: self.user_id };
        // Serializing a string and an integer cannot fail.
        let json = gojson::to_vec(&data).unwrap_or_default();
        GO_URL_ENCODING.encode(json)
    }

    /// Parses a cursor from [`FollowListCursor::encode`] (or the Go backend). `None` for an empty
    /// or malformed cursor, like Go's `decodeCursor`; a JSON `null` or missing fields decode as
    /// the zero cursor, as `json.Unmarshal` leaves them.
    pub fn decode(cursor: &str) -> Option<Self> {
        if cursor.is_empty() {
            return None;
        }
        // Go's base64 decoder ignores line breaks.
        let cleaned: String = cursor.chars().filter(|c| *c != '\r' && *c != '\n').collect();
        let bytes = GO_URL_ENCODING.decode(cleaned).ok()?;
        let value: Value = serde_json::from_slice(&bytes).ok()?;
        let mut out = Self { created_at: gojson::go_zero_time(), user_id: 0 };
        let fields = match value {
            Value::Null => return Some(out),
            Value::Object(fields) => fields,
            _ => return None,
        };
        // encoding/json matches field names case-insensitively.
        for (key, value) in fields {
            if key.eq_ignore_ascii_case("c") {
                match value {
                    Value::Null => {}
                    Value::String(s) => {
                        out.created_at = DateTime::parse_from_rfc3339(&s).ok()?.with_timezone(&Utc);
                    }
                    _ => return None,
                }
            } else if key.eq_ignore_ascii_case("u") {
                match value {
                    Value::Null => {}
                    Value::Number(n) => out.user_id = i64::try_from(n.as_u64()?).ok()?,
                    _ => return None,
                }
            }
        }
        Some(out)
    }
}

/// A mutual follower with the time the viewer followed them (for cursor pagination).
#[derive(Debug, Clone, PartialEq, Eq, sqlx::FromRow)]
pub struct MutualEdgeRow {
    pub user_id: i64,
    pub created_at: DateTime<Utc>,
}

/// [`FollowRepository::cleanup_old_tombstones`] failed after deleting `deleted` rows from the
/// first table (Go returned the partial count together with the error).
#[derive(Debug, thiserror::Error)]
#[error("{source}")]
pub struct TombstoneCleanupError {
    pub deleted: i64,
    #[source]
    pub source: sqlx::Error,
}

// ==================== Repository ====================

/// Handles follow relationship data operations.
#[derive(Debug, Clone)]
pub struct FollowRepository {
    pool: PgPool,
}

/// The two edge tables, each keyed by `(owner, other)`.
#[derive(Clone, Copy)]
enum EdgeTable {
    /// `follow_edges_by_follower`, owner = follower.
    ByFollower,
    /// `follow_edges_by_followee`, owner = followee.
    ByFollowee,
}

impl EdgeTable {
    fn name(self) -> &'static str {
        match self {
            EdgeTable::ByFollower => "follow_edges_by_follower",
            EdgeTable::ByFollowee => "follow_edges_by_followee",
        }
    }

    fn columns(self) -> &'static str {
        match self {
            EdgeTable::ByFollower => FollowEdgeByFollower::COLUMNS,
            EdgeTable::ByFollowee => FollowEdgeByFollowee::COLUMNS,
        }
    }

    /// `(owner column, other column)`.
    fn keys(self) -> (&'static str, &'static str) {
        match self {
            EdgeTable::ByFollower => ("follower_id", "followee_id"),
            EdgeTable::ByFollowee => ("followee_id", "follower_id"),
        }
    }
}

const EDGE_TABLES: [EdgeTable; 2] = [EdgeTable::ByFollower, EdgeTable::ByFollowee];

/// Counter columns of `follow_counters`.
const FOLLOWERS: &str = "followers_count";
const FOLLOWING: &str = "following_count";
const PENDING: &str = "pending_requests_count";

impl FollowRepository {
    /// A repository over `pool`.
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// The underlying pool, for callers that need their own transactions (Go `GetDB`).
    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    /// Whether `follower_id` actively follows `followee_id`.
    pub async fn is_following(&self, follower_id: i64, followee_id: i64) -> Result<bool, sqlx::Error> {
        let count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM follow_edges_by_follower WHERE follower_id = $1 AND followee_id = $2 AND state = $3",
        )
        .bind(follower_id)
        .bind(followee_id)
        .bind(FOLLOW_STATE_ACTIVE)
        .fetch_one(&self.pool)
        .await?;
        Ok(count > 0)
    }

    // ==================== Edge operations ====================

    /// GORM `Create` with `OnConflict{DoUpdates: state, accepted_at, updated_at}` on one edge
    /// table. `created_at`/`updated_at` take their `now()` defaults on insert; on conflict
    /// `created_at` is kept.
    async fn upsert_edge(
        tx: &mut Transaction<'_, Postgres>,
        table: EdgeTable,
        follower_id: i64,
        followee_id: i64,
        state: &str,
        accepted_at: Option<DateTime<Utc>>,
    ) -> Result<(), sqlx::Error> {
        let (owner, other) = table.keys();
        let (owner_id, other_id) = match table {
            EdgeTable::ByFollower => (follower_id, followee_id),
            EdgeTable::ByFollowee => (followee_id, follower_id),
        };
        let sql = format!(
            "INSERT INTO {t} ({owner}, {other}, state, accepted_at) VALUES ($1, $2, $3, $4) \
             ON CONFLICT ({owner}, {other}) DO UPDATE SET state = EXCLUDED.state, \
             accepted_at = EXCLUDED.accepted_at, updated_at = EXCLUDED.updated_at",
            t = table.name()
        );
        sqlx::query(&sql)
            .bind(owner_id)
            .bind(other_id)
            .bind(state)
            .bind(accepted_at)
            .execute(&mut **tx)
            .await
            .map(|_| ())
    }

    async fn upsert_both_edges(
        tx: &mut Transaction<'_, Postgres>,
        follower_id: i64,
        followee_id: i64,
        state: &str,
    ) -> Result<(), sqlx::Error> {
        let accepted_at = (state == FOLLOW_STATE_ACTIVE).then(Utc::now);
        for table in EDGE_TABLES {
            Self::upsert_edge(tx, table, follower_id, followee_id, state, accepted_at).await?;
        }
        Ok(())
    }

    /// GORM `Model(edge).Where(pair).Updates(map)` on both tables: sets `state`, `updated_at` and,
    /// when given, `accepted_at`.
    async fn update_both_edges(
        tx: &mut Transaction<'_, Postgres>,
        follower_id: i64,
        followee_id: i64,
        state: &str,
        now: DateTime<Utc>,
        accepted_at: Option<DateTime<Utc>>,
    ) -> Result<(), sqlx::Error> {
        for table in EDGE_TABLES {
            let sql = match accepted_at {
                Some(_) => format!(
                    "UPDATE {} SET state = $1, updated_at = $2, accepted_at = $3 WHERE follower_id = $4 AND followee_id = $5",
                    table.name()
                ),
                None => format!(
                    "UPDATE {} SET state = $1, updated_at = $2 WHERE follower_id = $3 AND followee_id = $4",
                    table.name()
                ),
            };
            let mut query = sqlx::query(&sql).bind(state).bind(now);
            if let Some(accepted_at) = accepted_at {
                query = query.bind(accepted_at);
            }
            query.bind(follower_id).bind(followee_id).execute(&mut **tx).await?;
        }
        Ok(())
    }

    /// Adds `delta` to one counter, creating the row when missing with the delta already applied
    /// (never below zero).
    async fn increment_counter_in_tx(
        tx: &mut Transaction<'_, Postgres>,
        user_id: i64,
        field: &'static str,
        delta: i64,
    ) -> Result<(), sqlx::Error> {
        let initial = |column: &str| if column == field { delta.max(0) } else { 0 };
        let sql = format!(
            "INSERT INTO follow_counters (user_id, followers_count, following_count, pending_requests_count, updated_at) \
             VALUES ($1, $2, $3, $4, NOW()) \
             ON CONFLICT (user_id) DO UPDATE SET {field} = follow_counters.{field} + $5, updated_at = NOW()"
        );
        // Go ignored this statement's error, but a failed statement aborts the transaction, so
        // the commit failed anyway; returning it here has the same outcome.
        sqlx::query(&sql)
            .bind(user_id)
            .bind(initial(FOLLOWERS))
            .bind(initial(FOLLOWING))
            .bind(initial(PENDING))
            .bind(delta)
            .execute(&mut **tx)
            .await
            .map(|_| ())
    }

    /// Creates or updates an edge in both tables atomically, without touching counters.
    pub async fn upsert_edge_dual_write(
        &self,
        follower_id: i64,
        followee_id: i64,
        state: &str,
    ) -> Result<(), sqlx::Error> {
        let mut tx = self.pool.begin().await?;
        Self::upsert_both_edges(&mut tx, follower_id, followee_id, state).await?;
        tx.commit().await
    }

    /// Creates (or re-activates) a follow and updates counters atomically. `previous_state` is
    /// `None` for a new follow or the old state for a re-follow; counters only change for new
    /// follows and follows of `REMOVED` edges (ACTIVE: following/followers +1, PENDING: the
    /// followee's pending requests +1).
    pub async fn create_follow_with_counters(
        &self,
        follower_id: i64,
        followee_id: i64,
        new_state: &str,
        previous_state: Option<&str>,
    ) -> Result<(), sqlx::Error> {
        let mut tx = self.pool.begin().await?;
        Self::upsert_both_edges(&mut tx, follower_id, followee_id, new_state).await?;
        if previous_state.is_none_or(|s| s == FOLLOW_STATE_REMOVED) {
            if new_state == FOLLOW_STATE_ACTIVE {
                Self::increment_counter_in_tx(&mut tx, follower_id, FOLLOWING, 1).await?;
                Self::increment_counter_in_tx(&mut tx, followee_id, FOLLOWERS, 1).await?;
            } else if new_state == FOLLOW_STATE_PENDING {
                Self::increment_counter_in_tx(&mut tx, followee_id, PENDING, 1).await?;
            }
        }
        tx.commit().await
    }

    /// Marks the edge `REMOVED` in both tables and decrements the counters implied by
    /// `previous_state` (ACTIVE: following/followers -1, PENDING: pending requests -1).
    pub async fn remove_follow_with_counters(
        &self,
        follower_id: i64,
        followee_id: i64,
        previous_state: &str,
    ) -> Result<(), sqlx::Error> {
        let mut tx = self.pool.begin().await?;
        Self::update_both_edges(&mut tx, follower_id, followee_id, FOLLOW_STATE_REMOVED, Utc::now(), None).await?;
        if previous_state == FOLLOW_STATE_ACTIVE {
            Self::increment_counter_in_tx(&mut tx, follower_id, FOLLOWING, -1).await?;
            Self::increment_counter_in_tx(&mut tx, followee_id, FOLLOWERS, -1).await?;
        } else if previous_state == FOLLOW_STATE_PENDING {
            Self::increment_counter_in_tx(&mut tx, followee_id, PENDING, -1).await?;
        }
        tx.commit().await
    }

    /// Accepts a pending request (state ACTIVE, `accepted_at` now) and moves the counters from
    /// pending to active atomically.
    pub async fn accept_follow_with_counters(&self, follower_id: i64, followee_id: i64) -> Result<(), sqlx::Error> {
        let mut tx = self.pool.begin().await?;
        let now = Utc::now();
        Self::update_both_edges(&mut tx, follower_id, followee_id, FOLLOW_STATE_ACTIVE, now, Some(now)).await?;
        Self::increment_counter_in_tx(&mut tx, follower_id, FOLLOWING, 1).await?;
        Self::increment_counter_in_tx(&mut tx, followee_id, FOLLOWERS, 1).await?;
        Self::increment_counter_in_tx(&mut tx, followee_id, PENDING, -1).await?;
        tx.commit().await
    }

    /// Sets the state of an existing edge in both tables (`accepted_at` too when ACTIVE),
    /// without touching counters.
    pub async fn update_edge_state(
        &self,
        follower_id: i64,
        followee_id: i64,
        new_state: &str,
    ) -> Result<(), sqlx::Error> {
        let mut tx = self.pool.begin().await?;
        let now = Utc::now();
        let accepted_at = (new_state == FOLLOW_STATE_ACTIVE).then_some(now);
        Self::update_both_edges(&mut tx, follower_id, followee_id, new_state, now, accepted_at).await?;
        tx.commit().await
    }

    async fn find_edge(
        &self,
        follower_id: i64,
        followee_id: i64,
        state: Option<&str>,
    ) -> Result<Option<FollowEdgeByFollower>, sqlx::Error> {
        let state_filter = if state.is_some() { " AND state = $3" } else { "" };
        let sql = format!(
            "SELECT {} FROM follow_edges_by_follower WHERE follower_id = $1 AND followee_id = $2{state_filter} \
             ORDER BY follower_id LIMIT 1",
            FollowEdgeByFollower::COLUMNS
        );
        let mut query = sqlx::query_as::<_, FollowEdgeByFollower>(&sql).bind(follower_id).bind(followee_id);
        if let Some(state) = state {
            query = query.bind(state);
        }
        query.fetch_optional(&self.pool).await
    }

    /// The edge `follower_id -> followee_id` in any state, or `None`.
    pub async fn get_edge(
        &self,
        follower_id: i64,
        followee_id: i64,
    ) -> Result<Option<FollowEdgeByFollower>, sqlx::Error> {
        self.find_edge(follower_id, followee_id, None).await
    }

    /// The edge when it is ACTIVE, or `None`.
    pub async fn get_active_edge(
        &self,
        follower_id: i64,
        followee_id: i64,
    ) -> Result<Option<FollowEdgeByFollower>, sqlx::Error> {
        self.find_edge(follower_id, followee_id, Some(FOLLOW_STATE_ACTIVE)).await
    }

    /// The edge when it is a PENDING request, or `None`.
    pub async fn get_pending_edge(
        &self,
        follower_id: i64,
        followee_id: i64,
    ) -> Result<Option<FollowEdgeByFollower>, sqlx::Error> {
        self.find_edge(follower_id, followee_id, Some(FOLLOW_STATE_PENDING)).await
    }

    // ==================== Lists (cursor pagination) ====================

    /// Edges of `owner_id` in `state`, newest first, after `cursor`.
    async fn edge_page<T>(
        &self,
        table: EdgeTable,
        owner_id: i64,
        state: &str,
        limit: i64,
        cursor: Option<&FollowListCursor>,
    ) -> Result<Vec<T>, sqlx::Error>
    where
        T: for<'r> sqlx::FromRow<'r, sqlx::postgres::PgRow> + Send + Unpin,
    {
        let (owner, other) = table.keys();
        let cursor_filter =
            if cursor.is_some() { format!(" AND (created_at, {other}) < ($4, $5)") } else { String::new() };
        let sql = format!(
            "SELECT {cols} FROM {t} WHERE {owner} = $1 AND state = $2{cursor_filter} \
             ORDER BY created_at DESC, {other} DESC LIMIT $3",
            cols = table.columns(),
            t = table.name()
        );
        let mut query = sqlx::query_as::<_, T>(&sql).bind(owner_id).bind(state).bind(go_limit(limit));
        if let Some(c) = cursor {
            query = query.bind(c.created_at).bind(c.user_id);
        }
        query.fetch_all(&self.pool).await
    }

    /// Active followers of `followee_id`, newest first.
    pub async fn get_followers_paginated(
        &self,
        followee_id: i64,
        limit: i64,
        cursor: Option<&FollowListCursor>,
    ) -> Result<Vec<FollowEdgeByFollowee>, sqlx::Error> {
        self.edge_page(EdgeTable::ByFollowee, followee_id, FOLLOW_STATE_ACTIVE, limit, cursor).await
    }

    /// Every active follower id of `followee_id` (for notification fan-out; no particular order).
    pub async fn get_all_follower_ids(&self, followee_id: i64) -> Result<Vec<i64>, sqlx::Error> {
        sqlx::query_scalar("SELECT follower_id FROM follow_edges_by_followee WHERE followee_id = $1 AND state = $2")
            .bind(followee_id)
            .bind(FOLLOW_STATE_ACTIVE)
            .fetch_all(&self.pool)
            .await
    }

    /// Users `follower_id` actively follows, newest first.
    pub async fn get_following_paginated(
        &self,
        follower_id: i64,
        limit: i64,
        cursor: Option<&FollowListCursor>,
    ) -> Result<Vec<FollowEdgeByFollower>, sqlx::Error> {
        self.edge_page(EdgeTable::ByFollower, follower_id, FOLLOW_STATE_ACTIVE, limit, cursor).await
    }

    /// Pending requests to `followee_id`, newest first.
    pub async fn get_pending_incoming_requests(
        &self,
        followee_id: i64,
        limit: i64,
        cursor: Option<&FollowListCursor>,
    ) -> Result<Vec<FollowEdgeByFollowee>, sqlx::Error> {
        self.edge_page(EdgeTable::ByFollowee, followee_id, FOLLOW_STATE_PENDING, limit, cursor).await
    }

    /// Pending requests sent by `follower_id`, newest first.
    pub async fn get_pending_outgoing_requests(
        &self,
        follower_id: i64,
        limit: i64,
        cursor: Option<&FollowListCursor>,
    ) -> Result<Vec<FollowEdgeByFollower>, sqlx::Error> {
        self.edge_page(EdgeTable::ByFollower, follower_id, FOLLOW_STATE_PENDING, limit, cursor).await
    }

    // ==================== Batch operations ====================

    /// The relationship (`FOLLOWING`, `REQUESTED`, `INCOMING_PENDING` or `NONE`) of the viewer to
    /// each target. Every target gets an entry; empty input skips the queries.
    pub async fn batch_lookup_relationships(
        &self,
        viewer_id: i64,
        target_ids: &[i64],
    ) -> Result<HashMap<i64, String>, sqlx::Error> {
        let mut result: HashMap<i64, String> =
            target_ids.iter().map(|id| (*id, RELATIONSHIP_NONE.to_string())).collect();
        if target_ids.is_empty() {
            return Ok(result);
        }

        let sql = format!(
            "SELECT {} FROM follow_edges_by_follower WHERE follower_id = $1 AND followee_id = ANY($2) AND state IN ($3, $4)",
            FollowEdgeByFollower::COLUMNS
        );
        let outgoing = sqlx::query_as::<_, FollowEdgeByFollower>(&sql)
            .bind(viewer_id)
            .bind(target_ids)
            .bind(FOLLOW_STATE_ACTIVE)
            .bind(FOLLOW_STATE_PENDING)
            .fetch_all(&self.pool)
            .await?;
        for edge in outgoing {
            let state = match edge.state.as_str() {
                FOLLOW_STATE_ACTIVE => RELATIONSHIP_FOLLOWING,
                FOLLOW_STATE_PENDING => RELATIONSHIP_REQUESTED,
                _ => continue,
            };
            result.insert(edge.followee_id, state.to_string());
        }

        let sql = format!(
            "SELECT {} FROM follow_edges_by_follower WHERE follower_id = ANY($1) AND followee_id = $2 AND state = $3",
            FollowEdgeByFollower::COLUMNS
        );
        let incoming = sqlx::query_as::<_, FollowEdgeByFollower>(&sql)
            .bind(target_ids)
            .bind(viewer_id)
            .bind(FOLLOW_STATE_PENDING)
            .fetch_all(&self.pool)
            .await?;
        for edge in incoming {
            // An incoming request only shows when the viewer has no outgoing edge.
            if let Some(state) = result.get_mut(&edge.follower_id) {
                if state == RELATIONSHIP_NONE {
                    *state = RELATIONSHIP_INCOMING_PENDING.to_string();
                }
            }
        }
        Ok(result)
    }

    /// Users the viewer follows who also follow `target_user_id`, ordered by when the viewer
    /// followed them (newest first); the cursor only uses its `created_at`.
    pub async fn get_mutual_follower_ids(
        &self,
        viewer_id: i64,
        target_user_id: i64,
        limit: i64,
        cursor: Option<&FollowListCursor>,
    ) -> Result<Vec<i64>, sqlx::Error> {
        let cursor_filter = if cursor.is_some() { " AND f1.created_at < $6" } else { "" };
        let sql = format!(
            "SELECT f1.followee_id FROM follow_edges_by_follower AS f1 \
             INNER JOIN follow_edges_by_followee AS f2 ON f1.followee_id = f2.follower_id \
             WHERE (f1.follower_id = $1 AND f1.state = $2) AND (f2.followee_id = $3 AND f2.state = $4){cursor_filter} \
             ORDER BY f1.created_at DESC LIMIT $5"
        );
        let mut query = sqlx::query_scalar::<_, i64>(&sql)
            .bind(viewer_id)
            .bind(FOLLOW_STATE_ACTIVE)
            .bind(target_user_id)
            .bind(FOLLOW_STATE_ACTIVE)
            .bind(go_limit(limit));
        if let Some(c) = cursor {
            query = query.bind(c.created_at);
        }
        query.fetch_all(&self.pool).await
    }

    /// Like [`FollowRepository::get_mutual_follower_ids`] with timestamps, paginated by
    /// `(created_at, user_id)` so a page can end inside a group of equal timestamps.
    pub async fn get_mutual_followers_with_timestamps(
        &self,
        viewer_id: i64,
        target_user_id: i64,
        limit: i64,
        cursor: Option<&FollowListCursor>,
    ) -> Result<Vec<MutualEdgeRow>, sqlx::Error> {
        let cursor_filter = if cursor.is_some() { " AND (f1.created_at, f1.followee_id) < ($6, $7)" } else { "" };
        let sql = format!(
            "SELECT f1.followee_id AS user_id, f1.created_at FROM follow_edges_by_follower AS f1 \
             INNER JOIN follow_edges_by_followee AS f2 ON f1.followee_id = f2.follower_id \
             WHERE (f1.follower_id = $1 AND f1.state = $2) AND (f2.followee_id = $3 AND f2.state = $4){cursor_filter} \
             ORDER BY f1.created_at DESC, f1.followee_id DESC LIMIT $5"
        );
        let mut query = sqlx::query_as::<_, MutualEdgeRow>(&sql)
            .bind(viewer_id)
            .bind(FOLLOW_STATE_ACTIVE)
            .bind(target_user_id)
            .bind(FOLLOW_STATE_ACTIVE)
            .bind(go_limit(limit));
        if let Some(c) = cursor {
            query = query.bind(c.created_at).bind(c.user_id);
        }
        query.fetch_all(&self.pool).await
    }

    // ==================== Counters ====================

    async fn find_counter(&self, user_id: i64) -> Result<Option<FollowCounter>, sqlx::Error> {
        let sql = format!(
            "SELECT {} FROM follow_counters WHERE user_id = $1 ORDER BY user_id LIMIT 1",
            FollowCounter::COLUMNS
        );
        sqlx::query_as::<_, FollowCounter>(&sql).bind(user_id).fetch_optional(&self.pool).await
    }

    /// The user's counters, creating a zeroed row when missing.
    pub async fn get_or_create_counter(&self, user_id: i64) -> Result<FollowCounter, sqlx::Error> {
        if let Some(counter) = self.find_counter(user_id).await? {
            return Ok(counter);
        }
        // GORM treats `user_id` as auto-increment: a zero id is left to the sequence.
        let sql = if user_id == 0 {
            format!(
                "INSERT INTO follow_counters (followers_count, following_count, pending_requests_count) \
                 VALUES (0, 0, 0) RETURNING {}",
                FollowCounter::COLUMNS
            )
        } else {
            format!(
                "INSERT INTO follow_counters (user_id, followers_count, following_count, pending_requests_count) \
                 VALUES ($1, 0, 0, 0) RETURNING {}",
                FollowCounter::COLUMNS
            )
        };
        let mut query = sqlx::query_as::<_, FollowCounter>(&sql);
        if user_id != 0 {
            query = query.bind(user_id);
        }
        query.fetch_one(&self.pool).await
    }

    /// Adds `delta` to one counter; a missing row starts at `delta` (even when negative).
    async fn increment_counter(&self, user_id: i64, field: &'static str, delta: i64) -> Result<(), sqlx::Error> {
        let value = |column: &str| if column == field { "$2" } else { "0" };
        let sql = format!(
            "INSERT INTO follow_counters (user_id, followers_count, following_count, pending_requests_count, updated_at) \
             VALUES ($1, {}, {}, {}, NOW()) \
             ON CONFLICT (user_id) DO UPDATE SET {field} = follow_counters.{field} + $3, updated_at = NOW()",
            value(FOLLOWERS),
            value(FOLLOWING),
            value(PENDING)
        );
        sqlx::query(&sql).bind(user_id).bind(delta).bind(delta).execute(&self.pool).await.map(|_| ())
    }

    /// Atomically adds `delta` to `followers_count`.
    pub async fn increment_followers_count(&self, user_id: i64, delta: i64) -> Result<(), sqlx::Error> {
        self.increment_counter(user_id, FOLLOWERS, delta).await
    }

    /// Atomically adds `delta` to `following_count`.
    pub async fn increment_following_count(&self, user_id: i64, delta: i64) -> Result<(), sqlx::Error> {
        self.increment_counter(user_id, FOLLOWING, delta).await
    }

    /// Atomically adds `delta` to `pending_requests_count`.
    pub async fn increment_pending_requests_count(&self, user_id: i64, delta: i64) -> Result<(), sqlx::Error> {
        self.increment_counter(user_id, PENDING, delta).await
    }

    /// `(followers_count, following_count)` from the counters row; `(0, 0)` when missing.
    pub async fn get_follow_counts(&self, user_id: i64) -> Result<(i64, i64), sqlx::Error> {
        Ok(self.find_counter(user_id).await?.map(|c| (c.followers_count, c.following_count)).unwrap_or((0, 0)))
    }

    /// `pending_requests_count` from the counters row; 0 when missing.
    pub async fn get_pending_requests_count(&self, user_id: i64) -> Result<i64, sqlx::Error> {
        Ok(self.find_counter(user_id).await?.map(|c| c.pending_requests_count).unwrap_or(0))
    }

    // ==================== Cleanup ====================

    /// Deletes `REMOVED` edges last updated before `older_than` from both tables and returns the
    /// number of rows deleted.
    pub async fn cleanup_old_tombstones(&self, older_than: DateTime<Utc>) -> Result<i64, TombstoneCleanupError> {
        let mut total: i64 = 0;
        for table in EDGE_TABLES {
            let sql = format!("DELETE FROM {} WHERE state = $1 AND updated_at < $2", table.name());
            let result = sqlx::query(&sql)
                .bind(FOLLOW_STATE_REMOVED)
                .bind(older_than)
                .execute(&self.pool)
                .await
                .map_err(|source| TombstoneCleanupError { deleted: total, source })?;
            total += i64::try_from(result.rows_affected()).unwrap_or(i64::MAX);
        }
        Ok(total)
    }

    // ==================== Counts ====================

    async fn count(&self, sql: &str, user_id: i64, state: &str) -> Result<i64, sqlx::Error> {
        sqlx::query_scalar(sql).bind(user_id).bind(state).fetch_one(&self.pool).await
    }

    /// Number of users `user_id` actively follows (from the edges, not the counters).
    pub async fn count_following(&self, user_id: i64) -> Result<i64, sqlx::Error> {
        self.count(
            "SELECT count(*) FROM follow_edges_by_follower WHERE follower_id = $1 AND state = $2",
            user_id,
            FOLLOW_STATE_ACTIVE,
        )
        .await
    }

    /// Follow actions (edges created, whatever their state now) by `user_id` since UTC midnight.
    pub async fn count_daily_follows(&self, user_id: i64) -> Result<i64, sqlx::Error> {
        let today = utc_midnight(Utc::now());
        let tomorrow = today + Duration::hours(24);
        sqlx::query_scalar(
            "SELECT count(*) FROM follow_edges_by_follower WHERE follower_id = $1 AND created_at >= $2 AND created_at < $3",
        )
        .bind(user_id)
        .bind(today)
        .bind(tomorrow)
        .fetch_one(&self.pool)
        .await
    }

    /// Number of pending requests to `user_id` (from the edges).
    pub async fn count_pending_requests_for(&self, user_id: i64) -> Result<i64, sqlx::Error> {
        self.count(
            "SELECT count(*) FROM follow_edges_by_followee WHERE followee_id = $1 AND state = $2",
            user_id,
            FOLLOW_STATE_PENDING,
        )
        .await
    }

    // ==================== Reconciliation ====================

    /// Recomputes the user's counters from the edges (fixes drift), creating the row if needed.
    pub async fn reconcile_counters(&self, user_id: i64) -> Result<(), sqlx::Error> {
        let followers = self
            .count(
                "SELECT count(*) FROM follow_edges_by_followee WHERE followee_id = $1 AND state = $2",
                user_id,
                FOLLOW_STATE_ACTIVE,
            )
            .await?;
        let following = self.count_following(user_id).await?;
        let pending = self.count_pending_requests_for(user_id).await?;
        sqlx::query(
            "INSERT INTO follow_counters (user_id, followers_count, following_count, pending_requests_count, updated_at) \
             VALUES ($1, $2, $3, $4, NOW()) \
             ON CONFLICT (user_id) DO UPDATE SET followers_count = $2, following_count = $3, \
             pending_requests_count = $4, updated_at = NOW()",
        )
        .bind(user_id)
        .bind(followers)
        .bind(following)
        .bind(pending)
        .execute(&self.pool)
        .await
        .map(|_| ())
    }

    /// Reconciles every user that has a counters row; failures are skipped. Returns how many
    /// were reconciled.
    pub async fn reconcile_all_counters(&self) -> Result<i64, sqlx::Error> {
        let sql = format!("SELECT {} FROM follow_counters", FollowCounter::COLUMNS);
        let counters = sqlx::query_as::<_, FollowCounter>(&sql).fetch_all(&self.pool).await?;
        let mut reconciled = 0;
        for counter in counters {
            if self.reconcile_counters(counter.user_id).await.is_ok() {
                reconciled += 1;
            }
        }
        Ok(reconciled)
    }
}

/// Go `time.Now().Truncate(24 * time.Hour)`: truncation works on absolute time, i.e. UTC midnight.
fn utc_midnight(now: DateTime<Utc>) -> DateTime<Utc> {
    now.date_naive().and_hms_opt(0, 0, 0).map(|t| t.and_utc()).unwrap_or(now)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn at(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    #[test]
    fn cursor_round_trips_with_go_encoding() {
        let cursor = FollowListCursor::new(at("2026-01-10T12:00:00Z"), 10);
        // Go marshals the local-zone time: on a UTC host (production) this is the value Go
        // produces: base64.URLEncoding.EncodeToString(json.Marshal(cursorData{...})).
        let expected_json = format!(r#"{{"c":"{}","u":10}}"#, gojson::format_go_time(&at("2026-01-10T12:00:00Z")));
        assert_eq!(cursor.encode(), GO_URL_ENCODING.encode(expected_json));
        if gojson::to_go_local(&at("2026-01-10T12:00:00Z")).offset().local_minus_utc() == 0 {
            assert_eq!(cursor.encode(), "eyJjIjoiMjAyNi0wMS0xMFQxMjowMDowMFoiLCJ1IjoxMH0=");
        }
        assert_eq!(FollowListCursor::decode(&cursor.encode()), Some(cursor));
        // Cursors written on a UTC host (production Go) still decode.
        assert_eq!(
            FollowListCursor::decode("eyJjIjoiMjAyNi0wMS0xMFQxMjowMDowMFoiLCJ1IjoxMH0="),
            Some(FollowListCursor::new(at("2026-01-10T12:00:00Z"), 10))
        );

        let precise = FollowListCursor::new(at("2026-03-09T08:15:30.123456Z"), 4_000_000_001);
        assert_eq!(FollowListCursor::decode(&precise.encode()), Some(precise));
    }

    #[test]
    fn cursor_decode_rejects_malformed_input() {
        let b64 = |s: &str| GO_URL_ENCODING.encode(s);
        assert_eq!(FollowListCursor::decode(""), None);
        assert_eq!(FollowListCursor::decode("not base64!"), None);
        // Unpadded input is invalid for URLEncoding.
        assert_eq!(FollowListCursor::decode("eyJ1IjoxfQ"), None);
        assert_eq!(FollowListCursor::decode(&b64("not json")), None);
        assert_eq!(FollowListCursor::decode(&b64("[1]")), None);
        assert_eq!(FollowListCursor::decode(&b64(r#"{"c":"yesterday","u":1}"#)), None);
        assert_eq!(FollowListCursor::decode(&b64(r#"{"c":"2026-01-10T12:00:00Z","u":-1}"#)), None);
        assert_eq!(FollowListCursor::decode(&b64(r#"{"c":"2026-01-10T12:00:00Z","u":"1"}"#)), None);
        assert_eq!(FollowListCursor::decode(&b64(r#"{"c":"2026-01-10T12:00:00Z","u":1.5}"#)), None);
    }

    #[test]
    fn cursor_decode_is_lenient_like_encoding_json() {
        let b64 = |s: &str| GO_URL_ENCODING.encode(s);
        let zero = FollowListCursor::new(gojson::go_zero_time(), 0);
        assert_eq!(FollowListCursor::decode(&b64("null")), Some(zero));
        assert_eq!(FollowListCursor::decode(&b64("{}")), Some(zero));
        assert_eq!(
            FollowListCursor::decode(&b64(r#"{"C":"2026-01-10T17:30:00+05:30","U":7,"x":true}"#)),
            Some(FollowListCursor::new(Utc.with_ymd_and_hms(2026, 1, 10, 12, 0, 0).unwrap(), 7))
        );
        let with_newline = format!("{}\n", b64(r#"{"u":3}"#));
        assert_eq!(FollowListCursor::decode(&with_newline).map(|c| c.user_id), Some(3));
    }

    #[test]
    fn daily_window_starts_at_utc_midnight() {
        assert_eq!(utc_midnight(at("2026-03-09T23:59:59.9Z")), at("2026-03-09T00:00:00Z"));
        assert_eq!(utc_midnight(at("2026-03-10T00:00:00Z")), at("2026-03-10T00:00:00Z"));
    }
}
