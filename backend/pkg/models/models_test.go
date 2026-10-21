package models

import (
	"database/sql"
	"database/sql/driver"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The jsonb types must satisfy the database/sql interfaces GORM relies on.
var (
	_ driver.Valuer = JSONB{}
	_ sql.Scanner   = (*JSONB)(nil)
	_ driver.Valuer = NotificationMetadata{}
	_ sql.Scanner   = (*NotificationMetadata)(nil)
	_ driver.Valuer = PushPreferences{}
	_ sql.Scanner   = (*PushPreferences)(nil)
)

func TestTableNames(t *testing.T) {
	cases := []struct {
		model interface{ TableName() string }
		want  string
	}{
		{User{}, "users"},
		{Activity{}, "activities"},
		{Streak{}, "streaks"},
		{TileConfig{}, "tile_configs"},
		{Like{}, "likes"},
		{UserBadge{}, "user_badges"},
		{Notification{}, "notifications"},
		{NotificationDedupe{}, "notification_dedupes"},
		{PushSubscription{}, "push_subscriptions"},
		{PushPreference{}, "push_preferences"},
		{PushDeliveryLog{}, "push_delivery_logs"},
		{FollowEdgeByFollower{}, "follow_edges_by_follower"},
		{FollowEdgeByFollowee{}, "follow_edges_by_followee"},
		{FollowCounter{}, "follow_counters"},
		{CronJobLog{}, "cron_job_logs"},
		{ActivityPhoto{}, "activity_photos"},
		{StoryView{}, "story_views"},
		{StoryLike{}, "story_likes"},
		{Comment{}, "comments"},
		{CommentLike{}, "comment_likes"},
		{CommentMention{}, "comment_mentions"},
		{CommentDedupe{}, "comment_dedupes"},
		{RecentSearch{}, "recent_searches"},
	}
	for _, tc := range cases {
		t.Run(tc.want, func(t *testing.T) {
			assert.Equal(t, tc.want, tc.model.TableName())
		})
	}
}

// ==================== JSON columns ====================

func TestJSONB_Value(t *testing.T) {
	v, err := JSONB(nil).Value()
	require.NoError(t, err)
	assert.Nil(t, v, "nil map is stored as SQL NULL")

	v, err = JSONB{"order": []string{"sleep"}, "n": 2}.Value()
	require.NoError(t, err)
	require.IsType(t, []byte{}, v)
	assert.JSONEq(t, `{"order":["sleep"],"n":2}`, string(v.([]byte)))

	_, err = JSONB{"bad": make(chan int)}.Value()
	assert.Error(t, err, "values that cannot be encoded are rejected")
}

func TestJSONB_Scan(t *testing.T) {
	t.Run("valid JSON object", func(t *testing.T) {
		var j JSONB
		require.NoError(t, j.Scan([]byte(`{"order":["sleep","study"],"n":2}`)))
		assert.Equal(t, JSONB{"order": []interface{}{"sleep", "study"}, "n": float64(2)}, j)
	})

	t.Run("NULL resets the value", func(t *testing.T) {
		j := JSONB{"stale": true}
		require.NoError(t, j.Scan(nil))
		assert.Nil(t, j)
	})

	t.Run("non-byte input", func(t *testing.T) {
		var j JSONB
		err := j.Scan(`{"order":[]}`)
		assert.EqualError(t, err, "type assertion to []byte failed")
	})

	t.Run("invalid bytes", func(t *testing.T) {
		var j JSONB
		assert.Error(t, j.Scan([]byte(`{not json`)))
		assert.Error(t, j.Scan([]byte(`[1,2]`)), "arrays are not objects")
	})

	t.Run("round trip", func(t *testing.T) {
		in := JSONB{"sizes": map[string]interface{}{"sleep": "large"}}
		v, err := in.Value()
		require.NoError(t, err)
		var out JSONB
		require.NoError(t, out.Scan(v))
		assert.Equal(t, in, out)
	})
}

func TestNotificationMetadata_ValueAndScan(t *testing.T) {
	v, err := NotificationMetadata(nil).Value()
	require.NoError(t, err)
	assert.Nil(t, v)

	in := NotificationMetadata{"liker_id": 7, "liker_username": "alice", "note": "día 🔥"}
	v, err = in.Value()
	require.NoError(t, err)

	var out NotificationMetadata
	require.NoError(t, out.Scan(v))
	assert.Equal(t, NotificationMetadata{"liker_id": float64(7), "liker_username": "alice", "note": "día 🔥"}, out,
		"JSON numbers decode as float64")

	require.NoError(t, out.Scan(nil))
	assert.Nil(t, out)

	assert.EqualError(t, out.Scan(42), "failed to unmarshal NotificationMetadata")
	assert.EqualError(t, out.Scan("{}"), "failed to unmarshal NotificationMetadata")
	assert.Error(t, out.Scan([]byte(`{"liker_id":`)))
}

func TestPushPreferences_ValueAndScan(t *testing.T) {
	v, err := PushPreferences(nil).Value()
	require.NoError(t, err)
	assert.Nil(t, v)

	in := PushPreferences{"like_received": true, "badge_unlocked": false}
	v, err = in.Value()
	require.NoError(t, err)
	assert.JSONEq(t, `{"like_received":true,"badge_unlocked":false}`, string(v.([]byte)))

	var out PushPreferences
	require.NoError(t, out.Scan(v))
	assert.Equal(t, in, out)

	require.NoError(t, out.Scan(nil))
	assert.Nil(t, out)

	assert.EqualError(t, out.Scan(`{"a":true}`), "failed to unmarshal PushPreferences")
	assert.Error(t, out.Scan([]byte(`{"like_received":"yes"}`)), "values must be booleans")
	assert.Error(t, out.Scan([]byte(`nope`)))
}

// ==================== Small helpers ====================

func TestNotification_IsRead(t *testing.T) {
	assert.False(t, (&Notification{}).IsRead())
	now := time.Now()
	assert.True(t, (&Notification{ReadAt: &now}).IsRead())
}

func TestComment_IsTopLevel(t *testing.T) {
	assert.True(t, (&Comment{}).IsTopLevel())
	parent := uint(1)
	assert.False(t, (&Comment{ParentCommentID: &parent}).IsTopLevel())
}

func TestPushDeliveryLog_StatusClassification(t *testing.T) {
	cases := []struct {
		status                        int
		success, permanent, retryable bool
	}{
		{199, false, false, false},
		{200, true, false, false},
		{201, true, false, false},
		{299, true, false, false},
		{300, false, false, false},
		{400, false, false, false},
		{404, false, true, false},
		{410, false, true, false},
		{413, false, false, false},
		{429, false, false, true},
		{500, false, false, true},
		{503, false, false, true},
		{599, false, false, true},
		{600, false, false, false},
	}
	for _, tc := range cases {
		log := &PushDeliveryLog{StatusCode: tc.status}
		assert.Equal(t, tc.success, log.IsSuccess(), "IsSuccess(%d)", tc.status)
		assert.Equal(t, tc.permanent, log.IsPermanentFailure(), "IsPermanentFailure(%d)", tc.status)
		assert.Equal(t, tc.retryable, log.IsRetryable(), "IsRetryable(%d)", tc.status)
	}
}

func TestPushSubscription_IsActiveAndMarkGone(t *testing.T) {
	for status, want := range map[PushSubscriptionStatus]bool{
		PushSubscriptionStatusActive:  true,
		PushSubscriptionStatusGone:    false,
		PushSubscriptionStatusExpired: false,
		"":                            false,
	} {
		assert.Equal(t, want, (&PushSubscription{Status: status}).IsActive(), "status %q", status)
	}

	sub := &PushSubscription{Status: PushSubscriptionStatusActive}
	before := time.Now()
	sub.MarkGone()
	after := time.Now()

	assert.Equal(t, PushSubscriptionStatusGone, sub.Status)
	assert.False(t, sub.IsActive())
	require.NotNil(t, sub.LastFailureAt)
	assert.False(t, sub.LastFailureAt.Before(before))
	assert.False(t, sub.LastFailureAt.After(after))
}
