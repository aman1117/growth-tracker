//! Application-wide constants (port of `internal/constants/constants.go`). Names follow the Go
//! identifiers in SCREAMING_SNAKE_CASE, e.g. `ErrCodeInvalidRequest` -> `ERR_CODE_INVALID_REQUEST`.

use std::time::Duration;

const fn minutes(n: u64) -> Duration {
    Duration::from_secs(n * 60)
}

const fn hours(n: u64) -> Duration {
    Duration::from_secs(n * 3600)
}

// Date and time formats (chrono syntax; Go layout in comments)
/// Go: `2006-01-02`.
pub const DATE_FORMAT: &str = "%Y-%m-%d";
/// Go: `2006-01-02 15:04:05`.
pub const DATE_TIME_FORMAT: &str = "%Y-%m-%d %H:%M:%S";

// Timezone
pub const TIMEZONE_IST: &str = "Asia/Kolkata";

// Validation
pub const USERNAME_MIN_LENGTH: usize = 3;
pub const USERNAME_MAX_LENGTH: usize = 20;
pub const PASSWORD_MIN_LENGTH: usize = 8;
pub const BIO_MAX_LENGTH: usize = 150;
pub const NOTE_MAX_LENGTH: usize = 500;

// File upload
pub const MAX_PROFILE_PIC_SIZE: usize = 5 * 1024 * 1024;

// Activity
pub const MAX_DAILY_HOURS: f64 = 24.0;

// Custom tiles
pub const MAX_CUSTOM_TILES: usize = 5;
pub const CUSTOM_TILE_PREFIX: &str = "custom:";
pub const CUSTOM_TILE_LABEL_MAX_LEN: usize = 20;

// Tokens
pub const RESET_TOKEN_PREFIX: &str = "reset:";
pub const RESET_TOKEN_TTL: Duration = minutes(15);
pub const RESET_TOKEN_BYTE_LEN: usize = 32;
pub const BEARER_PREFIX: &str = "Bearer ";
pub const TRACE_ID_LENGTH: usize = 8;
pub const VERIFY_TOKEN_PREFIX: &str = "verify:";
pub const VERIFY_TOKEN_TTL: Duration = hours(24);
pub const VERIFY_TOKEN_BYTE_LEN: usize = 32;
pub const VERIFY_RESEND_COOLDOWN: Duration = minutes(2);
pub const VERIFY_RESEND_PREFIX: &str = "verify_cooldown:";

// Likes cache
pub const LIKES_CACHE_PREFIX: &str = "likes:";
pub const LIKES_CACHE_TTL: Duration = hours(4);

// Story likes cache
pub const STORY_LIKE_COUNT_CACHE_PREFIX: &str = "story_like_cnt:";
pub const STORY_LIKED_BY_CACHE_PREFIX: &str = "story_liked_by:";
pub const STORY_LIKE_CACHE_TTL: Duration = minutes(5);

// Notifications: Redis keys
pub const NOTIF_CHANNEL_PREFIX: &str = "notif:channel:";
pub const NOTIF_PENDING_PREFIX: &str = "notif:pending:";
pub const NOTIF_WS_CONN_PREFIX: &str = "notif:ws:conn:";
pub const NOTIF_UNREAD_PREFIX: &str = "notif:unread:";
// Notifications: TTLs
pub const NOTIF_PENDING_TTL: Duration = hours(24);
pub const NOTIF_UNREAD_CACHE_TTL: Duration = minutes(5);
pub const NOTIF_WS_CONN_TTL: Duration = Duration::from_secs(45);
// Notifications: cleanup
pub const NOTIF_READ_RETENTION_DAYS: i64 = 30;
pub const NOTIF_UNREAD_RETENTION_DAYS: i64 = 90;
// Notifications: rate limiting
pub const NOTIF_MAX_PER_HOUR: i64 = 50;
// WebSocket
pub const WS_MAX_CONNS_PER_USER: usize = 5;
pub const WS_PING_INTERVAL: Duration = Duration::from_secs(30);
pub const WS_PONG_TIMEOUT: Duration = Duration::from_secs(10);
pub const WS_WRITE_TIMEOUT: Duration = Duration::from_secs(10);
pub const WS_READ_TIMEOUT: Duration = Duration::from_secs(60);
pub const WS_MAX_MESSAGE_SIZE: usize = 512;

