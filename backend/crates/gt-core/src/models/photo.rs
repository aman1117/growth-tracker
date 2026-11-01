use chrono::{DateTime, NaiveDate, NaiveDateTime, Utc};
use serde::Serialize;
use serde_json::{json, Value};

use crate::gojson;

/// A photo uploaded for an activity on a day (`activity_photos`), one per activity per day.
#[derive(Debug, Clone, PartialEq, Serialize, sqlx::FromRow)]
pub struct ActivityPhoto {
    pub id: i64,
    pub user_id: i64,
    pub activity_name: String,
    #[serde(with = "gojson::date")]
    pub photo_date: NaiveDate,
    pub photo_url: String,
    pub thumbnail_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activity_icon: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activity_color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activity_label: Option<String>,
    #[serde(with = "gojson::time")]
    pub created_at: DateTime<Utc>,
}

impl ActivityPhoto {
    pub const COLUMNS: &'static str = "id, user_id, activity_name, photo_date, photo_url, thumbnail_url, \
         activity_icon, activity_color, activity_label, created_at";
}

/// Who viewed a story photo (`story_views`).
#[derive(Debug, Clone, PartialEq, Serialize, sqlx::FromRow)]
pub struct StoryView {
    pub id: i64,
    pub viewer_id: i64,
    pub photo_id: i64,
    #[serde(with = "gojson::time")]
    pub viewed_at: DateTime<Utc>,
}

impl StoryView {
    pub const COLUMNS: &'static str = "id, viewer_id, photo_id, viewed_at";
}

/// Who liked a story photo (`story_likes`: integer ids, timestamp without time zone).
#[derive(Debug, Clone, PartialEq, Serialize, sqlx::FromRow)]
pub struct StoryLike {
    pub id: i64,
    pub liker_id: i64,
    pub photo_id: i64,
    #[serde(with = "gojson::naive_time")]
    pub liked_at: NaiveDateTime,
}

impl StoryLike {
    pub const COLUMNS: &'static str =
        "id::int8 AS id, liker_id::int8 AS liker_id, photo_id::int8 AS photo_id, liked_at";
}

/// A viewer of a photo (API response).
#[derive(Debug, Clone, PartialEq, Serialize, sqlx::FromRow)]
pub struct PhotoViewer {
    pub user_id: i64,
    pub username: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_pic: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_pic_thumb: Option<String>,
    #[serde(with = "gojson::time")]
    pub viewed_at: DateTime<Utc>,
}

/// A liker of a photo (API response).
#[derive(Debug, Clone, PartialEq, Serialize, sqlx::FromRow)]
pub struct PhotoLiker {
    pub user_id: i64,
    pub username: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_pic: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_pic_thumb: Option<String>,
    // story_likes.liked_at is TIMESTAMP WITHOUT TIME ZONE, which Go decodes as UTC.
    #[serde(with = "gojson::time_utc")]
    pub liked_at: DateTime<Utc>,
}

/// A combined view/like entry (API response). `viewed_at` / `liked_at` are Go `time.Time`
/// values, so a missing one is the zero time `0001-01-01T00:00:00Z`, never omitted.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PhotoInteraction {
    pub user_id: i64,
    pub username: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_pic: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_pic_thumb: Option<String>,
    /// `view`, `like` or `both`.
    pub interaction_type: String,
    #[serde(with = "gojson::time")]
    pub viewed_at: DateTime<Utc>,
    // story_likes.liked_at is TIMESTAMP WITHOUT TIME ZONE, which Go decodes as UTC.
    #[serde(with = "gojson::time_utc")]
    pub liked_at: DateTime<Utc>,
}

/// A photo with its view count (Go embeds `ActivityPhoto`, so fields are flattened).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ActivityPhotoWithViews {
    #[serde(flatten)]
    pub photo: ActivityPhoto,
    pub view_count: i64,
}

/// A photo with the viewer's seen status (stories feed).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ActivityPhotoInStory {
    #[serde(flatten)]
    pub photo: ActivityPhoto,
    pub viewed: bool,
}

/// All photos of one user for a date. `photos` marshals as `null` when `None` (Go nil slice).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct UserStoryGroup {
    pub user_id: i64,
    pub username: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_pic: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_pic_thumb: Option<String>,
    pub photos: Option<Vec<ActivityPhotoInStory>>,
    pub has_unseen: bool,
}

/// `photo_uploaded` notification metadata.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PhotoUploadedMetadata {
    pub uploader_id: i64,
    pub uploader_username: String,
    pub uploader_avatar: String,
    pub photo_count: i64,
    pub photo_date: String,
}

impl PhotoUploadedMetadata {
    pub fn to_map(&self) -> Value {
        json!({
            "uploader_id": self.uploader_id,
            "uploader_username": self.uploader_username,
            "uploader_avatar": self.uploader_avatar,
            "photo_count": self.photo_count,
            "photo_date": self.photo_date,
        })
    }
}

/// `story_liked` notification metadata.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StoryLikedMetadata {
    pub liker_id: i64,
    pub liker_username: String,
    pub liker_avatar: String,
    pub photo_id: i64,
    pub photo_date: String,
}

impl StoryLikedMetadata {
    pub fn to_map(&self) -> Value {
        json!({
            "liker_id": self.liker_id,
            "liker_username": self.liker_username,
            "liker_avatar": self.liker_avatar,
            "photo_id": self.photo_id,
            "photo_date": self.photo_date,
        })
    }
}
