package handlers

import (
	"net/http"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/aman1117/backend/internal/config"
	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/dto"
	"github.com/aman1117/backend/internal/testutil"
	"github.com/aman1117/backend/pkg/models"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const pushEndpoint = "https://push.example.com/send/device-1"

// maintenanceKey is the MAINTENANCE_API_KEY of maintenanceConfig (test-only value).
const maintenanceKey = "test-maintenance-key"

var withMaintenanceKey = testutil.WithHeader(MaintenanceKeyHeader, maintenanceKey)

// maintenanceConfig returns a test configuration with the maintenance endpoints enabled.
func maintenanceConfig(t *testing.T) *config.Config {
	return useConfig(t, func(c *config.Config) { c.MaintenanceAPIKey = maintenanceKey })
}

func subscriptionBody(endpoint, p256dh, auth string) map[string]any {
	return map[string]any{
		"keyId":        "test",
		"subscription": map[string]any{"endpoint": endpoint, "keys": map[string]string{"p256dh": p256dh, "auth": auth}},
		"device":       map[string]string{"userAgent": "Mozilla/5.0", "platform": "windows", "browser": "chrome"},
	}
}

func subscriptionByEndpoint(t *testing.T, env *testEnv, endpoint string) models.PushSubscription {
	t.Helper()
	var sub models.PushSubscription
	require.NoError(t, env.db.Where("endpoint = ?", endpoint).First(&sub).Error)
	return sub
}

func TestPushHandler_GetVapidPublicKey(t *testing.T) {
	env := newEnv(t)

	t.Run("not configured", func(t *testing.T) {
		res := env.do(t, nil, http.MethodGet, "/api/push/vapid-public-key", nil)
		assertErrorMessage(t, res, http.StatusInternalServerError, constants.ErrCodeConfigError, "Push notifications not configured")
	})

	t.Run("configured", func(t *testing.T) {
		cfg := testutil.Config()
		cfg.WebPush.VapidPublicKey = "BTestOnlyPublicKey"
		cfg.WebPush.VapidKeyID = "key-2026"
		h := &handlerSet{push: NewPushHandler(env.pushRepo, cfg)}

		got := decodeAs[dto.VapidPublicKeyResponse](t, call(t, h, nil, http.MethodGet, "/api/push/vapid-public-key", nil), http.StatusOK)

		assert.Equal(t, dto.VapidPublicKeyResponse{Success: true, KeyID: "key-2026", PublicKey: "BTestOnlyPublicKey"}, got)
	})
}

func TestPushHandler_RegisterSubscription_Validation(t *testing.T) {
	env := newEnv(t)
	user := env.user(t)

	tests := []struct {
		name    string
		body    any
		message string
	}{
		{"malformed json", `{"subscription":`, "Invalid request body"},
		{"missing endpoint", subscriptionBody("", "p256", "auth"), "Endpoint is required"},
		{"missing p256dh key", subscriptionBody(pushEndpoint, "", "auth"), "Keys (p256dh and auth) are required"},
		{"missing auth key", subscriptionBody(pushEndpoint, "p256", ""), "Keys (p256dh and auth) are required"},
		{"endpoint too long", subscriptionBody("https://push.example.com/"+strings.Repeat("x", 2048), "p256", "auth"), "Endpoint too long"},
		{"plain http endpoint", subscriptionBody("http://push.example.com/send/device-1", "p256", "auth"), "Invalid push endpoint URL"},
		{"endpoint too short", subscriptionBody("https://a", "p256", "auth"), "Invalid push endpoint URL"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			res := env.do(t, user, http.MethodPost, "/api/push/subscriptions", tc.body)
			assertErrorMessage(t, res, http.StatusBadRequest, constants.ErrCodeInvalidInput, tc.message)
		})
	}
	assert.Zero(t, count(t, env.db, &models.PushSubscription{}, ""))
}

