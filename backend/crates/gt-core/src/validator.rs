//! Input validation (port of `internal/validator/validator.go`). Challenge-specific rules live
//! in the challenges crate.

use std::sync::LazyLock;

use regex::Regex;

use crate::constants as c;
use crate::error::ApiError;

/// Valid username characters (after lowercasing).
pub static USERNAME_PATTERN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z0-9_.]+$").expect("valid regex"));

/// `@username` mentions in comment text.
pub static MENTION_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"@([a-z0-9_.]{3,20})").expect("valid regex"));

/// A validation failure with an error code; converts into a 400 [`ApiError`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationError {
    pub message: String,
    pub code: &'static str,
}

impl ValidationError {
    pub fn new(message: impl Into<String>, code: &'static str) -> Self {
        Self { message: message.into(), code }
    }
}

impl std::fmt::Display for ValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ValidationError {}

impl From<ValidationError> for ApiError {
    fn from(e: ValidationError) -> Self {
        ApiError::bad_request(e.message, e.code)
    }
}

type Validation = Result<(), ValidationError>;

fn rune_count(s: &str) -> usize {
    s.chars().count()
}

pub fn validate_username(username: &str) -> Validation {
    let username = sanitize_username(username);
    if username.is_empty() {
        return Err(ValidationError::new("Username is required", c::ERR_CODE_MISSING_FIELDS));
    }
    let len = rune_count(&username);
    if !(c::USERNAME_MIN_LENGTH..=c::USERNAME_MAX_LENGTH).contains(&len) {
        return Err(ValidationError::new(
            "Username must be between 3 and 20 characters",
            c::ERR_CODE_INVALID_USERNAME_LEN,
        ));
    }
    if !USERNAME_PATTERN.is_match(&username) {
        return Err(ValidationError::new(
            "Username can only contain lowercase letters, numbers, _ and .",
            c::ERR_CODE_INVALID_USERNAME_FMT,
        ));
    }
    Ok(())
}

pub fn validate_password(password: &str) -> Validation {
    let password = password.trim();
    if password.is_empty() {
        return Err(ValidationError::new("Password is required", c::ERR_CODE_MISSING_FIELDS));
    }
    if rune_count(password) < c::PASSWORD_MIN_LENGTH {
        return Err(ValidationError::new(
            "Password must be at least 8 characters long",
            c::ERR_CODE_PASSWORD_TOO_SHORT,
        ));
    }
    Ok(())
}

/// Length check plus at least one letter and one digit (checked on the untrimmed password,
/// like Go).
pub fn validate_password_strength(password: &str) -> Validation {
    validate_password(password)?;
    let has_letter = password.chars().any(char::is_alphabetic);
    let has_number = password.chars().any(|ch| ch.is_numeric());
    if !has_letter {
        return Err(ValidationError::new("Password must contain at least one letter", c::ERR_CODE_WEAK_PASSWORD));
    }
    if !has_number {
        return Err(ValidationError::new("Password must contain at least one number", c::ERR_CODE_WEAK_PASSWORD));
    }
    Ok(())
}

pub fn validate_email(email: &str) -> Validation {
    let email = email.trim();
    if email.is_empty() {
        return Err(ValidationError::new("Email is required", c::ERR_CODE_MISSING_FIELDS));
    }
    if !email.contains('@') || !email.contains('.') {
        return Err(ValidationError::new("Invalid email format", c::ERR_CODE_INVALID_REQUEST));
    }
    Ok(())
}

pub fn validate_bio(bio: &str) -> Validation {
    if rune_count(bio.trim()) > c::BIO_MAX_LENGTH {
        return Err(ValidationError::new("Bio must be 150 characters or less", c::ERR_CODE_BIO_TOO_LONG));
    }
    Ok(())
}

pub fn validate_note(note: Option<&str>) -> Validation {
    match note {
        Some(note) if rune_count(note.trim()) > c::NOTE_MAX_LENGTH => {
            Err(ValidationError::new("Note must be 500 characters or less", c::ERR_CODE_INVALID_REQUEST))
        }
        _ => Ok(()),
    }
}

pub fn validate_comment_body(body: &str) -> Validation {
    let len = rune_count(body.trim());
    if len < c::COMMENT_BODY_MIN_LENGTH {
        return Err(ValidationError::new("Comment cannot be empty", c::ERR_CODE_COMMENT_EMPTY));
    }
    if len > c::COMMENT_BODY_MAX_LENGTH {
        return Err(ValidationError::new("Comment must be 200 characters or less", c::ERR_CODE_COMMENT_TOO_LONG));
    }
    Ok(())
}

/// Unique `@username` mentions in order of first appearance. Errors when there are more than
/// [`c::COMMENT_MAX_MENTIONS`].
pub fn parse_mentions(body: &str) -> Result<Vec<String>, ValidationError> {
    let mut usernames: Vec<String> = Vec::new();
    for cap in MENTION_PATTERN.captures_iter(body) {
        let name = cap[1].to_string();
        if !usernames.contains(&name) {
            usernames.push(name);
        }
    }
    if usernames.len() > c::COMMENT_MAX_MENTIONS {
        return Err(ValidationError::new("Too many mentions (max 10 per comment)", c::ERR_CODE_TOO_MANY_MENTIONS));
    }
    Ok(usernames)
}

pub fn validate_activity_hours(hours: f32) -> Validation {
    if hours < 0.0 || f64::from(hours) > c::MAX_DAILY_HOURS {
        return Err(ValidationError::new("Duration hours must be between 0 and 24", c::ERR_CODE_INVALID_REQUEST));
    }
    Ok(())
}

/// Dates are `YYYY-MM-DD` strings, so they compare lexicographically.
pub fn validate_date_range(start_date: &str, end_date: &str) -> Validation {
    if start_date > end_date {
        return Err(ValidationError::new("Start date must be before end date", c::ERR_CODE_INVALID_DATE_RANGE));
    }
    Ok(())
}

pub fn sanitize_username(username: &str) -> String {
    username.trim().to_lowercase()
}

pub fn sanitize_email(email: &str) -> String {
    email.trim().to_string()
}

pub fn sanitize_bio(bio: &str) -> String {
    bio.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn username_rules() {
        assert!(validate_username("John_Doe").is_ok());
        assert_eq!(validate_username("  ").unwrap_err().code, c::ERR_CODE_MISSING_FIELDS);
        assert_eq!(validate_username("ab").unwrap_err().code, c::ERR_CODE_INVALID_USERNAME_LEN);
        assert_eq!(validate_username("bad-name").unwrap_err().code, c::ERR_CODE_INVALID_USERNAME_FMT);
    }

    #[test]
    fn password_strength() {
        assert!(validate_password_strength("abcdefg1").is_ok());
        assert_eq!(validate_password_strength("abcdefgh").unwrap_err().code, c::ERR_CODE_WEAK_PASSWORD);
        assert_eq!(validate_password_strength("1234567").unwrap_err().code, c::ERR_CODE_PASSWORD_TOO_SHORT);
    }

    #[test]
    fn mentions_are_unique_and_limited() {
        assert_eq!(parse_mentions("hi @bob and @bob @al").unwrap(), vec!["bob"]);
        let many: String = (0..11).map(|i| format!("@user{i:02} ")).collect();
        assert_eq!(parse_mentions(&many).unwrap_err().code, c::ERR_CODE_TOO_MANY_MENTIONS);
    }
}
