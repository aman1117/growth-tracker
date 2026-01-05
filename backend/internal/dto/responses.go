package dto

import "github.com/aman1117/backend/pkg/models"

// ==================== Generic Response DTOs ====================

// SuccessResponse represents a generic success response
// @Description Generic success response
type SuccessResponse struct {
	Success bool   `json:"success" example:"true"`
	Message string `json:"message,omitempty" example:"Operation completed successfully"`
}

// ErrorResponse represents a generic error response
// @Description Generic error response
type ErrorResponse struct {
	Success   bool   `json:"success" example:"false"`
	Error     string `json:"error" example:"Invalid request"`
	ErrorCode string `json:"error_code" example:"INVALID_REQUEST"`
}

// DataResponse represents a generic response with data
// @Description Generic response with data payload
type DataResponse struct {
	Success bool        `json:"success" example:"true"`
	Data    interface{} `json:"data"`
}

// ==================== Authentication Response DTOs ====================

// LoginResponse represents the login response
// @Description Successful login response with JWT token
type LoginResponse struct {
	Success     bool   `json:"success" example:"true"`
	AccessToken string `json:"access_token" example:"eyJhbGciOiJIUzI1NiIs..."`
	TokenType   string `json:"token_type" example:"Bearer"`
	ExpiresAt   string `json:"expires_at" example:"2026-01-05T12:00:00Z"`
	ExpiresIn   int    `json:"expires_in" example:"86400"` // seconds
}

// TokenValidationResponse represents the token validation response
// @Description Token validation result
type TokenValidationResponse struct {
	Success bool `json:"success" example:"true"`
	Valid   bool `json:"valid" example:"true"`
}

// ==================== User DTOs ====================

// UserDTO represents a sanitized user for API responses
// @Description User information for search results
type UserDTO struct {
	ID         uint    `json:"id" example:"1"`
	Username   string  `json:"username" example:"john_doe"`
	Email      string  `json:"email" example:"john@example.com"`
	ProfilePic *string `json:"profile_pic" example:"https://storage.blob.core.windows.net/pics/1/abc.jpg"`
	Bio        *string `json:"bio,omitempty" example:"Software developer"` // Only included for public profiles
	IsPrivate  bool    `json:"is_private" example:"false"`
	IsVerified bool    `json:"is_verified" example:"false"`
}

// ProfileResponse represents the full profile response
// @Description User profile information
type ProfileResponse struct {
	Success    bool    `json:"success" example:"true"`
	Username   string  `json:"username" example:"john_doe"`
	Email      string  `json:"email" example:"john@example.com"`
	ProfilePic *string `json:"profile_pic" example:"https://storage.blob.core.windows.net/pics/1/abc.jpg"`
	Bio        *string `json:"bio" example:"Software developer"`
	IsVerified bool    `json:"is_verified" example:"false"`
}

// UsernameUpdateResponse represents the username update response
// @Description Username update result
type UsernameUpdateResponse struct {
	Success     bool   `json:"success" example:"true"`
	Message     string `json:"message" example:"Username updated successfully"`
	NewUsername string `json:"new_username" example:"new_username"`
}

// PrivacyResponse represents the privacy setting response
// @Description Privacy setting result
type PrivacyResponse struct {
	Success   bool `json:"success" example:"true"`
	IsPrivate bool `json:"is_private" example:"false"`
}

// BioResponse represents the bio response
// @Description Bio retrieval result
type BioResponse struct {
	Success bool    `json:"success" example:"true"`
	Bio     *string `json:"bio" example:"Software developer | Coffee enthusiast"`
}

// ProfilePicResponse represents the profile picture upload response
// @Description Profile picture upload result
type ProfilePicResponse struct {
	Success    bool   `json:"success" example:"true"`
	ProfilePic string `json:"profile_pic" example:"https://storage.blob.core.windows.net/pics/1/abc.jpg"`
}

// ==================== Activity DTOs ====================

// ActivityDTO represents an activity for API responses
// @Description Activity data
type ActivityDTO struct {
	ID            uint                `json:"id" example:"1"`
	Name          models.ActivityName `json:"name" example:"study"`
	DurationHours float32             `json:"hours" example:"2.5"`
	Date          string              `json:"date" example:"2026-01-04"`
	Note          *string             `json:"note,omitempty" example:"Worked on Go project"`
}