func TestPushHandler_RegisterSubscription(t *testing.T) {
	env := newEnv(t)
	user, other := env.user(t), env.user(t)

	t.Run("stores the subscription and default preferences", func(t *testing.T) {
		body := subscriptionBody(pushEndpoint, "p256-v1", "auth-v1")
		body["keyId"] = "an-old-key"
		body["device"] = map[string]string{"userAgent": strings.Repeat("u", 600), "platform": strings.Repeat("p", 60), "browser": "firefox"}

		res := env.do(t, user, http.MethodPost, "/api/push/subscriptions", body)

		require.Equal(t, http.StatusOK, res.Status, "body: %s", res.Body)
		assert.Equal(t, dto.PushSubscriptionResponse{Success: true, Message: "Subscription registered successfully"}, decodeAs[dto.PushSubscriptionResponse](t, res, http.StatusOK))
		sub := subscriptionByEndpoint(t, env, pushEndpoint)
		assert.Equal(t, user.ID, sub.UserID)
		assert.Equal(t, "p256-v1", sub.P256dh)
		assert.Equal(t, "auth-v1", sub.Auth)
		assert.Equal(t, "test", sub.VapidKeyID, "the current key id is stored, whatever the client sent")
		assert.Equal(t, models.PushSubscriptionStatusActive, sub.Status)
		assert.Len(t, sub.UserAgent, MaxUserAgentLength)
		assert.Len(t, sub.Platform, MaxPlatformLength)
		assert.Equal(t, "firefox", sub.Browser)
		assert.EqualValues(t, 1, count(t, env.db, &models.PushPreference{}, "user_id = ?", user.ID))
	})

	t.Run("registering again refreshes the keys and reactivates it", func(t *testing.T) {
		require.NoError(t, env.db.Model(&models.PushSubscription{}).Where("endpoint = ?", pushEndpoint).
			Update("status", models.PushSubscriptionStatusExpired).Error)

		res := env.do(t, user, http.MethodPost, "/api/push/subscriptions", subscriptionBody(pushEndpoint, "p256-v2", "auth-v2"))

		require.Equal(t, http.StatusOK, res.Status)
		sub := subscriptionByEndpoint(t, env, pushEndpoint)
		assert.Equal(t, "p256-v2", sub.P256dh)
		assert.Equal(t, models.PushSubscriptionStatusActive, sub.Status)
		assert.EqualValues(t, 1, count(t, env.db, &models.PushSubscription{}, ""))
		assert.EqualValues(t, 1, count(t, env.db, &models.PushPreference{}, ""))
	})

	t.Run("endpoint owned by another user", func(t *testing.T) {
		res := env.do(t, other, http.MethodPost, "/api/push/subscriptions", subscriptionBody(pushEndpoint, "p256", "auth"))
		assertErrorMessage(t, res, http.StatusConflict, constants.ErrCodeConflict, "Endpoint already registered to another user")
		assert.Equal(t, user.ID, subscriptionByEndpoint(t, env, pushEndpoint).UserID)
	})
}

func TestPushHandler_RegisterSubscription_Failures(t *testing.T) {
	env := newEnv(t)
	user := env.user(t)

	t.Run("database failure", func(t *testing.T) {
		res := call(t, brokenStack(t).handlers(), user, http.MethodPost, "/api/push/subscriptions", subscriptionBody(pushEndpoint, "p256", "auth"))
		assertErrorMessage(t, res, http.StatusInternalServerError, constants.ErrCodeDatabaseError, "Failed to register subscription")
	})

	t.Run("default preferences cannot be created", func(t *testing.T) {
		faulty := newStack(faultyDB(t, failOn("create", "push_preferences")), env.cfg, false)
		h := &handlerSet{push: NewPushHandler(faulty.pushRepo, env.cfg)}

		res := call(t, h, user, http.MethodPost, "/api/push/subscriptions", subscriptionBody(pushEndpoint, "p256", "auth"))

		require.Equal(t, http.StatusOK, res.Status, "preferences are optional")
		assert.Equal(t, user.ID, subscriptionByEndpoint(t, env, pushEndpoint).UserID)
		assert.Zero(t, count(t, env.db, &models.PushPreference{}, ""))
	})
}

