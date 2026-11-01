//! Upload validation and the request-parsing rules of the photo handlers (Go messages and
//! codes; the messages reach clients).

use chrono::{Duration, NaiveDate};
use gt_core::constants as c;
use gt_core::error::ApiError;

use crate::form::UploadedFile;

/// `c.FormFile` failed (no multipart body or no `image` part).
pub const MSG_NO_IMAGE: &str = "No image file provided";
/// Profile picture over [`c::MAX_PROFILE_PIC_SIZE`].
pub const MSG_PROFILE_PIC_TOO_LARGE: &str = "Image size must be less than 5MB";
/// Profile picture with an extension outside [`c::ALLOWED_IMAGE_EXTENSIONS`].
pub const MSG_PROFILE_PIC_BAD_TYPE: &str = "Only JPG, PNG, WebP, and HEIC images are allowed";

/// Default and maximum `limit` of the following-stories feed.
pub const STORIES_DEFAULT_LIMIT: i64 = 20;
pub const STORIES_MAX_LIMIT: i64 = 50;
/// Default and maximum `limit` of the viewers / interactions lists.
pub const LIST_DEFAULT_LIMIT: i64 = 20;
pub const LIST_MAX_LIMIT: i64 = 100;
/// How many days back a photo may be uploaded for.
pub const PHOTO_MAX_AGE_DAYS: i64 = 7;

/// Business-rule failures of an activity photo upload (Go `ActivityPhotoService.Upload`
/// errors, sent to clients verbatim with `INVALID_REQUEST`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum PhotoRuleError {
    #[error("cannot upload photo for future date")]
    FutureDate,
    #[error("can only upload photos for the last 7 days")]
    TooOld,
    #[error("image size must be less than 5MB")]
    TooLarge,
}

/// 400 `No image file provided` (`INVALID_REQUEST`).
pub fn no_image_error() -> ApiError {
    ApiError::bad_request(MSG_NO_IMAGE, c::ERR_CODE_INVALID_REQUEST)
}

/// The profile picture checks of `BlobHandler.UploadProfilePicture`, in Go's order: size,
/// then extension.
pub fn validate_profile_picture(file: &UploadedFile) -> Result<(), ApiError> {
    if file.size > c::MAX_PROFILE_PIC_SIZE as i64 {
        return Err(ApiError::bad_request(MSG_PROFILE_PIC_TOO_LARGE, c::ERR_CODE_INVALID_REQUEST));
    }
    if !c::is_allowed_image_extension(&file_extension(&file.filename)) {
        return Err(ApiError::bad_request(MSG_PROFILE_PIC_BAD_TYPE, c::ERR_CODE_INVALID_REQUEST));
    }
    Ok(())
}

/// The photo date must be an IST day within the last [`PHOTO_MAX_AGE_DAYS`] days, today
/// included.
pub fn validate_photo_date(photo_date: NaiveDate, today_ist: NaiveDate) -> Result<(), PhotoRuleError> {
    if photo_date > today_ist {
        return Err(PhotoRuleError::FutureDate);
    }
    if photo_date < today_ist - Duration::days(PHOTO_MAX_AGE_DAYS) {
        return Err(PhotoRuleError::TooOld);
    }
    Ok(())
}

/// Activity photos share the profile picture size limit.
pub fn validate_photo_size(size: i64) -> Result<(), PhotoRuleError> {
    if size > c::MAX_PROFILE_PIC_SIZE as i64 {
        return Err(PhotoRuleError::TooLarge);
    }
    Ok(())
}

/// Go `strconv.ParseUint(s, 10, 32)`: decimal digits only, at most `u32::MAX`.
pub fn parse_uint32(s: &str) -> Option<i64> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse::<u32>().ok().map(i64::from)
}

/// A `limit` query value: `strconv.Atoi` result in `1..=max`, otherwise `default`.
pub fn parse_limit(raw: &str, default: i64, max: i64) -> i64 {
    match gt_core::extract::parse_go_int(raw) {
        Some(limit) if limit > 0 && limit <= max => limit,
        _ => default,
    }
}

/// An `offset` query value: non-negative `strconv.Atoi` result, otherwise 0.
pub fn parse_offset(raw: &str) -> i64 {
    match gt_core::extract::parse_go_int(raw) {
        Some(offset) if offset >= 0 => offset,
        _ => 0,
    }
}

