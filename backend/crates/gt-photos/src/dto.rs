//! Response bodies of the profile picture and activity photo endpoints. The Go handlers built
//! them as `fiber.Map`s, which marshal with sorted keys, so every struct declares its fields
//! in alphabetical order (nested Go structs keep their declaration order).

use chrono::{DateTime, Utc};
use gt_core::gojson;
use gt_core::models::{ActivityPhoto, PhotoInteraction, PhotoViewer, UserStoryGroup};
use serde::Serialize;

/// `POST /api/profile/upload-picture`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ProfilePictureResponse {
    pub profile_pic: String,
    pub profile_pic_thumb: String,
    pub success: bool,
}

/// `POST /api/activity-photo`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PhotoUploadResponse {
    pub photo: ActivityPhoto,
    pub success: bool,
}

/// `GET /api/activity-photos`. GORM `Find` never yields a nil slice, so `photos` is `[]` when
/// empty.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PhotosResponse {
    pub photos: Vec<ActivityPhoto>,
    pub success: bool,
}

/// `GET /api/activity-photos/following`. `stories` is `null` when nobody followed posted.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StoriesResponse {
    pub stories: Option<Vec<UserStoryGroup>>,
    pub success: bool,
}

/// `GET /api/activity-photo/{id}/viewers`. `viewers` is `null` when the page is empty.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ViewersResponse {
    pub success: bool,
    pub total: i64,
    pub viewers: Option<Vec<PhotoViewer>>,
}

/// `GET /api/activity-photo/{id}/interactions`. `interactions` is `null` when the page is
/// empty.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct InteractionsResponse {
    pub interactions: Option<Vec<PhotoInteractionJson>>,
    pub success: bool,
    pub total: i64,
}

/// One interaction as Go marshaled it: `viewed_at` comes from a `TIMESTAMPTZ` column (local
/// zone) but `liked_at` from a `TIMESTAMP WITHOUT TIME ZONE` column, which pgx decoded as UTC,
/// so it always ends in `Z`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PhotoInteractionJson {
    pub user_id: i64,
    pub username: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_pic: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_pic_thumb: Option<String>,
    pub interaction_type: String,
    #[serde(with = "gojson::time")]
    pub viewed_at: DateTime<Utc>,
    #[serde(with = "gojson::time_utc")]
    pub liked_at: DateTime<Utc>,
}

impl From<PhotoInteraction> for PhotoInteractionJson {
    fn from(i: PhotoInteraction) -> Self {
        Self {
            user_id: i.user_id,
            username: i.username,
            profile_pic: i.profile_pic,
            profile_pic_thumb: i.profile_pic_thumb,
            interaction_type: i.interaction_type,
            viewed_at: i.viewed_at,
            liked_at: i.liked_at,
        }
    }
}

/// `GET /api/activity-photo/{id}/like-status`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct LikeStatusResponse {
    pub like_count: i64,
    pub liked: bool,
    pub success: bool,
}

/// `{"success":true}` (record view, like, unlike).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct SuccessResponse {
    pub success: bool,
}

impl SuccessResponse {
    pub const OK: SuccessResponse = SuccessResponse { success: true };
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{NaiveDate, TimeZone, Utc};
    use gt_core::gojson;

    fn photo() -> ActivityPhoto {
        ActivityPhoto {
            id: 5,
            user_id: 2,
            activity_name: "study".into(),
            photo_date: NaiveDate::from_ymd_opt(2026, 1, 4).unwrap(),
            photo_url: "https://a.blob.core.windows.net/c/x.jpg".into(),
            thumbnail_url: "https://a.blob.core.windows.net/c/x_thumb.jpg".into(),
            activity_icon: None,
            activity_color: Some("#fff".into()),
            activity_label: None,
            created_at: Utc.with_ymd_and_hms(2026, 1, 4, 10, 0, 0).unwrap(),
        }
    }

    #[test]
    fn keys_are_sorted_like_fiber_maps() {
        let body = ProfilePictureResponse { profile_pic: "p".into(), profile_pic_thumb: "t".into(), success: true };
        assert_eq!(gojson::to_string(&body).unwrap(), r#"{"profile_pic":"p","profile_pic_thumb":"t","success":true}"#);
        let body = LikeStatusResponse { like_count: 3, liked: false, success: true };
        assert_eq!(gojson::to_string(&body).unwrap(), r#"{"like_count":3,"liked":false,"success":true}"#);
        assert_eq!(gojson::to_string(&SuccessResponse::OK).unwrap(), r#"{"success":true}"#);
    }

    #[test]
    fn photo_upload_body() {
        let body = PhotoUploadResponse { photo: photo(), success: true };
        // `created_at` is a local-zone Go time (`Z` on UTC hosts); the date is always UTC.
        let created_at = gojson::format_go_time(&Utc.with_ymd_and_hms(2026, 1, 4, 10, 0, 0).unwrap());
        assert_eq!(
            gojson::to_string(&body).unwrap(),
            format!(
                r##"{{"photo":{{"id":5,"user_id":2,"activity_name":"study","photo_date":"2026-01-04T00:00:00Z","photo_url":"https://a.blob.core.windows.net/c/x.jpg","thumbnail_url":"https://a.blob.core.windows.net/c/x_thumb.jpg","activity_color":"#fff","created_at":"{created_at}"}},"success":true}}"##
            )
        );
    }

    #[test]
    fn empty_lists_marshal_like_go() {
        assert_eq!(
            gojson::to_string(&ViewersResponse { success: true, total: 0, viewers: None }).unwrap(),
            r#"{"success":true,"total":0,"viewers":null}"#
        );
        assert_eq!(
            gojson::to_string(&InteractionsResponse { interactions: None, success: true, total: 2 }).unwrap(),
            r#"{"interactions":null,"success":true,"total":2}"#
        );
        assert_eq!(
            gojson::to_string(&StoriesResponse { stories: None, success: true }).unwrap(),
            r#"{"stories":null,"success":true}"#
        );
        assert_eq!(
            gojson::to_string(&PhotosResponse { photos: vec![], success: true }).unwrap(),
            r#"{"photos":[],"success":true}"#
        );
    }

    #[test]
    fn interaction_times_follow_their_column_types() {
        let viewed = Utc.with_ymd_and_hms(2026, 3, 9, 8, 0, 0).unwrap();
        let interaction = PhotoInteractionJson::from(PhotoInteraction {
            user_id: 3,
            username: "amy".into(),
            profile_pic: None,
            profile_pic_thumb: None,
            interaction_type: "both".into(),
            viewed_at: viewed,
            liked_at: Utc.with_ymd_and_hms(2026, 3, 9, 13, 30, 0).unwrap(),
        });
        assert_eq!(
            gojson::to_string(&interaction).unwrap(),
            format!(
                r#"{{"user_id":3,"username":"amy","interaction_type":"both","viewed_at":"{}","liked_at":"2026-03-09T13:30:00Z"}}"#,
                gojson::format_go_time(&viewed)
            )
        );
        let never =
            PhotoInteractionJson { liked_at: gojson::go_zero_time(), viewed_at: gojson::go_zero_time(), ..interaction };
        let json = gojson::to_string(&never).unwrap();
        assert!(json.ends_with(r#""viewed_at":"0001-01-01T00:00:00Z","liked_at":"0001-01-01T00:00:00Z"}"#), "{json}");
    }
}