// Error codes: authentication
pub const ERR_CODE_UNAUTHORIZED: &str = "UNAUTHORIZED";
pub const ERR_CODE_MISSING_AUTH_HEADER: &str = "MISSING_AUTH_HEADER";
pub const ERR_CODE_INVALID_AUTH_HEADER: &str = "INVALID_AUTH_HEADER";
pub const ERR_CODE_INVALID_TOKEN: &str = "INVALID_TOKEN";
pub const ERR_CODE_INVALID_CREDENTIALS: &str = "INVALID_CREDENTIALS";
pub const ERR_CODE_INVALID_PASSWORD: &str = "INVALID_PASSWORD";
pub const ERR_CODE_TOKEN_EXPIRED: &str = "TOKEN_EXPIRED";
pub const ERR_CODE_TOKEN_GEN_FAILED: &str = "TOKEN_GENERATION_FAILED";
// Error codes: validation
pub const ERR_CODE_INVALID_REQUEST: &str = "INVALID_REQUEST";
pub const ERR_CODE_MISSING_FIELDS: &str = "MISSING_FIELDS";
pub const ERR_CODE_INVALID_DATE: &str = "INVALID_DATE";
pub const ERR_CODE_INVALID_DATE_RANGE: &str = "INVALID_DATE_RANGE";
pub const ERR_CODE_INVALID_ACTIVITY: &str = "INVALID_ACTIVITY";
pub const ERR_CODE_INVALID_USERNAME_LEN: &str = "INVALID_USERNAME_LENGTH";
pub const ERR_CODE_INVALID_USERNAME_FMT: &str = "INVALID_USERNAME_FORMAT";
pub const ERR_CODE_PASSWORD_TOO_SHORT: &str = "PASSWORD_TOO_SHORT";
pub const ERR_CODE_WEAK_PASSWORD: &str = "WEAK_PASSWORD";
pub const ERR_CODE_PASSWORD_MISMATCH: &str = "PASSWORD_MISMATCH";
pub const ERR_CODE_BIO_TOO_LONG: &str = "BIO_TOO_LONG";
pub const ERR_CODE_HOURS_EXCEEDED: &str = "HOURS_EXCEEDED";
pub const ERR_CODE_TILE_LIMIT_EXCEEDED: &str = "TILE_LIMIT_EXCEEDED";
pub const ERR_CODE_INVALID_TILE_CONFIG: &str = "INVALID_TILE_CONFIG";
pub const ERR_CODE_INVALID_COLOR: &str = "INVALID_COLOR";
// Error codes: resources
pub const ERR_CODE_USER_NOT_FOUND: &str = "USER_NOT_FOUND";
pub const ERR_CODE_USER_EXISTS: &str = "USER_EXISTS";
pub const ERR_CODE_USERNAME_TAKEN: &str = "USERNAME_TAKEN";
pub const ERR_CODE_NOT_AUTHORIZED: &str = "NOT_AUTHORIZED";
pub const ERR_CODE_ACCOUNT_PRIVATE: &str = "ACCOUNT_PRIVATE";
pub const ERR_CODE_STREAK_NOT_FOUND: &str = "STREAK_NOT_FOUND";
pub const ERR_CODE_NOTIFICATION_NOT_FOUND: &str = "NOTIFICATION_NOT_FOUND";
pub const ERR_CODE_PHOTO_NOT_FOUND: &str = "PHOTO_NOT_FOUND";
pub const ERR_CODE_CONFLICT: &str = "CONFLICT";
// Error codes: follow
pub const ERR_CODE_CANNOT_FOLLOW_SELF: &str = "CANNOT_FOLLOW_SELF";
pub const ERR_CODE_ALREADY_FOLLOWING: &str = "ALREADY_FOLLOWING";
pub const ERR_CODE_NOT_FOLLOWING: &str = "NOT_FOLLOWING";
pub const ERR_CODE_FOLLOW_REQUEST_EXISTS: &str = "FOLLOW_REQUEST_EXISTS";
pub const ERR_CODE_NO_FOLLOW_REQUEST: &str = "NO_FOLLOW_REQUEST";
pub const ERR_CODE_FOLLOW_LIMIT_EXCEEDED: &str = "FOLLOW_LIMIT_EXCEEDED";
pub const ERR_CODE_DAILY_LIMIT_EXCEEDED: &str = "DAILY_LIMIT_EXCEEDED";
// Error codes: configuration / input
pub const ERR_CODE_CONFIG_ERROR: &str = "CONFIG_ERROR";
pub const ERR_CODE_INVALID_INPUT: &str = "INVALID_INPUT";
// Error codes: operations
pub const ERR_CODE_FETCH_FAILED: &str = "FETCH_FAILED";
pub const ERR_CODE_CREATE_FAILED: &str = "CREATE_FAILED";
pub const ERR_CODE_UPDATE_FAILED: &str = "UPDATE_FAILED";
pub const ERR_CODE_SAVE_FAILED: &str = "SAVE_FAILED";
pub const ERR_CODE_DELETE_FAILED: &str = "DELETE_FAILED";
pub const ERR_CODE_DATABASE_ERROR: &str = "DATABASE_ERROR";
pub const ERR_CODE_SERVER_ERROR: &str = "SERVER_ERROR";
pub const ERR_CODE_HASH_FAILED: &str = "HASH_FAILED";
pub const ERR_CODE_STREAK_ERROR: &str = "STREAK_ERROR";
// Error codes: password reset
pub const ERR_CODE_MISSING_TOKEN: &str = "MISSING_TOKEN";
pub const ERR_CODE_INVALID_RESET_TOKEN: &str = "INVALID_TOKEN";
// Error codes: email verification
pub const ERR_CODE_INVALID_VERIFY_TOKEN: &str = "INVALID_VERIFY_TOKEN";
pub const ERR_CODE_ALREADY_VERIFIED: &str = "ALREADY_VERIFIED";
pub const ERR_CODE_VERIFY_RESEND_COOLDOWN: &str = "VERIFY_RESEND_COOLDOWN";
// Error codes: rate limiting
pub const ERR_CODE_RATE_LIMIT_EXCEEDED: &str = "RATE_LIMIT_EXCEEDED";

