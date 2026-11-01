//! `CommentService` (port of `internal/services/comment_service.go`).

use std::collections::HashMap;
use std::sync::Arc;

use chrono::{NaiveDate, Utc};
use gt_core::constants::COMMENT_DEDUPE_WINDOW;
use gt_core::models::Comment;
use gt_core::validator::{parse_mentions, validate_comment_body};
use gt_notify::NotificationService;
use gt_users::repository::{FollowRepository, UserRepository};

use super::count_cache;
use super::error::CommentError;
use super::mapping::{assemble_comment_dtos, build_comment_dto, created_comment_dto, reply_to_user_ids};
use super::notifier::{CommentNotifier, CreatedComment};
use super::pagination::{clamp_list_limit, clamp_reply_limit, next_cursor, skip_past_ranked_cursor, split_page};
use super::ranking::{rank_comments, CommentSort};
use super::rules;
use super::text::hash_body;
use crate::dto::{CommentDto, CommentsListResponse, MentionDto};
use crate::repository::{
    CommentDedupeRepository, CommentLikeRepository, CommentMentionRepository, CommentRepository, CommentWithAuthor,
    NewComment, NewCommentDedupe, NewCommentMention,
};

/// The comment repositories, all on the same pool.
#[derive(Debug, Clone)]
pub struct CommentRepositories {
    pub comments: Arc<CommentRepository>,
    pub likes: Arc<CommentLikeRepository>,
    pub mentions: Arc<CommentMentionRepository>,
    pub dedupes: Arc<CommentDedupeRepository>,
}

impl CommentRepositories {
    pub fn new(pool: sqlx::PgPool) -> Self {
        Self {
            comments: Arc::new(CommentRepository::new(pool.clone())),
            likes: Arc::new(CommentLikeRepository::new(pool.clone())),
            mentions: Arc::new(CommentMentionRepository::new(pool.clone())),
            dedupes: Arc::new(CommentDedupeRepository::new(pool)),
        }
    }
}

/// A new comment or reply (Go passes these positionally to `CreateComment`).
#[derive(Debug, Clone, Copy)]
pub struct CreateComment<'a> {
    pub author_id: i64,
    /// From the caller's token; returned as `author_username`.
    pub author_username: &'a str,
    pub day_owner_id: i64,
    pub day_owner_username: &'a str,
    pub day_date: NaiveDate,
    /// Raw body; trimmed before validation and storage.
    pub body: &'a str,
    /// Set for replies.
    pub parent_comment_id: Option<i64>,
    /// `X-Idempotency-Key`; a retried request with the same key returns the first comment.
    pub idempotency_key: Option<&'a str>,
}

/// Comment business logic: creation with dedupe, mentions and notifications, deletion, likes,
/// listing and editing.
#[derive(Debug, Clone)]
pub struct CommentService {
    repos: CommentRepositories,
    user_repo: Arc<UserRepository>,
    notifier: CommentNotifier,
}

impl CommentService {
    /// Go `NewCommentService`. `follow_repo` and `notifications` are optional as in Go (nil
    /// skips the mention privacy check / all notifications).
    pub fn new(
        repos: CommentRepositories,
        user_repo: Arc<UserRepository>,
        follow_repo: Option<Arc<FollowRepository>>,
        notifications: Option<Arc<NotificationService>>,
    ) -> Self {
        let notifier = CommentNotifier { user_repo: user_repo.clone(), follow_repo, notifications };
        Self { repos, user_repo, notifier }
    }

