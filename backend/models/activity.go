package models

import (
	"fmt"
	"time"

	"gorm.io/gorm"
)

type ActivityName string

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

func (a *Activity) BeforeSave(tx *gorm.DB) error {
	return a.Validate()
}

func (a *Activity) Validate() error {
	if a.DurationHours < 0 || a.DurationHours > 24 {
		return fmt.Errorf("duration_hours must be between 0 and 24")
	}

	if !a.Name.IsValid() {
		return fmt.Errorf("invalid activity name: %s", a.Name)
	}

	return nil
}

func (a ActivityName) IsValid() bool {
	for _, allowed := range ActivityNames {
		if a == allowed {
			return true
		}
	}
	return false
}
