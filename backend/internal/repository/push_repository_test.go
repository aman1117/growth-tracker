package repository

import (
	"testing"
	"time"

	"github.com/aman1117/backend/internal/testutil"
	"github.com/aman1117/backend/pkg/models"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func newSubscription(userID uint, endpoint string) *models.PushSubscription {
	return &models.PushSubscription{
		UserID:     userID,
		Endpoint:   endpoint,
		P256dh:     "p256dh-public-key",
		Auth:       "auth-secret",
		VapidKeyID: "test",
		Status:     models.PushSubscriptionStatusActive,
		UserAgent:  "Mozilla/5.0 (Windows NT 10.0)",
		Platform:   "windows",
		Browser:    "edge",
	}
}

func subscription(t *testing.T, db *gorm.DB, id uint) models.PushSubscription {
	t.Helper()
	var sub models.PushSubscription
	require.NoError(t, db.First(&sub, id).Error)
	return sub
}

func subscriptionIDs(subs []models.PushSubscription) []uint {
	ids := make([]uint, len(subs))
	for i, s := range subs {
		ids[i] = s.ID
	}
	return ids
}

func TestPushRepository_UpsertSubscription(t *testing.T) {
	db := testutil.DB(t)
	repo := NewPushRepository(db)
	user, other := testutil.CreateUser(t, db), testutil.CreateUser(t, db)
	const endpoint = "https://push.example.com/send/abc"

	first := newSubscription(user.ID, endpoint)
	require.NoError(t, repo.UpsertSubscription(first))
	require.NotZero(t, first.ID)
	require.NoError(t, repo.MarkSubscriptionGone(first.ID))
	original := subscription(t, db, first.ID)

	t.Run("same user re-subscribes", func(t *testing.T) {
		again := newSubscription(user.ID, endpoint)
		again.P256dh, again.Auth, again.Browser = "rotated-key", "rotated-auth", "chrome"

		require.NoError(t, repo.UpsertSubscription(again))

		assert.Equal(t, first.ID, again.ID, "the existing row is reused")
		got := subscription(t, db, first.ID)
		assert.Equal(t, "rotated-key", got.P256dh)
		assert.Equal(t, "rotated-auth", got.Auth)
		assert.Equal(t, "chrome", got.Browser)
		assert.Equal(t, models.PushSubscriptionStatusActive, got.Status, "a gone endpoint is revived")
		assert.True(t, got.CreatedAt.Equal(original.CreatedAt), "created_at is preserved")
	})

	t.Run("endpoint owned by another user", func(t *testing.T) {
		stolen := newSubscription(other.ID, endpoint)
		stolen.P256dh = "attacker-key"

		err := repo.UpsertSubscription(stolen)

		assert.ErrorIs(t, err, ErrEndpointConflict)
		got := subscription(t, db, first.ID)
		assert.Equal(t, user.ID, got.UserID)
		assert.Equal(t, "rotated-key", got.P256dh)
	})

	var rows int64
	require.NoError(t, db.Model(&models.PushSubscription{}).Count(&rows).Error)
	assert.Equal(t, int64(1), rows)
}

func TestPushRepository_UpsertSubscription_KeepsDeliveryHistorySoActiveDevicesStayActive(t *testing.T) {
	db := testutil.DB(t)
	repo := NewPushRepository(db)
	user := testutil.CreateUser(t, db)
	sub := newSubscription(user.ID, "https://push.example.com/send/long-lived")
	require.NoError(t, repo.UpsertSubscription(sub))

	// Subscribed 200 days ago, last delivered yesterday, last failed a week ago
	created := time.Now().AddDate(0, 0, -200)
	succeeded := time.Now().AddDate(0, 0, -1)
	failed := time.Now().AddDate(0, 0, -7)
	require.NoError(t, db.Model(&models.PushSubscription{}).Where("id = ?", sub.ID).
		Updates(map[string]interface{}{"created_at": created, "last_success_at": succeeded, "last_failure_at": failed}).Error)

	// The app confirms its subscription again at the start of a session
	require.NoError(t, repo.UpsertSubscription(newSubscription(user.ID, sub.Endpoint)))

	got := subscription(t, db, sub.ID)
	require.NotNil(t, got.LastSuccessAt, "re-registering keeps the last successful delivery")
	assert.WithinDuration(t, succeeded, *got.LastSuccessAt, time.Second)
	require.NotNil(t, got.LastFailureAt)
	assert.WithinDuration(t, failed, *got.LastFailureAt, time.Second)

	expired, err := repo.CleanupStaleSubscriptions(90)
	require.NoError(t, err)
	assert.Zero(t, expired, "a device that received a push yesterday is not stale")
	assert.Equal(t, models.PushSubscriptionStatusActive, subscription(t, db, sub.ID).Status)
}

func TestPushRepository_SubscriptionQueries(t *testing.T) {
	db := testutil.DB(t)
	repo := NewPushRepository(db)
	user, other := testutil.CreateUser(t, db), testutil.CreateUser(t, db)
	laptop := newSubscription(user.ID, "https://push.example.com/laptop")
	phone := newSubscription(user.ID, "https://push.example.com/phone")
	expired := newSubscription(user.ID, "https://push.example.com/old")
	expired.Status = models.PushSubscriptionStatusExpired
	othersSub := newSubscription(other.ID, "https://push.example.com/other")
	for _, s := range []*models.PushSubscription{laptop, phone, expired, othersSub} {
		require.NoError(t, repo.UpsertSubscription(s))
	}

	got, err := repo.GetSubscriptionByEndpoint("https://push.example.com/phone")
	require.NoError(t, err)
	require.NotNil(t, got)
	assert.Equal(t, phone.ID, got.ID)

	got, err = repo.GetSubscriptionByEndpoint("https://push.example.com/unknown")
	assert.NoError(t, err)
	assert.Nil(t, got)

	active, err := repo.GetActiveSubscriptionsByUserID(user.ID)
	require.NoError(t, err)
	assert.ElementsMatch(t, []uint{laptop.ID, phone.ID}, subscriptionIDs(active))
}

func TestPushRepository_DeleteSubscription(t *testing.T) {
	db := testutil.DB(t)
	repo := NewPushRepository(db)
	user, other := testutil.CreateUser(t, db), testutil.CreateUser(t, db)
	sub := newSubscription(user.ID, "https://push.example.com/a")
	require.NoError(t, repo.UpsertSubscription(sub))

	require.NoError(t, repo.DeleteSubscription(sub.Endpoint, other.ID))
	assert.Equal(t, models.PushSubscriptionStatusActive, subscription(t, db, sub.ID).Status, "only the owner can unsubscribe")

	require.NoError(t, repo.DeleteSubscription(sub.Endpoint, user.ID))
	assert.Equal(t, models.PushSubscriptionStatusExpired, subscription(t, db, sub.ID).Status, "soft delete")
}

func TestPushRepository_DeleteSubscriptionsByUserID(t *testing.T) {
	db := testutil.DB(t)
	repo := NewPushRepository(db)
	user, other := testutil.CreateUser(t, db), testutil.CreateUser(t, db)
	require.NoError(t, repo.UpsertSubscription(newSubscription(user.ID, "https://push.example.com/a")))
	require.NoError(t, repo.UpsertSubscription(newSubscription(user.ID, "https://push.example.com/b")))
	kept := newSubscription(other.ID, "https://push.example.com/c")
	require.NoError(t, repo.UpsertSubscription(kept))

	require.NoError(t, repo.DeleteSubscriptionsByUserID(user.ID))

	var remaining []models.PushSubscription
	require.NoError(t, db.Find(&remaining).Error)
	assert.Equal(t, []uint{kept.ID}, subscriptionIDs(remaining))
}

func TestPushRepository_DeliveryOutcomes(t *testing.T) {
	db := testutil.DB(t)
	repo := NewPushRepository(db)
	user := testutil.CreateUser(t, db)

	t.Run("gone", func(t *testing.T) {
		sub := newSubscription(user.ID, "https://push.example.com/gone")
		require.NoError(t, repo.UpsertSubscription(sub))

		require.NoError(t, repo.MarkSubscriptionGone(sub.ID))

		got := subscription(t, db, sub.ID)
		assert.Equal(t, models.PushSubscriptionStatusGone, got.Status)
		require.NotNil(t, got.LastFailureAt)
		assert.WithinDuration(t, time.Now(), *got.LastFailureAt, time.Minute)
	})

	t.Run("success resets failures", func(t *testing.T) {
		sub := newSubscription(user.ID, "https://push.example.com/ok")
		sub.FailureCount = 2
		require.NoError(t, repo.UpsertSubscription(sub))

		require.NoError(t, repo.UpdateSubscriptionSuccess(sub.ID))

		got := subscription(t, db, sub.ID)
		assert.Zero(t, got.FailureCount)
		require.NotNil(t, got.LastSuccessAt)
		assert.WithinDuration(t, time.Now(), *got.LastSuccessAt, time.Minute)
	})

	t.Run("failures expire the subscription at the limit", func(t *testing.T) {
		sub := newSubscription(user.ID, "https://push.example.com/flaky")
		require.NoError(t, repo.UpsertSubscription(sub))

		for attempt := 1; attempt <= 3; attempt++ {
			require.NoError(t, repo.IncrementSubscriptionFailure(sub.ID, 3))
			got := subscription(t, db, sub.ID)
			assert.Equal(t, attempt, got.FailureCount)
			require.NotNil(t, got.LastFailureAt)
			want := models.PushSubscriptionStatusActive
			if attempt == 3 {
				want = models.PushSubscriptionStatusExpired
			}
			assert.Equal(t, want, got.Status, "after %d failures", attempt)
		}
	})

	t.Run("no limit never expires", func(t *testing.T) {
		sub := newSubscription(user.ID, "https://push.example.com/unlimited")
		require.NoError(t, repo.UpsertSubscription(sub))

		for i := 0; i < 5; i++ {
			require.NoError(t, repo.IncrementSubscriptionFailure(sub.ID, 0))
		}

		got := subscription(t, db, sub.ID)
		assert.Equal(t, 5, got.FailureCount)
		assert.Equal(t, models.PushSubscriptionStatusActive, got.Status)
	})
}

func TestPushRepository_CleanupStaleSubscriptions(t *testing.T) {
	db := testutil.DB(t)
	repo := NewPushRepository(db)
	user := testutil.CreateUser(t, db)
	create := func(endpoint string, status models.PushSubscriptionStatus, lastSuccess, createdAt string) uint {
		sub := newSubscription(user.ID, endpoint)
		sub.Status = status
		require.NoError(t, repo.UpsertSubscription(sub))
		require.NoError(t, db.Exec("UPDATE push_subscriptions SET last_success_at = "+lastSuccess+", created_at = "+createdAt+" WHERE id = ?", sub.ID).Error)
		return sub.ID
	}
	staleSuccess := create("https://push.example.com/1", models.PushSubscriptionStatusActive, "NOW() - INTERVAL '100 days'", "NOW() - INTERVAL '200 days'")
	recentSuccess := create("https://push.example.com/2", models.PushSubscriptionStatusActive, "NOW() - INTERVAL '10 days'", "NOW() - INTERVAL '200 days'")
	neverSucceededOld := create("https://push.example.com/3", models.PushSubscriptionStatusActive, "NULL", "NOW() - INTERVAL '200 days'")
	gone := create("https://push.example.com/4", models.PushSubscriptionStatusGone, "NOW() - INTERVAL '100 days'", "NOW() - INTERVAL '200 days'")

	expired, err := repo.CleanupStaleSubscriptions(90)

	require.NoError(t, err)
	assert.Equal(t, int64(2), expired)
	assert.Equal(t, models.PushSubscriptionStatusExpired, subscription(t, db, staleSuccess).Status)
	assert.Equal(t, models.PushSubscriptionStatusActive, subscription(t, db, recentSuccess).Status)
	assert.Equal(t, models.PushSubscriptionStatusExpired, subscription(t, db, neverSucceededOld).Status)
	assert.Equal(t, models.PushSubscriptionStatusGone, subscription(t, db, gone).Status, "only active subscriptions are expired")
}

func TestPushRepository_CleanupStaleSubscriptions_KeepsRecentSubscriptionsWithoutDeliveries(t *testing.T) {
	db := testutil.DB(t)
	repo := NewPushRepository(db)
	user := testutil.CreateUser(t, db)
	fresh := newSubscription(user.ID, "https://push.example.com/new")
	require.NoError(t, repo.UpsertSubscription(fresh))
	recent := newSubscription(user.ID, "https://push.example.com/recent")
	require.NoError(t, repo.UpsertSubscription(recent))
	require.NoError(t, db.Exec("UPDATE push_subscriptions SET created_at = NOW() - INTERVAL '89 days' WHERE id = ?", recent.ID).Error)

	expired, err := repo.CleanupStaleSubscriptions(90)

	require.NoError(t, err)
	assert.Zero(t, expired)
	assert.Equal(t, models.PushSubscriptionStatusActive, subscription(t, db, fresh.ID).Status,
		"a device subscribed moments ago is not stale")
	assert.Equal(t, models.PushSubscriptionStatusActive, subscription(t, db, recent.ID).Status,
		"without a delivery, age is measured from the subscription date")
}

func TestPushRepository_CleanupGoneSubscriptions(t *testing.T) {
	db := testutil.DB(t)
	repo := NewPushRepository(db)
	user := testutil.CreateUser(t, db)
	create := func(endpoint string, status models.PushSubscriptionStatus, updatedAt string) uint {
		sub := newSubscription(user.ID, endpoint)
		sub.Status = status
		require.NoError(t, repo.UpsertSubscription(sub))
		require.NoError(t, db.Exec("UPDATE push_subscriptions SET updated_at = "+updatedAt+" WHERE id = ?", sub.ID).Error)
		return sub.ID
	}
	oldGone := create("https://push.example.com/1", models.PushSubscriptionStatusGone, "NOW() - INTERVAL '10 days'")
	recentGone := create("https://push.example.com/2", models.PushSubscriptionStatusGone, "NOW() - INTERVAL '1 day'")
	oldActive := create("https://push.example.com/3", models.PushSubscriptionStatusActive, "NOW() - INTERVAL '10 days'")

	deleted, err := repo.CleanupGoneSubscriptions(7)

	require.NoError(t, err)
	assert.Equal(t, int64(1), deleted)
	var remaining []models.PushSubscription
	require.NoError(t, db.Order("id").Find(&remaining).Error)
	assert.Equal(t, []uint{recentGone, oldActive}, subscriptionIDs(remaining))
	assert.NotContains(t, subscriptionIDs(remaining), oldGone)
}

func TestPushRepository_GetOrCreatePreference(t *testing.T) {
	db := testutil.DB(t)
	repo := NewPushRepository(db)
	user := testutil.CreateUser(t, db)

	created, err := repo.GetOrCreatePreference(user.ID)
	require.NoError(t, err)
	require.NotZero(t, created.ID)
	assert.True(t, created.PushEnabled)
	assert.False(t, created.QuietHoursEnabled)
	assert.Equal(t, "Asia/Kolkata", created.Timezone)
	assert.Empty(t, created.Preferences)

	again, err := repo.GetOrCreatePreference(user.ID)
	require.NoError(t, err)
	assert.Equal(t, created.ID, again.ID, "an existing row is returned")
	assert.NotNil(t, again.Preferences, "the stored {} decodes to an empty map")

	var rows int64
	require.NoError(t, db.Model(&models.PushPreference{}).Count(&rows).Error)
	assert.Equal(t, int64(1), rows)
}

func TestPushRepository_GetOrCreatePreference_ConcurrentCreate(t *testing.T) {
	db := testutil.DB(t)
	user := testutil.CreateUser(t, db)
	var winner *models.PushPreference
	repo := NewPushRepository(faultyDB(t, func(op string, stmt *gorm.Statement) bool {
		if op == "create" && stmt.Table == "push_preferences" && winner == nil {
			// Another request inserts the row between our lookup and our insert.
			winner = models.DefaultPushPreference(user.ID)
			winner.Timezone = "Europe/Berlin"
			require.NoError(t, db.Create(winner).Error)
		}
		return false
	}))

	pref, err := repo.GetOrCreatePreference(user.ID)

	require.NoError(t, err)
	require.NotNil(t, winner)
	assert.Equal(t, winner.ID, pref.ID, "the row created by the other request is returned")
	assert.Equal(t, "Europe/Berlin", pref.Timezone)
}

func TestPushRepository_GetOrCreatePreference_CreateFails(t *testing.T) {
	db := testutil.DB(t)
	user := testutil.CreateUser(t, db)
	repo := NewPushRepository(faultyDB(t, on("create", "push_preferences")))

	pref, err := repo.GetOrCreatePreference(user.ID)

	assert.ErrorIs(t, err, errInjected)
	assert.Nil(t, pref)
}

func TestPushRepository_UpdateAndDeletePreference(t *testing.T) {
	db := testutil.DB(t)
	repo := NewPushRepository(db)
	user, other := testutil.CreateUser(t, db), testutil.CreateUser(t, db)
	pref, err := repo.GetOrCreatePreference(user.ID)
	require.NoError(t, err)
	_, err = repo.GetOrCreatePreference(other.ID)
	require.NoError(t, err)

	pref.PushEnabled = false
	pref.Preferences = models.PushPreferences{"like_received": false, "badge_unlocked": true}
	pref.QuietHoursEnabled, pref.QuietStart, pref.QuietEnd, pref.Timezone = true, "22:00", "07:00", "Europe/London"
	require.NoError(t, repo.UpdatePreference(pref))

	got, err := repo.GetOrCreatePreference(user.ID)
	require.NoError(t, err)
	assert.Equal(t, pref.ID, got.ID)
	assert.False(t, got.PushEnabled, "false is persisted")
	assert.Equal(t, models.PushPreferences{"like_received": false, "badge_unlocked": true}, got.Preferences)
	assert.True(t, got.QuietHoursEnabled)
	assert.Equal(t, "22:00", got.QuietStart)
	assert.Equal(t, "07:00", got.QuietEnd)
	assert.Equal(t, "Europe/London", got.Timezone)

	require.NoError(t, repo.DeletePreferenceByUserID(user.ID))
	var rows []models.PushPreference
	require.NoError(t, db.Find(&rows).Error)
	require.Len(t, rows, 1)
	assert.Equal(t, other.ID, rows[0].UserID)
}

func TestPushRepository_DeliveryLogs(t *testing.T) {
	db := testutil.DB(t)
	repo := NewPushRepository(db)
	user, other := testutil.CreateUser(t, db), testutil.CreateUser(t, db)
	logEntry := func(userID, subID uint, messageID, dedupeKey string, status int, createdAt time.Time) *models.PushDeliveryLog {
		l := &models.PushDeliveryLog{
			UserID: userID, SubscriptionID: subID, NotificationType: string(models.NotifTypeLikeReceived),
			DedupeKey: dedupeKey, MessageID: messageID, StatusCode: status, DurationMs: 42, CreatedAt: createdAt,
		}
		require.NoError(t, repo.CreateDeliveryLog(l))
		require.NotZero(t, l.ID)
		return l
	}
	now := time.Now()
	logEntry(user.ID, 1, "msg-1", "like:7:2026-03-09", 201, now.Add(-10*time.Second))
	logEntry(user.ID, 1, "msg-2", "badge:streak_7", 500, now.Add(-10*time.Second))
	logEntry(user.ID, 1, "msg-3", "follow:8", 201, now.Add(-2*time.Minute))

	t.Run("CheckIdempotency", func(t *testing.T) {
		for _, tc := range []struct {
			messageID string
			subID     uint
			want      bool
		}{
			{"msg-1", 1, true},
			{"msg-1", 2, false},
			{"msg-9", 1, false},
		} {
			delivered, err := repo.CheckIdempotency(tc.messageID, tc.subID)
			require.NoError(t, err)
			assert.Equal(t, tc.want, delivered, "%s to subscription %d", tc.messageID, tc.subID)
		}
	})

	t.Run("CheckDedupeWindow", func(t *testing.T) {
		for _, tc := range []struct {
			name   string
			userID uint
			key    string
			window int
			want   bool
		}{
			{"recent success", user.ID, "like:7:2026-03-09", 60, true},
			{"recent failure does not count", user.ID, "badge:streak_7", 60, false},
			{"success outside the window", user.ID, "follow:8", 60, false},
			{"success inside a wider window", user.ID, "follow:8", 300, true},
			{"other user", other.ID, "like:7:2026-03-09", 60, false},
			{"empty key never dedupes", user.ID, "", 60, false},
		} {
			dup, err := repo.CheckDedupeWindow(tc.userID, tc.key, tc.window)
			require.NoError(t, err)
			assert.Equal(t, tc.want, dup, tc.name)
		}
	})
}

func TestPushRepository_CleanupOldDeliveryLogs(t *testing.T) {
	db := testutil.DB(t)
	repo := NewPushRepository(db)
	user := testutil.CreateUser(t, db)
	for _, age := range []int{40, 31, 29, 1} {
		require.NoError(t, repo.CreateDeliveryLog(&models.PushDeliveryLog{
			UserID: user.ID, SubscriptionID: 1, NotificationType: "like_received", MessageID: "m",
			StatusCode: 201, CreatedAt: time.Now().AddDate(0, 0, -age),
		}))
	}

	deleted, err := repo.CleanupOldDeliveryLogs(30)

	require.NoError(t, err)
	assert.Equal(t, int64(2), deleted)
	var remaining int64
	require.NoError(t, db.Model(&models.PushDeliveryLog{}).Count(&remaining).Error)
	assert.Equal(t, int64(2), remaining)
}

func TestPushRepository_DatabaseErrors(t *testing.T) {
	repo := NewPushRepository(testutil.BrokenDB(t))

	dup, err := repo.CheckDedupeWindow(1, "", 60)
	assert.NoError(t, err, "an empty dedupe key needs no query")
	assert.False(t, dup)

	calls := map[string]func() error{
		"UpsertSubscription": func() error { return repo.UpsertSubscription(newSubscription(1, "https://push.example.com/x")) },
		"GetSubscriptionByEndpoint": func() error {
			_, err := repo.GetSubscriptionByEndpoint("https://push.example.com/x")
			return err
		},
		"GetActiveSubscriptionsByUserID": func() error { _, err := repo.GetActiveSubscriptionsByUserID(1); return err },
		"DeleteSubscription":             func() error { return repo.DeleteSubscription("https://push.example.com/x", 1) },
		"DeleteSubscriptionsByUserID":    func() error { return repo.DeleteSubscriptionsByUserID(1) },
		"MarkSubscriptionGone":           func() error { return repo.MarkSubscriptionGone(1) },
		"UpdateSubscriptionSuccess":      func() error { return repo.UpdateSubscriptionSuccess(1) },
		"IncrementSubscriptionFailure":   func() error { return repo.IncrementSubscriptionFailure(1, 3) },
		"CleanupStaleSubscriptions":      func() error { _, err := repo.CleanupStaleSubscriptions(90); return err },
		"CleanupGoneSubscriptions":       func() error { _, err := repo.CleanupGoneSubscriptions(7); return err },
		"GetOrCreatePreference":          func() error { _, err := repo.GetOrCreatePreference(1); return err },
		"UpdatePreference":               func() error { return repo.UpdatePreference(models.DefaultPushPreference(1)) },
		"DeletePreferenceByUserID":       func() error { return repo.DeletePreferenceByUserID(1) },
		"CreateDeliveryLog": func() error {
			return repo.CreateDeliveryLog(&models.PushDeliveryLog{UserID: 1, SubscriptionID: 1, NotificationType: "x", MessageID: "m"})
		},
		"CheckIdempotency":       func() error { _, err := repo.CheckIdempotency("m", 1); return err },
		"CheckDedupeWindow":      func() error { _, err := repo.CheckDedupeWindow(1, "k", 60); return err },
		"CleanupOldDeliveryLogs": func() error { _, err := repo.CleanupOldDeliveryLogs(30); return err },
	}
	for name, call := range calls {
		t.Run(name, func(t *testing.T) { assert.Error(t, call()) })
	}
}
