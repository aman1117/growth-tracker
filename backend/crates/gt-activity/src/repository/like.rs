//! `LikeRepository` (port of `internal/repository/like_repository.go`): likes on a user's day.

use chrono::{DateTime, NaiveDate, Utc};
use gt_core::models::Like;
use sqlx::PgPool;

use crate::dates::format_date;

/// A like with the liker's public profile, newest first in [`LikeRepository::get_likes_for_day`].
#[derive(Debug, Clone, PartialEq, Eq, sqlx::FromRow)]
pub struct LikeWithUser {
    pub id: i64,
    pub liker_id: i64,
    pub username: String,
    pub profile_pic: Option<String>,
    pub profile_pic_thumb: Option<String>,
    pub is_verified: bool,
    pub created_at: DateTime<Utc>,
}

/// Why a like could not be removed.
#[derive(Debug, thiserror::Error)]
pub enum LikeDeleteError {
    /// There was no like to remove (Go `repository.ErrLikeNotFound`).
    #[error("like not found")]
    NotFound,
    #[error(transparent)]
    Database(#[from] sqlx::Error),
}

/// Handles like data operations.
#[derive(Debug, Clone)]
pub struct LikeRepository {
    pool: PgPool,
}

/// Go swallowed errors whose text mentioned a unique violation.
fn is_duplicate(err: &sqlx::Error) -> bool {
    if gt_core::db::is_unique_violation(err) {
        return true;
    }
    let text = err.to_string();
    text.contains("23505") || text.contains("duplicate")
}

impl LikeRepository {
    /// A repository over `pool`.
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// Likes `liked_user_id`'s day; liking it again is not an error.
    pub async fn create(&self, liker_id: i64, liked_user_id: i64, liked_date: NaiveDate) -> Result<(), sqlx::Error> {
        let date = format_date(liked_date);
        tracing::info!(liker_id, liked_user_id, liked_date = %date, "LikeRepository.Create called");
        let result: Result<i64, sqlx::Error> = sqlx::query_scalar(
            "INSERT INTO likes (liker_id, liked_user_id, liked_date, created_at, updated_at) \
             VALUES ($1, $2, $3, NOW(), NOW()) RETURNING id",
        )
        .bind(liker_id)
        .bind(liked_user_id)
        .bind(liked_date)
        .fetch_one(&self.pool)
        .await;
        match result {
            Ok(like_id) => {
                tracing::info!(liker_id, liked_user_id, liked_date = %date, like_id, "LikeRepository.Create success");
                Ok(())
            }
            Err(err) if is_duplicate(&err) => {
                tracing::warn!(liker_id, liked_user_id, liked_date = %date, "Like already exists (duplicate key)");
                Ok(())
            }
            Err(err) => {
                tracing::error!(liker_id, liked_user_id, liked_date = %date, error = %err, "LikeRepository.Create failed");
                Err(err)
            }
        }
    }

    /// Removes a like; [`LikeDeleteError::NotFound`] when there was none.
    pub async fn delete(
        &self,
        liker_id: i64,
        liked_user_id: i64,
        liked_date: NaiveDate,
    ) -> Result<(), LikeDeleteError> {
        let date = format_date(liked_date);
        tracing::info!(liker_id, liked_user_id, liked_date = %date, "LikeRepository.Delete called");
        let result =
            sqlx::query("DELETE FROM likes WHERE liker_id = $1 AND liked_user_id = $2 AND liked_date = DATE($3)")
                .bind(liker_id)
                .bind(liked_user_id)
                .bind(liked_date)
                .execute(&self.pool)
                .await;
        let rows_affected = match result {
            Ok(done) => done.rows_affected(),
            Err(err) => {
                tracing::error!(liker_id, liked_user_id, liked_date = %date, error = %err, "LikeRepository.Delete failed");
                return Err(err.into());
            }
        };
        if rows_affected == 0 {
            tracing::warn!(
                liker_id,
                liked_user_id,
                liked_date = %date,
                "LikeRepository.Delete no rows affected (like not found)"
            );
            return Err(LikeDeleteError::NotFound);
        }
        tracing::info!(liker_id, liked_user_id, liked_date = %date, rows_affected, "LikeRepository.Delete success");
        Ok(())
    }

    /// Whether `liker_id` liked `liked_user_id`'s day.
    pub async fn has_liked(
        &self,
        liker_id: i64,
        liked_user_id: i64,
        liked_date: NaiveDate,
    ) -> Result<bool, sqlx::Error> {
        let date = format_date(liked_date);
        tracing::info!(liker_id, liked_user_id, liked_date = %date, "LikeRepository.HasLiked called");
        let count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM likes WHERE liker_id = $1 AND liked_user_id = $2 AND liked_date = DATE($3)",
        )
        .bind(liker_id)
        .bind(liked_user_id)
        .bind(liked_date)
        .fetch_one(&self.pool)
        .await
        .inspect_err(|err| {
            tracing::error!(liker_id, liked_user_id, liked_date = %date, error = %err, "LikeRepository.HasLiked query failed");
        })?;
        let has_liked = count > 0;
        tracing::info!(liker_id, liked_user_id, liked_date = %date, count, has_liked, "LikeRepository.HasLiked result");
        Ok(has_liked)
    }

    /// Every like of the day with the liker's profile, newest first.
    pub async fn get_likes_for_day(
        &self,
        liked_user_id: i64,
        liked_date: NaiveDate,
    ) -> Result<Vec<LikeWithUser>, sqlx::Error> {
        let date = format_date(liked_date);
        tracing::info!(liked_user_id, liked_date = %date, "LikeRepository.GetLikesForDay called");
        let likes = sqlx::query_as::<_, LikeWithUser>(
            "SELECT likes.id, likes.liker_id, users.username, users.profile_pic, users.profile_pic_thumb, \
             COALESCE(users.is_verified, false) AS is_verified, likes.created_at \
             FROM likes JOIN users ON users.id = likes.liker_id \
             WHERE likes.liked_user_id = $1 AND likes.liked_date = DATE($2) ORDER BY likes.created_at DESC",
        )
        .bind(liked_user_id)
        .bind(liked_date)
        .fetch_all(&self.pool)
        .await
        .inspect_err(|err| {
            tracing::error!(liked_user_id, liked_date = %date, error = %err, "LikeRepository.GetLikesForDay failed");
        })?;
        tracing::info!(liked_user_id, liked_date = %date, likes_count = likes.len(), "LikeRepository.GetLikesForDay result");
        Ok(likes)
    }

    /// Number of likes on the day.
    pub async fn count_likes_for_day(&self, liked_user_id: i64, liked_date: NaiveDate) -> Result<i64, sqlx::Error> {
        sqlx::query_scalar("SELECT count(*) FROM likes WHERE liked_user_id = $1 AND liked_date = DATE($2)")
            .bind(liked_user_id)
            .bind(liked_date)
            .fetch_one(&self.pool)
            .await
    }

    /// The likes `liker_id` gave, newest first; a negative `limit` means no limit (GORM).
    pub async fn get_likes_by_user(&self, liker_id: i64, limit: i64) -> Result<Vec<Like>, sqlx::Error> {
        let sql = format!("SELECT {} FROM likes WHERE liker_id = $1 ORDER BY created_at DESC LIMIT $2", Like::COLUMNS);
        sqlx::query_as::<_, Like>(&sql).bind(liker_id).bind((limit >= 0).then_some(limit)).fetch_all(&self.pool).await
    }
}
