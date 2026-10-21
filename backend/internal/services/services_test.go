package services

import (
	"strings"
	"testing"
	"time"

	"github.com/aman1117/backend/internal/repository"
	"github.com/aman1117/backend/internal/testutil"
	"github.com/aman1117/backend/pkg/models"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/crypto/bcrypt"
	"gorm.io/gorm"
)

// tooLongPassword exceeds bcrypt's 72-byte input limit, so hashing fails fast.
var tooLongPassword = strings.Repeat("p", 73)

func TestAuthService(t *testing.T) {
	db := testDB(t)
	svc := NewAuthService(repository.NewUserRepository(db))

	t.Run("register stores a bcrypt hash and follow counters", func(t *testing.T) {
		require.NoError(t, svc.Register("new@example.com", "newbie", "s3cret-pass"))
		user, err := svc.GetUserByEmail("new@example.com")
		require.NoError(t, err)
		require.NotNil(t, user)
		assert.Equal(t, "newbie", user.Username)
		assert.NotEqual(t, "s3cret-pass", user.PasswordHash)
		assert.NoError(t, bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte("s3cret-pass")))
		cost, err := bcrypt.Cost([]byte(user.PasswordHash))
		require.NoError(t, err)
		assert.Equal(t, bcrypt.DefaultCost, cost)
		var counters int64
		require.NoError(t, db.Model(&models.FollowCounter{}).Where("user_id = ?", user.ID).Count(&counters).Error)
		assert.EqualValues(t, 1, counters)

		assert.Error(t, svc.Register("new@example.com", "other", "s3cret-pass"), "duplicate email")
		assert.ErrorIs(t, svc.Register("long@example.com", "long", tooLongPassword), bcrypt.ErrPasswordTooLong)
	})

	t.Run("authenticate by email or username", func(t *testing.T) {
		user := testutil.CreateUser(t, db)
		for _, identifier := range []string{user.Email, user.Username} {
			got, err := svc.Authenticate(identifier, testutil.TestPassword)
			require.NoError(t, err)
			assert.Equal(t, user.ID, got.ID)
		}
		_, err := svc.Authenticate(user.Username, "wrong-password")
		assert.EqualError(t, err, "invalid password")
		_, err = svc.Authenticate("nobody@example.com", testutil.TestPassword)
		assert.EqualError(t, err, "user not found")
		_, err = NewAuthService(repository.NewUserRepository(testutil.BrokenDB(t))).Authenticate(user.Username, testutil.TestPassword)
		assert.Error(t, err)
	})

	t.Run("lookups and username change", func(t *testing.T) {
		user := testutil.CreateUser(t, db)
		byID, err := svc.GetUserByID(user.ID)
		require.NoError(t, err)
		assert.Equal(t, user.Email, byID.Email)
		byName, err := svc.GetUserByUsername(user.Username)
		require.NoError(t, err)
		assert.Equal(t, user.ID, byName.ID)

		require.NoError(t, svc.UpdateUsername(user.ID, "renamed_user"))
		renamed, err := svc.GetUserByUsername("renamed_user")
		require.NoError(t, err)
		require.NotNil(t, renamed)
		assert.Equal(t, user.ID, renamed.ID)
		gone, err := svc.GetUserByUsername(user.Username)
		require.NoError(t, err)
		assert.Nil(t, gone)
	})

	t.Run("change password", func(t *testing.T) {
		user := testutil.CreateUser(t, db)
		assert.EqualError(t, svc.ChangePassword(user.ID, "not-it", "brand-new-pass"), "current password is incorrect")
		assert.EqualError(t, svc.ChangePassword(999999, testutil.TestPassword, "brand-new-pass"), "user not found")
		assert.ErrorIs(t, svc.ChangePassword(user.ID, testutil.TestPassword, tooLongPassword), bcrypt.ErrPasswordTooLong)

		require.NoError(t, svc.ChangePassword(user.ID, testutil.TestPassword, "brand-new-pass"))
		_, err := svc.Authenticate(user.Username, "brand-new-pass")
		assert.NoError(t, err)
		_, err = svc.Authenticate(user.Username, testutil.TestPassword)
		assert.EqualError(t, err, "invalid password")
	})

	t.Run("reset password", func(t *testing.T) {
		user := testutil.CreateUser(t, db)
		assert.ErrorIs(t, svc.ResetPassword(user.ID, tooLongPassword), bcrypt.ErrPasswordTooLong)
		require.NoError(t, svc.ResetPassword(user.ID, "reset-pass-1"))
		_, err := svc.Authenticate(user.Email, "reset-pass-1")
		assert.NoError(t, err)
	})
}