    /// Creates a comment (or a reply when `parent_comment_id` is set). Returns the first
    /// comment again for a repeated idempotency key; rejects an identical body from the same
    /// author on the same day within the dedupe window. Notifications are sent in the
    /// background.
    pub async fn create_comment(&self, req: CreateComment<'_>) -> Result<CommentDto, CommentError> {
        let body = req.body.trim();

        if let Some(existing) = self.find_by_idempotency_key(req).await {
            return Ok(existing);
        }

        validate_comment_body(body)?;

        let body_hash = hash_body(body);
        match self
            .repos
            .dedupes
            .check_body_hash(req.author_id, req.day_owner_id, req.day_date, &body_hash, COMMENT_DEDUPE_WINDOW)
            .await
        {
            Ok(Some(_)) => {
                tracing::info!(
                    author_id = req.author_id,
                    day_owner_id = req.day_owner_id,
                    day_date = %req.day_date,
                    "Duplicate comment rejected (body hash)"
                );
                return Err(rules::duplicate_comment().into());
            }
            Ok(None) => {}
            Err(err) => {
                tracing::warn!(author_id = req.author_id, error = %err, "Body hash dedup check failed, proceeding");
            }
        }

        let mentioned_usernames = parse_mentions(body)?;

        let reply_target = match req.parent_comment_id {
            None => None,
            Some(parent_id) => {
                let parent = self.repos.comments.get_by_id(parent_id).await.ok().flatten();
                Some(rules::resolve_reply_target(parent.as_ref(), req.day_owner_id, req.day_date)?)
            }
        };

        let comment = self
            .repos
            .comments
            .create(&NewComment {
                day_owner_id: req.day_owner_id,
                day_date: req.day_date,
                author_id: req.author_id,
                parent_comment_id: req.parent_comment_id,
                root_comment_id: reply_target.map(|t| t.root_comment_id),
                reply_to_user_id: reply_target.map(|t| t.reply_to_user_id),
                body: body.to_string(),
                created_at: None,
            })
            .await
            .map_err(CommentError::db("failed to create comment"))?;

        let dedupe = NewCommentDedupe {
            user_id: req.author_id,
            day_owner_id: req.day_owner_id,
            day_date: req.day_date,
            body_hash,
            idempotency_key: req.idempotency_key.map(str::to_string),
            comment_id: comment.id,
        };
        if let Err(err) = self.repos.dedupes.upsert(&dedupe).await {
            tracing::warn!(comment_id = comment.id, error = %err, "Failed to store dedupe record, continuing");
        }

        if req.parent_comment_id.is_some() {
            if let Err(err) = self.repos.comments.increment_ancestor_reply_counts(comment.id).await {
                tracing::error!(comment_id = comment.id, error = %err, "Failed to increment ancestor reply counts");
            }
        }

        let mentions = self.resolve_mentions(comment.id, &mentioned_usernames).await;
        count_cache::invalidate_count_cache(req.day_owner_id, req.day_date).await;

        let author = self.user_repo.find_by_id(req.author_id).await.ok().flatten();
        let mut result = created_comment_dto(&comment, req.author_username, author.as_ref(), mentions.clone());
        if let Some(reply_to_user_id) = comment.reply_to_user_id {
            result.reply_to_username = self.reply_to_username(reply_to_user_id).await;
        }

        let notifier = self.notifier.clone();
        let created = CreatedComment {
            comment: comment.clone(),
            author_username: req.author_username.to_string(),
            author,
            day_owner_username: req.day_owner_username.to_string(),
            day_date: req.day_date,
            parent_author_id: reply_target.map(|t| t.reply_to_user_id),
            mentions,
        };
        tokio::spawn(async move { notifier.send_comment_notifications(created).await });

        tracing::info!(
            comment_id = comment.id,
            author_id = req.author_id,
            day_owner_id = req.day_owner_id,
            is_reply = req.parent_comment_id.is_some(),
            "Comment created"
        );
        Ok(result)
    }

    /// The comment previously created with the request's idempotency key, if it still exists.
    /// Lookup failures are logged and ignored.
    async fn find_by_idempotency_key(&self, req: CreateComment<'_>) -> Option<CommentDto> {
        let key = req.idempotency_key.filter(|k| !k.is_empty())?;
        let existing = match self.repos.dedupes.check_idempotency_key(key, COMMENT_DEDUPE_WINDOW).await {
            Ok(existing) => existing?,
            Err(err) => {
                tracing::warn!(key, error = %err, "Idempotency check failed, proceeding");
                return None;
            }
        };
        let comment = self.repos.comments.get_by_id_with_author(existing.comment_id).await.ok().flatten()?;
        tracing::debug!(key, comment_id = existing.comment_id, "Idempotency key matched, returning existing comment");
        Some(build_comment_dto(&comment, false, &[]))
    }