/// Go `filepath.Base` with `/` separators (the Linux servers' behavior).
pub fn go_base(path: &str) -> String {
    if path.is_empty() {
        return ".".to_string();
    }
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() {
        return "/".to_string();
    }
    match trimmed.rfind('/') {
        Some(i) => trimmed[i + 1..].to_string(),
        None => trimmed.to_string(),
    }
}

/// Go `strings.ToLower(filepath.Ext(name))`: the suffix from the last `.` of the last path
/// element, `""` when there is none.
pub fn file_extension(name: &str) -> String {
    for (i, b) in name.bytes().enumerate().rev() {
        match b {
            b'/' => break,
            b'.' => return name[i..].to_lowercase(),
            _ => {}
        }
    }
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    use bytes::Bytes;

    fn file(name: &str, size: usize) -> UploadedFile {
        UploadedFile { filename: name.into(), content_type: String::new(), size: size as i64, data: Bytes::new() }
    }

    #[test]
    fn profile_picture_rules() {
        assert!(validate_profile_picture(&file("me.JPG", 10)).is_ok());
        assert!(validate_profile_picture(&file("me.heif", 10)).is_ok());
        let err = validate_profile_picture(&file("big.jpg", c::MAX_PROFILE_PIC_SIZE + 1)).unwrap_err();
        assert_eq!((err.message.as_str(), err.code.as_str()), (MSG_PROFILE_PIC_TOO_LARGE, "INVALID_REQUEST"));
        let err = validate_profile_picture(&file("notes.txt", 5)).unwrap_err();
        assert_eq!(err.message, MSG_PROFILE_PIC_BAD_TYPE);
        let err = validate_profile_picture(&file("huge.txt", c::MAX_PROFILE_PIC_SIZE + 1)).unwrap_err();
        assert_eq!(err.message, MSG_PROFILE_PIC_TOO_LARGE, "size is checked first");
        assert!(validate_profile_picture(&file("photo", 5)).is_err());
    }

    #[test]
    fn photo_date_window() {
        let today = NaiveDate::from_ymd_opt(2026, 3, 9).unwrap();
        assert_eq!(validate_photo_date(today, today), Ok(()));
        assert_eq!(validate_photo_date(today - Duration::days(7), today), Ok(()));
        assert_eq!(validate_photo_date(today - Duration::days(8), today), Err(PhotoRuleError::TooOld));
        assert_eq!(validate_photo_date(today + Duration::days(1), today), Err(PhotoRuleError::FutureDate));
        assert_eq!(PhotoRuleError::TooOld.to_string(), "can only upload photos for the last 7 days");
        assert_eq!(validate_photo_size(c::MAX_PROFILE_PIC_SIZE as i64), Ok(()));
        assert_eq!(validate_photo_size(c::MAX_PROFILE_PIC_SIZE as i64 + 1), Err(PhotoRuleError::TooLarge));
    }

    #[test]
    fn id_and_paging_parsing() {
        assert_eq!(parse_uint32("42"), Some(42));
        assert_eq!(parse_uint32("007"), Some(7));
        assert_eq!(parse_uint32("4294967295"), Some(4_294_967_295));
        assert_eq!(parse_uint32("4294967296"), None, "bit size 32");
        for bad in ["", "-1", "+1", "1.5", "abc", " 1"] {
            assert_eq!(parse_uint32(bad), None, "{bad:?}");
        }
        assert_eq!(parse_limit("", 20, 50), 20);
        assert_eq!(parse_limit("50", 20, 50), 50);
        assert_eq!(parse_limit("51", 20, 50), 20);
        assert_eq!(parse_limit("0", 20, 50), 20);
        assert_eq!(parse_limit("x", 20, 100), 20);
        assert_eq!(parse_offset("-1"), 0);
        assert_eq!(parse_offset("15"), 15);
        assert_eq!(parse_offset("+3"), 3);
    }

    #[test]
    fn go_path_helpers() {
        assert_eq!(go_base(""), ".");
        assert_eq!(go_base("///"), "/");
        assert_eq!(go_base("a/b/c.png/"), "c.png");
        assert_eq!(go_base("C:\\x\\y.jpg"), "C:\\x\\y.jpg", "backslashes are not separators on Linux");
        assert_eq!(file_extension("Me.PNG"), ".png");
        assert_eq!(file_extension("archive.tar.GZ"), ".gz");
        assert_eq!(file_extension("photo"), "");
        assert_eq!(file_extension("dir.d/photo"), "");
        assert_eq!(file_extension(".jpg"), ".jpg");
    }
}
