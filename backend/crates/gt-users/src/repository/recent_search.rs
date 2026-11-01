//! `RecentSearchRepository` (port of the recent-search part of `internal/repository/repository.go`).
//!
//! `recent_searches` (created by a Go-era migration) has `integer` ids and a `TIMESTAMP WITHOUT
//! TIME ZONE` column; ids are bound as `int8` and PostgreSQL casts them on assignment/comparison.

use serde::Serialize;
use sqlx::PgPool;

/// A recently searched user, with details for the suggestions list.
#[derive(Debug, Clone, PartialEq, Serialize, sqlx::FromRow)]
pub struct RecentSearchResult {
    pub id: i64,
    pub username: String,
    pub profile_pic: Option<String>,
    pub profile_pic_thumb: Option<String>,
    pub is_verified: bool,
    pub followers_count: i64,
}

/// A trending user with the number of the viewer's followers who engaged with them recently.
#[derive(Debug, Clone, PartialEq, Serialize, sqlx::FromRow)]
pub struct TrendingUserResult {
    pub id: i64,
    pub username: String,
    pub profile_pic: Option<String>,
    pub profile_pic_thumb: Option<String>,
    pub is_verified: bool,
    pub followers_count: i64,
    pub interaction_count: i64,
}

const RECENT_DEFAULT_LIMIT: i64 = 5;
const RECENT_MAX_LIMIT: i64 = 10;
const TRENDING_DEFAULT_LIMIT: i64 = 6;
const TRENDING_MAX_LIMIT: i64 = 10;

/// Verbatim from Go (plus a COALESCE so NULL `is_verified` decodes as false, as GORM did).
const RECENT_SEARCHES_SQL: &str = "
		SELECT 
			u.id,
			u.username,
			u.profile_pic,
			u.profile_pic_thumb,
			COALESCE(u.is_verified, false) AS is_verified,
			COALESCE(fc.followers_count, 0) as followers_count
		FROM recent_searches rs
		JOIN users u ON u.id = rs.searched_user_id
		LEFT JOIN follow_counters fc ON fc.user_id = u.id
		WHERE rs.user_id = $1
		ORDER BY rs.searched_at DESC
		LIMIT $2
	";

/// Users the viewer's followers engaged with in the last 7 days (story likes, day likes, new
/// follows), restricted to public accounts or private ones followed by someone the viewer
/// follows, excluding the viewer and users they already follow; verified first, then by
/// interactions and followers. Padded with a global ranking (verified, followers). Verbatim from
/// Go apart from COALESCE on `is_verified` (GORM read NULL as false).
const TRENDING_SQL: &str = "
		WITH my_followers AS (
			SELECT follower_id 
			FROM follow_edges_by_followee 
			WHERE followee_id = $1 AND state = 'ACTIVE'
		),
		my_following AS (
			SELECT followee_id 
			FROM follow_edges_by_follower 
			WHERE follower_id = $1 AND state = 'ACTIVE'
		),
		follower_interactions AS (
			-- Story likes from my followers
			SELECT 
				ap.user_id as target_user_id,
				sl.liker_id as follower_id,
				sl.liked_at as interaction_time
			FROM story_likes sl
			JOIN activity_photos ap ON ap.id = sl.photo_id
			WHERE sl.liker_id IN (SELECT follower_id FROM my_followers)
			AND sl.liked_at > NOW() - INTERVAL '7 days'
			
			UNION ALL
			
			-- Day likes from my followers
			SELECT 
				l.liked_user_id as target_user_id,
				l.liker_id as follower_id,
				l.created_at as interaction_time
			FROM likes l
			WHERE l.liker_id IN (SELECT follower_id FROM my_followers)
			AND l.created_at > NOW() - INTERVAL '7 days'
			
			UNION ALL
			
			-- New follows from my followers
			SELECT 
				fe.followee_id as target_user_id,
				fe.follower_id,
				fe.created_at as interaction_time
			FROM follow_edges_by_follower fe
			WHERE fe.follower_id IN (SELECT follower_id FROM my_followers)
			AND fe.state = 'ACTIVE'
			AND fe.created_at > NOW() - INTERVAL '7 days'
		),
		personalized_trending AS (
			SELECT 
				u.id,
				u.username,
				u.profile_pic,
				u.profile_pic_thumb,
				COALESCE(u.is_verified, false) AS is_verified,
				COALESCE(fc.followers_count, 0) as followers_count,
				COUNT(DISTINCT fi.follower_id) as interaction_count
			FROM follower_interactions fi
			JOIN users u ON u.id = fi.target_user_id
			LEFT JOIN follow_counters fc ON fc.user_id = u.id
			WHERE u.id != $1
			-- Exclude users I already follow
			AND u.id NOT IN (SELECT followee_id FROM my_following)
			-- Allow public users OR private users with mutual followers
			AND (
				u.is_private = false
				OR EXISTS (
					-- Has mutual followers: someone I follow also follows them
					SELECT 1 FROM follow_edges_by_follower mf
					WHERE mf.follower_id IN (SELECT followee_id FROM my_following)
					AND mf.followee_id = u.id
					AND mf.state = 'ACTIVE'
				)
			)
			GROUP BY u.id, u.username, u.profile_pic, u.profile_pic_thumb, u.is_verified, fc.followers_count
			ORDER BY 
				CASE WHEN u.is_verified THEN 1 ELSE 0 END DESC,
				interaction_count DESC,
				followers_count DESC
			LIMIT $2
		),
		global_trending AS (
			SELECT 
				u.id,
				u.username,
				u.profile_pic,
				u.profile_pic_thumb,
				COALESCE(u.is_verified, false) AS is_verified,
				COALESCE(fc.followers_count, 0) as followers_count,
				0 as interaction_count
			FROM users u
			LEFT JOIN follow_counters fc ON fc.user_id = u.id
			WHERE u.id != $1
			-- Exclude users I already follow
			AND u.id NOT IN (SELECT followee_id FROM my_following)
			-- Allow public users OR private users with mutual followers
			AND (
				u.is_private = false
				OR EXISTS (
					SELECT 1 FROM follow_edges_by_follower mf
					WHERE mf.follower_id IN (SELECT followee_id FROM my_following)
					AND mf.followee_id = u.id
					AND mf.state = 'ACTIVE'
				)
			)
			-- Exclude users already in personalized results
			AND u.id NOT IN (SELECT id FROM personalized_trending)
			ORDER BY 
				CASE WHEN u.is_verified THEN 1 ELSE 0 END DESC,
				followers_count DESC
			LIMIT $2
		)
		-- Combine personalized + global fallback, limit to requested count
		SELECT * FROM personalized_trending
		UNION ALL
		SELECT * FROM global_trending
		LIMIT $2
	";

