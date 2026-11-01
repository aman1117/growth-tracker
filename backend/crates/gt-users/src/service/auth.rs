//! `AuthService` (port of the auth part of `internal/services/services.go`).

use std::sync::Arc;

use gt_core::models::User;

use crate::repository::UserRepository;

/// bcrypt work factor (Go `bcrypt.DefaultCost`).
pub const BCRYPT_COST: u32 = 10;

/// bcrypt only looks at the first 72 bytes; Go refuses to hash longer passwords.
const BCRYPT_MAX_PASSWORD_BYTES: usize = 72;

/// Authentication errors. The messages are the Go error strings handlers compared against.
#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    /// No user with that identifier (or, for password changes, the lookup failed).
    #[error("user not found")]
    UserNotFound,
    /// Login password does not match.
    #[error("invalid password")]
    InvalidPassword,
    /// Password change with a wrong current password.
    #[error("current password is incorrect")]
    IncorrectCurrentPassword,
    /// The password is longer than bcrypt's 72-byte input (Go `bcrypt.ErrPasswordTooLong`).
    #[error("bcrypt: password length exceeds 72 bytes")]
    PasswordTooLong,
    /// Hashing failed for another reason.
    #[error("bcrypt: {0}")]
    Hash(String),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
}

/// Hashes `password` with bcrypt (cost 10) as a `$2a$` hash, like Go's
/// `bcrypt.GenerateFromPassword(password, bcrypt.DefaultCost)`. Runs on the blocking pool.
pub async fn hash_password(password: &str) -> Result<String, AuthError> {
    if password.len() > BCRYPT_MAX_PASSWORD_BYTES {
        return Err(AuthError::PasswordTooLong);
    }
    let password = password.to_owned();
    tokio::task::spawn_blocking(move || {
        bcrypt::hash_with_result(password, BCRYPT_COST)
            .map(|parts| parts.format_for_version(bcrypt::Version::TwoA))
            .map_err(|e| AuthError::Hash(e.to_string()))
    })
    .await
    .map_err(|e| AuthError::Hash(e.to_string()))?
}

/// Whether `password` matches the bcrypt `hash` (any `$2?$` variant, including hashes written by
/// the Go backend). A malformed hash never matches. Runs on the blocking pool.
pub async fn verify_password(password: &str, hash: &str) -> bool {
    let (password, hash) = (password.to_owned(), hash.to_owned());
    tokio::task::spawn_blocking(move || bcrypt::verify(password, &hash).unwrap_or(false)).await.unwrap_or(false)
}

/// Registration, login and credential changes.
#[derive(Debug, Clone)]
pub struct AuthService {
    user_repo: Arc<UserRepository>,
}

impl AuthService {
    /// Go `NewAuthService`.
    pub fn new(user_repo: Arc<UserRepository>) -> Self {
        Self { user_repo }
    }

    /// Hashes the password and creates the user (with its follow counters).
    pub async fn register(&self, email: &str, username: &str, password: &str) -> Result<(), AuthError> {
        let hash = hash_password(password).await?;
        self.user_repo.create(email, username, &hash).await?;
        Ok(())
    }

    /// The user whose email or username is `identifier`, if `password` matches.
    pub async fn authenticate(&self, identifier: &str, password: &str) -> Result<User, AuthError> {
        let user = self.user_repo.find_by_identifier(identifier).await?.ok_or(AuthError::UserNotFound)?;
        if !verify_password(password, &user.password_hash).await {
            return Err(AuthError::InvalidPassword);
        }
        Ok(user)
    }

    /// The user with `user_id`, or `None`.
    pub async fn get_user_by_id(&self, user_id: i64) -> Result<Option<User>, sqlx::Error> {
        self.user_repo.find_by_id(user_id).await
    }

    /// The user with exactly this email, or `None`.
    pub async fn get_user_by_email(&self, email: &str) -> Result<Option<User>, sqlx::Error> {
        self.user_repo.find_by_email(email).await
    }

    /// The user with exactly this username, or `None`.
    pub async fn get_user_by_username(&self, username: &str) -> Result<Option<User>, sqlx::Error> {
        self.user_repo.find_by_username(username).await
    }

    /// Changes the username (fails when it is taken).
    pub async fn update_username(&self, user_id: i64, new_username: &str) -> Result<(), sqlx::Error> {
        self.user_repo.update_username(user_id, new_username).await
    }

    /// Checks `current_password` and stores a hash of `new_password`. A failed or empty user
    /// lookup is reported as [`AuthError::UserNotFound`], as in Go.
    pub async fn change_password(
        &self,
        user_id: i64,
        current_password: &str,
        new_password: &str,
    ) -> Result<(), AuthError> {
        let user = match self.user_repo.find_by_id(user_id).await {
            Ok(Some(user)) => user,
            Ok(None) | Err(_) => return Err(AuthError::UserNotFound),
        };
        if !verify_password(current_password, &user.password_hash).await {
            return Err(AuthError::IncorrectCurrentPassword);
        }
        let hash = hash_password(new_password).await?;
        self.user_repo.update_password(user_id, &hash).await?;
        Ok(())
    }

    /// Stores a hash of `new_password` without checking the old one (password reset).
    pub async fn reset_password(&self, user_id: i64, new_password: &str) -> Result<(), AuthError> {
        let hash = hash_password(new_password).await?;
        self.user_repo.update_password(user_id, &hash).await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn hashes_are_2a_cost_10_and_verify() {
        let hash = hash_password("s3cret-pass").await.unwrap();
        assert!(hash.starts_with("$2a$10$"), "{hash}");
        assert_eq!(hash.len(), 60);
        assert!(verify_password("s3cret-pass", &hash).await);
        assert!(!verify_password("wrong", &hash).await);
        assert!(!verify_password("s3cret-pass", "not-a-hash").await);
    }

    #[tokio::test]
    async fn verifies_go_generated_hash() {
        // bcrypt.GenerateFromPassword([]byte("password123"), bcrypt.DefaultCost) in Go.
        let go_hash = "$2a$10$SkzLfruj2/DiHqW9dFWw4.EGXM.STQGFVEzR2vhHekx./2UCHh76q";
        assert!(verify_password("password123", go_hash).await);
        assert!(!verify_password("password124", go_hash).await);
    }

    #[tokio::test]
    async fn rejects_passwords_longer_than_72_bytes_like_go() {
        let long = "p".repeat(73);
        assert!(matches!(hash_password(&long).await, Err(AuthError::PasswordTooLong)));
        assert_eq!(AuthError::PasswordTooLong.to_string(), "bcrypt: password length exceeds 72 bytes");
        assert!(hash_password(&"p".repeat(72)).await.is_ok());
    }
}
