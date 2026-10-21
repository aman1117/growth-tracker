package testutil

import (
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aman1117/backend/pkg/models"
	"golang.org/x/crypto/bcrypt"
	"gorm.io/gorm"
)

// TestPassword is the plain-text password of every user created by CreateUser.
const TestPassword = "Password123!"

var (
	userSeq      atomic.Int64
	hashOnce     sync.Once
	passwordHash string
)

// PasswordHash returns a bcrypt hash of TestPassword (minimum cost, computed once).
func PasswordHash() string {
	hashOnce.Do(func() {
		h, err := bcrypt.GenerateFromPassword([]byte(TestPassword), bcrypt.MinCost)
		if err != nil {
			panic(err)
		}
		passwordHash = string(h)
	})
	return passwordHash
}

// CreateUser inserts a public user with a verified email, a unique username/email and the
// password TestPassword. Options adjust fields before the insert, for example:
//
//	testutil.CreateUser(t, db, func(u *models.User) { u.Username = "alice"; u.IsPrivate = true })
func CreateUser(t testing.TB, db *gorm.DB, opts ...func(*models.User)) *models.User {
	t.Helper()
	n := userSeq.Add(1)
	user := &models.User{
		Email:         fmt.Sprintf("user%d@example.com", n),
		Username:      fmt.Sprintf("user%d", n),
		PasswordHash:  PasswordHash(),
		EmailVerified: true,
	}
	for _, opt := range opts {
		opt(user)
	}
	if err := db.Create(user).Error; err != nil {
		t.Fatalf("testutil: create user: %v", err)
	}
	return user
}

// CreateActivity inserts an activity entry for userID on date.
func CreateActivity(t testing.TB, db *gorm.DB, userID uint, name models.ActivityName, hours float32, date time.Time) *models.Activity {
	t.Helper()
	activity := &models.Activity{UserID: userID, Name: name, DurationHours: hours, ActivityDate: date}
	if err := db.Create(activity).Error; err != nil {
		t.Fatalf("testutil: create activity: %v", err)
	}
	return activity
}

// CreateStreak inserts a streak row for userID on date.
func CreateStreak(t testing.TB, db *gorm.DB, userID uint, current, longest int, date time.Time) *models.Streak {
	t.Helper()
	streak := &models.Streak{UserID: userID, Current: current, Longest: longest, ActivityDate: date}
	if err := db.Create(streak).Error; err != nil {
		t.Fatalf("testutil: create streak: %v", err)
	}
	return streak
}

// Day returns midnight UTC on the given date, the representation used for DATE columns.
func Day(year int, month time.Month, day int) time.Time {
	return time.Date(year, month, day, 0, 0, 0, 0, time.UTC)
}

// Ptr returns a pointer to v, for optional model fields.
func Ptr[T any](v T) *T {
	return &v
}
