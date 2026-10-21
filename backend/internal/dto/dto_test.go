package dto_test

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/aman1117/backend/internal/dto"
	"github.com/aman1117/backend/pkg/models"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func ptr[T any](v T) *T { return &v }

func TestNotificationToDTO(t *testing.T) {
	createdAt := time.Date(2026, time.January, 5, 10, 0, 0, 0, time.UTC)
	readAt := time.Date(2026, time.January, 5, 12, 30, 15, 0, time.UTC)

	tests := []struct {
		name string
		in   models.Notification
		want dto.NotificationDTO
	}{
		{
			name: "unread notification has no read_at",
			in: models.Notification{
				ID:        7,
				UserID:    3,
				Type:      models.NotifTypeLikeReceived,
				Title:     "New Like!",
				Body:      "alice liked your Jan 5 activities",
				Metadata:  models.NotificationMetadata{"liker_username": "alice", "liker_id": float64(9)},
				CreatedAt: createdAt,
			},
			want: dto.NotificationDTO{
				ID:        7,
				Type:      "like_received",
				Title:     "New Like!",
				Body:      "alice liked your Jan 5 activities",
				Metadata:  map[string]interface{}{"liker_username": "alice", "liker_id": float64(9)},
				CreatedAt: "2026-01-05T10:00:00Z",
			},
		},
		{
			name: "read notification formats read_at",
			in: models.Notification{
				ID:        8,
				Type:      models.NotifTypeBadgeUnlocked,
				Title:     "Badge unlocked",
				ReadAt:    &readAt,
				CreatedAt: createdAt,
			},
			want: dto.NotificationDTO{
				ID:        8,
				Type:      "badge_unlocked",
				Title:     "Badge unlocked",
				ReadAt:    ptr("2026-01-05T12:30:15Z"),
				CreatedAt: "2026-01-05T10:00:00Z",
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := dto.NotificationToDTO(&tt.in)
			assert.Equal(t, tt.want, got)
		})
	}
}

func TestNotificationDTO_JSONOmitsEmptyOptionalFields(t *testing.T) {
	unread := dto.NotificationToDTO(&models.Notification{
		ID:        1,
		Type:      models.NotifTypeNewFollower,
		Title:     "New follower",
		CreatedAt: time.Date(2026, time.March, 1, 8, 0, 0, 0, time.UTC),
	})

	encoded, err := json.Marshal(unread)
	require.NoError(t, err)
	assert.JSONEq(t, `{
		"id": 1,
		"type": "new_follower",
		"title": "New follower",
		"body": "",
		"created_at": "2026-03-01T08:00:00Z"
	}`, string(encoded))
}

func TestNotificationsToDTOs(t *testing.T) {
	t.Run("nil input encodes as an empty list", func(t *testing.T) {
		got := dto.NotificationsToDTOs(nil)
		require.NotNil(t, got)
		assert.Empty(t, got)

		encoded, err := json.Marshal(got)
		require.NoError(t, err)
		assert.Equal(t, "[]", string(encoded))
	})

	t.Run("converts every notification in order", func(t *testing.T) {
		firstRead := time.Date(2026, time.February, 1, 9, 0, 0, 0, time.UTC)
		secondRead := time.Date(2026, time.February, 2, 9, 0, 0, 0, time.UTC)
		created := time.Date(2026, time.February, 1, 8, 0, 0, 0, time.UTC)
		notifications := []models.Notification{
			{ID: 1, Type: models.NotifTypeCommentReceived, Title: "first", ReadAt: &firstRead, CreatedAt: created},
			{ID: 2, Type: models.NotifTypeCommentReply, Title: "second", ReadAt: &secondRead, CreatedAt: created},
			{ID: 3, Type: models.NotifTypeCommentMention, Title: "third", CreatedAt: created},
		}

		got := dto.NotificationsToDTOs(notifications)

		require.Len(t, got, 3)
		for i, n := range notifications {
			assert.Equal(t, dto.NotificationToDTO(&n), got[i])
		}
		require.NotNil(t, got[0].ReadAt)
		require.NotNil(t, got[1].ReadAt)
		assert.Equal(t, "2026-02-01T09:00:00Z", *got[0].ReadAt, "each element keeps its own read_at")
		assert.Equal(t, "2026-02-02T09:00:00Z", *got[1].ReadAt)
		assert.Nil(t, got[2].ReadAt)
	})
}

