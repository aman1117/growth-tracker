// Package models defines the domain entities for the application.
package models

import "time"

// UserBadge represents a badge earned by a user
type UserBadge struct {
	ID       uint      `gorm:"primaryKey"`
	UserID   uint      `gorm:"not null;index:idx_user_badges_user_id;uniqueIndex:idx_user_badge_unique,priority:1"`
	User     User      `gorm:"foreignKey:UserID"`
	BadgeKey string    `gorm:"not null;size:50;uniqueIndex:idx_user_badge_unique,priority:2"`
	EarnedAt time.Time `gorm:"not null;default:now()"`
}

// TableName specifies the table name for UserBadge
func (UserBadge) TableName() string {
	return "user_badges"
}