func TestProfileService(t *testing.T) {
	db := testDB(t)
	userRepo := repository.NewUserRepository(db)
	svc := NewProfileService(userRepo, repository.NewFollowRepository(db))
	alice := testutil.CreateUser(t, db, func(u *models.User) { u.Username = "alice" })
	alicia := testutil.CreateUser(t, db, func(u *models.User) { u.Username = "alicia"; u.IsPrivate = true })
	bob := testutil.CreateUser(t, db, func(u *models.User) { u.Username = "bob" })

	t.Run("privacy, bio and picture", func(t *testing.T) {
		require.NoError(t, svc.UpdatePrivacy(alice.ID, true))
		private, err := svc.GetPrivacy(alice.ID)
		require.NoError(t, err)
		assert.True(t, private)
		require.NoError(t, svc.UpdatePrivacy(alice.ID, false))
		private, err = svc.GetPrivacy(alice.ID)
		require.NoError(t, err)
		assert.False(t, private)

		require.NoError(t, svc.UpdateBio(alice.ID, "Learning Go 🚀"))
		bio, err := svc.GetBio(alice.ID)
		require.NoError(t, err)
		require.NotNil(t, bio)
		assert.Equal(t, "Learning Go 🚀", *bio)
		require.NoError(t, svc.UpdateBio(alice.ID, ""))
		bio, err = svc.GetBio(alice.ID)
		require.NoError(t, err)
		assert.Nil(t, bio, "an empty bio is stored as NULL")

		require.NoError(t, svc.UpdateProfilePic(alice.ID, testutil.Ptr("https://img/a.jpg"), testutil.Ptr("https://img/a_t.jpg")))
		profile, err := svc.GetProfile(alice.ID)
		require.NoError(t, err)
		assert.Equal(t, "https://img/a.jpg", *profile.ProfilePic)
		assert.Equal(t, "https://img/a_t.jpg", *profile.ProfilePicThumb)
		require.NoError(t, svc.UpdateProfilePic(alice.ID, nil, nil))
		profile, err = svc.GetProfile(alice.ID)
		require.NoError(t, err)
		assert.Nil(t, profile.ProfilePic)

		_, err = svc.GetPrivacy(999999)
		assert.Error(t, err)
		_, err = svc.GetBio(999999)
		assert.Error(t, err)
	})

	t.Run("search and autocomplete", func(t *testing.T) {
		found, err := svc.SearchUsers("ALI")
		require.NoError(t, err)
		var names []string
		for _, u := range found {
			names = append(names, u.Username)
		}
		assert.ElementsMatch(t, []string{"alice", "alicia"}, names, "search is case-insensitive and includes private users")

		results, err := svc.AutocompleteUsers("alice", 5)
		require.NoError(t, err)
		require.NotEmpty(t, results)
		assert.Equal(t, "alice", results[0].Username, "exact match ranks first")
	})

	t.Run("who can view a profile", func(t *testing.T) {
		makeFollow(t, db, bob.ID, alicia.ID, models.FollowStateActive)
		assert.False(t, svc.CanViewProfile(nil, bob.ID))
		assert.True(t, svc.CanViewProfile(alicia, alicia.ID), "own profile")
		assert.True(t, svc.CanViewProfile(alice, 0), "public profiles are visible to everyone")
		assert.True(t, svc.CanViewProfile(alicia, bob.ID), "accepted follower")
		assert.False(t, svc.CanViewProfile(alicia, alice.ID), "not a follower")
		assert.False(t, svc.CanViewProfile(alicia, 0), "anonymous visitor")
		assert.False(t, NewProfileService(userRepo, nil).CanViewProfile(alicia, bob.ID), "no follow repository")
		broken := NewProfileService(userRepo, repository.NewFollowRepository(testutil.BrokenDB(t)))
		assert.False(t, broken.CanViewProfile(alicia, bob.ID), "follow lookup failure")
	})
}

