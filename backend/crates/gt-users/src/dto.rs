//! Response DTOs produced by this crate's services (port of the parts of `internal/dto` that
//! services return). Field order, names and `omitempty` follow the Go `json` tags.

use serde::Serialize;

/// A badge definition with the user's progress on it (Go `dto.BadgeDTO`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct BadgeDto {
    pub key: String,
    pub name: String,
    pub icon: String,
    pub color: String,
    pub threshold: i64,
    pub earned: bool,
    /// `YYYY-MM-DD` (UTC) when earned; omitted when empty.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub earned_at: String,
}

impl BadgeDto {
    /// The DTO for a badge definition, not yet earned.
    pub fn from_badge(badge: &gt_core::badges::Badge) -> Self {
        Self {
            key: badge.key.to_string(),
            name: badge.name.to_string(),
            icon: badge.icon.to_string(),
            color: badge.color.to_string(),
            threshold: badge.threshold,
            earned: false,
            earned_at: String::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn badge_dto_marshals_like_go() {
        let mut dto = BadgeDto::from_badge(&gt_core::badges::BADGES[1]);
        assert_eq!(
            gt_core::gojson::to_string(&dto).unwrap(),
            r##"{"key":"spark_starter","name":"Spark Starter","icon":"Zap","color":"#3b82f6","threshold":7,"earned":false}"##
        );
        dto.earned = true;
        dto.earned_at = "2026-01-04".into();
        assert!(gt_core::gojson::to_string(&dto).unwrap().ends_with(r#""earned":true,"earned_at":"2026-01-04"}"#));
    }
}
