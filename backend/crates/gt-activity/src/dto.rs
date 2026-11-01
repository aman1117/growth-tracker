//! Request and response bodies of the activity, streak, analytics, tile configuration, like
//! and badge endpoints (port of the matching DTOs in `internal/dto/requests.go` and
//! `internal/dto/responses.go`).
//!
//! Field order, `omitempty` and `null` behavior match the Go structs exactly; responses must be
//! encoded with `gt_core::response` (Go-compatible JSON). Request fields accept `null` like Go's
//! `encoding/json`, which leaves the field at its zero value.

use std::collections::BTreeMap;

use gt_users::BadgeDto;
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};

// ==================== Go decoding helpers ====================

/// Go's `encoding/json` leaves a field untouched when the JSON value is `null`; serde would
/// reject it, so decode `null` as the default value instead.
fn null_as_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

/// A Go `float32` field: `null` leaves 0 and numbers that overflow `float32` are rejected
/// (Go: `strconv.ParseFloat(s, 32)` returns a range error).
fn go_f32<'de, D: Deserializer<'de>>(deserializer: D) -> Result<f32, D::Error> {
    let Some(value) = Option::<f64>::deserialize(deserializer)? else {
        return Ok(0.0);
    };
    let narrowed = value as f32;
    if narrowed.is_infinite() {
        return Err(D::Error::custom(format!("number {value} overflows float32")));
    }
    Ok(narrowed)
}

/// A Go `uint` id: `null` leaves 0; negative and fractional numbers are rejected.
fn go_uint<'de, D: Deserializer<'de>>(deserializer: D) -> Result<i64, D::Error> {
    let value = Option::<u64>::deserialize(deserializer)?.unwrap_or_default();
    i64::try_from(value).map_err(D::Error::custom)
}

/// Converts every number to `f64`, as Go does when it decodes JSON into `interface{}` (a
/// `models.JSONB` map), so storing and echoing a configuration formats numbers like Go.
pub fn go_interface_value(value: Value) -> Value {
    match value {
        Value::Number(n) => n.as_f64().and_then(serde_json::Number::from_f64).map_or(Value::Number(n), Value::Number),
        Value::Array(items) => Value::Array(items.into_iter().map(go_interface_value).collect()),
        Value::Object(map) => Value::Object(go_interface_map(map)),
        other => other,
    }
}

/// [`go_interface_value`] for a JSON object.
pub fn go_interface_map(map: Map<String, Value>) -> Map<String, Value> {
    map.into_iter().map(|(k, v)| (k, go_interface_value(v))).collect()
}

// ==================== Requests ====================

/// `POST /api/create-activity`.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct CreateActivityRequest {
    #[serde(deserialize_with = "null_as_default")]
    pub username: String,
    /// A predefined activity name or `custom:<uuid>`.
    #[serde(deserialize_with = "null_as_default")]
    pub activity: String,
    #[serde(deserialize_with = "go_f32")]
    pub hours: f32,
    /// `YYYY-MM-DD`.
    #[serde(deserialize_with = "null_as_default")]
    pub date: String,
    pub note: Option<String>,
}

/// `POST /api/get-activities` and `POST /api/get-daily-totals`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct GetActivitiesRequest {
    #[serde(deserialize_with = "null_as_default")]
    pub username: String,
    /// `YYYY-MM-DD`.
    #[serde(deserialize_with = "null_as_default")]
    pub start_date: String,
    /// `YYYY-MM-DD`.
    #[serde(deserialize_with = "null_as_default")]
    pub end_date: String,
}

/// `POST /api/get-daily-totals` (same shape as [`GetActivitiesRequest`]).
pub type GetDailyTotalsRequest = GetActivitiesRequest;

/// `POST /api/get-streak`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct GetStreakRequest {
    #[serde(deserialize_with = "null_as_default")]
    pub username: String,
    /// `YYYY-MM-DD`.
    #[serde(deserialize_with = "null_as_default")]
    pub date: String,
}

/// `POST /api/get-week-analytics`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct GetWeekAnalyticsRequest {
    #[serde(deserialize_with = "null_as_default")]
    pub username: String,
    /// `YYYY-MM-DD` (normally a Monday).
    #[serde(deserialize_with = "null_as_default")]
    pub week_start: String,
}

/// `POST /api/tile-config/user`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct GetTileConfigByUsernameRequest {
    #[serde(deserialize_with = "null_as_default")]
    pub username: String,
}