func newActivityService(db *gorm.DB, notif *NotificationService) *ActivityService {
	return NewActivityService(
		repository.NewActivityRepository(db),
		NewStreakService(repository.NewStreakRepository(db)),
		repository.NewUserRepository(db),
		repository.NewFollowRepository(db),
		notif,
	)
}

func activitiesOn(t *testing.T, db *gorm.DB, userID uint, day time.Time) map[models.ActivityName]float32 {
	t.Helper()
	var list []models.Activity
	require.NoError(t, db.Where("user_id = ? AND activity_date = ?", userID, day).Find(&list).Error)
	out := map[models.ActivityName]float32{}
	for _, a := range list {
		out[a.Name] = a.DurationHours
	}
	return out
}

func TestActivityService_CreateOrUpdateActivity(t *testing.T) {
	db := testDB(t)
	svc := newActivityService(db, newNotificationService(db))
	user := newUser(t, db)
	follower := newUser(t, db)
	makeFollow(t, db, follower.ID, user.ID, models.FollowStateActive)
	today := todayUTC()

	require.NoError(t, svc.CreateOrUpdateActivity(user.ID, models.ActivityStudy, 6, today, testutil.Ptr("chapter 3")))
	require.NoError(t, svc.CreateOrUpdateActivity(user.ID, models.ActivityStudy, 10, today, testutil.Ptr("chapter 4")),
		"logging the same activity replaces its hours")
	assert.Equal(t, map[models.ActivityName]float32{models.ActivityStudy: 10}, activitiesOn(t, db, user.ID, today))
	var study models.Activity
	require.NoError(t, db.Where("user_id = ? AND name = ?", user.ID, models.ActivityStudy).First(&study).Error)
	assert.Equal(t, "chapter 4", *study.Note)

	streak, err := svc.streakSvc.GetStreak(user.ID, today)
	require.NoError(t, err)
	require.NotNil(t, streak, "logging today starts a streak")
	assert.Equal(t, 1, streak.Current)
	assert.Equal(t, 1, streak.Longest)

	err = svc.CreateOrUpdateActivity(user.ID, models.ActivitySleep, 14.5, today, nil)
	assert.EqualError(t, err, "total hours cannot be more than 24")
	assert.Len(t, activitiesOn(t, db, user.ID, today), 1)

	require.NoError(t, svc.CreateOrUpdateActivity(user.ID, models.ActivitySleep, 14, today, nil))
	waitForAsync(t)
	notifs := notificationsOf(t, db, follower.ID)
	require.Len(t, notifs, 1, "followers hear when the day reaches 24 hours")
	assert.Equal(t, "Day Completed! 🎯", notifs[0].Title)
	assert.Equal(t, today.Format("2006-01-02"), notifs[0].Metadata["completed_date"])

	require.NoError(t, svc.CreateOrUpdateActivity(user.ID, models.ActivitySleep, 13, today, nil))
	require.NoError(t, svc.CreateOrUpdateActivity(user.ID, models.ActivitySleep, 14, today, nil))
	waitForAsync(t)
	assert.Len(t, notificationsOf(t, db, follower.ID), 1, "dropping below 24 and back does not notify again")

	streak, err = svc.streakSvc.GetStreak(user.ID, today)
	require.NoError(t, err)
	assert.Equal(t, 1, streak.Current, "more logging on the same day keeps the streak")

	t.Run("past days are saved without touching the streak", func(t *testing.T) {
		past := today.AddDate(0, 0, -3)
		require.NoError(t, svc.CreateOrUpdateActivity(user.ID, models.ActivityFamily, 2, past, nil))
		assert.Equal(t, map[models.ActivityName]float32{models.ActivityFamily: 2}, activitiesOn(t, db, user.ID, past))
		s, err := svc.streakSvc.GetStreak(user.ID, past)
		require.NoError(t, err)
		assert.Nil(t, s)
	})

	t.Run("invalid values are rejected by the model", func(t *testing.T) {
		other := newUser(t, db)
		assert.ErrorContains(t, svc.CreateOrUpdateActivity(other.ID, models.ActivityName("juggling"), 1, today, nil), "invalid activity name")
		require.NoError(t, svc.CreateOrUpdateActivity(other.ID, models.ActivityStudy, 1, today, nil))
		assert.ErrorContains(t, svc.CreateOrUpdateActivity(other.ID, models.ActivityStudy, -1, today, nil), "duration_hours must be between 0 and 24")
		assert.Equal(t, map[models.ActivityName]float32{models.ActivityStudy: 1}, activitiesOn(t, db, other.ID, today))
	})

	t.Run("database failures", func(t *testing.T) {
		broken := newActivityService(testutil.BrokenDB(t), nil)
		assert.Error(t, broken.CreateOrUpdateActivity(user.ID, models.ActivityStudy, 1, today, nil))

		streakBroken := NewActivityService(repository.NewActivityRepository(db),
			NewStreakService(repository.NewStreakRepository(testutil.BrokenDB(t))), nil, nil, nil)
		other := newUser(t, db)
		assert.Error(t, streakBroken.CreateOrUpdateActivity(other.ID, models.ActivityStudy, 1, today, nil),
			"streak failures are reported")
		assert.Len(t, activitiesOn(t, db, other.ID, today), 1, "the activity itself is saved")

		noNotifier := NewActivityService(repository.NewActivityRepository(db),
			NewStreakService(repository.NewStreakRepository(db)), nil, nil, nil)
		lazy := newUser(t, db)
		makeFollow(t, db, follower.ID, lazy.ID, models.FollowStateActive)
		require.NoError(t, noNotifier.CreateOrUpdateActivity(lazy.ID, models.ActivitySleep, 24, today, nil))
		waitForAsync(t)
		assert.Len(t, notificationsOf(t, db, follower.ID), 1, "no notification service, no notification")
	})
}

