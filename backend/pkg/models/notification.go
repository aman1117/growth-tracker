// Package models defines the domain entities for the application.
package models

import (
	"database/sql/driver"
	"encoding/json"
	"errors"
	"time"
)

// NotificationType represents the type of notification
type NotificationType string

const (
	NotifTypeLikeReceived    NotificationType = "like_received"
	NotifTypeBadgeUnlocked   NotificationType = "badge_unlocked"
	NotifTypeStreakMilestone NotificationType = "streak_milestone"
	NotifTypeStreakAtRisk    NotificationType = "streak_at_risk"
	NotifTypeSystemAnnounce  NotificationType = "system_announcement"
	NotifTypeFollowRequest   NotificationType = "follow_request"
	NotifTypeFollowAccepted  NotificationType = "follow_accepted"
	NotifTypeNewFollower     NotificationType = "new_follower"
)

// NotificationMetadata is a flexible JSON field for notification-specific data
type NotificationMetadata map[string]interface{}

// Value implements the driver.Valuer interface for GORM
func (m NotificationMetadata) Value() (driver.Value, error) {
	if m == nil {
		return nil, nil
	}
	return json.Marshal(m)
}

// Scan implements the sql.Scanner interface for GORM
func (m *NotificationMetadata) Scan(value interface{}) error {
	if value == nil {
		*m = nil
		return nil
	}
	bytes, ok := value.([]byte)
	if !ok {
		return errors.New("failed to unmarshal NotificationMetadata")
	}
	return json.Unmarshal(bytes, m)
}

// Notification represents a user notification
type Notification struct {
	ID        uint                 `gorm:"primaryKey" json:"id"`
	UserID    uint                 `gorm:"not null;index:idx_notif_user_created;index:idx_notif_user_unread" json:"user_id"`
	Type      NotificationType     `gorm:"type:varchar(50);not null" json:"type"`
	Title     string               `gorm:"type:varchar(255);not null" json:"title"`
	Body      string               `gorm:"type:text" json:"body"`
	Metadata  NotificationMetadata `gorm:"type:jsonb" json:"metadata"`
	ReadAt    *time.Time           `gorm:"index:idx_notif_user_unread" json:"read_at"`
	CreatedAt time.Time            `gorm:"not null;default:now();autoCreateTime;index:idx_notif_user_created,sort:desc" json:"created_at"`
}

// TableName specifies the table name for Notification
func (Notification) TableName() string {
	return "notifications"
}

// IsRead returns whether the notification has been read
func (n *Notification) IsRead() bool {
	return n.ReadAt != nil
}

// ==================== Metadata Helper Types ====================

// LikeMetadata holds data for like_received notifications
type LikeMetadata struct {
	LikerID       uint   `json:"liker_id"`
	LikerUsername string `json:"liker_username"`
	LikerAvatar   string `json:"liker_avatar,omitempty"`
	LikedDate     string `json:"liked_date"`
}

// ToMap converts LikeMetadata to NotificationMetadata
func (m LikeMetadata) ToMap() NotificationMetadata {
	return NotificationMetadata{
		"liker_id":       m.LikerID,
		"liker_username": m.LikerUsername,
		"liker_avatar":   m.LikerAvatar,
		"liked_date":     m.LikedDate,
	}
}

// BadgeMetadata holds data for badge_unlocked notifications
type BadgeMetadata struct {
	BadgeID   string `json:"badge_id"`
	BadgeName string `json:"badge_name"`
	BadgeIcon string `json:"badge_icon"`
}

// ToMap converts BadgeMetadata to NotificationMetadata
func (m BadgeMetadata) ToMap() NotificationMetadata {
	return NotificationMetadata{
		"badge_id":   m.BadgeID,
		"badge_name": m.BadgeName,
		"badge_icon": m.BadgeIcon,
	}
}

// StreakMetadata holds data for streak notifications
type StreakMetadata struct {
	ActivityType string `json:"activity_type"`
	StreakCount  int    `json:"streak_count"`
}

// ToMap converts StreakMetadata to NotificationMetadata
func (m StreakMetadata) ToMap() NotificationMetadata {
	return NotificationMetadata{
		"activity_type": m.ActivityType,
		"streak_count":  m.StreakCount,
	}
}

// ==================== Notification Deduplication ====================

// NotificationDedupe ensures "only once ever" notification delivery.
// The composite unique index prevents duplicate notifications for the same
// (UserID, ActorID, Type, EntityType, EntityKey) combination.
type NotificationDedupe struct {
	ID         uint             `gorm:"primaryKey"`
	UserID     uint             `gorm:"not null;uniqueIndex:idx_notif_dedupe,priority:1;index:idx_dedupe_user"` // recipient
	ActorID    uint             `gorm:"not null;uniqueIndex:idx_notif_dedupe,priority:2"`                       // actor (e.g., liker)
	Type       NotificationType `gorm:"type:varchar(50);not null;uniqueIndex:idx_notif_dedupe,priority:3"`
	EntityType string           `gorm:"type:varchar(50);not null;uniqueIndex:idx_notif_dedupe,priority:4"`  // e.g., "day_like"
	EntityKey  string           `gorm:"type:varchar(200);not null;uniqueIndex:idx_notif_dedupe,priority:5"` // e.g., "123:2026-01-05"
	CreatedAt  time.Time        `gorm:"not null;default:now();autoCreateTime"`
}

// TableName specifies the table name for NotificationDedupe
func (NotificationDedupe) TableName() string {
	return "notification_dedupes"
}