/// `POST /api/tile-config`. `config` must be a JSON object or `null` (Go `models.JSONB`).
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct SaveTileConfigRequest {
    pub config: Option<Map<String, Value>>,
}

/// `POST /api/like-day` and `POST /api/unlike-day`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct LikeDayRequest {
    /// The user whose day is (un)liked.
    #[serde(deserialize_with = "null_as_default")]
    pub username: String,
    /// `YYYY-MM-DD`.
    #[serde(deserialize_with = "null_as_default")]
    pub date: String,
}

/// `POST /api/get-likes` (same shape as [`LikeDayRequest`]).
pub type GetLikesRequest = LikeDayRequest;

/// `POST /api/badges/user`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct GetBadgesByUsernameRequest {
    #[serde(deserialize_with = "null_as_default")]
    pub username: String,
}

// ==================== Responses ====================

/// An activity as returned by `get-activities` (Go `dto.ActivityDTO`). The note is only
/// included on the owner's own activities.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ActivityDto {
    pub id: i64,
    pub name: String,
    #[serde(rename = "hours")]
    pub duration_hours: f32,
    /// `YYYY-MM-DD`.
    pub date: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// A streak record (Go `dto.StreakDTO`); `new_badges` is omitted when nothing new was earned.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StreakDto {
    pub id: i64,
    pub current: i64,
    pub longest: i64,
    /// `YYYY-MM-DD`.
    pub date: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub new_badges: Vec<BadgeDto>,
}

/// `POST /api/get-streak` response.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StreakResponse {
    pub success: bool,
    pub data: StreakDto,
}

/// One activity of a day in the weekly analytics.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DayActivityBreakdown {
    pub name: String,
    pub hours: f32,
}

/// One day of the weekly analytics. `activities` is always an array.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DayAnalytics {
    /// `YYYY-MM-DD`.
    pub date: String,
    /// `Mon` .. `Sun` (by position in the week).
    pub day_name: String,
    pub total_hours: f32,
    pub activities: Vec<DayActivityBreakdown>,
}

/// Hours of one activity over the week.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ActivitySummary {
    pub name: String,
    pub total_hours: f32,
}

/// Streak figures of the weekly analytics; the longest-streak dates are omitted when unknown.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct StreakInfo {
    pub current: i64,
    pub longest: i64,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub longest_start: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub longest_end: String,
}

/// `POST /api/get-week-analytics` response.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WeekAnalyticsResponse {
    pub success: bool,
    pub total_hours_this_week: f32,
    pub total_hours_prev_week: f32,
    pub total_hours_current_week: f32,
    pub percentage_change: f32,
    pub percentage_vs_current: f32,
    pub is_current_week: bool,
    pub streak: StreakInfo,
    pub daily_breakdown: Vec<DayAnalytics>,
    pub activity_summary: Vec<ActivitySummary>,
}

/// Tile configuration response; `data` is `null` when the user saved none.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TileConfigResponse {
    pub success: bool,
    pub data: Option<Value>,
}

/// A user who liked a day (Go `dto.LikerDTO`). Also the element type of the likes cache, which
/// is decoded with Go's leniency (`null` fields keep their zero value).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct LikerDto {
    #[serde(deserialize_with = "go_uint")]
    pub id: i64,
    #[serde(deserialize_with = "null_as_default")]
    pub username: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_pic: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_pic_thumb: Option<String>,
    #[serde(deserialize_with = "null_as_default")]
    pub is_verified: bool,
    /// RFC 3339, whole seconds.
    #[serde(deserialize_with = "null_as_default")]
    pub liked_at: String,
}

/// Decodes the likes cache like Go's `json.Unmarshal` into `[]dto.LikerDTO`: `null` yields
/// `None` (a nil slice, i.e. a cache miss) and `null` elements are zero-valued likers.
pub fn decode_cached_likers(cached: &str) -> Result<Option<Vec<LikerDto>>, serde_json::Error> {
    let likers: Option<Vec<Option<LikerDto>>> = serde_json::from_str(cached)?;
    Ok(likers.map(|list| list.into_iter().map(Option::unwrap_or_default).collect()))
}

/// `POST /api/get-likes` response. `data` is always an array.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LikesResponse {
    pub success: bool,
    pub data: Vec<LikerDto>,
    pub count: i64,
    pub user_has_liked: bool,
}