func TestActivityService_NotifyFollowersOfDayCompletion(t *testing.T) {
	db := testDB(t)
	day := testutil.Day(2026, time.May, 3)
	user := newUser(t, db, func(u *models.User) { u.ProfilePic = testutil.Ptr("https://img/u.jpg") })
	follower := newUser(t, db)
	makeFollow(t, db, follower.ID, user.ID, models.FollowStateActive)
	notif := newNotificationService(db)

	t.Run("notifies followers with the user's details", func(t *testing.T) {
		newActivityService(db, notif).notifyFollowersOfDayCompletion(user.ID, day)
		waitForAsync(t)
		notifs := notificationsOf(t, db, follower.ID)
		require.Len(t, notifs, 1)
		assert.Equal(t, user.Username+" logged all 24 hours on 3 May, 2026", notifs[0].Body)
		assert.Equal(t, "https://img/u.jpg", notifs[0].Metadata["completed_user_avatar"])
	})

	t.Run("failures and edge cases notify nobody", func(t *testing.T) {
		lonely := newUser(t, db)
		ghostFollower := newUser(t, db)
		makeFollow(t, db, ghostFollower.ID, 999999, models.FollowStateActive) // follows a user that no longer exists

		cases := map[string]func(){
			"no followers": func() { newActivityService(db, notif).notifyFollowersOfDayCompletion(lonely.ID, day) },
			"unknown user": func() { newActivityService(db, notif).notifyFollowersOfDayCompletion(999999, day) },
			"user lookup fails": func() {
				NewActivityService(nil, nil, repository.NewUserRepository(testutil.BrokenDB(t)), repository.NewFollowRepository(db), notif).
					notifyFollowersOfDayCompletion(user.ID, day.AddDate(0, 0, 1))
			},
			"follower lookup fails": func() {
				NewActivityService(nil, nil, repository.NewUserRepository(db), repository.NewFollowRepository(testutil.BrokenDB(t)), notif).
					notifyFollowersOfDayCompletion(user.ID, day.AddDate(0, 0, 2))
			},
			"notification failure": func() {
				newActivityService(db, newNotificationService(testutil.BrokenDB(t))).notifyFollowersOfDayCompletion(user.ID, day.AddDate(0, 0, 3))
			},
			"missing dependencies": func() {
				NewActivityService(nil, nil, nil, repository.NewFollowRepository(db), notif).notifyFollowersOfDayCompletion(user.ID, day)
			},
		}
		before := countRows(t, db, &models.Notification{})
		for name, call := range cases {
			t.Run(name, func(t *testing.T) {
				call()
				waitForAsync(t)
				assert.Equal(t, before, countRows(t, db, &models.Notification{}))
			})
		}
	})
}

