//! Challenge input validation (port of `internal/validator/challenge.go`). Every failure carries
//! the `INVALID_CHALLENGE` code and a message naming the invalid field.

use chrono::{Days, NaiveDate};
use gt_core::constants as c;
use gt_core::models::is_predefined_activity;
use gt_core::models::{CHALLENGE_GOAL_AT_LEAST, CHALLENGE_GOAL_AT_MOST};
use gt_core::timeutil;
use gt_core::validator::ValidationError;

use crate::gostr;

fn challenge_error(message: impl Into<String>) -> ValidationError {
    ValidationError::new(message, c::ERR_CODE_INVALID_CHALLENGE)
}

/// Trims a title and checks its length in characters (so emoji and accented letters count
/// once).
pub fn normalize_challenge_title(title: &str) -> Result<String, ValidationError> {
    let trimmed = title.trim();
    if !(1..=c::CHALLENGE_TITLE_MAX_LENGTH).contains(&trimmed.chars().count()) {
        return Err(challenge_error(format!(
            "title must be between 1 and {} characters",
            c::CHALLENGE_TITLE_MAX_LENGTH
        )));
    }
    Ok(trimmed.to_string())
}

/// Accepts the predefined activities only: custom tiles belong to a single user, so other
/// participants could never log them.
pub fn validate_challenge_activity(activity: &str) -> Result<(), ValidationError> {
    if !is_predefined_activity(activity) {
        return Err(challenge_error("activity must be one of the predefined activities"));
    }
    Ok(())
}

/// Checks `goal_type` and `target_hours`. The target is a multiple of 0.25 hours: 0.25..24 for
/// `at_least` and 0..23.75 for `at_most` (0 means "none at all").
pub fn validate_challenge_goal(goal_type: &str, target_hours: Option<f64>) -> Result<(), ValidationError> {
    let (low, high) = match goal_type {
        CHALLENGE_GOAL_AT_LEAST => (c::CHALLENGE_HOURS_STEP, c::CHALLENGE_AT_LEAST_MAX_HOURS),
        CHALLENGE_GOAL_AT_MOST => (0.0, c::CHALLENGE_AT_MOST_MAX_HOURS),
        _ => return Err(challenge_error("goal_type must be at_least or at_most")),
    };
    let Some(target) = target_hours else {
        return Err(challenge_error("target_hours is required"));
    };
    let steps = target / c::CHALLENGE_HOURS_STEP;
    if target.is_nan() || target < low || target > high || steps != steps.trunc() {
        // Rust's `Display` for f64 matches Go's strconv.FormatFloat(h, 'f', -1, 64) here.
        return Err(challenge_error(format!(
            "target_hours must be a multiple of {} between {} and {}",
            c::CHALLENGE_HOURS_STEP,
            low,
            high
        )));
    }
    Ok(())
}

/// Checks `duration_days`.
pub fn validate_challenge_duration(days: Option<i64>) -> Result<(), ValidationError> {
    match days {
        Some(d) if (c::CHALLENGE_MIN_DURATION_DAYS..=c::CHALLENGE_MAX_DURATION_DAYS).contains(&d) => Ok(()),
        _ => Err(challenge_error(format!(
            "duration_days must be between {} and {}",
            c::CHALLENGE_MIN_DURATION_DAYS,
            c::CHALLENGE_MAX_DURATION_DAYS
        ))),
    }
}

/// Parses `start_date` (`YYYY-MM-DD`, surrounding whitespace ignored) and checks that it is
/// between today and 30 days from today (IST dates).
pub fn parse_challenge_start_date(raw: &str, today: NaiveDate) -> Result<NaiveDate, ValidationError> {
    let Some(start) = timeutil::parse_date(raw.trim()) else {
        return Err(challenge_error("start_date must be a date in YYYY-MM-DD format"));
    };
    let latest = today + Days::new(c::CHALLENGE_MAX_START_OFFSET_DAYS.unsigned_abs());
    if start < today || start > latest {
        return Err(challenge_error(format!(
            "start_date must be between today and {} days from today",
            c::CHALLENGE_MAX_START_OFFSET_DAYS
        )));
    }
    Ok(start)
}

