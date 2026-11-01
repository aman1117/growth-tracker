//! `comments` table (port of `comment_repository.go`).

use std::sync::LazyLock;

use chrono::{DateTime, NaiveDate, Utc};
use gt_core::models::Comment;
use serde::Serialize;
use sqlx::PgPool;

use super::gorm_limit;

/// A comment joined with its author's public profile fields (Go embeds `models.Comment`, so
/// the comment fields are flattened in JSON).
#[derive(Debug, Clone, PartialEq, Serialize, sqlx::FromRow)]
pub struct CommentWithAuthor {
    #[serde(flatten)]
    #[sqlx(flatten)]
    pub comment: Comment,
    pub author_username: String,
    pub author_avatar: Option<String>,
    pub author_avatar_thumb: Option<String>,
    pub author_verified: bool,
}

/// Fields of a comment to insert. `created_at` defaults to now (GORM `autoCreateTime` keeps an
/// explicitly set creation time).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewComment {
    pub day_owner_id: i64,
    pub day_date: NaiveDate,
    pub author_id: i64,
    pub parent_comment_id: Option<i64>,
    pub root_comment_id: Option<i64>,
    pub reply_to_user_id: Option<i64>,
    pub body: String,
    pub created_at: Option<DateTime<Utc>>,
}

/// `comments.*` plus the author columns, as selected by every Go "with author" query. A missing
/// author row scans as zero values in GORM, hence the `COALESCE`s.
static SELECT_WITH_AUTHOR: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {}, COALESCE(users.username, '') AS author_username, users.profile_pic AS author_avatar, \
         users.profile_pic_thumb AS author_avatar_thumb, COALESCE(users.is_verified, false) AS author_verified \
         FROM comments LEFT JOIN users ON users.id = comments.author_id",
        Comment::columns_with_alias("comments")
    )
});

/// Reads and writes comments.
#[derive(Debug, Clone)]
pub struct CommentRepository {
    pool: PgPool,
}

impl CommentRepository {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// Inserts a comment and returns the stored row (with its id and timestamps).
    pub async fn create(&self, new: &NewComment) -> Result<Comment, sqlx::Error> {
        let sql = format!(
            "INSERT INTO comments (day_owner_id, day_date, author_id, parent_comment_id, root_comment_id, \
             reply_to_user_id, body, created_at, updated_at) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, NOW()), NOW()) RETURNING {}",
            Comment::COLUMNS
        );
        sqlx::query_as::<_, Comment>(&sql)
            .bind(new.day_owner_id)
            .bind(new.day_date)
            .bind(new.author_id)
            .bind(new.parent_comment_id)
            .bind(new.root_comment_id)
            .bind(new.reply_to_user_id)
            .bind(&new.body)
            .bind(new.created_at)
            .fetch_one(&self.pool)
            .await
            .inspect_err(|e| {
                tracing::error!(
                    author_id = new.author_id,
                    day_owner_id = new.day_owner_id,
                    error = %e,
                    "CommentRepository.Create failed"
                );
            })
    }

    /// A comment by id (GORM `First`), `None` when it does not exist.
    pub async fn get_by_id(&self, id: i64) -> Result<Option<Comment>, sqlx::Error> {
        let sql =
            format!("SELECT {} FROM comments WHERE comments.id = $1 ORDER BY comments.id LIMIT 1", Comment::COLUMNS);
        sqlx::query_as::<_, Comment>(&sql).bind(id).fetch_optional(&self.pool).await
    }

    /// A comment with its author's profile, `None` when it does not exist.
    pub async fn get_by_id_with_author(&self, id: i64) -> Result<Option<CommentWithAuthor>, sqlx::Error> {
        let sql = format!("{} WHERE comments.id = $1", *SELECT_WITH_AUTHOR);
        sqlx::query_as::<_, CommentWithAuthor>(&sql).bind(id).fetch_optional(&self.pool).await
    }

    /// Top-level comments of a day, newest first, ids below `cursor` (when positive). Returns up
    /// to `limit + 1` rows so callers can tell whether another page exists.
    pub async fn get_top_level_by_day(
        &self,
        day_owner_id: i64,
        day_date: NaiveDate,
        cursor: Option<i64>,
        limit: i64,
    ) -> Result<Vec<CommentWithAuthor>, sqlx::Error> {
        let cursor = cursor.filter(|c| *c > 0);
        let mut sql = format!(
            "{} WHERE comments.day_owner_id = $1 AND comments.day_date = $2 AND comments.parent_comment_id IS NULL",
            *SELECT_WITH_AUTHOR
        );
        let limit_param = if cursor.is_some() {
            sql.push_str(" AND comments.id < $3");
            "$4"
        } else {
            "$3"
        };
        sql.push_str(&format!(" ORDER BY comments.created_at DESC, comments.id DESC LIMIT {limit_param}"));

        let mut query = sqlx::query_as::<_, CommentWithAuthor>(&sql).bind(day_owner_id).bind(day_date);
        if let Some(cursor) = cursor {
            query = query.bind(cursor);
        }
        query.bind(gorm_limit(limit.saturating_add(1))).fetch_all(&self.pool).await.inspect_err(|e| {
            tracing::error!(
                day_owner_id,
                day_date = %day_date,
                error = %e,
                "CommentRepository.GetTopLevelByDay failed"
            );
        })
    }