func TestPushHandler_RegisterSubscription_TruncatesDeviceInfoByCharacter(t *testing.T) {
	env := newEnv(t)
	user := env.user(t)
	body := subscriptionBody(pushEndpoint, "p256", "auth")
	body["device"] = map[string]string{
		"userAgent": strings.Repeat("🚀", MaxUserAgentLength+1),
		"platform":  "a" + strings.Repeat("é", MaxPlatformLength), // a byte cut would split an "é"
		"browser":   strings.Repeat("€", MaxBrowserLength+1),
	}

	res := env.do(t, user, http.MethodPost, "/api/push/subscriptions", body)

	require.Equal(t, http.StatusOK, res.Status, "body: %s", res.Body)
	sub := subscriptionByEndpoint(t, env, pushEndpoint)
	assert.Equal(t, strings.Repeat("🚀", MaxUserAgentLength), sub.UserAgent)
	assert.Equal(t, "a"+strings.Repeat("é", MaxPlatformLength-1), sub.Platform)
	assert.Equal(t, strings.Repeat("€", MaxBrowserLength), sub.Browser)
}

func TestPushHandler_UnregisterSubscription(t *testing.T) {
	env := newEnv(t)
	user, other := env.user(t), env.user(t)
	require.Equal(t, http.StatusOK, env.do(t, user, http.MethodPost, "/api/push/subscriptions", subscriptionBody(pushEndpoint, "p256", "auth")).Status)

	t.Run("malformed json", func(t *testing.T) {
		res := env.do(t, user, http.MethodDelete, "/api/push/subscriptions", `{"endpoint":`)
		assertErrorMessage(t, res, http.StatusBadRequest, constants.ErrCodeInvalidInput, "Invalid request body")
	})

	t.Run("missing endpoint", func(t *testing.T) {
		res := env.do(t, user, http.MethodDelete, "/api/push/subscriptions", map[string]string{})
		assertErrorMessage(t, res, http.StatusBadRequest, constants.ErrCodeInvalidInput, "Endpoint is required")
	})

	t.Run("someone else's subscription is left alone", func(t *testing.T) {
		res := env.do(t, other, http.MethodDelete, "/api/push/subscriptions", map[string]string{"endpoint": pushEndpoint})
		require.Equal(t, http.StatusOK, res.Status)
		assert.Equal(t, models.PushSubscriptionStatusActive, subscriptionByEndpoint(t, env, pushEndpoint).Status)
	})

	t.Run("expires own subscription", func(t *testing.T) {
		res := env.do(t, user, http.MethodDelete, "/api/push/subscriptions", map[string]string{"endpoint": pushEndpoint})
		assertSuccessMessage(t, res, http.StatusOK, "Subscription removed")
		assert.Equal(t, models.PushSubscriptionStatusExpired, subscriptionByEndpoint(t, env, pushEndpoint).Status)
	})

	t.Run("database failure", func(t *testing.T) {
		res := call(t, brokenStack(t).handlers(), user, http.MethodDelete, "/api/push/subscriptions", map[string]string{"endpoint": pushEndpoint})
		assertErrorMessage(t, res, http.StatusInternalServerError, constants.ErrCodeDatabaseError, "Failed to unregister subscription")
	})
}