/// Checks the number of users invited in one request.
pub fn validate_invite_user_ids(user_ids: &[u64]) -> Result<(), ValidationError> {
    if user_ids.is_empty() || user_ids.len() > c::CHALLENGE_MAX_INVITES_PER_REQUEST {
        return Err(challenge_error(format!(
            "user_ids must contain between 1 and {} users",
            c::CHALLENGE_MAX_INVITES_PER_REQUEST
        )));
    }
    Ok(())
}

/// Trims and upper-cases an invite code (codes are case-insensitive). `None` when the result
/// cannot be an invite code.
pub fn normalize_invite_code(raw: &str) -> Option<String> {
    let code = gostr::to_upper(raw.trim());
    // Go compares the byte length; the alphabet is ASCII, so any other character fails below.
    if code.len() != c::CHALLENGE_INVITE_CODE_LENGTH {
        return None;
    }
    code.chars().all(|ch| c::CHALLENGE_INVITE_CODE_ALPHABET.contains(ch)).then_some(code)
}

#[cfg(test)]
mod tests {
    use super::*;
    use gt_core::models::ACTIVITY_NAMES;

    const INVALID: &str = c::ERR_CODE_INVALID_CHALLENGE;

    fn assert_invalid<T: std::fmt::Debug>(result: Result<T, ValidationError>, message: &str) {
        let err = result.expect_err("expected a validation error");
        assert_eq!(err.code, INVALID);
        assert_eq!(err.message, message);
        assert_eq!(err.to_string(), message);
    }

    #[test]
    fn title() {
        const MSG: &str = "title must be between 1 and 60 characters";
        let ok = [
            ("Study 2h+ a day", "Study 2h+ a day".to_string()),
            ("  \t Study \n", "Study".to_string()),
            ("a", "a".to_string()),
            (&"a".repeat(60), "a".repeat(60)),
            (&format!("  {}  ", "a".repeat(60)), "a".repeat(60)),
            (&"🏆".repeat(60), "🏆".repeat(60)),
            (&"é".repeat(60), "é".repeat(60)),
        ];
        for (input, want) in ok {
            assert_eq!(normalize_challenge_title(input).unwrap(), want, "{input:?}");
        }
        for input in ["", "   \t\n ", &"a".repeat(61), &"🏆".repeat(61)] {
            assert_invalid(normalize_challenge_title(input), MSG);
        }
    }

    #[test]
    fn activity() {
        for name in ACTIVITY_NAMES {
            assert!(validate_challenge_activity(name).is_ok(), "{name}");
        }
        for name in ["", "swimming", "Study", " study", "custom:3f2b8c4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f"] {
            assert_invalid(validate_challenge_activity(name), "activity must be one of the predefined activities");
        }
    }

    #[test]
    fn goal() {
        const AT_LEAST: &str = "target_hours must be a multiple of 0.25 between 0.25 and 24";
        const AT_MOST: &str = "target_hours must be a multiple of 0.25 between 0 and 23.75";
        const GOAL: &str = "goal_type must be at_least or at_most";
        let cases: &[(&str, Option<f64>, Option<&str>)] = &[
            ("at_least", Some(0.25), None),
            ("at_least", Some(2.75), None),
            ("at_least", Some(24.0), None),
            ("at_least", Some(0.0), Some(AT_LEAST)),
            ("at_least", Some(-1.0), Some(AT_LEAST)),
            ("at_least", Some(24.25), Some(AT_LEAST)),
            ("at_least", Some(2.1), Some(AT_LEAST)),
            ("at_least", Some(0.1), Some(AT_LEAST)),
            ("at_most", Some(0.0), None),
            ("at_most", Some(0.25), None),
            ("at_most", Some(23.75), None),
            ("at_most", Some(24.0), Some(AT_MOST)),
            ("at_most", Some(-0.25), Some(AT_MOST)),
            ("at_most", Some(1.3), Some(AT_MOST)),
            ("at_most", Some(f64::NAN), Some(AT_MOST)),
            ("at_least", Some(f64::INFINITY), Some(AT_LEAST)),
            ("at_least", None, Some("target_hours is required")),
            ("exactly", Some(2.0), Some(GOAL)),
            ("AT_LEAST", Some(2.0), Some(GOAL)),
            ("", None, Some(GOAL)),
        ];
        for &(goal, target, want) in cases {
            let result = validate_challenge_goal(goal, target);
            match want {
                None => assert!(result.is_ok(), "{goal} {target:?}"),
                Some(msg) => assert_invalid(result, msg),
            }
        }
    }