func TestActivityService_Queries(t *testing.T) {
	db := testDB(t)
	svc := newActivityService(db, nil)
	user := newUser(t, db)
	d1, d2 := testutil.Day(2026, time.March, 1), testutil.Day(2026, time.March, 2)
	testutil.CreateActivity(t, db, user.ID, models.ActivityStudy, 2.5, d1)
	testutil.CreateActivity(t, db, user.ID, models.ActivitySleep, 1, d1)
	testutil.CreateActivity(t, db, user.ID, models.ActivityWorkout, 2.25, d2)
	testutil.CreateActivity(t, db, user.ID, models.ActivityWorkout, 4, testutil.Day(2026, time.March, 9))

	activities, err := svc.GetActivities(user.ID, d1, d2)
	require.NoError(t, err)
	assert.Len(t, activities, 3)

	totals, err := svc.GetDailyTotals(user.ID, d1, d2)
	require.NoError(t, err)
	assert.Equal(t, map[string]float32{"2026-03-01": 3.5, "2026-03-02": 2.25}, totals)

	empty, err := svc.GetDailyTotals(user.ID, testutil.Day(2025, time.January, 1), testutil.Day(2025, time.January, 7))
	require.NoError(t, err)
	assert.Empty(t, empty)

	_, err = newActivityService(testutil.BrokenDB(t), nil).GetDailyTotals(user.ID, d1, d2)
	assert.Error(t, err)
}

