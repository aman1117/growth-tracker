//! `comment_dedupes` table: duplicate-submission guard keyed by a client idempotency key and
//! by a hash of the body (port of `comment_dedupe_repository.go`).

use std::time::Duration;

use chrono::NaiveDate;
use gt_core::models::CommentDedupe;
use sqlx::PgPool;

use super::cutoff;

/// A dedupe record to store for a freshly created comment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewCommentDedupe {
    pub user_id: i64,
    pub day_owner_id: i64,
    pub day_date: NaiveDate,
    pub body_hash: String,
    pub idempotency_key: Option<String>,
    pub comment_id: i64,
}

/// Reads and writes comment dedupe records.
#[derive(Debug, Clone)]
pub struct CommentDedupeRepository {
    pool: PgPool,
}

impl CommentDedupeRepository {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// The record using `key` created within `window`, if any.
    pub async fn check_idempotency_key(
        &self,
        key: &str,
        window: Duration,
    ) -> Result<Option<CommentDedupe>, sqlx::Error> {
        let sql = format!(
            "SELECT {} FROM comment_dedupes WHERE idempotency_key = $1 AND created_at > $2 \
             ORDER BY comment_dedupes.id LIMIT 1",
            CommentDedupe::COLUMNS
        );
        sqlx::query_as::<_, CommentDedupe>(&sql).bind(key).bind(cutoff(window)).fetch_optional(&self.pool).await
    }

    /// The record of the same commenter, day and body hash created within `window`, if any.
    pub async fn check_body_hash(
        &self,
        user_id: i64,
        day_owner_id: i64,
        day_date: NaiveDate,
        body_hash: &str,
        window: Duration,
    ) -> Result<Option<CommentDedupe>, sqlx::Error> {
        let sql = format!(
            "SELECT {} FROM comment_dedupes \
             WHERE user_id = $1 AND day_owner_id = $2 AND day_date = $3 AND body_hash = $4 AND created_at > $5 \
             ORDER BY comment_dedupes.id LIMIT 1",
            CommentDedupe::COLUMNS
        );
        sqlx::query_as::<_, CommentDedupe>(&sql)
            .bind(user_id)
            .bind(day_owner_id)
            .bind(day_date)
            .bind(body_hash)
            .bind(cutoff(window))
            .fetch_optional(&self.pool)
            .await
    }

    /// Inserts the record, or refreshes the existing one for the same commenter/day/body (an
    /// expired record still occupies that unique slot). Fails when the idempotency key is
    /// already used by another record.
    pub async fn upsert(&self, dedupe: &NewCommentDedupe) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO comment_dedupes (user_id, day_owner_id, day_date, body_hash, idempotency_key, comment_id, created_at)
		 VALUES ($1, $2, $3, $4, $5, $6, NOW())
		 ON CONFLICT (user_id, day_owner_id, day_date, body_hash)
		 DO UPDATE SET comment_id = EXCLUDED.comment_id,
		               idempotency_key = EXCLUDED.idempotency_key,
		               created_at = NOW()",
        )
        .bind(dedupe.user_id)
        .bind(dedupe.day_owner_id)
        .bind(dedupe.day_date)
        .bind(&dedupe.body_hash)
        .bind(dedupe.idempotency_key.as_deref())
        .bind(dedupe.comment_id)
        .execute(&self.pool)
        .await
        .map(|_| ())
        .inspect_err(|e| {
            tracing::error!(
                user_id = dedupe.user_id,
                comment_id = dedupe.comment_id,
                error = %e,
                "CommentDedupeRepository.Upsert failed"
            );
        })
    }

    /// Deletes records older than `window`; returns how many were removed.
    pub async fn cleanup_expired(&self, window: Duration) -> Result<i64, sqlx::Error> {
        sqlx::query("DELETE FROM comment_dedupes WHERE created_at < $1")
            .bind(cutoff(window))
            .execute(&self.pool)
            .await
            .map(|r| i64::try_from(r.rows_affected()).unwrap_or(i64::MAX))
            .inspect_err(|e| tracing::error!(error = %e, "CommentDedupeRepository.CleanupExpired failed"))
    }
}