func TestPushHandler_Preferences(t *testing.T) {
	env := newEnv(t)
	user := env.user(t)
	update := func(t *testing.T, body any) dto.PushPreferencesResponse {
		t.Helper()
		return decodeAs[dto.PushPreferencesResponse](t, env.do(t, user, http.MethodPut, "/api/push/preferences", body), http.StatusOK)
	}

	t.Run("defaults are created on first read", func(t *testing.T) {
		got := decodeAs[dto.PushPreferencesResponse](t, env.do(t, user, http.MethodGet, "/api/push/preferences", nil), http.StatusOK)
		assert.Equal(t, dto.PushPreferencesResponse{
			Success:     true,
			Preferences: dto.PushPreferenceDTO{PushEnabled: true, Preferences: map[string]bool{}, Timezone: "Asia/Kolkata"},
		}, got)
		assert.EqualValues(t, 1, count(t, env.db, &models.PushPreference{}, "user_id = ?", user.ID))
	})

	t.Run("full update", func(t *testing.T) {
		got := update(t, map[string]any{
			"push_enabled":        false,
			"preferences":         map[string]bool{"like_received": false, "badge_unlocked": true},
			"quiet_hours_enabled": true,
			"quiet_start":         "22:30",
			"quiet_end":           "07:00",
			"timezone":            "Europe/Berlin",
		})

		want := dto.PushPreferenceDTO{
			PushEnabled:       false,
			Preferences:       map[string]bool{"like_received": false, "badge_unlocked": true},
			QuietHoursEnabled: true,
			QuietStart:        "22:30",
			QuietEnd:          "07:00",
			Timezone:          "Europe/Berlin",
		}
		assert.Equal(t, dto.PushPreferencesResponse{Success: true, Preferences: want}, got)
		stored := decodeAs[dto.PushPreferencesResponse](t, env.do(t, user, http.MethodGet, "/api/push/preferences", nil), http.StatusOK)
		assert.Equal(t, want, stored.Preferences, "persisted")
	})

	t.Run("partial update keeps the other settings", func(t *testing.T) {
		got := update(t, map[string]any{"preferences": map[string]bool{"streak_at_risk": false}, "push_enabled": true})
		assert.True(t, got.Preferences.PushEnabled)
		assert.Equal(t, map[string]bool{"like_received": false, "badge_unlocked": true, "streak_at_risk": false}, got.Preferences.Preferences)
		assert.Equal(t, "22:30", got.Preferences.QuietStart)
		assert.Equal(t, "Europe/Berlin", got.Preferences.Timezone)
	})

	t.Run("a stored null preference map is replaced", func(t *testing.T) {
		require.NoError(t, env.db.Exec("UPDATE push_preferences SET preferences = NULL WHERE user_id = ?", user.ID).Error)
		got := update(t, map[string]any{"preferences": map[string]bool{"system_announcement": false}})
		assert.Equal(t, map[string]bool{"system_announcement": false}, got.Preferences.Preferences)
	})
}

func TestPushHandler_UpdatePreferences_Validation(t *testing.T) {
	env := newEnv(t)
	user := env.user(t)

	tests := []struct {
		name    string
		body    any
		message string
	}{
		{"malformed json", `{"push_enabled":`, "Invalid request body"},
		{"unknown notification type", map[string]any{"preferences": map[string]bool{"follow_request": false}}, "Invalid notification type: follow_request"},
		{"quiet start out of range", map[string]any{"quiet_start": "24:00"}, "Invalid quiet_start format (expected HH:MM)"},
		{"quiet start without leading zero", map[string]any{"quiet_start": "7:30"}, "Invalid quiet_start format (expected HH:MM)"},
		{"quiet end minutes out of range", map[string]any{"quiet_end": "12:60"}, "Invalid quiet_end format (expected HH:MM)"},
		{"quiet end not a time", map[string]any{"quiet_end": "ab:cd"}, "Invalid quiet_end format (expected HH:MM)"},
		{"unknown timezone", map[string]any{"timezone": "Mars/Olympus_Mons"}, "Invalid timezone"},
		{"empty timezone", map[string]any{"timezone": ""}, "Invalid timezone"},
		{"overlong timezone", map[string]any{"timezone": strings.Repeat("A", 51)}, "Invalid timezone"},
		{"quiet hours without times", map[string]any{"quiet_hours_enabled": true}, "Quiet hours requires both start and end times"},
		{"quiet hours with only a start", map[string]any{"quiet_hours_enabled": true, "quiet_start": "22:00"}, "Quiet hours requires both start and end times"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			res := env.do(t, user, http.MethodPut, "/api/push/preferences", tc.body)
			assertErrorMessage(t, res, http.StatusBadRequest, constants.ErrCodeInvalidInput, tc.message)
		})
	}

	var pref models.PushPreference
	require.NoError(t, env.db.Where("user_id = ?", user.ID).First(&pref).Error)
	assert.Equal(t, *models.DefaultPushPreference(user.ID), models.PushPreference{
		UserID: pref.UserID, PushEnabled: pref.PushEnabled, Preferences: pref.Preferences,
		QuietHoursEnabled: pref.QuietHoursEnabled, Timezone: pref.Timezone,
	}, "rejected updates are not saved")
	assert.Empty(t, pref.QuietStart)
}

