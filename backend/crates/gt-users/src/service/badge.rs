//! `BadgeService` (port of `internal/services/badge.go`).

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use chrono::{DateTime, Utc};
use gt_core::badges;
use gt_core::gojson;
use gt_core::models::UserBadge;
use gt_core::timeutil;

use crate::dto::BadgeDto;
use crate::repository::{BadgeRepository, UserRepository};

/// Streak badges: awarding and listing.
#[derive(Debug, Clone)]
pub struct BadgeService {
    badge_repo: Arc<BadgeRepository>,
    user_repo: Arc<UserRepository>,
}

/// `YYYY-MM-DD` of an earned time in the process time zone (Go formats the pgx-decoded
/// local-zone `time.Time`; production runs in UTC).
fn earned_date(earned_at: &DateTime<Utc>) -> String {
    timeutil::format_date(&gojson::to_go_local(earned_at).date_naive())
}

impl BadgeService {
    /// Go `NewBadgeService`.
    pub fn new(badge_repo: Arc<BadgeRepository>, user_repo: Arc<UserRepository>) -> Self {
        Self { badge_repo, user_repo }
    }

    /// Awards every badge `longest_streak` qualifies for that the user does not have yet (in one
    /// insert) and returns the newly awarded ones, in threshold order. Empty when nothing is new
    /// (Go returned nil; the `new_badges` field is `omitempty`).
    pub async fn check_and_award_badges(
        &self,
        user_id: i64,
        longest_streak: i64,
    ) -> Result<Vec<BadgeDto>, sqlx::Error> {
        let eligible = badges::eligible_badge_keys(longest_streak);
        if eligible.is_empty() {
            return Ok(Vec::new());
        }
        let earned: HashSet<String> = self.badge_repo.get_earned_badge_keys(user_id).await?.into_iter().collect();

        let now = Utc::now();
        let mut new_badges: Vec<UserBadge> = eligible
            .into_iter()
            .filter(|key| !earned.contains(*key))
            .map(|key| UserBadge { id: 0, user_id, badge_key: key.to_string(), earned_at: now })
            .collect();
        if new_badges.is_empty() {
            return Ok(Vec::new());
        }
        self.badge_repo.create_batch(&mut new_badges).await?;

        Ok(new_badges
            .iter()
            .filter_map(|badge| {
                let def = badges::badge_by_key(&badge.badge_key)?;
                // Go formatted the in-memory time, not the stored one.
                Some(BadgeDto { earned_at: earned_date(&now), ..BadgeDto::from_badge(def) })
            })
            .collect())
    }

    /// Every badge definition, in threshold order, marked with whether (and when) the user
    /// earned it.
    pub async fn get_user_badges(&self, user_id: i64) -> Result<Vec<BadgeDto>, sqlx::Error> {
        let earned: HashMap<String, DateTime<Utc>> =
            self.badge_repo.find_by_user_id(user_id).await?.into_iter().map(|b| (b.badge_key, b.earned_at)).collect();
        Ok(badges::all_badges()
            .iter()
            .map(|def| {
                let mut dto = BadgeDto::from_badge(def);
                if let Some(earned_at) = earned.get(def.key) {
                    dto.earned = true;
                    dto.earned_at = earned_date(earned_at);
                }
                dto
            })
            .collect())
    }

    /// [`BadgeService::get_user_badges`] by username (badges are always public); `None` when the
    /// user does not exist.
    pub async fn get_badges_by_username(&self, username: &str) -> Result<Option<Vec<BadgeDto>>, sqlx::Error> {
        let Some(user) = self.user_repo.find_by_username(username).await? else {
            return Ok(None);
        };
        self.get_user_badges(user.id).await.map(Some)
    }

    /// Awards `badge_key` with a specific `earned_at` (migrations); a no-op when already earned.
    pub async fn award_badge_with_date(
        &self,
        user_id: i64,
        badge_key: &str,
        earned_at: DateTime<Utc>,
    ) -> Result<(), sqlx::Error> {
        if self.badge_repo.exists_by_user_and_key(user_id, badge_key).await? {
            return Ok(());
        }
        let mut badge = UserBadge { id: 0, user_id, badge_key: badge_key.to_string(), earned_at };
        self.badge_repo.create(&mut badge).await
    }
}
