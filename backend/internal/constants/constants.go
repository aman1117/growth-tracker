// Package constants defines all application-wide constants to avoid magic numbers and strings.
package constants

import "time"

// Date and time formats
const (
	DateFormat     = "2006-01-02"
	DateTimeFormat = "2006-01-02 15:04:05"
	RFC3339Format  = time.RFC3339
)

// Timezone constants
const (
	TimezoneIST = "Asia/Kolkata"
)

// Validation constants
const (
	UsernameMinLength = 3
	UsernameMaxLength = 20
	PasswordMinLength = 8
	BioMaxLength      = 150
	NoteMaxLength     = 500
)

// File upload constants
const (
	MaxProfilePicSize = 5 * 1024 * 1024 // 5MB
)

// Activity constants
const (
	MaxDailyHours = 24.0
)

// Custom tile constants
const (
	MaxCustomTiles        = 5
	CustomTilePrefix      = "custom:"
	CustomTileLabelMaxLen = 20
)

// Token constants
const (
	ResetTokenPrefix  = "reset:"
	ResetTokenTTL     = 15 * time.Minute
	ResetTokenByteLen = 32
	BearerPrefix      = "Bearer "
	TraceIDLength     = 8
)

// Likes cache constants
const (
	LikesCachePrefix = "likes:"
	LikesCacheTTL    = 4 * time.Hour
)

// Notification constants
const (
	// Redis keys
	NotifChannelPrefix = "notif:channel:" // Pub/Sub channel per user
	NotifPendingPrefix = "notif:pending:" // Fallback queue per user
	NotifWSConnPrefix  = "notif:ws:conn:" // WebSocket connection tracking
	NotifUnreadPrefix  = "notif:unread:"  // Cached unread count

	// TTLs
	NotifPendingTTL     = 24 * time.Hour   // Pending notifications expire after 24h
	NotifUnreadCacheTTL = 5 * time.Minute  // Unread count cache TTL
	NotifWSConnTTL      = 45 * time.Second // WebSocket connection tracking TTL (should be > ping interval)

	// Cleanup settings
	NotifReadRetentionDays   = 30 // Delete read notifications after 30 days
	NotifUnreadRetentionDays = 90 // Delete unread notifications after 90 days

	// Rate limiting
	NotifMaxPerHour = 50 // Max notifications per user per hour

	// WebSocket settings
	WSMaxConnsPerUser = 5                // Max concurrent WebSocket connections per user
	WSPingInterval    = 30 * time.Second // Heartbeat ping interval
	WSPongTimeout     = 10 * time.Second // Pong response timeout
	WSWriteTimeout    = 10 * time.Second // Write deadline
	WSReadTimeout     = 60 * time.Second // Read deadline (should be > ping interval)
	WSMaxMessageSize  = 512              // Max incoming message size (bytes)
)

