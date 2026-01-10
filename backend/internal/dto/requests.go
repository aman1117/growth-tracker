// Package dto defines Data Transfer Objects for API requests and responses.
// These structures define the contract between the frontend and backend.
package dto

import "github.com/aman1117/backend/pkg/models"

// ==================== Authentication DTOs ====================

// RegisterRequest represents the registration request body
// @Description User registration request
type RegisterRequest struct {
	Email    string `json:"email" example:"user@example.com"`
	Username string `json:"username" example:"john_doe"`
	Password string `json:"password" example:"SecurePass123"`
}

// LoginRequest represents the login request body
// @Description User login request
type LoginRequest struct {
	Identifier string `json:"identifier" example:"john_doe"` // Can be email or username
	Password   string `json:"password" example:"SecurePass123"`
}

// ForgotPasswordRequest represents the forgot password request body
// @Description Password reset request initiation
type ForgotPasswordRequest struct {
	Email string `json:"email" example:"user@example.com"`
}

// ResetPasswordRequest represents the password reset request body
// @Description Password reset with token
type ResetPasswordRequest struct {
	Token           string `json:"token" example:"abc123def456"`
	NewPassword     string `json:"new_password" example:"NewSecurePass123"`
	ConfirmPassword string `json:"confirm_password" example:"NewSecurePass123"`
}

// ChangePasswordRequest represents the change password request body
// @Description Change password for authenticated user
type ChangePasswordRequest struct {
	CurrentPassword string `json:"current_password" example:"OldPass123"`
	NewPassword     string `json:"new_password" example:"NewPass123"`
}

// ==================== User Profile DTOs ====================

// UpdateUsernameRequest represents the username update request body
// @Description Username update request
type UpdateUsernameRequest struct {
	NewUsername string `json:"new_username" example:"new_username"`
}

// UpdatePrivacyRequest represents the privacy update request body
// @Description Privacy setting update request
type UpdatePrivacyRequest struct {
	IsPrivate bool `json:"is_private" example:"true"`
}

// UpdateBioRequest represents the bio update request body
// @Description Bio update request
type UpdateBioRequest struct {
	Bio string `json:"bio" example:"Software developer | Coffee enthusiast"`
}

// ==================== Activity DTOs ====================

// CreateActivityRequest represents the activity creation/update request body
// @Description Create or update an activity
type CreateActivityRequest struct {
	Username string              `json:"username" example:"john_doe"`
	Activity models.ActivityName `json:"activity" example:"study"`
	Hours    float32             `json:"hours" example:"2.5"`
	Date     string              `json:"date" example:"2026-01-04"` // Format: YYYY-MM-DD
	Note     *string             `json:"note,omitempty" example:"Worked on Go project"`
}

// GetActivitiesRequest represents the request to fetch activities
// @Description Get activities for a date range
type GetActivitiesRequest struct {
	Username  string `json:"username" example:"john_doe"`
	StartDate string `json:"start_date" example:"2026-01-01"` // Format: YYYY-MM-DD
	EndDate   string `json:"end_date" example:"2026-01-07"`   // Format: YYYY-MM-DD
}

// ==================== Streak DTOs ====================

// GetStreakRequest represents the request to fetch streak data
// @Description Get streak data for a specific date
type GetStreakRequest struct {
	Username string `json:"username" example:"john_doe"`
	Date     string `json:"date" example:"2026-01-04"` // Format: YYYY-MM-DD
}

// ==================== Analytics DTOs ====================

// GetWeekAnalyticsRequest represents the request for weekly analytics
// @Description Get weekly analytics starting from a specific Monday
type GetWeekAnalyticsRequest struct {
	Username  string `json:"username" example:"john_doe"`
	WeekStart string `json:"week_start" example:"2025-12-30"` // Format: YYYY-MM-DD (Monday of the week)
}

// ==================== User Search DTOs ====================

// SearchUsersRequest represents the user search request body
// @Description Search for users by username
type SearchUsersRequest struct {
	Username string `json:"username" example:"john"`
}

// ==================== Tile Config DTOs ====================

// GetTileConfigByUsernameRequest represents the request to get another user's tile config
type GetTileConfigByUsernameRequest struct {
	Username string `json:"username"`
}

// SaveTileConfigRequest represents the request to save tile configuration
type SaveTileConfigRequest struct {
	Config models.JSONB `json:"config"`
}

// ==================== Like DTOs ====================

// LikeDayRequest represents the request to like/unlike a user's day
// @Description Like or unlike a user's day
type LikeDayRequest struct {
	Username string `json:"username" example:"john_doe"` // User whose day is being liked
	Date     string `json:"date" example:"2026-01-04"`   // Format: YYYY-MM-DD
}

// GetLikesRequest represents the request to get likes for a user's day
// @Description Get likes for a specific day
type GetLikesRequest struct {
	Username string `json:"username" example:"john_doe"`
	Date     string `json:"date" example:"2026-01-04"` // Format: YYYY-MM-DD
}

// ==================== Push Notification DTOs ====================

// PushSubscriptionKeys represents the encryption keys for a push subscription
type PushSubscriptionKeys struct {
	P256dh string `json:"p256dh" example:"BNcRd..."`
	Auth   string `json:"auth" example:"tBHIt..."`
}

// PushSubscriptionData represents the Web Push subscription object from the browser
type PushSubscriptionData struct {
	Endpoint string               `json:"endpoint" example:"https://fcm.googleapis.com/fcm/send/..."`
	Keys     PushSubscriptionKeys `json:"keys"`
}

// PushDeviceInfo represents device metadata for a push subscription
type PushDeviceInfo struct {
	UserAgent string `json:"userAgent,omitempty" example:"Mozilla/5.0..."`
	Platform  string `json:"platform,omitempty" example:"windows"`
	Browser   string `json:"browser,omitempty" example:"chrome"`
}

// RegisterPushSubscriptionRequest represents the request to register a push subscription
// @Description Register a new push subscription for the authenticated user
type RegisterPushSubscriptionRequest struct {
	KeyID        string               `json:"keyId" example:"prod-2026-01"`
	Subscription PushSubscriptionData `json:"subscription"`
	Device       PushDeviceInfo       `json:"device,omitempty"`
}

// UnregisterPushSubscriptionRequest represents the request to unregister a push subscription
// @Description Unregister a push subscription
type UnregisterPushSubscriptionRequest struct {
	Endpoint string `json:"endpoint" example:"https://fcm.googleapis.com/fcm/send/..."`
}

// UpdatePushPreferencesRequest represents the request to update push preferences
// @Description Update push notification preferences
type UpdatePushPreferencesRequest struct {
	PushEnabled       *bool           `json:"push_enabled,omitempty"`
	Preferences       map[string]bool `json:"preferences,omitempty"` // Per-type toggles
	QuietHoursEnabled *bool           `json:"quiet_hours_enabled,omitempty"`
	QuietStart        *string         `json:"quiet_start,omitempty"` // "HH:MM" format
	QuietEnd          *string         `json:"quiet_end,omitempty"`   // "HH:MM" format
	Timezone          *string         `json:"timezone,omitempty"`    // IANA timezone
}
