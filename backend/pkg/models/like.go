package models

import "time"

// Like represents a user liking another user's day
type Like struct {
	ID          uint      `gorm:"primaryKey"`
	LikerID     uint      `gorm:"not null;uniqueIndex:idx_likes_unique,priority:1;index:idx_likes_liker"`
	Liker       User      `gorm:"foreignKey:LikerID;constraint:OnDelete:CASCADE"`
	LikedUserID uint      `gorm:"not null;uniqueIndex:idx_likes_unique,priority:2;index:idx_likes_liked_user_date,priority:1"`
	LikedUser   User      `gorm:"foreignKey:LikedUserID;constraint:OnDelete:CASCADE"`
	LikedDate   time.Time `gorm:"type:date;not null;uniqueIndex:idx_likes_unique,priority:3;index:idx_likes_liked_user_date,priority:2"`
	CreatedAt   time.Time `gorm:"not null;default:now();autoCreateTime"`
	UpdatedAt   time.Time `gorm:"not null;default:now();autoUpdateTime"`
}

// TableName returns the table name for the Like model
func (Like) TableName() string {
	return "likes"
}
