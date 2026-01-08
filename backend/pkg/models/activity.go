package models

import (
	"fmt"
	"time"

	"gorm.io/gorm"
)

// ActivityName represents the type of activity
type ActivityName string

// Predefined activity types
const (
	ActivitySleep         ActivityName = "sleep"
	ActivityStudy         ActivityName = "study"
	ActivityBookReading   ActivityName = "book_reading"
	ActivityEating        ActivityName = "eating"
	ActivityFriends       ActivityName = "friends"
	ActivityGrooming      ActivityName = "grooming"
	ActivityWorkout       ActivityName = "workout"
	ActivityReels         ActivityName = "reels"
	ActivityFamily        ActivityName = "family"
	ActivityIdle          ActivityName = "idle"
	ActivityCreative      ActivityName = "creative"
	ActivityTravelling    ActivityName = "travelling"
	ActivityErrand        ActivityName = "errand"
	ActivityRest          ActivityName = "rest"
	ActivityEntertainment ActivityName = "entertainment"
	ActivityOffice        ActivityName = "office"
)

// ActivityNames contains all valid activity names
var ActivityNames = []ActivityName{
	ActivitySleep,
	ActivityStudy,
	ActivityBookReading,
	ActivityEating,
	ActivityFriends,
	ActivityGrooming,
	ActivityWorkout,
	ActivityReels,
	ActivityFamily,
	ActivityIdle,
	ActivityCreative,
	ActivityTravelling,
	ActivityErrand,
	ActivityRest,
	ActivityEntertainment,
	ActivityOffice,
}

// Activity represents a tracked activity
type Activity struct {
	ID uint `gorm:"primaryKey"`

	UserID uint `gorm:"not null;index:idx_activities_user_date"`
	User   User `gorm:"foreignKey:UserID;constraint:OnUpdate:CASCADE,OnDelete:CASCADE"`

	Name ActivityName `gorm:"type:varchar(50);not null"`

	// decimal(4,2) allows values like 0.25, 1.50, 12.75 etc.
	DurationHours float32 `gorm:"type:decimal(4,2);not null;check:duration_hours >= 0 AND duration_hours <= 24"`

	// Optional note for the activity (max 500 characters)
	Note *string `gorm:"type:varchar(500)"`

	CreatedAt    time.Time `gorm:"not null;default:now();autoCreateTime"`
	UpdatedAt    time.Time `gorm:"not null;default:now();autoUpdateTime"`
	ActivityDate time.Time `gorm:"type:date;default:CURRENT_DATE;index:idx_activities_user_date"`
}

// TableName specifies the table name for Activity
func (Activity) TableName() string {
	return "activities"
}

// BeforeSave is a GORM hook that validates the activity before saving
func (a *Activity) BeforeSave(tx *gorm.DB) error {
	return a.Validate()
}

// Validate validates the activity fields
func (a *Activity) Validate() error {
	if a.DurationHours < 0 || a.DurationHours > 24 {
		return fmt.Errorf("duration_hours must be between 0 and 24")
	}

	if !a.Name.IsValid() {
		return fmt.Errorf("invalid activity name: %s", a.Name)
	}

	return nil
}

// CustomTilePrefix is the prefix used for custom tile activity names
const CustomTilePrefix = "custom:"

// IsValid checks if the activity name is a valid predefined type or a valid custom tile
func (a ActivityName) IsValid() bool {
	// Check if it's a custom tile (format: custom:<uuid>)
	if a.IsCustomTile() {
		return a.ValidateCustomTileFormat()
	}

	// Check against predefined activities
	for _, allowed := range ActivityNames {
		if a == allowed {
			return true
		}
	}
	return false
}

// IsCustomTile checks if the activity name is a custom tile
func (a ActivityName) IsCustomTile() bool {
	return len(a) > len(CustomTilePrefix) && string(a)[:len(CustomTilePrefix)] == CustomTilePrefix
}

// ValidateCustomTileFormat validates the format of a custom tile ID
// Expected format: custom:<uuid> where uuid is a valid UUID v4
func (a ActivityName) ValidateCustomTileFormat() bool {
	if !a.IsCustomTile() {
		return false
	}

	// Extract the UUID part
	uuid := string(a)[len(CustomTilePrefix):]

	// Basic UUID validation: should be 36 characters with hyphens in specific positions
	if len(uuid) != 36 {
		return false
	}

	// Check hyphen positions (8-4-4-4-12 format)
	for i, c := range uuid {
		if i == 8 || i == 13 || i == 18 || i == 23 {
			if c != '-' {
				return false
			}
		} else {
			// Must be hex digit
			if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
				return false
			}
		}
	}

	return true
}

// GetCustomTileID extracts the UUID from a custom tile activity name
func (a ActivityName) GetCustomTileID() string {
	if !a.IsCustomTile() {
		return ""
	}
	return string(a)[len(CustomTilePrefix):]
}
