//! `UserRepository` (port of the user half of `internal/repository/repository.go`).

use gt_core::models::User;
use serde::Serialize;
use sqlx::PgPool;

/// A user ranked by [`UserRepository::autocomplete_users`].
#[derive(Debug, Clone, PartialEq, Serialize, sqlx::FromRow)]
pub struct AutocompleteResult {
    pub id: i64,
    pub username: String,
    pub profile_pic: Option<String>,
    pub profile_pic_thumb: Option<String>,
    pub is_verified: bool,
    pub is_private: bool,
    pub followers_count: i64,
    pub score: f64,
}

/// Default and maximum number of autocomplete results.
const AUTOCOMPLETE_DEFAULT_LIMIT: i64 = 12;
const AUTOCOMPLETE_MAX_LIMIT: i64 = 20;

/// Ranking: exact match (100) > prefix match (50 + similarity * 30) > trigram similarity above
/// 0.15 (similarity * 30), then followers DESC, username ASC. `$1` is the raw query (equality and
/// similarity), `$3` the LIKE-escaped one. Verbatim from Go, plus casts/COALESCEs so the row
/// decodes without NUMERIC or NULL booleans.
const AUTOCOMPLETE_SQL: &str = r"
		SELECT 
			u.id,
			u.username,
			u.profile_pic,
			u.profile_pic_thumb,
			COALESCE(u.is_verified, false) AS is_verified,
			COALESCE(u.is_private, false) AS is_private,
			COALESCE(fc.followers_count, 0) as followers_count,
			(CASE 
				WHEN lower(u.username) = lower($1) THEN 100.0
				WHEN lower(u.username) LIKE lower($3) || '%' ESCAPE '\' THEN 50.0 + (similarity(u.username, $1) * 30.0)
				WHEN similarity(u.username, $1) > 0.15 THEN similarity(u.username, $1) * 30.0
				ELSE 0.0
			END)::float8 as score
		FROM users u
		LEFT JOIN follow_counters fc ON fc.user_id = u.id
		WHERE 
			lower(u.username) = lower($1)
			OR lower(u.username) LIKE lower($3) || '%' ESCAPE '\'
			OR similarity(u.username, $1) > 0.15
		ORDER BY 
			score DESC,
			followers_count DESC,
			u.username ASC
		LIMIT $2
	";

/// Handles user data operations.
#[derive(Debug, Clone)]
pub struct UserRepository {
    pool: PgPool,
}

