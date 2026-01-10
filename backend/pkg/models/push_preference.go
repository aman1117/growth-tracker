// Package models defines the domain entities for the application.
package models

import (
	"database/sql/driver"
	"encoding/json"
	"errors"
	"time"
)

// PushPreferences is a flexible JSON field for per-type notification settings
type PushPreferences map[string]bool

// Value implements the driver.Valuer interface for GORM
func (p PushPreferences) Value() (driver.Value, error) {
	if p == nil {
		return nil, nil
	}
	return json.Marshal(p)
}

// Scan implements the sql.Scanner interface for GORM
func (p *PushPreferences) Scan(value interface{}) error {
	if value == nil {
		*p = nil
		return nil
	}
	bytes, ok := value.([]byte)
	if !ok {
		return errors.New("failed to unmarshal PushPreferences")
	}
	return json.Unmarshal(bytes, p)
}

// PushPreference represents a user's push notification preferences
type PushPreference struct {
	ID     uint `gorm:"primaryKey" json:"id"`
	UserID uint `gorm:"not null;uniqueIndex:idx_push_pref_user" json:"user_id"`

	// Global push enable/disable
	PushEnabled bool `gorm:"not null;default:true" json:"push_enabled"`

	// Per-type preferences: {"like_received": true, "badge_unlocked": false, ...}
	Preferences PushPreferences `gorm:"type:jsonb;default:'{}'" json:"preferences"`

	// Quiet hours settings
	QuietHoursEnabled bool   `gorm:"not null;default:false" json:"quiet_hours_enabled"`
	QuietStart        string `gorm:"type:varchar(5)" json:"quiet_start"`                      // "22:00" (HH:MM format)
	QuietEnd          string `gorm:"type:varchar(5)" json:"quiet_end"`                        // "08:00" (HH:MM format)
	Timezone          string `gorm:"type:varchar(50);default:'Asia/Kolkata'" json:"timezone"` // IANA timezone

	// Timestamps
	CreatedAt time.Time `gorm:"not null;default:now();autoCreateTime" json:"created_at"`
	UpdatedAt time.Time `gorm:"not null;default:now();autoUpdateTime" json:"updated_at"`
}

// TableName specifies the table name for PushPreference
func (PushPreference) TableName() string {
	return "push_preferences"
}

// IsTypeEnabled checks if a specific notification type is enabled
// Returns true if not explicitly disabled (opt-out model)
func (p *PushPreference) IsTypeEnabled(notificationType string) bool {
	if !p.PushEnabled {
		return false
	}
	if p.Preferences == nil {
		return true // Default to enabled
	}
	enabled, exists := p.Preferences[notificationType]
	if !exists {
		return true // Default to enabled if not set
	}
	return enabled
}

// IsInQuietHours checks if the current time is within quiet hours
func (p *PushPreference) IsInQuietHours(currentTime time.Time) bool {
	if !p.QuietHoursEnabled || p.QuietStart == "" || p.QuietEnd == "" {
		return false
	}

	// Load user's timezone
	loc, err := time.LoadLocation(p.Timezone)
	if err != nil {
		loc = time.UTC
	}

	// Convert current time to user's timezone
	userTime := currentTime.In(loc)
	currentMinutes := userTime.Hour()*60 + userTime.Minute()

	// Parse quiet hours
	startMinutes := parseTimeToMinutes(p.QuietStart)
	endMinutes := parseTimeToMinutes(p.QuietEnd)

	// Handle overnight quiet hours (e.g., 22:00 - 08:00)
	if startMinutes > endMinutes {
		// Quiet hours span midnight
		return currentMinutes >= startMinutes || currentMinutes < endMinutes
	}

	// Same-day quiet hours (e.g., 13:00 - 14:00)
	return currentMinutes >= startMinutes && currentMinutes < endMinutes
}

// parseTimeToMinutes converts "HH:MM" to minutes since midnight
func parseTimeToMinutes(timeStr string) int {
	var hour, minute int
	_, err := parseHHMM(timeStr, &hour, &minute)
	if err != nil {
		return 0
	}
	return hour*60 + minute
}

// parseHHMM parses "HH:MM" format
func parseHHMM(s string, hour, minute *int) (bool, error) {
	if len(s) != 5 || s[2] != ':' {
		return false, errors.New("invalid time format")
	}
	h, err := parseInt(s[0:2])
	if err != nil || h < 0 || h > 23 {
		return false, errors.New("invalid hour")
	}
	m, err := parseInt(s[3:5])
	if err != nil || m < 0 || m > 59 {
		return false, errors.New("invalid minute")
	}
	*hour = h
	*minute = m
	return true, nil
}

// parseInt parses a string to int
func parseInt(s string) (int, error) {
	var n int
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0, errors.New("not a number")
		}
		n = n*10 + int(c-'0')
	}
	return n, nil
}

// DefaultPushPreference creates a new PushPreference with default settings
func DefaultPushPreference(userID uint) *PushPreference {
	return &PushPreference{
		UserID:            userID,
		PushEnabled:       true,
		Preferences:       PushPreferences{},
		QuietHoursEnabled: false,
		Timezone:          "Asia/Kolkata",
	}
}
