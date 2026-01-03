package models

import "time"

// Streak represents a user's activity streak
type Streak struct {
	ID uint `gorm:"primaryKey"`

	UserID       uint      `gorm:"not null;index:idx_streaks_user_date"`
	User         User      `gorm:"foreignKey:UserID;constraint:OnUpdate:CASCADE,OnDelete:CASCADE"`
	Current      int       `gorm:"not null;default:0"`
	Longest      int       `gorm:"not null;default:0"`
	ActivityDate time.Time `gorm:"type:date;default:CURRENT_DATE;index:idx_streaks_user_date"`
}

// TableName specifies the table name for Streak
func (Streak) TableName() string {
	return "streaks"
}