// Messages
pub const MSG_SUCCESS: &str = "Operation successful";
pub const MSG_USER_CREATED: &str = "User created successfully.";
pub const MSG_USERNAME_UPDATED: &str = "Username updated successfully";
pub const MSG_PRIVACY_UPDATED: &str = "Privacy setting updated";
pub const MSG_BIO_UPDATED: &str = "Bio updated successfully";
pub const MSG_PASSWORD_CHANGED: &str = "Password changed successfully";
pub const MSG_PASSWORD_RESET: &str = "Password updated successfully. You can now log in with your new password.";
pub const MSG_PASSWORD_RESET_SENT: &str = "If an account exists with this email, a password reset link has been sent.";
pub const MSG_ACTIVITY_UPDATED: &str = "Activity updated successfully";
pub const MSG_TILE_CONFIG_SAVED: &str = "Tile configuration saved successfully";
pub const MSG_PROFILE_PIC_DELETED: &str = "Profile picture deleted successfully";
pub const MSG_EMAIL_VERIFIED: &str = "Your email has been verified successfully.";
pub const MSG_VERIFICATION_EMAIL_SENT: &str = "Verification email sent. Please check your inbox.";
pub const MSG_VERIFICATION_PENDING: &str = "Please verify your email address to access all features.";

// Rate limiting windows and limits
pub const RATE_LIMIT_AUTH_WINDOW: Duration = minutes(1);
pub const RATE_LIMIT_AUTH_MAX_REQUESTS: u32 = 5;
pub const RATE_LIMIT_PASSWORD_WINDOW: Duration = minutes(15);
pub const RATE_LIMIT_PASSWORD_MAX_REQUESTS: u32 = 5;
pub const RATE_LIMIT_API_WINDOW: Duration = minutes(1);
pub const RATE_LIMIT_API_MAX_REQUESTS: u32 = 200;
pub const RATE_LIMIT_UPLOAD_WINDOW: Duration = minutes(1);
pub const RATE_LIMIT_UPLOAD_MAX_REQUESTS: u32 = 20;
pub const RATE_LIMIT_FOLLOW_WINDOW: Duration = minutes(1);
pub const RATE_LIMIT_FOLLOW_MAX_REQUESTS: u32 = 120;
pub const RATE_LIMIT_AUTOCOMPLETE_WINDOW: Duration = minutes(1);
pub const RATE_LIMIT_AUTOCOMPLETE_MAX_REQUESTS: u32 = 60;
pub const RATE_LIMIT_COMMENT_WINDOW: Duration = minutes(1);
pub const RATE_LIMIT_COMMENT_MAX_REQUESTS: u32 = 15;
pub const RATE_LIMIT_COMMENT_LIKE_WINDOW: Duration = minutes(1);
pub const RATE_LIMIT_COMMENT_LIKE_MAX_REQUESTS: u32 = 60;
pub const RATE_LIMIT_CHALLENGE_WRITE_WINDOW: Duration = minutes(1);
pub const RATE_LIMIT_CHALLENGE_WRITE_MAX_REQUESTS: u32 = 30;