    /// Soft-deletes a comment when `requesting_user_id` is its author or the day owner.
    /// `day_owner_id` 0 means "the comment's own day owner".
    pub async fn delete_comment(
        &self,
        comment_id: i64,
        requesting_user_id: i64,
        day_owner_id: i64,
    ) -> Result<(), CommentError> {
        let comment = self.existing_comment(comment_id).await?;
        if let Err(err) = rules::check_can_delete(&comment, requesting_user_id, day_owner_id) {
            if err.code == gt_core::constants::ERR_CODE_COMMENT_FORBIDDEN {
                tracing::warn!(
                    comment_id,
                    requesting_user = requesting_user_id,
                    author_id = comment.author_id,
                    day_owner_id = rules::effective_day_owner_id(&comment, day_owner_id),
                    "Unauthorized comment delete attempt"
                );
            }
            return Err(err.into());
        }

        self.repos.comments.soft_delete(comment_id).await.map_err(CommentError::db("failed to delete comment"))?;

        if rules::decrements_ancestors_on_delete(&comment) {
            if let Err(err) = self.repos.comments.decrement_ancestor_reply_counts(comment.id).await {
                tracing::warn!(comment_id = comment.id, error = %err, "Failed to decrement ancestor reply counts");
            }
        }

        count_cache::invalidate_count_cache(comment.day_owner_id, comment.day_date).await;
        tracing::info!(comment_id, deleted_by = requesting_user_id, "Comment deleted");
        Ok(())
    }

    /// Likes a comment (idempotent). Returns `(liked, new_count)`; the author is notified of
    /// a new like by someone else.
    pub async fn like_comment(
        &self,
        comment_id: i64,
        user_id: i64,
        username: &str,
    ) -> Result<(bool, i64), CommentError> {
        let comment = self.existing_comment(comment_id).await?;
        rules::check_can_like(&comment)?;

        let created =
            self.repos.likes.create(comment_id, user_id).await.map_err(CommentError::db("failed to like comment"))?;
        if created {
            if let Err(err) = self.repos.likes.increment_like_count(comment_id).await {
                tracing::warn!(comment_id, error = %err, "Failed to increment like count");
            }
        }
        let new_count = rules::like_count_after_like(comment.like_count, created);
        tracing::debug!(comment_id, user_id, was_new_like = created, new_count, "Comment like processed");

        if created && comment.author_id != user_id && self.notifier.is_enabled() {
            self.notifier.send_comment_liked(&comment, user_id, username).await;
        }
        Ok((true, new_count))
    }

    /// Removes the user's like (idempotent). Returns `(liked, new_count)`.
    pub async fn unlike_comment(&self, comment_id: i64, user_id: i64) -> Result<(bool, i64), CommentError> {
        let comment = self.existing_comment(comment_id).await?;

        let removed =
            self.repos.likes.delete(comment_id, user_id).await.map_err(CommentError::db("failed to unlike comment"))?;
        if removed {
            if let Err(err) = self.repos.likes.decrement_like_count(comment_id).await {
                tracing::warn!(comment_id = comment.id, error = %err, "Failed to decrement like count");
            }
        }
        let new_count = rules::like_count_after_unlike(comment.like_count, removed);
        tracing::debug!(comment_id, user_id, was_removed = removed, new_count, "Comment unlike processed");
        Ok((false, new_count))
    }

