//! `comment_mentions` table (port of `comment_mention_repository.go`).

use std::collections::HashMap;

use gt_core::models::CommentMention;
use sqlx::PgPool;

/// A mention to store; `username` is a snapshot taken when the comment is written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewCommentMention {
    pub comment_id: i64,
    pub mentioned_user_id: i64,
    pub username: String,
}

/// Reads and writes comment mentions.
#[derive(Debug, Clone)]
pub struct CommentMentionRepository {
    pool: PgPool,
}

impl CommentMentionRepository {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// Inserts all mentions in one statement (GORM batch `Create`), in order. No-op when empty.
    pub async fn create_batch(&self, mentions: &[NewCommentMention]) -> Result<(), sqlx::Error> {
        if mentions.is_empty() {
            return Ok(());
        }
        let comment_ids: Vec<i64> = mentions.iter().map(|m| m.comment_id).collect();
        let user_ids: Vec<i64> = mentions.iter().map(|m| m.mentioned_user_id).collect();
        let usernames: Vec<&str> = mentions.iter().map(|m| m.username.as_str()).collect();
        sqlx::query(
            "INSERT INTO comment_mentions (comment_id, mentioned_user_id, username, created_at) \
             SELECT m.comment_id, m.mentioned_user_id, m.username, NOW() \
             FROM UNNEST($1::int8[], $2::int8[], $3::text[]) AS m(comment_id, mentioned_user_id, username)",
        )
        .bind(&comment_ids)
        .bind(&user_ids)
        .bind(&usernames)
        .execute(&self.pool)
        .await
        .map(|_| ())
        .inspect_err(|e| {
            tracing::error!(count = mentions.len(), error = %e, "CommentMentionRepository.CreateBatch failed");
        })
    }

    /// Every mention of a comment.
    pub async fn get_by_comment_id(&self, comment_id: i64) -> Result<Vec<CommentMention>, sqlx::Error> {
        let sql = format!("SELECT {} FROM comment_mentions WHERE comment_id = $1", CommentMention::COLUMNS);
        sqlx::query_as::<_, CommentMention>(&sql).bind(comment_id).fetch_all(&self.pool).await
    }

    /// Removes every mention of a comment.
    pub async fn delete_by_comment_id(&self, comment_id: i64) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM comment_mentions WHERE comment_id = $1")
            .bind(comment_id)
            .execute(&self.pool)
            .await
            .map(|_| ())
            .inspect_err(|e| {
                tracing::error!(comment_id, error = %e, "CommentMentionRepository.DeleteByCommentID failed");
            })
    }

    /// Mentions of several comments grouped by comment id; comments without mentions are absent.
    pub async fn get_by_comment_ids(
        &self,
        comment_ids: &[i64],
    ) -> Result<HashMap<i64, Vec<CommentMention>>, sqlx::Error> {
        let mut grouped: HashMap<i64, Vec<CommentMention>> = HashMap::new();
        if comment_ids.is_empty() {
            return Ok(grouped);
        }
        let sql = format!("SELECT {} FROM comment_mentions WHERE comment_id = ANY($1)", CommentMention::COLUMNS);
        let mentions = sqlx::query_as::<_, CommentMention>(&sql).bind(comment_ids).fetch_all(&self.pool).await?;
        for mention in mentions {
            grouped.entry(mention.comment_id).or_default().push(mention);
        }
        Ok(grouped)
    }
}