func TestStreakService_AddStreak(t *testing.T) {
	db := testDB(t)
	svc := NewStreakService(repository.NewStreakRepository(db))
	today := todayUTC()
	yesterday := today.AddDate(0, 0, -1)

	t.Run("first activity starts a streak", func(t *testing.T) {
		user := newUser(t, db)
		require.NoError(t, svc.AddStreak(user.ID, today, false))
		s, err := svc.GetStreak(user.ID, today)
		require.NoError(t, err)
		assert.Equal(t, 1, s.Current)
		assert.Equal(t, 1, s.Longest)
		require.NoError(t, svc.AddStreak(user.ID, today, false), "repeat logging is idempotent")
		all, err := svc.GetAllStreaks(user.ID)
		require.NoError(t, err)
		assert.Len(t, all, 1)
	})

	t.Run("first activity counts when the daily job already opened the day", func(t *testing.T) {
		user := newUser(t, db)
		testutil.CreateStreak(t, db, user.ID, 0, 0, today) // created by the midnight job
		require.NoError(t, svc.AddStreak(user.ID, today, false))
		s, err := svc.GetStreak(user.ID, today)
		require.NoError(t, err)
		assert.Equal(t, 1, s.Current)
		assert.Equal(t, 1, s.Longest)

		require.NoError(t, svc.AddStreak(user.ID, today, false))
		all, err := svc.GetAllStreaks(user.ID)
		require.NoError(t, err)
		require.Len(t, all, 1, "the job's record is updated, not duplicated")
		assert.Equal(t, 1, all[0].Current, "a day only counts once")
	})

	t.Run("continuing a streak extends it and keeps the record", func(t *testing.T) {
		user := newUser(t, db)
		testutil.CreateStreak(t, db, user.ID, 3, 5, yesterday)
		testutil.CreateStreak(t, db, user.ID, 0, 5, today) // created by the midnight job
		require.NoError(t, svc.AddStreak(user.ID, today, false))
		s, err := svc.GetStreak(user.ID, today)
		require.NoError(t, err)
		assert.Equal(t, 4, s.Current)
		assert.Equal(t, 5, s.Longest)

		require.NoError(t, svc.AddStreak(user.ID, today, false))
		s, err = svc.GetStreak(user.ID, today)
		require.NoError(t, err)
		assert.Equal(t, 4, s.Current, "a day only counts once")
	})

	t.Run("beating the record raises it", func(t *testing.T) {
		user := newUser(t, db)
		testutil.CreateStreak(t, db, user.ID, 5, 5, yesterday)
		testutil.CreateStreak(t, db, user.ID, 0, 5, today)
		require.NoError(t, svc.AddStreak(user.ID, today, false))
		s, err := svc.GetStreak(user.ID, today)
		require.NoError(t, err)
		assert.Equal(t, 6, s.Current)
		assert.Equal(t, 6, s.Longest)

		latest, err := svc.GetLatestStreak(user.ID)
		require.NoError(t, err)
		assert.Equal(t, s.ID, latest.ID)
		active, err := svc.GetLatestActiveStreak(user.ID)
		require.NoError(t, err)
		assert.Equal(t, s.ID, active.ID)
	})

	t.Run("without today's record nothing is updated", func(t *testing.T) {
		user := newUser(t, db)
		testutil.CreateStreak(t, db, user.ID, 2, 2, today.AddDate(0, 0, -2))
		testutil.CreateStreak(t, db, user.ID, 3, 3, yesterday)
		require.NoError(t, svc.AddStreak(user.ID, today, false))
		latest, err := svc.GetLatestStreak(user.ID)
		require.NoError(t, err)
		assert.Equal(t, 3, latest.Current)
	})

	t.Run("past dates are ignored outside the daily job", func(t *testing.T) {
		user := newUser(t, db)
		require.NoError(t, svc.AddStreak(user.ID, yesterday, false))
		latest, err := svc.GetLatestStreak(user.ID)
		require.NoError(t, err)
		assert.Nil(t, latest)
	})

	t.Run("daily job opens a broken day carrying the record", func(t *testing.T) {
		user := newUser(t, db)
		require.NoError(t, svc.AddStreak(user.ID, yesterday, true))
		s, err := svc.GetStreak(user.ID, yesterday)
		require.NoError(t, err)
		assert.Equal(t, 0, s.Current)
		assert.Equal(t, 0, s.Longest)

		testutil.CreateStreak(t, db, user.ID, 9, 12, today.AddDate(0, 0, -5))
		require.NoError(t, db.Model(&models.Streak{}).Where("id = ?", s.ID).Update("longest", 12).Error)
		require.NoError(t, svc.AddStreak(user.ID, today, true))
		s, err = svc.GetStreak(user.ID, today)
		require.NoError(t, err)
		assert.Equal(t, 0, s.Current)
		assert.Equal(t, 12, s.Longest)

		require.NoError(t, svc.AddStreak(user.ID, today, true), "the job is idempotent")
		all, err := svc.GetAllStreaks(user.ID)
		require.NoError(t, err)
		assert.Len(t, all, 3)
		active, err := svc.GetLatestActiveStreak(user.ID)
		require.NoError(t, err)
		assert.Equal(t, 9, active.Current)
	})

	t.Run("database failures", func(t *testing.T) {
		user := newUser(t, db)
		testutil.CreateStreak(t, db, user.ID, 1, 1, yesterday)
		testutil.CreateStreak(t, db, user.ID, 0, 1, today)

		assert.Error(t, NewStreakService(repository.NewStreakRepository(testutil.BrokenDB(t))).AddStreak(user.ID, today, false))

		dateLookupFails := NewStreakService(repository.NewStreakRepository(faultyDB(t, failingOn("query", "streaks", "activity_date = ?"))))
		assert.ErrorIs(t, dateLookupFails.AddStreak(user.ID, today, false), errInjected)
		assert.ErrorIs(t, dateLookupFails.AddStreak(user.ID, today.AddDate(0, 0, 1), true), errInjected)
	})
}

