//! Challenge request and response DTOs (port of the challenge parts of `internal/dto`).
//!
//! Field order, names and `null` behavior follow the Go structs exactly: none of the challenge
//! fields use `omitempty`, Go pointers are `Option`s that marshal as `null`, and embedded Go
//! structs are `#[serde(flatten)]`ed.

use serde::{Deserialize, Deserializer, Serialize};

// ==================== Requests ====================

/// `POST /api/challenges`. The creator joins the challenge automatically.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct CreateChallengeRequest {
    /// 1-60 characters, trimmed.
    #[serde(deserialize_with = "null_as_default")]
    pub title: String,
    /// A predefined activity (no custom tiles).
    #[serde(deserialize_with = "null_as_default")]
    pub activity: String,
    /// `at_least` or `at_most`.
    #[serde(deserialize_with = "null_as_default")]
    pub goal_type: String,
    /// Multiple of 0.25: 0.25-24 (`at_least`), 0-23.75 (`at_most`).
    pub target_hours: Option<f64>,
    /// 3-60.
    pub duration_days: Option<i64>,
    /// `YYYY-MM-DD` (IST), today .. today+30.
    #[serde(deserialize_with = "null_as_default")]
    pub start_date: String,
}

/// `POST /api/challenges/{id}/cheers`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct CheerChallengeRequest {
    /// Go `uint`: negative or fractional numbers are rejected, `null` leaves 0.
    #[serde(deserialize_with = "null_as_default")]
    pub user_id: u64,
}

/// `POST /api/challenges/{id}/invites`: 1-20 users the inviter follows or who follow them.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct InviteToChallengeRequest {
    /// Go `[]uint`: `null` is an empty list and `null` elements decode as 0.
    #[serde(deserialize_with = "go_uint_list")]
    pub user_ids: Vec<u64>,
}

/// Go's `encoding/json` leaves a field untouched when the JSON value is `null`.
fn null_as_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

/// A Go `[]uint`: `null` -> empty, `null` elements -> 0.
fn go_uint_list<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<u64>, D::Error> {
    let items = Option::<Vec<Option<u64>>>::deserialize(deserializer)?.unwrap_or_default();
    Ok(items.into_iter().map(Option::unwrap_or_default).collect())
}

// ==================== Responses ====================

/// A user shown in challenges.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct ChallengeUser {
    pub id: i64,
    pub username: String,
    pub profile_pic: Option<String>,
    pub profile_pic_thumb: Option<String>,
    pub is_verified: bool,
}

/// A participant's progress in a challenge.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct ChallengeProgress {
    /// `null` for upcoming challenges.
    pub rank: Option<i64>,
    pub days_met: i64,
    pub days_elapsed: i64,
    pub days_possible: i64,
    pub current_streak: i64,
    pub total_hours: f64,
    /// `null` unless the challenge is active and today is in the participant's window.
    pub today_hours: Option<f64>,
    /// `met`, `missed` or `pending`; `null` like `today_hours`.
    pub today_status: Option<String>,
    /// `null` until the results are final.
    pub completed: Option<bool>,
}

/// A challenge in the list, with the viewer's progress.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct ChallengeSummary {
    pub id: i64,
    pub title: String,
    pub activity: String,
    pub goal_type: String,
    pub target_hours: f64,
    pub start_date: String,
    pub end_date: String,
    pub duration_days: i64,
    /// `upcoming`, `active` or `ended`.
    pub status: String,
    pub finalized: bool,
    /// `null` unless active.
    pub day_number: Option<i64>,
    pub participant_count: i64,
    pub is_creator: bool,
    pub me: ChallengeProgress,
}

/// The viewer's result on one challenge date.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct ChallengeDay {
    pub date: String,
    /// `null` for upcoming / none.
    pub hours: Option<f64>,
    /// `met`, `missed`, `pending`, `upcoming` or `none`.
    pub status: String,
    pub locked: bool,
}

/// A participant with progress, in a challenge detail.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct ChallengeParticipant {
    #[serde(flatten)]
    pub progress: ChallengeProgress,
    pub user: ChallengeUser,
    pub joined_on: String,
    pub is_me: bool,
    /// By the viewer.
    pub cheered_today: bool,
    /// One character per date: M met, X missed, P pending, U upcoming, - not taking part yet.
    pub days: String,
}

/// A challenge with every participant's progress.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct ChallengeDetail {
    #[serde(flatten)]
    pub summary: ChallengeSummary,
    pub invite_code: String,
    pub today: String,
    pub locked_through: Option<String>,
    /// `end_date + 2`: when the results become final.
    pub results_date: String,
    pub completion_days: i64,
    pub max_participants: i64,
    pub creator: ChallengeUser,
    pub can_invite: bool,
    pub can_leave: bool,
    pub can_delete: bool,
    /// By rank (unranked last), then username.
    pub participants: Vec<ChallengeParticipant>,
    /// One per date, start_date..end_date. Go leaves it `nil` (`null`) when the viewer is not
    /// among the participants.
    pub my_days: Option<Vec<ChallengeDay>>,
}

