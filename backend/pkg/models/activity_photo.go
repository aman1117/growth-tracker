// Package models defines the activity photo domain entities.
package models

import (
	"time"
)

// ActivityPhoto represents a photo uploaded for an activity on a specific day.
// Each user can upload one photo per activity per day.
type ActivityPhoto struct {
	ID           uint      `gorm:"primaryKey" json:"id"`
	UserID       uint      `gorm:"not null;uniqueIndex:idx_activity_photo_unique,priority:1;index:idx_activity_photo_user_date" json:"user_id"`
	User         User      `gorm:"foreignKey:UserID;constraint:OnUpdate:CASCADE,OnDelete:CASCADE" json:"-"`
	ActivityName string    `gorm:"type:varchar(50);not null;uniqueIndex:idx_activity_photo_unique,priority:2" json:"activity_name"`
	PhotoDate    time.Time `gorm:"type:date;not null;uniqueIndex:idx_activity_photo_unique,priority:3;index:idx_activity_photo_user_date;index:idx_activity_photo_date,sort:desc" json:"photo_date"`
	PhotoURL     string    `gorm:"type:varchar(500);not null" json:"photo_url"`
	ThumbnailURL string    `gorm:"type:varchar(500);not null" json:"thumbnail_url"`
	// Custom tile metadata (optional, only for custom activities)
	ActivityIcon  *string   `gorm:"type:varchar(50)" json:"activity_icon,omitempty"`
	ActivityColor *string   `gorm:"type:varchar(20)" json:"activity_color,omitempty"`
	ActivityLabel *string   `gorm:"type:varchar(50)" json:"activity_label,omitempty"`
	CreatedAt     time.Time `gorm:"not null;default:now();autoCreateTime" json:"created_at"`
}

// TableName specifies the table name for ActivityPhoto
func (ActivityPhoto) TableName() string {
	return "activity_photos"
}

// StoryView tracks who has viewed a story photo.
// Used for "seen by" feature.
type StoryView struct {
	ID       uint          `gorm:"primaryKey" json:"id"`
	ViewerID uint          `gorm:"not null;uniqueIndex:idx_story_view_unique,priority:1;index:idx_story_view_viewer" json:"viewer_id"`
	Viewer   User          `gorm:"foreignKey:ViewerID;constraint:OnUpdate:CASCADE,OnDelete:CASCADE" json:"-"`
	PhotoID  uint          `gorm:"not null;uniqueIndex:idx_story_view_unique,priority:2;index:idx_story_view_photo" json:"photo_id"`
	Photo    ActivityPhoto `gorm:"foreignKey:PhotoID;constraint:OnUpdate:CASCADE,OnDelete:CASCADE" json:"-"`
	ViewedAt time.Time     `gorm:"not null;default:now();autoCreateTime" json:"viewed_at"`
}

// TableName specifies the table name for StoryView
func (StoryView) TableName() string {
	return "story_views"
}

// PhotoViewer represents a user who viewed a photo (for API responses)
type PhotoViewer struct {
	UserID     uint      `json:"user_id"`
	Username   string    `json:"username"`
	ProfilePic *string   `json:"profile_pic,omitempty"`
	ViewedAt   time.Time `json:"viewed_at"`
}

// ActivityPhotoWithViews combines a photo with its view count
type ActivityPhotoWithViews struct {
	ActivityPhoto
	ViewCount int64 `json:"view_count"`
}

// ActivityPhotoInStory extends ActivityPhoto with view status (for following stories)
type ActivityPhotoInStory struct {
	ActivityPhoto
	Viewed bool `json:"viewed"`
}

// UserStoryGroup represents all photos from a single user for a date
type UserStoryGroup struct {
	UserID     uint                   `json:"user_id"`
	Username   string                 `json:"username"`
	ProfilePic *string                `json:"profile_pic,omitempty"`
	Photos     []ActivityPhotoInStory `json:"photos"`
	HasUnseen  bool                   `json:"has_unseen"`
}

// StoryLike tracks who has liked a story photo.
// Used for "liked by" feature, similar to StoryView.
type StoryLike struct {
	ID      uint          `gorm:"primaryKey" json:"id"`
	LikerID uint          `gorm:"not null;uniqueIndex:idx_story_like_unique,priority:1;index:idx_story_like_liker" json:"liker_id"`
	Liker   User          `gorm:"foreignKey:LikerID;constraint:OnUpdate:CASCADE,OnDelete:CASCADE" json:"-"`
	PhotoID uint          `gorm:"not null;uniqueIndex:idx_story_like_unique,priority:2;index:idx_story_like_photo" json:"photo_id"`
	Photo   ActivityPhoto `gorm:"foreignKey:PhotoID;constraint:OnUpdate:CASCADE,OnDelete:CASCADE" json:"-"`
	LikedAt time.Time     `gorm:"not null;default:now();autoCreateTime" json:"liked_at"`
}

// TableName specifies the table name for StoryLike
func (StoryLike) TableName() string {
	return "story_likes"
}

// PhotoLiker represents a user who liked a photo (for API responses)
type PhotoLiker struct {
	UserID     uint      `json:"user_id"`
	Username   string    `json:"username"`
	ProfilePic *string   `json:"profile_pic,omitempty"`
	LikedAt    time.Time `json:"liked_at"`
}

// PhotoInteraction represents a combined view/like entry (for API responses)
type PhotoInteraction struct {
	UserID          uint      `json:"user_id"`
	Username        string    `json:"username"`
	ProfilePic      *string   `json:"profile_pic,omitempty"`
	InteractionType string    `json:"interaction_type"` // "view", "like", or "both"
	ViewedAt        time.Time `json:"viewed_at,omitempty"`
	LikedAt         time.Time `json:"liked_at,omitempty"`
}

// PhotoUploadedMetadata holds data for photo_uploaded notifications
type PhotoUploadedMetadata struct {
	UploaderID       uint   `json:"uploader_id"`
	UploaderUsername string `json:"uploader_username"`
	UploaderAvatar   string `json:"uploader_avatar,omitempty"`
	PhotoCount       int    `json:"photo_count"`
	PhotoDate        string `json:"photo_date"`
}

// StoryLikedMetadata holds data for story_liked notifications
type StoryLikedMetadata struct {
	LikerID       uint   `json:"liker_id"`
	LikerUsername string `json:"liker_username"`
	LikerAvatar   string `json:"liker_avatar,omitempty"`
	PhotoID       uint   `json:"photo_id"`
	PhotoDate     string `json:"photo_date"`
}

// ToMap converts StoryLikedMetadata to NotificationMetadata
func (m StoryLikedMetadata) ToMap() NotificationMetadata {
	return NotificationMetadata{
		"liker_id":       m.LikerID,
		"liker_username": m.LikerUsername,
		"liker_avatar":   m.LikerAvatar,
		"photo_id":       m.PhotoID,
		"photo_date":     m.PhotoDate,
	}
}

// ToMap converts PhotoUploadedMetadata to NotificationMetadata
func (m PhotoUploadedMetadata) ToMap() NotificationMetadata {
	return NotificationMetadata{
		"uploader_id":       m.UploaderID,
		"uploader_username": m.UploaderUsername,
		"uploader_avatar":   m.UploaderAvatar,
		"photo_count":       m.PhotoCount,
		"photo_date":        m.PhotoDate,
	}
}