impl UserRepository {
    /// A repository over `pool`.
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// Creates a user and its zeroed `follow_counters` row in one transaction.
    pub async fn create(&self, email: &str, username: &str, password_hash: &str) -> Result<(), sqlx::Error> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("INSERT INTO users (email, username, password_hash) VALUES ($1, $2, $3)")
            .bind(email)
            .bind(username)
            .bind(password_hash)
            .execute(&mut *tx)
            .await?;
        // GORM `Raw(...).Scan(&userID)`: no row leaves the id at 0 without an error.
        let user_id: i64 = sqlx::query_scalar("SELECT id FROM users WHERE email = $1")
            .bind(email)
            .fetch_optional(&mut *tx)
            .await?
            .unwrap_or(0);
        sqlx::query(
            "INSERT INTO follow_counters (user_id, followers_count, following_count, pending_requests_count, updated_at) \
             VALUES ($1, 0, 0, 0, NOW()) ON CONFLICT (user_id) DO NOTHING",
        )
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await
    }

    /// GORM `Where(cond).First(&user)`: the lowest id matching `cond`, `None` when there is none.
    async fn first_where(&self, condition: &str, value: &str) -> Result<Option<User>, sqlx::Error> {
        let sql = format!("SELECT {} FROM users WHERE {condition} ORDER BY id LIMIT 1", User::COLUMNS);
        sqlx::query_as::<_, User>(&sql).bind(value).fetch_optional(&self.pool).await
    }

    /// The user with `id`, or `None`.
    pub async fn find_by_id(&self, id: i64) -> Result<Option<User>, sqlx::Error> {
        let sql = format!("SELECT {} FROM users WHERE id = $1 ORDER BY id LIMIT 1", User::COLUMNS);
        sqlx::query_as::<_, User>(&sql).bind(id).fetch_optional(&self.pool).await
    }

    /// The user whose email or username equals `identifier` (lowest id first), or `None`.
    pub async fn find_by_identifier(&self, identifier: &str) -> Result<Option<User>, sqlx::Error> {
        self.first_where("email = $1 OR username = $1", identifier).await
    }

    /// The user with exactly this username, or `None`.
    pub async fn find_by_username(&self, username: &str) -> Result<Option<User>, sqlx::Error> {
        self.first_where("username = $1", username).await
    }

    /// Users whose username is in `usernames` (no particular order). Empty input skips the query.
    pub async fn find_by_usernames(&self, usernames: &[String]) -> Result<Vec<User>, sqlx::Error> {
        if usernames.is_empty() {
            return Ok(Vec::new());
        }
        let sql = format!("SELECT {} FROM users WHERE username = ANY($1)", User::COLUMNS);
        sqlx::query_as::<_, User>(&sql).bind(usernames).fetch_all(&self.pool).await
    }

    /// The user with exactly this email, or `None`.
    pub async fn find_by_email(&self, email: &str) -> Result<Option<User>, sqlx::Error> {
        self.first_where("email = $1", email).await
    }

    /// GORM `Model(&User{}).Where("id = ?").Update(column, value)`: also bumps `updated_at`.
    async fn update_column<T>(&self, user_id: i64, column: &str, value: T) -> Result<(), sqlx::Error>
    where
        T: for<'q> sqlx::Encode<'q, sqlx::Postgres> + sqlx::Type<sqlx::Postgres> + Send,
    {
        let sql = format!("UPDATE users SET {column} = $1, updated_at = NOW() WHERE id = $2");
        sqlx::query(&sql).bind(value).bind(user_id).execute(&self.pool).await.map(|_| ())
    }

    /// Changes the username (fails on a unique-constraint violation).
    pub async fn update_username(&self, user_id: i64, new_username: &str) -> Result<(), sqlx::Error> {
        self.update_column(user_id, "username", new_username).await
    }

    /// Stores a new password hash.
    pub async fn update_password(&self, user_id: i64, password_hash: &str) -> Result<(), sqlx::Error> {
        self.update_column(user_id, "password_hash", password_hash).await
    }

    /// Sets `is_private` (false is written too).
    pub async fn update_privacy(&self, user_id: i64, is_private: bool) -> Result<(), sqlx::Error> {
        self.update_column(user_id, "is_private", is_private).await
    }

    /// The user's privacy flag; `Err(RowNotFound)` when the user does not exist (Go:
    /// `gorm.ErrRecordNotFound`).
    pub async fn get_privacy(&self, user_id: i64) -> Result<bool, sqlx::Error> {
        sqlx::query_scalar("SELECT COALESCE(is_private, false) FROM users WHERE id = $1 ORDER BY id LIMIT 1")
            .bind(user_id)
            .fetch_one(&self.pool)
            .await
    }

    /// Sets the bio; an empty bio is stored as NULL.
    pub async fn update_bio(&self, user_id: i64, bio: &str) -> Result<(), sqlx::Error> {
        let bio = (!bio.is_empty()).then(|| bio.to_string());
        self.update_column(user_id, "bio", bio).await
    }

    /// The user's bio (`None` when NULL); `Err(RowNotFound)` when the user does not exist.
    pub async fn get_bio(&self, user_id: i64) -> Result<Option<String>, sqlx::Error> {
        sqlx::query_scalar("SELECT bio FROM users WHERE id = $1 ORDER BY id LIMIT 1")
            .bind(user_id)
            .fetch_one(&self.pool)
            .await
    }

    /// Sets (or clears, with `None`) the profile picture URL and its thumbnail.
    pub async fn update_profile_pic(
        &self,
        user_id: i64,
        url: Option<&str>,
        thumb_url: Option<&str>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query("UPDATE users SET profile_pic = $1, profile_pic_thumb = $2, updated_at = NOW() WHERE id = $3")
            .bind(url)
            .bind(thumb_url)
            .bind(user_id)
            .execute(&self.pool)
            .await
            .map(|_| ())
    }

    /// Sets `email_verified`.
    pub async fn update_email_verified(&self, user_id: i64, verified: bool) -> Result<(), sqlx::Error> {
        self.update_column(user_id, "email_verified", verified).await
    }

    /// Case-insensitive substring search on usernames, including private users. `query` is used
    /// as-is inside `%...%` (LIKE wildcards are not escaped, as in Go). No particular order.
    pub async fn search_by_username(&self, query: &str) -> Result<Vec<User>, sqlx::Error> {
        let sql = format!("SELECT {} FROM users WHERE username ILIKE $1", User::COLUMNS);
        sqlx::query_as::<_, User>(&sql).bind(format!("%{query}%")).fetch_all(&self.pool).await
    }

    /// Ranked username autocomplete (exact > prefix > trigram similarity, then followers DESC,
    /// username ASC). `limit` defaults to 12 when `<= 0` and is capped at 20; LIKE wildcards in
    /// `query` match literally.
    pub async fn autocomplete_users(&self, query: &str, limit: i64) -> Result<Vec<AutocompleteResult>, sqlx::Error> {
        sqlx::query_as::<_, AutocompleteResult>(AUTOCOMPLETE_SQL)
            .bind(query)
            .bind(clamp_autocomplete_limit(limit))
            .bind(escape_like(query))
            .fetch_all(&self.pool)
            .await
    }

    /// Every user (no particular order).
    pub async fn get_all(&self) -> Result<Vec<User>, sqlx::Error> {
        let sql = format!("SELECT {} FROM users", User::COLUMNS);
        sqlx::query_as::<_, User>(&sql).fetch_all(&self.pool).await
    }
}

fn clamp_autocomplete_limit(limit: i64) -> i64 {
    if limit <= 0 {
        AUTOCOMPLETE_DEFAULT_LIMIT
    } else {
        limit.min(AUTOCOMPLETE_MAX_LIMIT)
    }
}

/// Escapes `\`, `%` and `_` for a LIKE pattern with `ESCAPE '\'` (Go `strings.NewReplacer`, which
/// replaces each character once, left to right).
pub(crate) fn escape_like(query: &str) -> String {
    let mut out = String::with_capacity(query.len());
    for ch in query.chars() {
        if matches!(ch, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn like_escaping_matches_go_replacer() {
        assert_eq!(escape_like("a_b"), r"a\_b");
        assert_eq!(escape_like("%%"), r"\%\%");
        assert_eq!(escape_like(r"\"), r"\\");
        assert_eq!(escape_like(r"x\_%y"), r"x\\\_\%y");
        assert_eq!(escape_like("élan"), "élan");
    }

    #[test]
    fn autocomplete_limit_is_clamped() {
        for (limit, want) in [(-1, 12), (0, 12), (3, 3), (20, 20), (21, 20), (100, 20)] {
            assert_eq!(clamp_autocomplete_limit(limit), want, "limit {limit}");
        }
    }
}