// Rate limiting messages
pub const MSG_RATE_LIMIT_AUTH: &str = "Too many attempts. Please wait a minute before trying again.";
pub const MSG_RATE_LIMIT_PASSWORD: &str = "Too many password reset requests. Please try again later.";
pub const MSG_RATE_LIMIT_API: &str = "Too many requests. Please slow down.";
pub const MSG_RATE_LIMIT_UPLOAD: &str = "Too many uploads. Please wait a minute.";
pub const MSG_RATE_LIMIT_AUTOCOMPLETE: &str = "Too many search requests. Please slow down.";
pub const MSG_RATE_LIMIT_COMMENT: &str = "Too many comments. Please slow down.";
pub const MSG_RATE_LIMIT_COMMENT_LIKE: &str = "Too many like actions. Please slow down.";
pub const MSG_RATE_LIMIT_CHALLENGE_WRITE: &str = "Too many challenge actions. Please slow down.";
pub const MSG_RATE_LIMIT_FOLLOW: &str = "Too many follow actions. Please slow down.";

// Follow system
pub const FOLLOW_EVENT_CHANNEL: &str = "follow_events";
pub const FOLLOW_COUNT_CACHE_PREFIX: &str = "follow_cnt:";
pub const FOLLOW_REL_CACHE_PREFIX: &str = "follow_rel:";
pub const FOLLOW_COUNT_CACHE_TTL: Duration = minutes(5);
pub const FOLLOW_REL_CACHE_TTL: Duration = minutes(5);
pub const DEFAULT_MAX_FOLLOWS_PER_MINUTE: i64 = 60;
pub const DEFAULT_MAX_FOLLOWS_PER_DAY: i64 = 5000;
pub const DEFAULT_MAX_TOTAL_FOLLOWING: i64 = 7500;
pub const DEFAULT_TOMBSTONE_RETENTION_DAYS: i64 = 7;
pub const FOLLOW_LIST_DEFAULT_LIMIT: i64 = 20;
pub const FOLLOW_LIST_MAX_LIMIT: i64 = 100;

// Comments: validation
pub const COMMENT_BODY_MAX_LENGTH: usize = 200;
pub const COMMENT_BODY_MIN_LENGTH: usize = 1;
pub const COMMENT_MAX_MENTIONS: usize = 10;
pub const COMMENT_LIST_DEFAULT_LIMIT: i64 = 20;
pub const COMMENT_LIST_MAX_LIMIT: i64 = 50;
pub const COMMENT_REPLY_DEFAULT_LIMIT: i64 = 20;
pub const COMMENT_REPLY_MAX_LIMIT: i64 = 50;
pub const COMMENT_PREVIEW_LENGTH: usize = 100;
pub const COMMENT_DEDUPE_WINDOW: Duration = Duration::from_secs(60);
pub const COMMENT_EDIT_WINDOW: Duration = hours(1);
// Comments: error codes
pub const ERR_CODE_COMMENT_NOT_FOUND: &str = "COMMENT_NOT_FOUND";
pub const ERR_CODE_COMMENT_DELETED: &str = "COMMENT_DELETED";
pub const ERR_CODE_COMMENT_TOO_LONG: &str = "COMMENT_TOO_LONG";
pub const ERR_CODE_COMMENT_EMPTY: &str = "COMMENT_EMPTY";
pub const ERR_CODE_TOO_MANY_MENTIONS: &str = "TOO_MANY_MENTIONS";
pub const ERR_CODE_COMMENT_FORBIDDEN: &str = "COMMENT_FORBIDDEN";
pub const ERR_CODE_DUPLICATE_COMMENT: &str = "DUPLICATE_COMMENT";
pub const ERR_CODE_PARENT_NOT_FOUND: &str = "PARENT_COMMENT_NOT_FOUND";
pub const ERR_CODE_COMMENT_EDIT_EXPIRED: &str = "COMMENT_EDIT_EXPIRED";
// Comments: messages
pub const MSG_COMMENT_CREATED: &str = "Comment created successfully";
pub const MSG_COMMENT_DELETED: &str = "Comment deleted successfully";
pub const MSG_COMMENT_LIKED: &str = "Comment liked";
pub const MSG_COMMENT_UNLIKED: &str = "Comment unliked";
pub const MSG_COMMENT_EDITED: &str = "Comment edited successfully";
// Comments: cache
pub const COMMENT_COUNT_CACHE_PREFIX: &str = "comment_cnt:";
pub const COMMENT_COUNT_CACHE_TTL: Duration = minutes(5);

