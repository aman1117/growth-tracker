//! `BadgeRepository` (port of `internal/repository/badge_repository.go`).

use gt_core::gojson;
use gt_core::models::UserBadge;
use sqlx::{PgPool, Postgres, QueryBuilder};

/// Handles badge data operations.
#[derive(Debug, Clone)]
pub struct BadgeRepository {
    pool: PgPool,
}

/// GORM omits a zero `earned_at` so the column default (`now()`) applies.
fn earned_at_or_default(badge: &UserBadge) -> Option<chrono::DateTime<chrono::Utc>> {
    (!gojson::is_go_zero_time(&badge.earned_at)).then_some(badge.earned_at)
}

impl BadgeRepository {
    /// A repository over `pool`.
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// Inserts `badge` and stores the generated id (and `earned_at` when it was defaulted).
    pub async fn create(&self, badge: &mut UserBadge) -> Result<(), sqlx::Error> {
        self.create_batch(std::slice::from_mut(badge)).await
    }

    /// Inserts all badges in one statement (all or nothing) and stores their generated ids.
    pub async fn create_batch(&self, badges: &mut [UserBadge]) -> Result<(), sqlx::Error> {
        if badges.is_empty() {
            return Ok(());
        }
        let mut builder: QueryBuilder<Postgres> =
            QueryBuilder::new("INSERT INTO user_badges (user_id, badge_key, earned_at) ");
        builder.push_values(badges.iter(), |mut row, badge| {
            row.push_bind(badge.user_id)
                .push_bind(badge.badge_key.clone())
                .push("COALESCE(")
                .push_bind_unseparated(earned_at_or_default(badge))
                .push_unseparated("::timestamptz, now())");
        });
        builder.push(" RETURNING id, earned_at");
        let rows: Vec<(i64, chrono::DateTime<chrono::Utc>)> = builder.build_query_as().fetch_all(&self.pool).await?;
        for (badge, (id, earned_at)) in badges.iter_mut().zip(rows) {
            badge.id = id;
            badge.earned_at = earned_at;
        }
        Ok(())
    }

    /// All badges of the user, earliest first.
    pub async fn find_by_user_id(&self, user_id: i64) -> Result<Vec<UserBadge>, sqlx::Error> {
        let sql = format!("SELECT {} FROM user_badges WHERE user_id = $1 ORDER BY earned_at ASC", UserBadge::COLUMNS);
        sqlx::query_as::<_, UserBadge>(&sql).bind(user_id).fetch_all(&self.pool).await
    }

    /// All badges of the given users, earliest first.
    pub async fn find_by_user_ids(&self, user_ids: &[i64]) -> Result<Vec<UserBadge>, sqlx::Error> {
        let sql =
            format!("SELECT {} FROM user_badges WHERE user_id = ANY($1) ORDER BY earned_at ASC", UserBadge::COLUMNS);
        sqlx::query_as::<_, UserBadge>(&sql).bind(user_ids).fetch_all(&self.pool).await
    }

    /// Whether the user already earned `badge_key`.
    pub async fn exists_by_user_and_key(&self, user_id: i64, badge_key: &str) -> Result<bool, sqlx::Error> {
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM user_badges WHERE user_id = $1 AND badge_key = $2")
            .bind(user_id)
            .bind(badge_key)
            .fetch_one(&self.pool)
            .await?;
        Ok(count > 0)
    }

    /// Keys of every badge the user earned (no particular order).
    pub async fn get_earned_badge_keys(&self, user_id: i64) -> Result<Vec<String>, sqlx::Error> {
        sqlx::query_scalar("SELECT badge_key FROM user_badges WHERE user_id = $1")
            .bind(user_id)
            .fetch_all(&self.pool)
            .await
    }

    /// Deletes all badges of the user.
    pub async fn delete_by_user_id(&self, user_id: i64) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM user_badges WHERE user_id = $1").bind(user_id).execute(&self.pool).await.map(|_| ())
    }
}