    /// A page of a day's top-level comments. `Top` ranks up to three pages of the newest
    /// comments in memory (the cursor is then the last comment seen); `Newest` pages by id.
    pub async fn get_top_level_comments(
        &self,
        day_owner_id: i64,
        current_user_id: i64,
        day_date: NaiveDate,
        sort: CommentSort,
        cursor: Option<i64>,
        limit: i64,
    ) -> Result<CommentsListResponse, CommentError> {
        let limit = clamp_list_limit(limit);
        let comments = match sort {
            CommentSort::Top => {
                let mut comments = self
                    .repos
                    .comments
                    .get_top_level_by_day(day_owner_id, day_date, None, limit * 3)
                    .await
                    .map_err(CommentError::db("failed to get comments"))?;
                rank_comments(&mut comments, Utc::now());
                skip_past_ranked_cursor(comments, cursor, |c| c.comment.id)
            }
            CommentSort::Newest => self
                .repos
                .comments
                .get_top_level_by_day(day_owner_id, day_date, cursor, limit)
                .await
                .map_err(CommentError::db("failed to get comments"))?,
        };
        Ok(self.page(comments, limit, current_user_id).await)
    }

    /// A page of a thread's replies (any depth), oldest first.
    pub async fn get_replies(
        &self,
        root_comment_id: i64,
        current_user_id: i64,
        cursor: Option<i64>,
        limit: i64,
    ) -> Result<CommentsListResponse, CommentError> {
        let limit = clamp_reply_limit(limit);
        let comments = self
            .repos
            .comments
            .get_replies_by_root(root_comment_id, cursor, limit)
            .await
            .map_err(CommentError::db("failed to get replies"))?;
        Ok(self.page(comments, limit, current_user_id).await)
    }

    async fn page(&self, comments: Vec<CommentWithAuthor>, limit: i64, current_user_id: i64) -> CommentsListResponse {
        let (comments, has_more) = split_page(comments, limit);
        let comments = self.enrich_comments(&comments, current_user_id).await;
        let next_cursor = next_cursor(has_more, comments.last().map(|c| c.id));
        CommentsListResponse { success: true, comments, has_more, next_cursor }
    }

    /// A day's non-deleted comment count (cached in Redis for 5 minutes).
    pub async fn get_comment_count(&self, day_owner_id: i64, day_date: NaiveDate) -> Result<i64, sqlx::Error> {
        count_cache::get_comment_count(&self.repos.comments, day_owner_id, day_date).await
    }

    /// A comment by id, `None` when it does not exist.
    pub async fn get_comment_by_id(&self, comment_id: i64) -> Result<Option<Comment>, sqlx::Error> {
        self.repos.comments.get_by_id(comment_id).await
    }

    /// Edits a comment's body (author only, within the edit window) and replaces its mentions.
    /// No notifications are sent.
    pub async fn edit_comment(
        &self,
        comment_id: i64,
        requesting_user_id: i64,
        new_body: &str,
    ) -> Result<CommentDto, CommentError> {
        let comment = self.existing_comment(comment_id).await?;
        if let Err(err) = rules::check_can_edit(&comment, requesting_user_id, Utc::now()) {
            if err.code == gt_core::constants::ERR_CODE_COMMENT_FORBIDDEN {
                tracing::warn!(
                    comment_id,
                    requesting_user = requesting_user_id,
                    author_id = comment.author_id,
                    "Unauthorized comment edit attempt"
                );
            }
            return Err(err.into());
        }

        let body = new_body.trim();
        validate_comment_body(body)?;
        // Mentions are validated before saving so a rejected edit leaves the comment unchanged.
        let mentioned_usernames = parse_mentions(body)?;

        self.repos
            .comments
            .update_body(comment_id, body)
            .await
            .map_err(CommentError::db("failed to update comment"))?;

        if let Err(err) = self.repos.mentions.delete_by_comment_id(comment_id).await {
            tracing::warn!(comment_id, error = %err, "Failed to delete old mentions during edit");
        }
        self.resolve_mentions(comment_id, &mentioned_usernames).await;

        let updated = match self.repos.comments.get_by_id_with_author(comment_id).await {
            Ok(Some(updated)) => updated,
            Ok(None) => return Err(CommentError::db("failed to fetch updated comment")(sqlx::Error::RowNotFound)),
            Err(err) => return Err(CommentError::db("failed to fetch updated comment")(err)),
        };
        let mentions = self.repos.mentions.get_by_comment_id(comment_id).await.unwrap_or_default();
        let liked = self.repos.likes.batch_has_liked(&[comment_id], requesting_user_id).await.unwrap_or_default();

        let mut result = build_comment_dto(&updated, liked.contains(&comment_id), &mentions);
        if let Some(reply_to_user_id) = updated.comment.reply_to_user_id {
            result.reply_to_username = self.reply_to_username(reply_to_user_id).await;
        }
        tracing::info!(comment_id, edited_by = requesting_user_id, "Comment edited");
        Ok(result)
    }