func newTileConfigService(db *gorm.DB) *TileConfigService {
	return NewTileConfigService(repository.NewTileConfigRepository(db), repository.NewUserRepository(db), repository.NewActivityPhotoRepository(db))
}

const (
	tileA = "8a0d6c2e-1f3b-4c5d-9e7f-0a1b2c3d4e5f"
	tileB = "1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b"
)

func customTile(id, name string) map[string]any {
	return map[string]any{"id": id, "name": name, "icon": "Music", "color": "#22c55e"}
}

func TestTileConfigService_ValidateConfig(t *testing.T) {
	svc := newTileConfigService(nil)
	sixTiles := []any{}
	for i := 0; i < 6; i++ {
		sixTiles = append(sixTiles, customTile("00000000-0000-4000-8000-00000000000"+string(rune('0'+i)), "t"))
	}

	cases := []struct {
		name   string
		config models.JSONB
		code   string
	}{
		{"valid", models.JSONB{"order": []any{"study"}, "colors": map[string]any{"study": "#abc"},
			"customTiles": []any{customTile(tileA, "Guitar"), customTile(tileB, "Chess")}}, ""},
		{"empty", nil, ""},
		{"wrong shape", models.JSONB{"order": "study"}, "INVALID_TILE_CONFIG"},
		{"too many tiles", models.JSONB{"customTiles": sixTiles}, "TILE_LIMIT_EXCEEDED"},
		{"invalid tile", models.JSONB{"customTiles": []any{customTile("not-a-uuid", "x")}}, "INVALID_TILE_CONFIG"},
		{"duplicate tile", models.JSONB{"customTiles": []any{customTile(tileA, "a"), customTile(tileA, "b")}}, "INVALID_TILE_CONFIG"},
		{"bad color", models.JSONB{"colors": map[string]any{"study": "red"}}, "INVALID_COLOR"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := svc.ValidateConfig(tc.config)
			if tc.code == "" {
				assert.Nil(t, err)
				return
			}
			require.NotNil(t, err)
			assert.Equal(t, tc.code, err.Code)
			assert.Equal(t, err.Message, err.Error())
		})
	}
}