// ActivitiesResponse represents the activities list response
// @Description List of activities
type ActivitiesResponse struct {
	Success bool          `json:"success" example:"true"`
	Data    []ActivityDTO `json:"data"`
}

// ==================== Streak DTOs ====================

// StreakDTO represents streak data for API responses
// @Description Streak information
type StreakDTO struct {
	ID        uint       `json:"id" example:"1"`
	Current   int        `json:"current" example:"7"`
	Longest   int        `json:"longest" example:"30"`
	Date      string     `json:"date" example:"2026-01-04"`
	NewBadges []BadgeDTO `json:"new_badges,omitempty"`
}

// StreakResponse represents the streak response
// @Description Streak data response
type StreakResponse struct {
	Success bool      `json:"success" example:"true"`
	Data    StreakDTO `json:"data"`
}

// ==================== Analytics DTOs ====================

// DayActivityBreakdown represents a single activity in a day
// @Description Activity breakdown for a day
type DayActivityBreakdown struct {
	Name  models.ActivityName `json:"name" example:"study"`
	Hours float32             `json:"hours" example:"2.5"`
}

// DayAnalytics represents analytics for a single day
// @Description Daily analytics data
type DayAnalytics struct {
	Date       string                 `json:"date" example:"2026-01-04"`
	DayName    string                 `json:"day_name" example:"Sat"`
	TotalHours float32                `json:"total_hours" example:"8.5"`
	Activities []DayActivityBreakdown `json:"activities"`
}

// ActivitySummary represents aggregated activity data
// @Description Aggregated activity summary
type ActivitySummary struct {
	Name       models.ActivityName `json:"name" example:"study"`
	TotalHours float32             `json:"total_hours" example:"15.5"`
}

// StreakInfo represents streak information in analytics
// @Description Streak information in analytics
type StreakInfo struct {
	Current      int    `json:"current" example:"7"`
	Longest      int    `json:"longest" example:"30"`
	LongestStart string `json:"longest_start,omitempty" example:"2025-12-01"`
	LongestEnd   string `json:"longest_end,omitempty" example:"2025-12-30"`
}

// WeekAnalyticsResponse represents the weekly analytics response
// @Description Weekly analytics data
type WeekAnalyticsResponse struct {
	Success               bool              `json:"success" example:"true"`
	TotalHoursThisWeek    float32           `json:"total_hours_this_week" example:"42.5"`
	TotalHoursPrevWeek    float32           `json:"total_hours_prev_week" example:"38.0"`
	TotalHoursCurrentWeek float32           `json:"total_hours_current_week" example:"42.5"`
	PercentageChange      float32           `json:"percentage_change" example:"11.84"`
	PercentageVsCurrent   float32           `json:"percentage_vs_current" example:"0"`
	IsCurrentWeek         bool              `json:"is_current_week" example:"true"`
	Streak                StreakInfo        `json:"streak"`
	DailyBreakdown        []DayAnalytics    `json:"daily_breakdown"`
	ActivitySummary       []ActivitySummary `json:"activity_summary"`
}

// ==================== Tile Config DTOs ====================

// TileConfigResponse represents the tile configuration response
type TileConfigResponse struct {
	Success bool         `json:"success"`
	Data    models.JSONB `json:"data"`
}

// ==================== Like DTOs ====================

// LikerDTO represents a user who liked a day
// @Description User who liked a day
type LikerDTO struct {
	ID         uint    `json:"id" example:"1"`
	Username   string  `json:"username" example:"john_doe"`
	ProfilePic *string `json:"profile_pic,omitempty" example:"https://storage.blob.core.windows.net/pics/1/abc.jpg"`
	IsVerified bool    `json:"is_verified" example:"false"`
	LikedAt    string  `json:"liked_at" example:"2026-01-04T12:00:00Z"`
}

// LikesResponse represents the response for getting likes on a day
// @Description Likes data for a day
type LikesResponse struct {
	Success      bool       `json:"success" example:"true"`
	Data         []LikerDTO `json:"data"`
	Count        int64      `json:"count" example:"5"`
	UserHasLiked bool       `json:"user_has_liked" example:"true"`
}