// Error codes for consistent API responses
const (
	// Authentication errors
	ErrCodeUnauthorized       = "UNAUTHORIZED"
	ErrCodeMissingAuthHeader  = "MISSING_AUTH_HEADER"
	ErrCodeInvalidAuthHeader  = "INVALID_AUTH_HEADER"
	ErrCodeInvalidToken       = "INVALID_TOKEN"
	ErrCodeInvalidCredentials = "INVALID_CREDENTIALS"
	ErrCodeInvalidPassword    = "INVALID_PASSWORD"
	ErrCodeTokenExpired       = "TOKEN_EXPIRED"
	ErrCodeTokenGenFailed     = "TOKEN_GENERATION_FAILED"

	// Validation errors
	ErrCodeInvalidRequest     = "INVALID_REQUEST"
	ErrCodeMissingFields      = "MISSING_FIELDS"
	ErrCodeInvalidDate        = "INVALID_DATE"
	ErrCodeInvalidDateRange   = "INVALID_DATE_RANGE"
	ErrCodeInvalidActivity    = "INVALID_ACTIVITY"
	ErrCodeInvalidUsernameLen = "INVALID_USERNAME_LENGTH"
	ErrCodeInvalidUsernameFmt = "INVALID_USERNAME_FORMAT"
	ErrCodePasswordTooShort   = "PASSWORD_TOO_SHORT"
	ErrCodeWeakPassword       = "WEAK_PASSWORD"
	ErrCodePasswordMismatch   = "PASSWORD_MISMATCH"
	ErrCodeBioTooLong         = "BIO_TOO_LONG"
	ErrCodeHoursExceeded      = "HOURS_EXCEEDED"
	ErrCodeTileLimitExceeded  = "TILE_LIMIT_EXCEEDED"
	ErrCodeInvalidTileConfig  = "INVALID_TILE_CONFIG"
	ErrCodeInvalidColor       = "INVALID_COLOR"

	// Resource errors
	ErrCodeUserNotFound         = "USER_NOT_FOUND"
	ErrCodeUserExists           = "USER_EXISTS"
	ErrCodeUsernameTaken        = "USERNAME_TAKEN"
	ErrCodeNotAuthorized        = "NOT_AUTHORIZED"
	ErrCodeAccountPrivate       = "ACCOUNT_PRIVATE"
	ErrCodeStreakNotFound       = "STREAK_NOT_FOUND"
	ErrCodeNotificationNotFound = "NOTIFICATION_NOT_FOUND"

	// Operation errors
	ErrCodeFetchFailed   = "FETCH_FAILED"
	ErrCodeCreateFailed  = "CREATE_FAILED"
	ErrCodeUpdateFailed  = "UPDATE_FAILED"
	ErrCodeSaveFailed    = "SAVE_FAILED"
	ErrCodeDeleteFailed  = "DELETE_FAILED"
	ErrCodeDatabaseError = "DATABASE_ERROR"
	ErrCodeServerError   = "SERVER_ERROR"
	ErrCodeHashFailed    = "HASH_FAILED"
	ErrCodeStreakError   = "STREAK_ERROR"

	// Password reset errors
	ErrCodeMissingToken      = "MISSING_TOKEN"
	ErrCodeInvalidResetToken = "INVALID_TOKEN"
)

// HTTP status messages
const (
	MsgSuccess           = "Operation successful"
	MsgUserCreated       = "User created successfully."
	MsgUsernameUpdated   = "Username updated successfully"
	MsgPrivacyUpdated    = "Privacy setting updated"
	MsgBioUpdated        = "Bio updated successfully"
	MsgPasswordChanged   = "Password changed successfully"
	MsgPasswordReset     = "Password updated successfully. You can now log in with your new password."
	MsgPasswordResetSent = "If an account exists with this email, a password reset link has been sent."
	MsgActivityUpdated   = "Activity updated successfully"
	MsgTileConfigSaved   = "Tile configuration saved successfully"
	MsgProfilePicDeleted = "Profile picture deleted successfully"
)

// Rate limiting constants
const (
	// Auth endpoints - strict limits to prevent brute force
	RateLimitAuthWindow      = 1 * time.Minute
	RateLimitAuthMaxRequests = 5 // 5 requests per minute for login/register

	// Password reset - moderate limits (per 15 min window)
	RateLimitPasswordWindow      = 15 * time.Minute
	RateLimitPasswordMaxRequests = 5 // 5 requests per 15 minutes

	// General API - moderate limits for authenticated users
	RateLimitAPIWindow      = 1 * time.Minute
	RateLimitAPIMaxRequests = 100 // 100 requests per minute

	// File upload - prevent abuse
	RateLimitUploadWindow      = 1 * time.Minute
	RateLimitUploadMaxRequests = 10 // 10 uploads per minute
)

// Rate limiting error codes
const (
	ErrCodeRateLimitExceeded = "RATE_LIMIT_EXCEEDED"
)

// Rate limiting messages
const (
	MsgRateLimitAuth     = "Too many attempts. Please wait a minute before trying again."
	MsgRateLimitPassword = "Too many password reset requests. Please try again later."
	MsgRateLimitAPI      = "Too many requests. Please slow down."
	MsgRateLimitUpload   = "Too many uploads. Please wait a minute."
)

// Allowed file extensions for profile pictures
var AllowedImageExtensions = map[string]bool{
	".jpg":  true,
	".jpeg": true,
	".png":  true,
	".webp": true,
	".heic": true,
	".heif": true,
}

// Content types for image extensions
var ImageContentTypes = map[string]string{
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".png":  "image/png",
	".webp": "image/webp",
	".heic": "image/heic",
	".heif": "image/heif",
}
