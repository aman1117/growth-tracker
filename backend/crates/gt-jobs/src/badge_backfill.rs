//! Badge backfill (port of `migrations/seed_badges.go`): awards existing users every badge
//! their longest streak qualifies for, dated the first day they reached each threshold.

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, NaiveDate, NaiveTime, Utc};
use gt_core::badges;
use gt_core::models::UserBadge;
use gt_users::BadgeRepository;
use sqlx::PgPool;

/// A user's streak summary.
#[derive(Debug, Clone, PartialEq, Eq, sqlx::FromRow)]
pub struct UserStreak {
    pub user_id: i64,
    pub max_longest: i64,
    pub first_streak_at: Option<NaiveDate>,
}

/// Every user with a positive streak, with their best streak (no particular order).
pub async fn load_user_streaks(pool: &PgPool) -> Result<Vec<UserStreak>, sqlx::Error> {
    sqlx::query_as::<_, UserStreak>(
        "SELECT user_id, MAX(longest) AS max_longest, MIN(activity_date) AS first_streak_at \
         FROM streaks WHERE longest > 0 GROUP BY user_id",
    )
    .fetch_all(pool)
    .await
}

/// Awards the badges `max_longest` qualifies for that the user lacks, in one insert, and
/// returns how many were created. Each badge is dated midnight UTC of the first day the user's
/// longest streak reached its threshold (now when that day is unknown).
pub async fn seed_badges_for_user(
    pool: &PgPool,
    badge_repo: &BadgeRepository,
    user_id: i64,
    max_longest: i64,
) -> Result<usize, sqlx::Error> {
    let eligible = badges::eligible_badge_keys(max_longest);
    if eligible.is_empty() {
        return Ok(0);
    }
    let earned: HashSet<String> = badge_repo.get_earned_badge_keys(user_id).await?.into_iter().collect();

    let mut first_reached: HashMap<&str, DateTime<Utc>> = HashMap::new();
    for badge in badges::all_badges().iter().filter(|b| b.threshold <= max_longest) {
        let date: Option<Option<NaiveDate>> = sqlx::query_scalar(
            "SELECT activity_date FROM streaks WHERE user_id = $1 AND longest >= $2 ORDER BY activity_date ASC LIMIT 1",
        )
        .bind(user_id)
        .bind(badge.threshold)
        .fetch_optional(pool)
        .await
        .unwrap_or_default();
        // Go ignored lookup errors and left the badge dated "now".
        if let Some(Some(date)) = date {
            first_reached.insert(badge.key, date.and_time(NaiveTime::MIN).and_utc());
        }
    }

    let now = Utc::now();
    let mut new_badges: Vec<UserBadge> = eligible
        .into_iter()
        .filter(|key| !earned.contains(*key))
        .map(|key| UserBadge {
            id: 0,
            user_id,
            badge_key: key.to_string(),
            earned_at: first_reached.get(key).copied().unwrap_or(now),
        })
        .collect();
    if new_badges.is_empty() {
        return Ok(0);
    }
    badge_repo.create_batch(&mut new_badges).await?;
    Ok(new_badges.len())
}