func TestTileConfigService_SaveConfig(t *testing.T) {
	db := testDB(t)
	svc := newTileConfigService(db)
	user := newUser(t, db)
	photo := seedPhoto(t, db, user.ID, "custom:"+tileA, todayIST())
	require.NoError(t, db.Model(photo).Update("activity_label", "Guitar").Error)
	label := func() string {
		var p models.ActivityPhoto
		require.NoError(t, db.First(&p, photo.ID).Error)
		return *p.ActivityLabel
	}

	cfg, err := svc.GetConfig(user.ID)
	require.NoError(t, err)
	assert.Nil(t, cfg)

	first := models.JSONB{"order": []any{"study"}, "customTiles": []any{customTile(tileA, "Guitar")}}
	require.NoError(t, svc.SaveConfig(user.ID, first))
	cfg, err = svc.GetConfigByUsername(user.Username)
	require.NoError(t, err)
	assert.Equal(t, []any{"study"}, cfg.Config["order"])

	require.NoError(t, svc.SaveConfig(user.ID, models.JSONB{"customTiles": []any{customTile(tileA, "Guitar"), customTile(tileB, "Chess")}}))
	assert.Equal(t, "Guitar", label(), "unchanged names leave photos alone")

	require.NoError(t, svc.SaveConfig(user.ID, models.JSONB{"customTiles": []any{customTile(tileA, "Piano")}}))
	assert.Equal(t, "Piano", label(), "renamed tiles relabel their photos")
	cfg, err = svc.GetConfig(user.ID)
	require.NoError(t, err)
	data, err := cfg.GetConfigData()
	require.NoError(t, err)
	require.Len(t, data.CustomTiles, 1)
	assert.Equal(t, "Piano", data.CustomTiles[0].Name)

	err = svc.SaveConfig(user.ID, models.JSONB{"colors": map[string]any{"study": "nope"}})
	var vErr *TileConfigValidationError
	require.ErrorAs(t, err, &vErr)
	assert.Equal(t, "INVALID_COLOR", vErr.Code)

	t.Run("relabel failure aborts the save", func(t *testing.T) {
		broken := NewTileConfigService(repository.NewTileConfigRepository(db), repository.NewUserRepository(db),
			repository.NewActivityPhotoRepository(faultyDB(t, failingOn("update", "activity_photos"))))
		err := broken.SaveConfig(user.ID, models.JSONB{"customTiles": []any{customTile(tileA, "Drums")}})
		require.ErrorIs(t, err, errInjected)
		assert.Equal(t, "Piano", label())
	})

	t.Run("without a photo repository names change without relabeling", func(t *testing.T) {
		noPhotos := NewTileConfigService(repository.NewTileConfigRepository(db), repository.NewUserRepository(db), nil)
		require.NoError(t, noPhotos.SaveConfig(user.ID, models.JSONB{"customTiles": []any{customTile(tileA, "Violin")}}))
		assert.Equal(t, "Piano", label())
	})

	t.Run("a corrupt stored config is replaced", func(t *testing.T) {
		require.NoError(t, db.Model(&models.TileConfig{}).Where("user_id = ?", user.ID).
			Update("config", models.JSONB{"customTiles": "corrupt"}).Error)
		require.NoError(t, svc.SaveConfig(user.ID, models.JSONB{"customTiles": []any{customTile(tileA, "Flute")}}))
		assert.Equal(t, "Piano", label())
	})

	t.Run("unknown user", func(t *testing.T) {
		_, err := svc.GetConfigByUsername("nobody_at_all")
		assert.EqualError(t, err, "user not found")
	})
}

func TestSearchSuggestionsService(t *testing.T) {
	db := testDB(t)
	svc := NewSearchSuggestionsService(repository.NewRecentSearchRepository(db))
	me := newUser(t, db)
	alice := newUser(t, db)
	bob := newUser(t, db)

	require.NoError(t, svc.SaveRecentSearch(me.ID, alice.ID))
	require.NoError(t, svc.SaveRecentSearch(me.ID, bob.ID))
	require.NoError(t, svc.SaveRecentSearch(me.ID, me.ID), "searching yourself is not recorded")
	recent, err := svc.GetRecentSearches(me.ID, 10)
	require.NoError(t, err)
	var ids []uint
	for _, r := range recent {
		ids = append(ids, r.ID)
	}
	assert.ElementsMatch(t, []uint{alice.ID, bob.ID}, ids)

	require.NoError(t, svc.DeleteRecentSearch(me.ID, alice.ID))
	recent, err = svc.GetRecentSearches(me.ID, 10)
	require.NoError(t, err)
	require.Len(t, recent, 1)
	assert.Equal(t, bob.ID, recent[0].ID)

	require.NoError(t, svc.ClearRecentSearches(me.ID))
	recent, err = svc.GetRecentSearches(me.ID, 10)
	require.NoError(t, err)
	assert.Empty(t, recent)

	trending, err := svc.GetTrendingUsersForUser(me.ID, 5)
	require.NoError(t, err)
	var trendingIDs []uint
	for _, u := range trending {
		trendingIDs = append(trendingIDs, u.ID)
	}
	assert.ElementsMatch(t, []uint{alice.ID, bob.ID}, trendingIDs, "falls back to everyone else")
}