/// Handles recent search data operations.
#[derive(Debug, Clone)]
pub struct RecentSearchRepository {
    pool: PgPool,
}

impl RecentSearchRepository {
    /// A repository over `pool`.
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// Records that `user_id` viewed `searched_user_id`'s profile. Repeats within 60 seconds keep
    /// the old timestamp (throttle). Invalid ids (0) and self-searches are silently ignored.
    pub async fn save_recent_search(&self, user_id: i64, searched_user_id: i64) -> Result<(), sqlx::Error> {
        if user_id <= 0 || searched_user_id <= 0 || user_id == searched_user_id {
            return Ok(());
        }
        sqlx::query(
            "INSERT INTO recent_searches (user_id, searched_user_id, searched_at) VALUES ($1, $2, NOW()) \
             ON CONFLICT (user_id, searched_user_id) DO UPDATE SET searched_at = NOW() \
             WHERE recent_searches.searched_at < NOW() - INTERVAL '60 seconds'",
        )
        .bind(user_id)
        .bind(searched_user_id)
        .execute(&self.pool)
        .await
        .map(|_| ())
    }

    /// The user's most recent searches, newest first. `limit` defaults to 5 and is capped at 10;
    /// user 0 has none (Go returned nil without querying).
    pub async fn get_recent_searches(&self, user_id: i64, limit: i64) -> Result<Vec<RecentSearchResult>, sqlx::Error> {
        if user_id <= 0 {
            return Ok(Vec::new());
        }
        sqlx::query_as::<_, RecentSearchResult>(RECENT_SEARCHES_SQL)
            .bind(user_id)
            .bind(clamp(limit, RECENT_DEFAULT_LIMIT, RECENT_MAX_LIMIT))
            .fetch_all(&self.pool)
            .await
    }

    /// Removes one entry from the user's recent searches (invalid ids are ignored).
    pub async fn delete_recent_search(&self, user_id: i64, searched_user_id: i64) -> Result<(), sqlx::Error> {
        if user_id <= 0 || searched_user_id <= 0 {
            return Ok(());
        }
        sqlx::query("DELETE FROM recent_searches WHERE user_id = $1 AND searched_user_id = $2")
            .bind(user_id)
            .bind(searched_user_id)
            .execute(&self.pool)
            .await
            .map(|_| ())
    }

    /// Removes all of the user's recent searches (user 0 is ignored).
    pub async fn clear_recent_searches(&self, user_id: i64) -> Result<(), sqlx::Error> {
        if user_id <= 0 {
            return Ok(());
        }
        sqlx::query("DELETE FROM recent_searches WHERE user_id = $1")
            .bind(user_id)
            .execute(&self.pool)
            .await
            .map(|_| ())
    }

    /// Personalized trending users padded with global trending ones (see [`TRENDING_SQL`]).
    /// `limit` defaults to 6 and is capped at 10; user 0 gets none.
    pub async fn get_trending_users_for_user(
        &self,
        user_id: i64,
        limit: i64,
    ) -> Result<Vec<TrendingUserResult>, sqlx::Error> {
        if user_id <= 0 {
            return Ok(Vec::new());
        }
        sqlx::query_as::<_, TrendingUserResult>(TRENDING_SQL)
            .bind(user_id)
            .bind(clamp(limit, TRENDING_DEFAULT_LIMIT, TRENDING_MAX_LIMIT))
            .fetch_all(&self.pool)
            .await
    }
}

fn clamp(limit: i64, default: i64, max: i64) -> i64 {
    if limit <= 0 {
        default
    } else {
        limit.min(max)
    }
}

#[cfg(test)]
mod tests {
    use super::clamp;

    #[test]
    fn limits_default_and_cap() {
        for (limit, want) in [(-1, 5), (0, 5), (3, 3), (10, 10), (11, 10), (50, 10)] {
            assert_eq!(clamp(limit, 5, 10), want);
        }
        for (limit, want) in [(-1, 6), (0, 6), (4, 4), (11, 10)] {
            assert_eq!(clamp(limit, 6, 10), want);
        }
    }
}