/// A user who can be invited to a challenge.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct InviteCandidate {
    #[serde(flatten)]
    pub user: ChallengeUser,
    /// Already has an invite (from anyone); leaving the challenge removes it.
    pub invited: bool,
}

/// What an invite link shows before joining.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct ChallengePreview {
    pub id: i64,
    pub title: String,
    pub activity: String,
    pub goal_type: String,
    pub target_hours: f64,
    pub start_date: String,
    pub end_date: String,
    pub duration_days: i64,
    pub status: String,
    pub finalized: bool,
    pub participant_count: i64,
    pub max_participants: i64,
    pub creator: ChallengeUser,
    /// Up to 5, earliest joined first.
    pub participants_preview: Vec<ChallengeUser>,
    pub is_participant: bool,
    pub can_join: bool,
    /// `ended`, `full` or `limit`.
    pub join_blocked_reason: Option<String>,
}

/// `GET /api/challenges`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ChallengeListResponse {
    pub success: bool,
    pub challenges: Vec<ChallengeSummary>,
}

/// A challenge detail response.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ChallengeResponse {
    pub success: bool,
    pub challenge: Option<ChallengeDetail>,
}

/// The result of a cheer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ChallengeCheerResponse {
    pub success: bool,
    pub already_cheered: bool,
}

/// Users who can be invited to a challenge.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct InviteCandidatesResponse {
    pub success: bool,
    pub users: Vec<InviteCandidate>,
}

/// The result of an invite request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ChallengeInviteResponse {
    pub success: bool,
    pub invited: i64,
    pub skipped: i64,
}

