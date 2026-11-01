//! Challenge business logic: the service and its daily job, built on pure rules, view builders,
//! the pure parts of the daily job and the service errors.

pub mod challenge;
pub mod error;
pub mod job;
pub mod locking;
pub mod rules;
pub mod view;

pub use challenge::{ChallengeService, Clock, CodeGenerator};
pub use error::ChallengeError;
pub use job::DailyJobError;

#[cfg(test)]
pub(crate) mod test_support {
    use chrono::{NaiveDate, Utc};
    use gt_core::models::Challenge;

    use super::rules::add_days;

    /// The start date most rule tests use.
    pub fn cday() -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 3, 9).expect("valid date")
    }

    /// The date `offset` days after [`cday`].
    pub fn on(offset: i64) -> NaiveDate {
        add_days(cday(), offset)
    }

    /// A study challenge of `days` days starting on [`cday`].
    pub fn rule_challenge(goal: &str, target: f64, days: i64, locked: Option<NaiveDate>) -> Challenge {
        Challenge {
            id: 0,
            creator_id: 0,
            title: "Study 2h+".into(),
            activity: "study".into(),
            goal_type: goal.into(),
            target_hours: target,
            start_date: cday(),
            end_date: on(days - 1),
            invite_code: String::new(),
            locked_through: locked,
            finalized_at: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }
}
