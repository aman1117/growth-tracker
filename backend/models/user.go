package models

import "time"

type User struct {
	ID           uint      `gorm:"primaryKey"`
	Email        string    `gorm:"unique;not null"`
	Username     string    `gorm:"unique;not null"`
	PasswordHash string    `gorm:"not null"`
	ProfilePic   *string   `gorm:"default:null"` // URL to profile picture, null for now
	Bio          *string   `gorm:"default:null;size:150"` // User bio, max 150 characters
	IsPrivate    bool      `gorm:"default:false"`
	CreatedAt    time.Time `gorm:"not null;default:now();autoCreateTime"`
	UpdatedAt    time.Time `gorm:"not null;default:now();autoUpdateTime"`
}