    #[test]
    fn duration() {
        const MSG: &str = "duration_days must be between 3 and 60";
        for days in [3, 21, 60] {
            assert!(validate_challenge_duration(Some(days)).is_ok());
        }
        for days in [Some(2), Some(0), Some(-5), Some(61), None] {
            assert_invalid(validate_challenge_duration(days), MSG);
        }
    }

    #[test]
    fn start_date() {
        const FORMAT: &str = "start_date must be a date in YYYY-MM-DD format";
        const RANGE: &str = "start_date must be between today and 30 days from today";
        let today = NaiveDate::from_ymd_opt(2026, 10, 23).unwrap();
        let plus = |n: u64| today + Days::new(n);
        assert_eq!(parse_challenge_start_date("2026-10-23", today).unwrap(), today);
        assert_eq!(parse_challenge_start_date("2026-10-24", today).unwrap(), plus(1));
        assert_eq!(parse_challenge_start_date("2026-11-22", today).unwrap(), plus(30));
        assert_eq!(parse_challenge_start_date(" 2026-10-25 ", today).unwrap(), plus(2));
        assert_invalid(parse_challenge_start_date("2026-10-22", today), RANGE);
        assert_invalid(parse_challenge_start_date("2026-11-23", today), RANGE);
        for raw in ["", "soon", "23-10-2026", "2026-10-23T00:00:00Z", "2026-02-30"] {
            assert_invalid(parse_challenge_start_date(raw, today), FORMAT);
        }
    }

    #[test]
    fn invite_user_ids() {
        const MSG: &str = "user_ids must contain between 1 and 20 users";
        let ids = |n: u64| (1..=n).collect::<Vec<_>>();
        assert!(validate_invite_user_ids(&ids(1)).is_ok());
        assert!(validate_invite_user_ids(&ids(20)).is_ok());
        assert_invalid(validate_invite_user_ids(&[]), MSG);
        assert_invalid(validate_invite_user_ids(&ids(21)), MSG);
    }

    #[test]
    fn invite_codes() {
        let valid = [
            ("K7Q2M9XA", "K7Q2M9XA"),
            ("k7q2m9xa", "K7Q2M9XA"),
            ("  k7Q2m9Xa\t", "K7Q2M9XA"),
            ("ABCDEFGH", "ABCDEFGH"),
            ("23456789", "23456789"),
            // Go's ToUpper maps the long s to S, and the byte length is checked afterwards.
            ("ſſſſſſſſ", "SSSSSSSS"),
        ];
        for (raw, want) in valid {
            assert_eq!(normalize_invite_code(raw).as_deref(), Some(want), "{raw:?}");
        }
        let invalid = [
            "",
            "K7Q2M9X",
            "K7Q2M9XAB",
            "K7Q2M9X0",
            "K7Q2M9X1",
            "K7Q2M9XI",
            "K7Q2M9XO",
            "K7Q2 9XA",
            "K7Q2M9X%",
            "K7Q2M9X_",
            "K7Q2M9Xé",
            "K7Q2M9ß",
            "K7Q2M9Xß",
        ];
        for raw in invalid {
            assert_eq!(normalize_invite_code(raw), None, "{raw:?}");
        }
    }
}