/// A challenge preview response.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ChallengePreviewResponse {
    pub success: bool,
    pub preview: Option<ChallengePreview>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use gt_core::gojson;

    fn decode<T: serde::de::DeserializeOwned>(json: &str) -> Result<T, serde_json::Error> {
        serde_json::from_str(json)
    }

    #[test]
    fn create_request_decodes_like_go() {
        let req: CreateChallengeRequest = decode(
            r#"{"title":"Study","activity":"study","goal_type":"at_least","target_hours":2,"duration_days":21,"start_date":"2026-10-23","x":1}"#,
        )
        .unwrap();
        assert_eq!(req.target_hours, Some(2.0));
        assert_eq!(req.duration_days, Some(21));

        let req: CreateChallengeRequest = decode(r#"{"title":null,"target_hours":null}"#).unwrap();
        assert_eq!(req, CreateChallengeRequest::default());
        assert!(decode::<CreateChallengeRequest>(r#"{"duration_days":2.5}"#).is_err());
        assert!(decode::<CreateChallengeRequest>(r#"{"duration_days":"21"}"#).is_err());
        assert!(decode::<CreateChallengeRequest>(r#"{"title":5}"#).is_err());
    }

    #[test]
    fn uint_fields_reject_negative_and_fractional_numbers() {
        assert_eq!(decode::<CheerChallengeRequest>(r#"{"user_id":42}"#).unwrap().user_id, 42);
        assert_eq!(decode::<CheerChallengeRequest>(r#"{"user_id":null}"#).unwrap().user_id, 0);
        assert_eq!(decode::<CheerChallengeRequest>("{}").unwrap().user_id, 0);
        assert!(decode::<CheerChallengeRequest>(r#"{"user_id":-1}"#).is_err());
        assert!(decode::<CheerChallengeRequest>(r#"{"user_id":1.5}"#).is_err());
        assert!(decode::<CheerChallengeRequest>(r#"{"user_id":"1"}"#).is_err());

        let req: InviteToChallengeRequest = decode(r#"{"user_ids":[3,null,4]}"#).unwrap();
        assert_eq!(req.user_ids, vec![3, 0, 4]);
        assert!(decode::<InviteToChallengeRequest>(r#"{"user_ids":null}"#).unwrap().user_ids.is_empty());
        assert!(decode::<InviteToChallengeRequest>(r#"{"user_ids":[-1]}"#).is_err());
        assert!(decode::<InviteToChallengeRequest>(r#"{"user_ids":7}"#).is_err());
    }

    #[test]
    fn participant_flattens_progress_in_go_field_order() {
        let p = ChallengeParticipant {
            progress: ChallengeProgress {
                rank: Some(1),
                days_met: 2,
                days_elapsed: 3,
                days_possible: 5,
                current_streak: 1,
                total_hours: 4.5,
                today_hours: Some(2.0),
                today_status: Some("met".into()),
                completed: None,
            },
            user: ChallengeUser { id: 7, username: "ann".into(), ..Default::default() },
            joined_on: "2026-03-09".into(),
            is_me: true,
            cheered_today: false,
            days: "MMP".into(),
        };
        assert_eq!(
            gojson::to_string(&p).unwrap(),
            r#"{"rank":1,"days_met":2,"days_elapsed":3,"days_possible":5,"current_streak":1,"total_hours":4.5,"today_hours":2,"today_status":"met","completed":null,"user":{"id":7,"username":"ann","profile_pic":null,"profile_pic_thumb":null,"is_verified":false},"joined_on":"2026-03-09","is_me":true,"cheered_today":false,"days":"MMP"}"#
        );
    }

    #[test]
    fn detail_flattens_summary_and_keeps_nulls() {
        let detail = ChallengeDetail {
            summary: ChallengeSummary {
                id: 12,
                title: "Study <2h>".into(),
                activity: "study".into(),
                goal_type: "at_least".into(),
                target_hours: 2.0,
                start_date: "2026-03-09".into(),
                end_date: "2026-03-11".into(),
                duration_days: 3,
                status: "upcoming".into(),
                ..Default::default()
            },
            invite_code: "K7Q2M9XA".into(),
            today: "2026-03-01".into(),
            results_date: "2026-03-13".into(),
            completion_days: 3,
            max_participants: 50,
            creator: ChallengeUser { id: 1, ..Default::default() },
            ..Default::default()
        };
        assert_eq!(
            gojson::to_string(&ChallengeResponse { success: true, challenge: Some(detail) }).unwrap(),
            concat!(
                r#"{"success":true,"challenge":{"id":12,"title":"Study \u003c2h\u003e","activity":"study","goal_type":"at_least","#,
                r#""target_hours":2,"start_date":"2026-03-09","end_date":"2026-03-11","duration_days":3,"status":"upcoming","#,
                r#""finalized":false,"day_number":null,"participant_count":0,"is_creator":false,"me":{"rank":null,"days_met":0,"#,
                r#""days_elapsed":0,"days_possible":0,"current_streak":0,"total_hours":0,"today_hours":null,"today_status":null,"#,
                r#""completed":null},"invite_code":"K7Q2M9XA","today":"2026-03-01","locked_through":null,"#,
                r#""results_date":"2026-03-13","completion_days":3,"max_participants":50,"creator":{"id":1,"username":"","#,
                r#""profile_pic":null,"profile_pic_thumb":null,"is_verified":false},"can_invite":false,"can_leave":false,"#,
                r#""can_delete":false,"participants":[],"my_days":null}}"#
            )
        );
    }

    #[test]
    fn small_responses_match_go() {
        let candidates = InviteCandidatesResponse {
            success: true,
            users: vec![InviteCandidate {
                user: ChallengeUser { id: 3, username: "amy".into(), is_verified: true, ..Default::default() },
                invited: true,
            }],
        };
        assert_eq!(
            gojson::to_string(&candidates).unwrap(),
            r#"{"success":true,"users":[{"id":3,"username":"amy","profile_pic":null,"profile_pic_thumb":null,"is_verified":true,"invited":true}]}"#
        );
        assert_eq!(
            gojson::to_string(&ChallengeInviteResponse { success: true, invited: 1, skipped: 2 }).unwrap(),
            r#"{"success":true,"invited":1,"skipped":2}"#
        );
        assert_eq!(
            gojson::to_string(&ChallengeCheerResponse { success: true, already_cheered: false }).unwrap(),
            r#"{"success":true,"already_cheered":false}"#
        );
        assert_eq!(
            gojson::to_string(&ChallengeListResponse { success: true, challenges: vec![] }).unwrap(),
            r#"{"success":true,"challenges":[]}"#
        );
        let day = ChallengeDay { date: "2026-03-09".into(), hours: Some(2.25), status: "met".into(), locked: true };
        assert_eq!(
            gojson::to_string(&day).unwrap(),
            r#"{"date":"2026-03-09","hours":2.25,"status":"met","locked":true}"#
        );
    }

    #[test]
    fn preview_field_order() {
        let preview = ChallengePreview {
            id: 1,
            status: "ended".into(),
            max_participants: 50,
            join_blocked_reason: Some("ended".into()),
            ..Default::default()
        };
        assert_eq!(
            gojson::to_string(&ChallengePreviewResponse { success: true, preview: Some(preview) }).unwrap(),
            concat!(
                r#"{"success":true,"preview":{"id":1,"title":"","activity":"","goal_type":"","target_hours":0,"#,
                r#""start_date":"","end_date":"","duration_days":0,"status":"ended","finalized":false,"#,
                r#""participant_count":0,"max_participants":50,"creator":{"id":0,"username":"","profile_pic":null,"#,
                r#""profile_pic_thumb":null,"is_verified":false},"participants_preview":[],"is_participant":false,"#,
                r#""can_join":false,"join_blocked_reason":"ended"}}"#
            )
        );
    }
}
