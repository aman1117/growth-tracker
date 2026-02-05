// Package models defines the domain entities for the application.
package models

import "time"

// RecentSearch tracks a user's recent profile searches for personalized suggestions.
// Used for syncing recent search history across devices.
type RecentSearch struct {
	ID             uint      `gorm:"primaryKey"`
	UserID         uint      `gorm:"not null;index:idx_recent_search_user_time,priority:1"`
	SearchedUserID uint      `gorm:"not null"`
	SearchedAt     time.Time `gorm:"not null;index:idx_recent_search_user_time,priority:2,sort:desc"`
}

// TableName specifies the table name for RecentSearch
func (RecentSearch) TableName() string {
	return "recent_searches"
}
