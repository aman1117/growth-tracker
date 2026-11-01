//! Request and response DTOs of the accounts API (port of the matching parts of
//! `internal/dto/{requests,responses,autocomplete}.go`).
//!
//! Field order, names, `omitempty` and `null` behavior follow the Go structs exactly. Request
//! DTOs decode like `encoding/json` into a Go struct: missing fields and JSON `null` leave the
//! zero value, unknown fields are ignored.

use std::collections::BTreeMap;

use chrono::NaiveDate;
use gt_core::gojson;
use serde::{Deserialize, Deserializer, Serialize};

/// Go's `encoding/json` leaves a field untouched when the JSON value is `null`.
fn null_as_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

/// A Go `[]uint`: `null` is an empty list and `null` elements decode as 0.
fn go_uint_list<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<u64>, D::Error> {
    let items = Option::<Vec<Option<u64>>>::deserialize(deserializer)?.unwrap_or_default();
    Ok(items.into_iter().map(Option::unwrap_or_default).collect())
}

fn is_zero(n: &i64) -> bool {
    *n == 0
}

// ==================== Requests ====================

/// `POST /api/register`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct RegisterRequest {
    #[serde(deserialize_with = "null_as_default")]
    pub email: String,
    #[serde(deserialize_with = "null_as_default")]
    pub username: String,
    #[serde(deserialize_with = "null_as_default")]
    pub password: String,
}

/// `POST /api/login`; `identifier` is an email or a username.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct LoginRequest {
    #[serde(deserialize_with = "null_as_default")]
    pub identifier: String,
    #[serde(deserialize_with = "null_as_default")]
    pub password: String,
}

/// `POST /api/auth/forgot-password`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct ForgotPasswordRequest {
    #[serde(deserialize_with = "null_as_default")]
    pub email: String,
}

/// `POST /api/auth/reset-password`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct ResetPasswordRequest {
    #[serde(deserialize_with = "null_as_default")]
    pub token: String,
    #[serde(deserialize_with = "null_as_default")]
    pub new_password: String,
    #[serde(deserialize_with = "null_as_default")]
    pub confirm_password: String,
}

/// `POST /api/auth/verify-email`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct VerifyEmailRequest {
    #[serde(deserialize_with = "null_as_default")]
    pub token: String,
}

/// `POST /api/change-password`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct ChangePasswordRequest {
    #[serde(deserialize_with = "null_as_default")]
    pub current_password: String,
    #[serde(deserialize_with = "null_as_default")]
    pub new_password: String,
}

/// `POST /api/update-username`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct UpdateUsernameRequest {
    #[serde(deserialize_with = "null_as_default")]
    pub new_username: String,
}

/// `POST /api/update-privacy`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct UpdatePrivacyRequest {
    #[serde(deserialize_with = "null_as_default")]
    pub is_private: bool,
}

/// `POST /api/update-bio`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct UpdateBioRequest {
    #[serde(deserialize_with = "null_as_default")]
    pub bio: String,
}

/// `POST /api/users` (username search).
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct SearchUsersRequest {
    #[serde(deserialize_with = "null_as_default")]
    pub username: String,
}

/// `POST /api/relationships/lookup`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct RelationshipLookupRequest {
    /// Go `[]uint`: negative or fractional numbers are rejected.
    #[serde(deserialize_with = "go_uint_list")]
    pub target_ids: Vec<u64>,
}

// ==================== Auth responses ====================

/// Successful login.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LoginResponse {
    pub success: bool,
    pub access_token: String,
    /// Always `Bearer`.
    pub token_type: String,
    /// RFC 3339 (UTC, whole seconds).
    pub expires_at: String,
    /// Seconds.
    pub expires_in: i64,
}

// ==================== User / profile responses ====================

/// A user in search results (Go `dto.UserDTO`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UserDto {
    pub id: i64,
    pub username: String,
    pub profile_pic: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_pic_thumb: Option<String>,
    /// Only for public profiles and private ones the viewer follows.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bio: Option<String>,
    pub is_private: bool,
    pub is_verified: bool,
}

/// `GET /api/profile`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProfileResponse {
    pub success: bool,
    pub username: String,
    pub email: String,
    pub profile_pic: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_pic_thumb: Option<String>,
    pub bio: Option<String>,
    pub is_private: bool,
    pub is_verified: bool,
    pub email_verified: bool,
    pub followers_count: i64,
    pub following_count: i64,
    /// Never set by `GET /api/profile` (omitted).
    #[serde(skip_serializing_if = "String::is_empty")]
    pub relationship_state: String,
}

