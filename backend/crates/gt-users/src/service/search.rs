//! `SearchSuggestionsService` (port of the search suggestions part of
//! `internal/services/services.go`).

use std::sync::Arc;

use crate::repository::{RecentSearchRepository, RecentSearchResult, TrendingUserResult};

/// Recent profile searches and trending users for the search box.
#[derive(Debug, Clone)]
pub struct SearchSuggestionsService {
    recent_search_repo: Arc<RecentSearchRepository>,
}

impl SearchSuggestionsService {
    /// Go `NewSearchSuggestionsService`.
    pub fn new(recent_search_repo: Arc<RecentSearchRepository>) -> Self {
        Self { recent_search_repo }
    }

    /// Records a profile view from search (throttled to one refresh per 60 s; self and invalid
    /// ids are ignored).
    pub async fn save_recent_search(&self, user_id: i64, searched_user_id: i64) -> Result<(), sqlx::Error> {
        self.recent_search_repo.save_recent_search(user_id, searched_user_id).await
    }

    /// The user's recent searches, newest first (`limit` defaults to 5, max 10).
    pub async fn get_recent_searches(&self, user_id: i64, limit: i64) -> Result<Vec<RecentSearchResult>, sqlx::Error> {
        self.recent_search_repo.get_recent_searches(user_id, limit).await
    }

    /// Removes one recent search.
    pub async fn delete_recent_search(&self, user_id: i64, searched_user_id: i64) -> Result<(), sqlx::Error> {
        self.recent_search_repo.delete_recent_search(user_id, searched_user_id).await
    }

    /// Removes all of the user's recent searches.
    pub async fn clear_recent_searches(&self, user_id: i64) -> Result<(), sqlx::Error> {
        self.recent_search_repo.clear_recent_searches(user_id).await
    }

    /// Personalized trending users based on what the user's followers engaged with (`limit`
    /// defaults to 6, max 10).
    pub async fn get_trending_users_for_user(
        &self,
        user_id: i64,
        limit: i64,
    ) -> Result<Vec<TrendingUserResult>, sqlx::Error> {
        self.recent_search_repo.get_trending_users_for_user(user_id, limit).await
    }
}
