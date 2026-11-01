//! `ProfileService` (port of the profile part of `internal/services/services.go`).

use std::sync::Arc;

use gt_core::models::User;

use crate::repository::{AutocompleteResult, FollowRepository, UserRepository};

/// Profile settings, user search and profile visibility.
#[derive(Debug, Clone)]
pub struct ProfileService {
    user_repo: Arc<UserRepository>,
    follow_repo: Arc<FollowRepository>,
}

impl ProfileService {
    /// Go `NewProfileService`.
    pub fn new(user_repo: Arc<UserRepository>, follow_repo: Arc<FollowRepository>) -> Self {
        Self { user_repo, follow_repo }
    }

    /// The user's full record, or `None`.
    pub async fn get_profile(&self, user_id: i64) -> Result<Option<User>, sqlx::Error> {
        self.user_repo.find_by_id(user_id).await
    }

    /// Sets the privacy flag.
    pub async fn update_privacy(&self, user_id: i64, is_private: bool) -> Result<(), sqlx::Error> {
        self.user_repo.update_privacy(user_id, is_private).await
    }

    /// The privacy flag; `Err(RowNotFound)` for an unknown user.
    pub async fn get_privacy(&self, user_id: i64) -> Result<bool, sqlx::Error> {
        self.user_repo.get_privacy(user_id).await
    }

    /// Sets the bio (empty clears it).
    pub async fn update_bio(&self, user_id: i64, bio: &str) -> Result<(), sqlx::Error> {
        self.user_repo.update_bio(user_id, bio).await
    }

    /// The bio (`None` when unset); `Err(RowNotFound)` for an unknown user.
    pub async fn get_bio(&self, user_id: i64) -> Result<Option<String>, sqlx::Error> {
        self.user_repo.get_bio(user_id).await
    }

    /// Sets or clears the profile picture and thumbnail URLs.
    pub async fn update_profile_pic(
        &self,
        user_id: i64,
        url: Option<&str>,
        thumb_url: Option<&str>,
    ) -> Result<(), sqlx::Error> {
        self.user_repo.update_profile_pic(user_id, url, thumb_url).await
    }

    /// Case-insensitive username substring search (includes private users).
    pub async fn search_users(&self, query: &str) -> Result<Vec<User>, sqlx::Error> {
        self.user_repo.search_by_username(query).await
    }

    /// Ranked username autocomplete (see [`UserRepository::autocomplete_users`]).
    pub async fn autocomplete_users(&self, query: &str, limit: i64) -> Result<Vec<AutocompleteResult>, sqlx::Error> {
        self.user_repo.autocomplete_users(query, limit).await
    }

    /// Whether `current_user_id` (0 = anonymous) may see `target`'s profile data: always for
    /// their own and public profiles; for private ones only as an accepted follower. Lookup
    /// failures deny access.
    pub async fn can_view_profile(&self, target: Option<&User>, current_user_id: i64) -> bool {
        let Some(target) = target else { return false };
        if target.id == current_user_id || !target.is_private {
            return true;
        }
        if current_user_id > 0 {
            return matches!(self.follow_repo.is_following(current_user_id, target.id).await, Ok(true));
        }
        false
    }
}