/// `GET /api/users/{id}/profile`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PublicProfileResponse {
    pub success: bool,
    pub id: i64,
    pub username: String,
    pub profile_pic: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_pic_thumb: Option<String>,
    /// Hidden for private accounts the viewer does not follow.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bio: Option<String>,
    pub is_private: bool,
    pub is_verified: bool,
    pub followers_count: i64,
    pub following_count: i64,
    /// `FOLLOWING`, `REQUESTED`, `INCOMING_PENDING` or `NONE`.
    pub relationship_state: String,
    /// Date of the latest active streak (`YYYY-MM-DDT00:00:00Z`); hidden like `bio`.
    #[serde(with = "gojson::date_opt", skip_serializing_if = "Option::is_none")]
    pub last_logged_at: Option<NaiveDate>,
}

/// `POST /api/update-username`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UsernameUpdateResponse {
    pub success: bool,
    pub message: String,
    pub new_username: String,
}

/// `GET /api/get-privacy`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PrivacyResponse {
    pub success: bool,
    pub is_private: bool,
}

/// `GET /api/get-bio`; `bio` is `null` when unset.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BioResponse {
    pub success: bool,
    pub bio: Option<String>,
}

// ==================== Autocomplete ====================
//
// These also deserialize: the response (with an empty `requestId`) is cached in Redis as JSON
// and decoded again on a cache hit, like Go's `json.Unmarshal` into the same structs.

/// Extra data shown next to an autocomplete suggestion.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AutocompleteSuggestionMeta {
    #[serde(rename = "profilePic", skip_serializing_if = "Option::is_none")]
    pub profile_pic: Option<String>,
    #[serde(rename = "profilePicThumb", skip_serializing_if = "Option::is_none")]
    pub profile_pic_thumb: Option<String>,
    #[serde(rename = "isVerified", deserialize_with = "null_as_default")]
    pub is_verified: bool,
    #[serde(rename = "followersCount", deserialize_with = "null_as_default")]
    pub followers_count: i64,
}

/// One autocomplete suggestion.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AutocompleteSuggestion {
    #[serde(deserialize_with = "null_as_default")]
    pub text: String,
    /// Always `user`.
    #[serde(deserialize_with = "null_as_default")]
    pub kind: String,
    #[serde(deserialize_with = "null_as_default")]
    pub score: f64,
    #[serde(deserialize_with = "null_as_default")]
    pub meta: AutocompleteSuggestionMeta,
}

/// `GET /api/autocomplete/users`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AutocompleteResponse {
    /// The (trimmed, truncated) query as received; a cache hit echoes the cached query.
    #[serde(deserialize_with = "null_as_default")]
    pub query: String,
    /// A fresh UUID per response (empty in the cache).
    #[serde(rename = "requestId", deserialize_with = "null_as_default")]
    pub request_id: String,
    /// `None` marshals as `null` (a Go nil slice); the handler always sets it.
    pub suggestions: Option<Vec<AutocompleteSuggestion>>,
}

// ==================== Search suggestions ====================

/// A recently searched or trending user. Also decoded from the trending cache.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct SearchSuggestionUser {
    /// Go `uint`.
    #[serde(deserialize_with = "null_as_default")]
    pub id: u64,
    #[serde(deserialize_with = "null_as_default")]
    pub username: String,
    #[serde(rename = "profilePic", skip_serializing_if = "Option::is_none")]
    pub profile_pic: Option<String>,
    #[serde(rename = "profilePicThumb", skip_serializing_if = "Option::is_none")]
    pub profile_pic_thumb: Option<String>,
    #[serde(rename = "isVerified", deserialize_with = "null_as_default")]
    pub is_verified: bool,
    #[serde(rename = "followersCount", deserialize_with = "null_as_default")]
    pub followers_count: i64,
}

/// `GET /api/search/suggestions`: up to six users in total.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct SearchSuggestionsResponse {
    pub recent: Vec<SearchSuggestionUser>,
    pub trending: Vec<SearchSuggestionUser>,
}

// ==================== Follow ====================

/// Result of `POST /api/users/{id}/follow`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FollowActionResponse {
    pub success: bool,
    /// `ACTIVE` or `PENDING`.
    pub state: String,
    pub message: String,
}

/// A user in follower, following and mutual lists.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FollowUserDto {
    pub id: i64,
    pub username: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_pic: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_pic_thumb: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bio: Option<String>,
    pub is_private: bool,
    pub is_verified: bool,
    /// RFC 3339, whole seconds, in the process time zone (Go `t.Format(time.RFC3339)`).
    #[serde(skip_serializing_if = "String::is_empty")]
    pub followed_at: String,
}

/// A pending incoming follow request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FollowRequestDto {
    pub id: i64,
    pub username: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_pic: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_pic_thumb: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bio: Option<String>,
    pub is_verified: bool,
    /// RFC 3339, whole seconds, in the process time zone (Go `t.Format(time.RFC3339)`).
    pub requested_at: String,
}