func TestPushHandler_Preferences_DatabaseFailures(t *testing.T) {
	env := newEnv(t)
	user := env.user(t)

	t.Run("reading", func(t *testing.T) {
		res := call(t, brokenStack(t).handlers(), user, http.MethodGet, "/api/push/preferences", nil)
		assertErrorMessage(t, res, http.StatusInternalServerError, constants.ErrCodeDatabaseError, "Failed to get preferences")
	})

	t.Run("loading before an update", func(t *testing.T) {
		res := call(t, brokenStack(t).handlers(), user, http.MethodPut, "/api/push/preferences", map[string]any{"push_enabled": false})
		assertErrorMessage(t, res, http.StatusInternalServerError, constants.ErrCodeDatabaseError, "Failed to get preferences")
	})

	t.Run("saving", func(t *testing.T) {
		faulty := newStack(faultyDB(t, failOn("update", "push_preferences")), env.cfg, false)
		h := &handlerSet{push: NewPushHandler(faulty.pushRepo, env.cfg)}

		res := call(t, h, user, http.MethodPut, "/api/push/preferences", map[string]any{"push_enabled": false})

		assertErrorMessage(t, res, http.StatusInternalServerError, constants.ErrCodeDatabaseError, "Failed to update preferences")
		var pref models.PushPreference
		require.NoError(t, env.db.Where("user_id = ?", user.ID).First(&pref).Error)
		assert.True(t, pref.PushEnabled)
	})
}

func TestPushHandler_RunCleanup(t *testing.T) {
	env := newEnv(t, withConfig(maintenanceConfig(t)))
	user := env.user(t)
	recently := time.Now().Add(-24 * time.Hour)
	subscribe := func(endpoint string, status models.PushSubscriptionStatus, lastSuccess time.Time, updatedDaysAgo int) {
		t.Helper()
		sub := &models.PushSubscription{UserID: user.ID, Endpoint: endpoint, P256dh: "p", Auth: "a", VapidKeyID: "test",
			Status: status, LastSuccessAt: &lastSuccess}
		require.NoError(t, env.db.Create(sub).Error)
		require.NoError(t, env.db.Exec("UPDATE push_subscriptions SET updated_at = NOW() - make_interval(days => ?) WHERE id = ?", updatedDaysAgo, sub.ID).Error)
	}
	subscribe("https://push.example.com/stale", models.PushSubscriptionStatusActive, time.Now().AddDate(0, 0, -100), 0)
	subscribe("https://push.example.com/healthy", models.PushSubscriptionStatusActive, recently, 0)
	subscribe("https://push.example.com/gone-old", models.PushSubscriptionStatusGone, recently, 8)
	subscribe("https://push.example.com/gone-new", models.PushSubscriptionStatusGone, recently, 1)
	for _, age := range []int{31, 2} {
		log := &models.PushDeliveryLog{UserID: user.ID, SubscriptionID: 1, NotificationType: "like_received", MessageID: "m",
			StatusCode: 201, CreatedAt: time.Now().AddDate(0, 0, -age)}
		require.NoError(t, env.db.Create(log).Error)
	}

	res := env.do(t, user, http.MethodPost, "/api/push/cleanup", nil, withMaintenanceKey)

	require.Equal(t, http.StatusOK, res.Status)
	assert.Equal(t, map[string]any{
		"success":                     true,
		"stale_subscriptions_cleaned": float64(1),
		"gone_subscriptions_deleted":  float64(1),
		"old_logs_deleted":            float64(1),
	}, res.JSON(t))
	statuses := map[string]models.PushSubscriptionStatus{}
	var subs []models.PushSubscription
	require.NoError(t, env.db.Find(&subs).Error)
	for _, s := range subs {
		statuses[strings.TrimPrefix(s.Endpoint, "https://push.example.com/")] = s.Status
	}
	assert.Equal(t, map[string]models.PushSubscriptionStatus{
		"stale":    models.PushSubscriptionStatusExpired,
		"healthy":  models.PushSubscriptionStatusActive,
		"gone-new": models.PushSubscriptionStatusGone,
	}, statuses)
	assert.EqualValues(t, 1, count(t, env.db, &models.PushDeliveryLog{}, ""))
}

