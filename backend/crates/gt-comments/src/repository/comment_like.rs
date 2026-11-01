//! `comment_likes` table and the `comments.like_count` counter (port of
//! `comment_like_repository.go`).

use std::collections::HashSet;

use gt_core::db::is_unique_violation;
use sqlx::PgPool;

/// Reads and writes comment likes.
#[derive(Debug, Clone)]
pub struct CommentLikeRepository {
    pool: PgPool,
}

impl CommentLikeRepository {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// Likes a comment. `Ok(true)` when the like was created, `Ok(false)` when the user had
    /// already liked it.
    pub async fn create(&self, comment_id: i64, user_id: i64) -> Result<bool, sqlx::Error> {
        let result = sqlx::query("INSERT INTO comment_likes (comment_id, user_id, created_at) VALUES ($1, $2, NOW())")
            .bind(comment_id)
            .bind(user_id)
            .execute(&self.pool)
            .await;
        match result {
            Ok(_) => Ok(true),
            Err(e) if is_unique_violation(&e) => Ok(false),
            Err(e) => {
                tracing::error!(comment_id, user_id, error = %e, "CommentLikeRepository.Create failed");
                Err(e)
            }
        }
    }

    /// Removes a like. `Ok(true)` when a like was removed, `Ok(false)` when there was none.
    pub async fn delete(&self, comment_id: i64, user_id: i64) -> Result<bool, sqlx::Error> {
        let result = sqlx::query("DELETE FROM comment_likes WHERE comment_id = $1 AND user_id = $2")
            .bind(comment_id)
            .bind(user_id)
            .execute(&self.pool)
            .await?;
        Ok(result.rows_affected() > 0)
    }

    /// Whether the user liked the comment.
    pub async fn has_liked(&self, comment_id: i64, user_id: i64) -> Result<bool, sqlx::Error> {
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM comment_likes WHERE comment_id = $1 AND user_id = $2")
                .bind(comment_id)
                .bind(user_id)
                .fetch_one(&self.pool)
                .await?;
        Ok(count > 0)
    }

    /// Atomically increments `like_count` (GORM `UpdateColumn`: `updated_at` is untouched).
    pub async fn increment_like_count(&self, comment_id: i64) -> Result<(), sqlx::Error> {
        sqlx::query("UPDATE comments SET like_count = like_count + 1 WHERE id = $1")
            .bind(comment_id)
            .execute(&self.pool)
            .await
            .map(|_| ())
    }

    /// Atomically decrements `like_count`, never below zero.
    pub async fn decrement_like_count(&self, comment_id: i64) -> Result<(), sqlx::Error> {
        sqlx::query("UPDATE comments SET like_count = like_count - 1 WHERE id = $1 AND like_count > 0")
            .bind(comment_id)
            .execute(&self.pool)
            .await
            .map(|_| ())
    }

    /// The subset of `comment_ids` the user liked (Go returns `map[id]true` for those).
    pub async fn batch_has_liked(&self, comment_ids: &[i64], user_id: i64) -> Result<HashSet<i64>, sqlx::Error> {
        if comment_ids.is_empty() {
            return Ok(HashSet::new());
        }
        let liked: Vec<i64> =
            sqlx::query_scalar("SELECT comment_id FROM comment_likes WHERE comment_id = ANY($1) AND user_id = $2")
                .bind(comment_ids)
                .bind(user_id)
                .fetch_all(&self.pool)
                .await?;
        Ok(liked.into_iter().collect())
    }
}