// LikeActionResponse represents the response for like/unlike actions
// @Description Response for like/unlike action
type LikeActionResponse struct {
	Success  bool  `json:"success" example:"true"`
	Liked    bool  `json:"liked" example:"true"`
	NewCount int64 `json:"new_count" example:"6"`
}

// ==================== Badge DTOs ====================

// BadgeDTO represents a badge for API responses
// @Description Badge information
type BadgeDTO struct {
	Key       string `json:"key" example:"spark_starter"`
	Name      string `json:"name" example:"Spark Starter"`
	Icon      string `json:"icon" example:"Zap"`
	Color     string `json:"color" example:"#3b82f6"`
	Threshold int    `json:"threshold" example:"7"`
	Earned    bool   `json:"earned" example:"true"`
	EarnedAt  string `json:"earned_at,omitempty" example:"2026-01-04"`
}

// NextBadgeDTO represents the next badge to earn
// @Description Next badge to earn with progress
type NextBadgeDTO struct {
	Key       string `json:"key" example:"flame_keeper"`
	Name      string `json:"name" example:"Flame Keeper"`
	Icon      string `json:"icon" example:"Flame"`
	Color     string `json:"color" example:"#f97316"`
	Threshold int    `json:"threshold" example:"15"`
	Progress  int    `json:"progress" example:"7"`
}

// BadgesResponse represents the badges list response
// @Description List of badges
type BadgesResponse struct {
	Success   bool          `json:"success" example:"true"`
	Badges    []BadgeDTO    `json:"badges"`
	NextBadge *NextBadgeDTO `json:"next_badge,omitempty"`
}

// GetBadgesByUsernameRequest represents the request to get badges by username
// @Description Request to get badges by username
type GetBadgesByUsernameRequest struct {
	Username string `json:"username" example:"john_doe"`
}

// ==================== Notification DTOs ====================

// NotificationDTO represents a notification for API responses
// @Description Notification information
type NotificationDTO struct {
	ID        uint                   `json:"id" example:"1"`
	Type      string                 `json:"type" example:"like_received"`
	Title     string                 `json:"title" example:"New Like!"`
	Body      string                 `json:"body" example:"john_doe liked your Jan 5 activities"`
	Metadata  map[string]interface{} `json:"metadata,omitempty"`
	ReadAt    *string                `json:"read_at,omitempty" example:"2026-01-05T12:00:00Z"`
	CreatedAt string                 `json:"created_at" example:"2026-01-05T10:00:00Z"`
}

// NotificationsResponse represents paginated notifications list
// @Description Paginated list of notifications
type NotificationsResponse struct {
	Success       bool              `json:"success" example:"true"`
	Notifications []NotificationDTO `json:"notifications"`
	Total         int64             `json:"total" example:"25"`
	Page          int               `json:"page" example:"1"`
	PageSize      int               `json:"page_size" example:"20"`
	HasMore       bool              `json:"has_more" example:"true"`
}

// UnreadCountResponse represents the unread notification count
// @Description Unread notification count
type UnreadCountResponse struct {
	Success     bool  `json:"success" example:"true"`
	UnreadCount int64 `json:"unread_count" example:"5"`
}

// NotificationActionResponse represents the response for notification actions
// @Description Response for mark as read/delete actions
type NotificationActionResponse struct {
	Success bool   `json:"success" example:"true"`
	Message string `json:"message,omitempty" example:"Notification marked as read"`
}

// NotificationToDTO converts a Notification model to DTO
func NotificationToDTO(n *models.Notification) NotificationDTO {
	dto := NotificationDTO{
		ID:        n.ID,
		Type:      string(n.Type),
		Title:     n.Title,
		Body:      n.Body,
		Metadata:  n.Metadata,
		CreatedAt: n.CreatedAt.Format("2006-01-02T15:04:05Z"),
	}
	if n.ReadAt != nil {
		readAt := n.ReadAt.Format("2006-01-02T15:04:05Z")
		dto.ReadAt = &readAt
	}
	return dto
}

// NotificationsToDTOs converts a slice of Notification models to DTOs
func NotificationsToDTOs(notifications []models.Notification) []NotificationDTO {
	dtos := make([]NotificationDTO, len(notifications))
	for i, n := range notifications {
		dtos[i] = NotificationToDTO(&n)
	}
	return dtos
}
