use chrono::{DateTime, NaiveDate, Utc};

/// Daily hours must reach the target.
pub const CHALLENGE_GOAL_AT_LEAST: &str = "at_least";
/// Daily hours must stay within the target.
pub const CHALLENGE_GOAL_AT_MOST: &str = "at_most";

/// A shared daily time goal for one predefined activity over a fixed run of IST days
/// (`challenges`).
#[derive(Debug, Clone, PartialEq, sqlx::FromRow)]
pub struct Challenge {
    pub id: i64,
    pub creator_id: i64,
    pub title: String,
    pub activity: String,
    pub goal_type: String,
    /// `numeric(4,2)` read as Go `float64`.
    pub target_hours: f64,
    pub start_date: NaiveDate,
    pub end_date: NaiveDate,
    pub invite_code: String,
    /// Last date whose results are final.
    pub locked_through: Option<NaiveDate>,
    /// Set once the final results are stored.
    pub finalized_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl Challenge {
    pub const COLUMNS: &'static str =
        "id, creator_id, title, activity, goal_type, target_hours::float8 AS target_hours, \
         start_date, end_date, invite_code, locked_through, finalized_at, created_at, updated_at";

    /// Qualified by `alias` (for joins).
    pub fn columns_with_alias(alias: &str) -> String {
        format!(
            "{a}.id, {a}.creator_id, {a}.title, {a}.activity, {a}.goal_type, {a}.target_hours::float8 AS target_hours, \
             {a}.start_date, {a}.end_date, {a}.invite_code, {a}.locked_through, {a}.finalized_at, {a}.created_at, \
             {a}.updated_at",
            a = alias
        )
    }

    /// Calendar days from `start_date` through `end_date`, inclusive.
    pub fn duration_days(&self) -> i64 {
        (self.end_date - self.start_date).num_days() + 1
    }
}

/// A user in a challenge (`challenge_participants`); the `final_*` fields and `completed` are
/// stored when the challenge is finalized.
#[derive(Debug, Clone, PartialEq, sqlx::FromRow)]
pub struct ChallengeParticipant {
    pub id: i64,
    pub challenge_id: i64,
    pub user_id: i64,
    pub joined_at: DateTime<Utc>,
    /// IST date of `joined_at`.
    pub joined_on: NaiveDate,
    pub final_rank: Option<i64>,
    pub final_days_met: Option<i64>,
    /// `numeric(6,2)` read as Go `*float64`.
    pub final_total_hours: Option<f64>,
    pub completed: Option<bool>,
}

impl ChallengeParticipant {
    pub const COLUMNS: &'static str = "id, challenge_id, user_id, joined_at, joined_on, final_rank, final_days_met, \
         final_total_hours::float8 AS final_total_hours, completed";
}

/// The locked (final) result of one participant on one challenge date (`challenge_days`).
#[derive(Debug, Clone, PartialEq, sqlx::FromRow)]
pub struct ChallengeDay {
    pub id: i64,
    pub challenge_id: i64,
    pub user_id: i64,
    pub day_date: NaiveDate,
    /// `numeric(4,2)` read as Go `float64`.
    pub hours: f64,
    /// Any activity logged that day.
    pub logged: bool,
    pub met: bool,
    pub locked_at: DateTime<Utc>,
}

impl ChallengeDay {
    pub const COLUMNS: &'static str =
        "id, challenge_id, user_id, day_date, hours::float8 AS hours, logged, met, locked_at";
}

/// One participant cheering another on an IST date (`challenge_cheers`).
#[derive(Debug, Clone, PartialEq, sqlx::FromRow)]
pub struct ChallengeCheer {
    pub id: i64,
    pub challenge_id: i64,
    pub from_user_id: i64,
    pub to_user_id: i64,
    pub cheer_date: NaiveDate,
    pub created_at: DateTime<Utc>,
}

impl ChallengeCheer {
    pub const COLUMNS: &'static str = "id, challenge_id, from_user_id, to_user_id, cheer_date, created_at";
}

/// An invite to a challenge (`challenge_invites`); at most one per invitee per challenge.
#[derive(Debug, Clone, PartialEq, sqlx::FromRow)]
pub struct ChallengeInvite {
    pub id: i64,
    pub challenge_id: i64,
    pub inviter_id: i64,
    pub invitee_id: i64,
    pub created_at: DateTime<Utc>,
}

impl ChallengeInvite {
    pub const COLUMNS: &'static str = "id, challenge_id, inviter_id, invitee_id, created_at";
}