// Challenges: limits
pub const CHALLENGE_MAX_PARTICIPANTS: i64 = 50;
pub const CHALLENGE_MAX_OPEN_PER_USER: i64 = 10;
pub const CHALLENGE_MAX_INVITES_PER_REQUEST: usize = 20;
pub const CHALLENGE_TITLE_MAX_LENGTH: usize = 60;
pub const CHALLENGE_MIN_DURATION_DAYS: i64 = 3;
pub const CHALLENGE_MAX_DURATION_DAYS: i64 = 60;
pub const CHALLENGE_MAX_START_OFFSET_DAYS: i64 = 30;
pub const CHALLENGE_AT_LEAST_MAX_HOURS: f64 = 24.0;
pub const CHALLENGE_AT_MOST_MAX_HOURS: f64 = 23.75;
pub const CHALLENGE_HOURS_STEP: f64 = 0.25;
pub const CHALLENGE_RECENT_ENDED_LIMIT: i64 = 20;
pub const CHALLENGE_PREVIEW_PARTICIPANTS: i64 = 5;
pub const CHALLENGE_CANDIDATES_DEFAULT: i64 = 20;
pub const CHALLENGE_CANDIDATES_MAX: i64 = 50;
pub const CHALLENGE_COMPLETION_PERCENT: i64 = 80;
pub const CHALLENGE_LOCK_DELAY_DAYS: i64 = 2;
// Challenges: invite codes (no look-alikes such as 0/O, 1/I)
pub const CHALLENGE_INVITE_CODE_LENGTH: usize = 8;
pub const CHALLENGE_INVITE_CODE_ALPHABET: &str = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
// Challenges: error codes
pub const ERR_CODE_INVALID_CHALLENGE: &str = "INVALID_CHALLENGE";
pub const ERR_CODE_CHALLENGE_NOT_FOUND: &str = "CHALLENGE_NOT_FOUND";
pub const ERR_CODE_CHALLENGE_FULL: &str = "CHALLENGE_FULL";
pub const ERR_CODE_CHALLENGE_LIMIT_REACHED: &str = "CHALLENGE_LIMIT_REACHED";
pub const ERR_CODE_CHALLENGE_ENDED: &str = "CHALLENGE_ENDED";
pub const ERR_CODE_CHALLENGE_NOT_ACTIVE: &str = "CHALLENGE_NOT_ACTIVE";
pub const ERR_CODE_CREATOR_CANNOT_LEAVE: &str = "CREATOR_CANNOT_LEAVE";
pub const ERR_CODE_CHALLENGE_IN_PROGRESS: &str = "CHALLENGE_IN_PROGRESS";
pub const ERR_CODE_CANNOT_CHEER_SELF: &str = "CANNOT_CHEER_SELF";

/// Allowed file extensions for uploaded images (lowercase, with the dot).
pub const ALLOWED_IMAGE_EXTENSIONS: &[&str] = &[".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"];

/// Content type for an allowed image extension (lowercase, with the dot).
pub fn image_content_type(ext: &str) -> Option<&'static str> {
    match ext {
        ".jpg" | ".jpeg" => Some("image/jpeg"),
        ".png" => Some("image/png"),
        ".webp" => Some("image/webp"),
        ".heic" => Some("image/heic"),
        ".heif" => Some("image/heif"),
        _ => None,
    }
}

/// Whether `ext` (lowercase, with the dot) is an allowed image extension.
pub fn is_allowed_image_extension(ext: &str) -> bool {
    ALLOWED_IMAGE_EXTENSIONS.contains(&ext)
}