func TestPushHandler_RunCleanup_JudgesNeverDeliveredSubscriptionsByAge(t *testing.T) {
	env := newEnv(t, withConfig(maintenanceConfig(t)))
	user := env.user(t)
	const abandoned = "https://push.example.com/send/abandoned"
	for _, endpoint := range []string{pushEndpoint, abandoned} {
		require.Equal(t, http.StatusOK, env.do(t, user, http.MethodPost, "/api/push/subscriptions", subscriptionBody(endpoint, "p256", "auth")).Status)
	}
	require.NoError(t, env.db.Model(&models.PushSubscription{}).Where("endpoint = ?", abandoned).
		Update("created_at", time.Now().AddDate(0, 0, -91)).Error)

	res := env.do(t, user, http.MethodPost, "/api/push/cleanup", nil, withMaintenanceKey)

	require.Equal(t, http.StatusOK, res.Status)
	assert.Equal(t, float64(1), res.JSON(t)["stale_subscriptions_cleaned"])
	assert.Equal(t, models.PushSubscriptionStatusActive, subscriptionByEndpoint(t, env, pushEndpoint).Status, "registered just now")
	assert.Equal(t, models.PushSubscriptionStatusExpired, subscriptionByEndpoint(t, env, abandoned).Status, "no delivery in 91 days")
}

func TestPushHandler_RunCleanup_RequiresTheMaintenanceKey(t *testing.T) {
	env := newEnv(t, withConfig(maintenanceConfig(t)))
	user := env.user(t)
	lastSuccess := time.Now().AddDate(0, 0, -100)
	require.NoError(t, env.db.Create(&models.PushSubscription{UserID: user.ID, Endpoint: pushEndpoint, P256dh: "p", Auth: "a",
		VapidKeyID: "test", Status: models.PushSubscriptionStatusActive, LastSuccessAt: &lastSuccess}).Error)
	cleanup := func(t *testing.T, h *handlerSet, opts ...testutil.RequestOption) testutil.Response {
		t.Helper()
		return call(t, h, user, http.MethodPost, "/api/push/cleanup", nil, opts...)
	}
	untouched := func(t *testing.T) {
		t.Helper()
		assert.Equal(t, models.PushSubscriptionStatusActive, subscriptionByEndpoint(t, env, pushEndpoint).Status)
	}

	t.Run("fails closed when no key is configured", func(t *testing.T) {
		h := &handlerSet{push: NewPushHandler(env.pushRepo, testutil.Config())}
		for _, opts := range [][]testutil.RequestOption{nil, {withMaintenanceKey}, {testutil.WithHeader(MaintenanceKeyHeader, "")}} {
			res := cleanup(t, h, opts...)
			assertErrorMessage(t, res, http.StatusForbidden, constants.ErrCodeNotAuthorized, "Maintenance endpoints are disabled")
		}
		untouched(t)
	})

	for name, opts := range map[string][]testutil.RequestOption{
		"missing key":           nil,
		"empty key":             {testutil.WithHeader(MaintenanceKeyHeader, "")},
		"wrong key":             {testutil.WithHeader(MaintenanceKeyHeader, "wrong-maintenance-key")},
		"key prefix":            {testutil.WithHeader(MaintenanceKeyHeader, maintenanceKey[:len(maintenanceKey)-1])},
		"key in another header": {testutil.WithHeader("X-Api-Key", maintenanceKey)},
	} {
		t.Run(name, func(t *testing.T) {
			assertErrorMessage(t, cleanup(t, env.h, opts...), http.StatusForbidden, constants.ErrCodeNotAuthorized, "Invalid maintenance key")
			untouched(t)
		})
	}

	t.Run("matching key", func(t *testing.T) {
		require.Equal(t, http.StatusOK, cleanup(t, env.h, withMaintenanceKey).Status)
		assert.Equal(t, models.PushSubscriptionStatusExpired, subscriptionByEndpoint(t, env, pushEndpoint).Status)
	})
}

