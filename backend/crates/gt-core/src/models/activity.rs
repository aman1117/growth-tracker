use chrono::{DateTime, NaiveDate, Utc};

use crate::constants::CUSTOM_TILE_PREFIX;

/// Predefined activity types, in Go's `ActivityNames` order.
pub const ACTIVITY_NAMES: &[&str] = &[
    "sleep",
    "study",
    "book_reading",
    "eating",
    "friends",
    "grooming",
    "workout",
    "reels",
    "family",
    "idle",
    "creative",
    "travelling",
    "errand",
    "rest",
    "entertainment",
    "office",
];

/// A logged activity (`activities`).
#[derive(Debug, Clone, PartialEq, sqlx::FromRow)]
pub struct Activity {
    pub id: i64,
    pub user_id: i64,
    pub name: String,
    /// `numeric(4,2)` read as Go `float32`.
    pub duration_hours: f32,
    pub note: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub activity_date: NaiveDate,
}

impl Activity {
    pub const COLUMNS: &'static str = "id, user_id, name, duration_hours::float4 AS duration_hours, note, \
         created_at, updated_at, activity_date";

    /// Go `Activity.Validate` (run by the GORM `BeforeSave` hook).
    pub fn validate(&self) -> Result<(), String> {
        if self.duration_hours < 0.0 || self.duration_hours > 24.0 {
            return Err("duration_hours must be between 0 and 24".to_string());
        }
        if !is_valid_activity_name(&self.name) {
            return Err(format!("invalid activity name: {}", self.name));
        }
        Ok(())
    }
}

/// A predefined activity or a well-formed custom tile (`custom:<uuid>`).
pub fn is_valid_activity_name(name: &str) -> bool {
    if is_custom_tile(name) {
        return validate_custom_tile_format(name);
    }
    is_predefined_activity(name)
}

/// One of the predefined activities (custom tiles are not).
pub fn is_predefined_activity(name: &str) -> bool {
    ACTIVITY_NAMES.contains(&name)
}

/// Starts with `custom:` and has something after it.
pub fn is_custom_tile(name: &str) -> bool {
    name.len() > CUSTOM_TILE_PREFIX.len() && name.starts_with(CUSTOM_TILE_PREFIX)
}

/// `custom:` followed by a 36-character 8-4-4-4-12 hex UUID.
pub fn validate_custom_tile_format(name: &str) -> bool {
    if !is_custom_tile(name) {
        return false;
    }
    let id = &name[CUSTOM_TILE_PREFIX.len()..];
    if id.len() != 36 {
        return false;
    }
    id.char_indices().all(|(i, ch)| if matches!(i, 8 | 13 | 18 | 23) { ch == '-' } else { ch.is_ascii_hexdigit() })
}

/// The UUID of a custom tile name, or `""`.
pub fn custom_tile_id(name: &str) -> &str {
    if is_custom_tile(name) {
        &name[CUSTOM_TILE_PREFIX.len()..]
    } else {
        ""
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn activity_names() {
        assert!(is_valid_activity_name("study"));
        assert!(!is_valid_activity_name("Study"));
        assert!(is_valid_activity_name("custom:123e4567-e89b-12d3-a456-426614174000"));
        assert!(!is_valid_activity_name("custom:123e4567e89b12d3a456426614174000"));
        assert!(!is_predefined_activity("custom:123e4567-e89b-12d3-a456-426614174000"));
        assert_eq!(custom_tile_id("custom:abc"), "abc");
        assert_eq!(custom_tile_id("custom:"), "");
    }
}