/// A page of followers or followed users.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FollowListResponse {
    pub success: bool,
    pub users: Vec<FollowUserDto>,
    /// Opaque cursor for the next page; omitted on the last page.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub next_cursor: String,
    pub has_more: bool,
}

/// A page of mutual followers (same shape as [`FollowListResponse`], Go `dto.MutualsResponse`).
pub type MutualsResponse = FollowListResponse;

/// A page of pending incoming follow requests.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FollowRequestListResponse {
    pub success: bool,
    pub requests: Vec<FollowRequestDto>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub next_cursor: String,
    pub has_more: bool,
}

/// `POST /api/relationships/lookup`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RelationshipLookupResponse {
    pub success: bool,
    /// User id -> relationship state. Keyed by the decimal id so the keys sort as strings,
    /// exactly like Go's `map[uint]string` marshals.
    pub relationships: BTreeMap<String, String>,
}

/// Follow counts of a user.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct FollowCountsDto {
    pub followers_count: i64,
    pub following_count: i64,
    /// Only reported to the account owner (omitted when 0).
    #[serde(skip_serializing_if = "is_zero")]
    pub pending_requests_count: i64,
}

/// `GET /api/users/{id}/follow-counts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct FollowCountsResponse {
    pub success: bool,
    pub counts: FollowCountsDto,
}

#[cfg(test)]
mod tests {
    use super::*;
    use gt_core::gojson::to_string;

    #[test]
    fn requests_decode_like_encoding_json() {
        let req: RegisterRequest = serde_json::from_str(r#"{"email":null,"username":"a","x":1}"#).unwrap();
        assert_eq!(req, RegisterRequest { email: String::new(), username: "a".into(), password: String::new() });
        let req: RelationshipLookupRequest = serde_json::from_str(r#"{"target_ids":[null,2]}"#).unwrap();
        assert_eq!(req.target_ids, vec![0, 2]);
        let req: RelationshipLookupRequest = serde_json::from_str(r#"{"target_ids":null}"#).unwrap();
        assert!(req.target_ids.is_empty());
        for bad in [r#"{"target_ids":[-1]}"#, r#"{"target_ids":[1.5]}"#, r#"{"target_ids":"1"}"#] {
            assert!(serde_json::from_str::<RelationshipLookupRequest>(bad).is_err(), "{bad}");
        }
        assert!(serde_json::from_str::<UpdatePrivacyRequest>(r#"{"is_private":"true"}"#).is_err());
    }

    #[test]
    fn profile_responses_marshal_like_go() {
        let profile = PublicProfileResponse {
            success: true,
            id: 2,
            username: "bob".into(),
            profile_pic: None,
            profile_pic_thumb: None,
            bio: None,
            is_private: false,
            is_verified: false,
            followers_count: 0,
            following_count: 0,
            relationship_state: "NONE".into(),
            last_logged_at: NaiveDate::from_ymd_opt(2026, 3, 9),
        };
        assert_eq!(
            to_string(&profile).unwrap(),
            r#"{"success":true,"id":2,"username":"bob","profile_pic":null,"is_private":false,"is_verified":false,"followers_count":0,"following_count":0,"relationship_state":"NONE","last_logged_at":"2026-03-09T00:00:00Z"}"#
        );
        let counts = FollowCountsResponse { success: true, counts: FollowCountsDto::default() };
        assert_eq!(
            to_string(&counts).unwrap(),
            r#"{"success":true,"counts":{"followers_count":0,"following_count":0}}"#
        );
    }

    #[test]
    fn autocomplete_cache_round_trips_byte_identically() {
        // Cached by the Go backend.
        let cached = r#"{"query":"Ali","requestId":"","suggestions":[{"text":"alice","kind":"user","score":62.857142984867096,"meta":{"isVerified":false,"followersCount":0}}]}"#;
        let decoded: AutocompleteResponse = serde_json::from_str(cached).unwrap();
        assert_eq!(to_string(&decoded).unwrap(), cached);
        let empty: AutocompleteResponse = serde_json::from_str("{}").unwrap();
        assert_eq!(to_string(&empty).unwrap(), r#"{"query":"","requestId":"","suggestions":null}"#);
    }

    #[test]
    fn relationship_keys_sort_as_strings() {
        let relationships = [2, 10, 3, 100].iter().map(|id: &i64| (id.to_string(), "NONE".to_string())).collect();
        let resp = RelationshipLookupResponse { success: true, relationships };
        assert_eq!(
            to_string(&resp).unwrap(),
            r#"{"success":true,"relationships":{"10":"NONE","100":"NONE","2":"NONE","3":"NONE"}}"#
        );
    }
}