func TestPushHandler_RunCleanup_FailuresAreOnlyLogged(t *testing.T) {
	h := newStack(testutil.BrokenDB(t), maintenanceConfig(t), false).handlers()

	res := call(t, h, ghostUser, http.MethodPost, "/api/push/cleanup", nil, withMaintenanceKey)

	require.Equal(t, http.StatusOK, res.Status)
	assert.Equal(t, map[string]any{
		"success":                     true,
		"stale_subscriptions_cleaned": float64(0),
		"gone_subscriptions_deleted":  float64(0),
		"old_logs_deleted":            float64(0),
	}, res.JSON(t))
}

func TestPushHandler_Helpers(t *testing.T) {
	t.Run("isValidTimeFormat", func(t *testing.T) {
		for in, want := range map[string]bool{
			"00:00": true, "23:59": true, "09:05": true,
			"24:00": false, "23:60": false, "7:30": false, "07-30": false, "0a:00": false,
			"00:0a": false, "30:00": false, "": false, "07:300": false,
		} {
			assert.Equal(t, want, isValidTimeFormat(in), in)
		}
	})

	t.Run("isValidPushEndpoint", func(t *testing.T) {
		for in, want := range map[string]bool{
			pushEndpoint: true, "https://a.b": true, "https://a": false, "http://push.example.com/x": false, "": false,
		} {
			assert.Equal(t, want, isValidPushEndpoint(in), in)
		}
	})

	t.Run("isValidTimezone", func(t *testing.T) {
		assert.True(t, isValidTimezone("UTC"))
		assert.True(t, isValidTimezone("Asia/Kolkata"))
		assert.False(t, isValidTimezone("Nowhere/City"))
	})

	t.Run("isValidNotificationType", func(t *testing.T) {
		for _, typ := range []string{"like_received", "badge_unlocked", "streak_milestone", "streak_at_risk", "system_announcement"} {
			assert.True(t, isValidNotificationType(typ), typ)
		}
		assert.False(t, isValidNotificationType("comment_received"))
	})

	t.Run("extractOrigin and truncateString", func(t *testing.T) {
		long := "https://push.example.com/" + strings.Repeat("x", 100)
		assert.Equal(t, long[:50]+"...", extractOrigin(long))
		assert.Equal(t, pushEndpoint, extractOrigin(pushEndpoint))
		assert.Equal(t, "abc", truncateString("abcdef", 3))
		assert.Equal(t, "abc", truncateString("abc", 3))
		assert.Equal(t, "hé", truncateString("héllo", 2), "counts characters, not bytes")
		assert.Equal(t, "🚀🚀", truncateString("🚀🚀🚀", 2))
		assert.Equal(t, "ab\uFFFDc", truncateString("ab\xffc", 10), "invalid UTF-8 is replaced")
		assert.True(t, utf8.ValidString(truncateString("€\xe2\x82", 5)))
	})
}