    /// Every reply of a thread (any depth), oldest first, ids above `cursor` (when positive).
    /// Returns up to `limit + 1` rows.
    pub async fn get_replies_by_root(
        &self,
        root_comment_id: i64,
        cursor: Option<i64>,
        limit: i64,
    ) -> Result<Vec<CommentWithAuthor>, sqlx::Error> {
        let cursor = cursor.filter(|c| *c > 0);
        let mut sql = format!("{} WHERE comments.root_comment_id = $1", *SELECT_WITH_AUTHOR);
        let limit_param = if cursor.is_some() {
            sql.push_str(" AND comments.id > $2");
            "$3"
        } else {
            "$2"
        };
        sql.push_str(&format!(" ORDER BY comments.created_at ASC, comments.id ASC LIMIT {limit_param}"));

        let mut query = sqlx::query_as::<_, CommentWithAuthor>(&sql).bind(root_comment_id);
        if let Some(cursor) = cursor {
            query = query.bind(cursor);
        }
        query.bind(gorm_limit(limit.saturating_add(1))).fetch_all(&self.pool).await.inspect_err(|e| {
            tracing::error!(root_comment_id, error = %e, "CommentRepository.GetRepliesByRoot failed");
        })
    }

    /// Marks a comment deleted and replaces its body with `[Deleted]`. No-op when it is
    /// already deleted (the original deletion time is kept).
    pub async fn soft_delete(&self, comment_id: i64) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE comments SET body = '[Deleted]', deleted_at = NOW(), is_deleted = true, updated_at = NOW() \
             WHERE id = $1 AND is_deleted = false",
        )
        .bind(comment_id)
        .execute(&self.pool)
        .await
        .map(|_| ())
        .inspect_err(|e| tracing::error!(comment_id, error = %e, "CommentRepository.SoftDelete failed"))
    }

    /// Replaces the body of a non-deleted comment and marks it edited.
    pub async fn update_body(&self, comment_id: i64, body: &str) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE comments SET body = $2, is_edited = true, updated_at = NOW() WHERE id = $1 AND is_deleted = false",
        )
        .bind(comment_id)
        .bind(body)
        .execute(&self.pool)
        .await
        .map(|_| ())
        .inspect_err(|e| tracing::error!(comment_id, error = %e, "CommentRepository.UpdateBody failed"))
    }

    /// Increments `reply_count` on every ancestor of the comment (parent, grandparent, ... up
    /// to the root) by walking the `parent_comment_id` chain.
    pub async fn increment_ancestor_reply_counts(&self, comment_id: i64) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
		WITH RECURSIVE ancestors AS (
			SELECT parent_comment_id AS id
			FROM comments
			WHERE id = $1 AND parent_comment_id IS NOT NULL
			UNION ALL
			SELECT c.parent_comment_id
			FROM comments c
			INNER JOIN ancestors a ON c.id = a.id
			WHERE c.parent_comment_id IS NOT NULL
		)
		UPDATE comments
		SET reply_count = reply_count + 1
		WHERE id IN (SELECT id FROM ancestors)
	"#,
        )
        .bind(comment_id)
        .execute(&self.pool)
        .await
        .map(|_| ())
    }

    /// Decrements `reply_count` on every ancestor of the comment, never below zero.
    pub async fn decrement_ancestor_reply_counts(&self, comment_id: i64) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
		WITH RECURSIVE ancestors AS (
			SELECT parent_comment_id AS id
			FROM comments
			WHERE id = $1 AND parent_comment_id IS NOT NULL
			UNION ALL
			SELECT c.parent_comment_id
			FROM comments c
			INNER JOIN ancestors a ON c.id = a.id
			WHERE c.parent_comment_id IS NOT NULL
		)
		UPDATE comments
		SET reply_count = GREATEST(reply_count - 1, 0)
		WHERE id IN (SELECT id FROM ancestors)
	"#,
        )
        .bind(comment_id)
        .execute(&self.pool)
        .await
        .map(|_| ())
    }

    /// Number of non-deleted comments (replies included) on a day.
    pub async fn get_comment_count_for_day(&self, day_owner_id: i64, day_date: NaiveDate) -> Result<i64, sqlx::Error> {
        sqlx::query_scalar(
            "SELECT count(*) FROM comments WHERE day_owner_id = $1 AND day_date = $2 AND is_deleted = false",
        )
        .bind(day_owner_id)
        .bind(day_date)
        .fetch_one(&self.pool)
        .await
    }

    /// The username of a user (the target of a reply), `None` when the user does not exist.
    pub async fn get_reply_to_username(&self, user_id: i64) -> Result<Option<String>, sqlx::Error> {
        sqlx::query_scalar("SELECT username FROM users WHERE users.id = $1 ORDER BY users.id LIMIT 1")
            .bind(user_id)
            .fetch_optional(&self.pool)
            .await
    }
}