func TestPushPreferenceToDTO(t *testing.T) {
	t.Run("copies every field", func(t *testing.T) {
		pref := &models.PushPreference{
			ID:                5,
			UserID:            9,
			PushEnabled:       true,
			Preferences:       models.PushPreferences{"like_received": false, "new_follower": true},
			QuietHoursEnabled: true,
			QuietStart:        "22:00",
			QuietEnd:          "07:30",
			Timezone:          "America/New_York",
		}

		assert.Equal(t, dto.PushPreferenceDTO{
			PushEnabled:       true,
			Preferences:       map[string]bool{"like_received": false, "new_follower": true},
			QuietHoursEnabled: true,
			QuietStart:        "22:00",
			QuietEnd:          "07:30",
			Timezone:          "America/New_York",
		}, dto.PushPreferenceToDTO(pref))
	})

	t.Run("defaults", func(t *testing.T) {
		got := dto.PushPreferenceToDTO(models.DefaultPushPreference(1))

		assert.Equal(t, dto.PushPreferenceDTO{
			PushEnabled: true,
			Preferences: map[string]bool{},
			Timezone:    "Asia/Kolkata",
		}, got)
	})

	t.Run("nil preferences encode as an empty object", func(t *testing.T) {
		got := dto.PushPreferenceToDTO(&models.PushPreference{PushEnabled: false, Timezone: "UTC"})
		require.NotNil(t, got.Preferences)

		encoded, err := json.Marshal(got)
		require.NoError(t, err)
		assert.JSONEq(t, `{
			"push_enabled": false,
			"preferences": {},
			"quiet_hours_enabled": false,
			"timezone": "UTC"
		}`, string(encoded))
	})

	t.Run("returned map is independent of the model", func(t *testing.T) {
		pref := &models.PushPreference{Preferences: models.PushPreferences{"like_received": true}}

		got := dto.PushPreferenceToDTO(pref)
		got.Preferences["like_received"] = false
		got.Preferences["badge_unlocked"] = false

		assert.Equal(t, models.PushPreferences{"like_received": true}, pref.Preferences)
	})
}

// The generic envelopes are part of the API contract the frontend parses.
func TestEnvelopes_JSONContract(t *testing.T) {
	tests := []struct {
		name string
		in   any
		want string
	}{
		{
			name: "error response",
			in:   dto.ErrorResponse{Success: false, Error: "Invalid request", ErrorCode: "INVALID_REQUEST"},
			want: `{"success": false, "error": "Invalid request", "error_code": "INVALID_REQUEST"}`,
		},
		{
			name: "success response with message",
			in:   dto.SuccessResponse{Success: true, Message: "Saved"},
			want: `{"success": true, "message": "Saved"}`,
		},
		{
			name: "success response omits an empty message",
			in:   dto.SuccessResponse{Success: true},
			want: `{"success": true}`,
		},
		{
			name: "data response keeps a null payload",
			in:   dto.DataResponse{Success: true},
			want: `{"success": true, "data": null}`,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			encoded, err := json.Marshal(tt.in)
			require.NoError(t, err)
			assert.JSONEq(t, tt.want, string(encoded))
		})
	}
}

func TestRegisterPushSubscriptionRequest_DecodesBrowserSubscription(t *testing.T) {
	body := `{
		"keyId": "prod-2026-01",
		"subscription": {
			"endpoint": "https://push.example.com/send/abc",
			"keys": {"p256dh": "BNcRd-key", "auth": "tBHIt-auth"}
		},
		"device": {"userAgent": "Mozilla/5.0", "platform": "windows", "browser": "chrome"}
	}`

	var req dto.RegisterPushSubscriptionRequest
	require.NoError(t, json.Unmarshal([]byte(body), &req))

	assert.Equal(t, dto.RegisterPushSubscriptionRequest{
		KeyID: "prod-2026-01",
		Subscription: dto.PushSubscriptionData{
			Endpoint: "https://push.example.com/send/abc",
			Keys:     dto.PushSubscriptionKeys{P256dh: "BNcRd-key", Auth: "tBHIt-auth"},
		},
		Device: dto.PushDeviceInfo{UserAgent: "Mozilla/5.0", Platform: "windows", Browser: "chrome"},
	}, req)
}

func TestUpdatePushPreferencesRequest_AbsentFieldsStayNil(t *testing.T) {
	var req dto.UpdatePushPreferencesRequest
	require.NoError(t, json.Unmarshal([]byte(`{"push_enabled": false, "quiet_start": "23:00"}`), &req))

	require.NotNil(t, req.PushEnabled)
	assert.False(t, *req.PushEnabled)
	require.NotNil(t, req.QuietStart)
	assert.Equal(t, "23:00", *req.QuietStart)
	assert.Nil(t, req.Preferences)
	assert.Nil(t, req.QuietHoursEnabled)
	assert.Nil(t, req.QuietEnd)
	assert.Nil(t, req.Timezone)
}