    // ==================== Helpers ====================

    /// The comment, or `COMMENT_NOT_FOUND` (also when the lookup fails, as in Go).
    async fn existing_comment(&self, comment_id: i64) -> Result<Comment, CommentError> {
        match self.repos.comments.get_by_id(comment_id).await {
            Ok(Some(comment)) => Ok(comment),
            Ok(None) | Err(_) => Err(rules::comment_not_found().into()),
        }
    }

    /// The username of a reply target; `None` when it cannot be resolved or is empty.
    async fn reply_to_username(&self, user_id: i64) -> Option<String> {
        self.repos.comments.get_reply_to_username(user_id).await.ok().flatten().filter(|name| !name.is_empty())
    }

    /// Adds liked-by-me, mentions and reply-to usernames to a page. Lookup failures degrade to
    /// "not liked" / "no mentions" / no reply-to username.
    async fn enrich_comments(&self, comments: &[CommentWithAuthor], current_user_id: i64) -> Vec<CommentDto> {
        if comments.is_empty() {
            return Vec::new();
        }
        let ids: Vec<i64> = comments.iter().map(|c| c.comment.id).collect();
        let liked = self.repos.likes.batch_has_liked(&ids, current_user_id).await.unwrap_or_else(|err| {
            tracing::warn!(error = %err, "Failed to batch check likes");
            Default::default()
        });
        let mentions = self.repos.mentions.get_by_comment_ids(&ids).await.unwrap_or_else(|err| {
            tracing::warn!(error = %err, "Failed to batch get mentions");
            Default::default()
        });
        let mut reply_to_usernames = HashMap::new();
        for user_id in reply_to_user_ids(comments) {
            if let Some(name) = self.reply_to_username(user_id).await {
                reply_to_usernames.insert(user_id, name);
            }
        }
        assemble_comment_dtos(comments, &liked, &mentions, &reply_to_usernames)
    }

    /// Resolves `@usernames` to users, stores the mentions and returns them. Unknown users are
    /// dropped; lookup failures drop every mention; storage failures are only logged.
    async fn resolve_mentions(&self, comment_id: i64, usernames: &[String]) -> Vec<MentionDto> {
        if usernames.is_empty() {
            return Vec::new();
        }
        let users = match self.user_repo.find_by_usernames(usernames).await {
            Ok(users) => users,
            Err(err) => {
                tracing::warn!(comment_id, ?usernames, error = %err, "Failed to resolve mention usernames");
                return Vec::new();
            }
        };
        if users.is_empty() {
            return Vec::new();
        }
        tracing::debug!(comment_id, requested = usernames.len(), resolved = users.len(), "Mentions resolved");

        let records: Vec<NewCommentMention> = users
            .iter()
            .map(|u| NewCommentMention { comment_id, mentioned_user_id: u.id, username: u.username.clone() })
            .collect();
        if let Err(err) = self.repos.mentions.create_batch(&records).await {
            tracing::warn!(comment_id, error = %err, "Failed to store mentions");
        }
        users.into_iter().map(|u| MentionDto { user_id: u.id, username: u.username }).collect()
    }
}
