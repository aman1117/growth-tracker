use chrono::{DateTime, Utc};

/// A registered user (`users`). Never serialized directly: handlers map it to DTOs.
#[derive(Debug, Clone, PartialEq, sqlx::FromRow)]
pub struct User {
    pub id: i64,
    pub email: String,
    pub username: String,
    pub password_hash: String,
    pub profile_pic: Option<String>,
    pub profile_pic_thumb: Option<String>,
    pub bio: Option<String>,
    pub is_private: bool,
    pub is_verified: bool,
    pub email_verified: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl User {
    /// Select list decoding into [`User`] (nullable booleans read as `false`, as GORM did).
    pub const COLUMNS: &'static str = "id, email, username, password_hash, profile_pic, profile_pic_thumb, bio, \
         COALESCE(is_private, false) AS is_private, COALESCE(is_verified, false) AS is_verified, \
         COALESCE(email_verified, false) AS email_verified, created_at, updated_at";

    /// Same as [`User::COLUMNS`] with every column qualified by `alias` (for joins).
    pub fn columns_with_alias(alias: &str) -> String {
        format!(
            "{a}.id, {a}.email, {a}.username, {a}.password_hash, {a}.profile_pic, {a}.profile_pic_thumb, {a}.bio, \
             COALESCE({a}.is_private, false) AS is_private, COALESCE({a}.is_verified, false) AS is_verified, \
             COALESCE({a}.email_verified, false) AS email_verified, {a}.created_at, {a}.updated_at",
            a = alias
        )
    }
}