/// `POST /api/like-day` / `POST /api/unlike-day` response.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct LikeActionResponse {
    pub success: bool,
    pub liked: bool,
    pub new_count: i64,
}

/// Badge list response. Go's `next_badge` field (`omitempty`) is never set by these endpoints,
/// so it is always omitted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BadgesResponse {
    pub success: bool,
    pub badges: Vec<BadgeDto>,
}

/// `POST /api/get-daily-totals` data: total hours per `YYYY-MM-DD` (sorted keys, like a Go map).
pub type DailyTotals = BTreeMap<String, f32>;

#[cfg(test)]
mod tests {
    use super::*;
    use gt_core::gojson;
    use serde_json::json;

    #[test]
    fn requests_decode_like_go() {
        let req: CreateActivityRequest =
            serde_json::from_str(r#"{"username":null,"activity":"study","hours":null,"date":"2026-03-09","x":1}"#)
                .unwrap();
        assert_eq!(req.username, "");
        assert_eq!(req.hours, 0.0);
        assert_eq!(req.note, None);
        let req: CreateActivityRequest = serde_json::from_str(r#"{"hours":2.5,"note":""}"#).unwrap();
        assert_eq!(req.hours, 2.5);
        assert_eq!(req.note.as_deref(), Some(""));
        assert!(serde_json::from_str::<CreateActivityRequest>(r#"{"hours":"2"}"#).is_err());
        assert!(serde_json::from_str::<CreateActivityRequest>(r#"{"hours":1e39}"#).is_err());

        let req: SaveTileConfigRequest = serde_json::from_str(r#"{"config":null}"#).unwrap();
        assert_eq!(req.config, None);
        assert!(serde_json::from_str::<SaveTileConfigRequest>(r#"{"config":[1,2]}"#).is_err());
    }

    #[test]
    fn interface_values_are_float64() {
        let v = go_interface_value(json!({"a": [1, 2.50, -3], "b": {"c": 12345678901234567890u64}, "d": "x"}));
        assert_eq!(gojson::to_string(&v).unwrap(), r#"{"a":[1,2.5,-3],"b":{"c":12345678901234567000},"d":"x"}"#);
    }

    #[test]
    fn responses_marshal_like_go() {
        let activity =
            ActivityDto { id: 3, name: "study".into(), duration_hours: 2.5, date: "2026-03-09".into(), note: None };
        assert_eq!(gojson::to_string(&activity).unwrap(), r#"{"id":3,"name":"study","hours":2.5,"date":"2026-03-09"}"#);

        let streak = StreakResponse {
            success: true,
            data: StreakDto { id: 1, current: 2, longest: 8, date: "2026-03-09".into(), new_badges: vec![] },
        };
        assert_eq!(
            gojson::to_string(&streak).unwrap(),
            r#"{"success":true,"data":{"id":1,"current":2,"longest":8,"date":"2026-03-09"}}"#
        );

        let info = StreakInfo { current: 0, longest: 2, ..Default::default() };
        assert_eq!(gojson::to_string(&info).unwrap(), r#"{"current":0,"longest":2}"#);

        let liker =
            LikerDto { id: 4, username: "amy".into(), liked_at: "2026-03-09T10:00:00Z".into(), ..Default::default() };
        assert_eq!(
            gojson::to_string(&liker).unwrap(),
            r#"{"id":4,"username":"amy","is_verified":false,"liked_at":"2026-03-09T10:00:00Z"}"#
        );
        let none = TileConfigResponse { success: true, data: None };
        assert_eq!(gojson::to_string(&none).unwrap(), r#"{"success":true,"data":null}"#);
    }

    #[test]
    fn cached_likers_decode_like_go() {
        assert_eq!(decode_cached_likers("null").unwrap(), None);
        assert_eq!(decode_cached_likers("[]").unwrap(), Some(vec![]));
        let list =
            decode_cached_likers(r#"[null,{"id":2,"username":"bo","profile_pic":"p","is_verified":true}]"#).unwrap();
        assert_eq!(
            list,
            Some(vec![
                LikerDto::default(),
                LikerDto {
                    id: 2,
                    username: "bo".into(),
                    profile_pic: Some("p".into()),
                    is_verified: true,
                    ..Default::default()
                },
            ])
        );
        assert!(decode_cached_likers("{not json").is_err());
        assert!(decode_cached_likers(r#"[{"id":-1}]"#).is_err());
    }
}
