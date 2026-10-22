package models

import (
	"encoding/json"
	"testing"
	"time"
	_ "time/tzdata" // quiet hours use IANA zones; embed them so results do not depend on the host

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestDefaultPushPreference(t *testing.T) {
	pref := DefaultPushPreference(42)

	assert.Equal(t, uint(42), pref.UserID)
	assert.True(t, pref.PushEnabled)
	assert.NotNil(t, pref.Preferences)
	assert.Empty(t, pref.Preferences)
	assert.False(t, pref.QuietHoursEnabled)
	assert.Equal(t, "Asia/Kolkata", pref.Timezone)
	assert.True(t, pref.IsTypeEnabled(string(NotifTypeLikeReceived)), "everything is enabled by default")
}

func TestPushPreference_IsTypeEnabled(t *testing.T) {
	prefs := PushPreferences{"like_received": false, "badge_unlocked": true}

	cases := []struct {
		name string
		pref PushPreference
		typ  string
		want bool
	}{
		{"push disabled overrides everything", PushPreference{PushEnabled: false, Preferences: prefs}, "badge_unlocked", false},
		{"no per-type settings", PushPreference{PushEnabled: true}, "like_received", true},
		{"type not configured (opt-out model)", PushPreference{PushEnabled: true, Preferences: prefs}, "new_follower", true},
		{"type explicitly disabled", PushPreference{PushEnabled: true, Preferences: prefs}, "like_received", false},
		{"type explicitly enabled", PushPreference{PushEnabled: true, Preferences: prefs}, "badge_unlocked", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, tc.want, tc.pref.IsTypeEnabled(tc.typ))
		})
	}
}

func TestPushPreference_IsInQuietHours(t *testing.T) {
	utc := func(hour, minute int) time.Time { return time.Date(2026, time.March, 9, hour, minute, 0, 0, time.UTC) }
	overnightIST := PushPreference{QuietHoursEnabled: true, QuietStart: "22:00", QuietEnd: "08:00", Timezone: "Asia/Kolkata"}
	lunchUTC := PushPreference{QuietHoursEnabled: true, QuietStart: "13:00", QuietEnd: "14:00", Timezone: "UTC"}

	cases := []struct {
		name string
		pref PushPreference
		now  time.Time
		want bool
	}{
		// Asia/Kolkata is UTC+05:30.
		{"overnight: start is inclusive (22:00 IST)", overnightIST, utc(16, 30), true},
		{"overnight: before start (21:59 IST)", overnightIST, utc(16, 29), false},
		{"overnight: late evening (23:30 IST)", overnightIST, utc(18, 0), true},
		{"overnight: midnight (00:00 IST)", overnightIST, utc(18, 30), true},
		{"overnight: early morning (07:59 IST)", overnightIST, utc(2, 29), true},
		{"overnight: end is exclusive (08:00 IST)", overnightIST, utc(2, 30), false},
		{"overnight: midday (12:00 IST)", overnightIST, utc(6, 30), false},
		{"same day: start", lunchUTC, utc(13, 0), true},
		{"same day: inside", lunchUTC, utc(13, 59), true},
		{"same day: end is exclusive", lunchUTC, utc(14, 0), false},
		{"same day: before", lunchUTC, utc(12, 59), false},
		{"converts to the user's zone", PushPreference{QuietHoursEnabled: true, QuietStart: "13:00", QuietEnd: "14:00", Timezone: "Asia/Kolkata"}, utc(13, 30), false},
		{"unknown zone falls back to UTC", PushPreference{QuietHoursEnabled: true, QuietStart: "13:00", QuietEnd: "14:00", Timezone: "Mars/Olympus_Mons"}, utc(13, 30), true},
		{"empty zone is UTC", PushPreference{QuietHoursEnabled: true, QuietStart: "13:00", QuietEnd: "14:00"}, utc(13, 30), true},
		{"disabled", PushPreference{QuietHoursEnabled: false, QuietStart: "00:00", QuietEnd: "23:59", Timezone: "UTC"}, utc(13, 30), false},
		{"missing start", PushPreference{QuietHoursEnabled: true, QuietEnd: "23:59", Timezone: "UTC"}, utc(13, 30), false},
		{"missing end", PushPreference{QuietHoursEnabled: true, QuietStart: "00:00", Timezone: "UTC"}, utc(13, 30), false},
		{"empty window", PushPreference{QuietHoursEnabled: true, QuietStart: "08:00", QuietEnd: "08:00", Timezone: "UTC"}, utc(8, 0), false},
		{"invalid start counts as midnight (inside)", PushPreference{QuietHoursEnabled: true, QuietStart: "25:00", QuietEnd: "06:00", Timezone: "UTC"}, utc(3, 0), true},
		{"invalid start counts as midnight (outside)", PushPreference{QuietHoursEnabled: true, QuietStart: "25:00", QuietEnd: "06:00", Timezone: "UTC"}, utc(7, 0), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, tc.want, tc.pref.IsInQuietHours(tc.now))
		})
	}
}

func TestParseTimeToMinutes(t *testing.T) {
	cases := map[string]int{
		"00:00": 0,
		"08:30": 510,
		"22:00": 1320,
		"23:59": 1439,
		// Malformed values count as midnight.
		"":       0,
		"8:30":   0,
		"08:300": 0,
		"08-30":  0,
		"ab:30":  0,
		"-1:30":  0,
		"24:00":  0,
		"12:60":  0,
		"12:3x":  0,
		"12:-1":  0,
	}
	for in, want := range cases {
		assert.Equal(t, want, parseTimeToMinutes(in), "parseTimeToMinutes(%q)", in)
	}
}

func TestParseHHMM(t *testing.T) {
	var hour, minute int
	ok, err := parseHHMM("07:05", &hour, &minute)
	require.NoError(t, err)
	assert.True(t, ok)
	assert.Equal(t, 7, hour)
	assert.Equal(t, 5, minute)

	for in, wantErr := range map[string]string{
		"0705":  "invalid time format",
		"07:5":  "invalid time format",
		"x7:05": "invalid hour",
		"24:05": "invalid hour",
		"07:x5": "invalid minute",
		"07:60": "invalid minute",
	} {
		hour, minute = -1, -1
		ok, err := parseHHMM(in, &hour, &minute)
		assert.False(t, ok, in)
		assert.EqualError(t, err, wantErr, in)
		assert.Equal(t, -1, hour, "outputs untouched on error (%s)", in)
		assert.Equal(t, -1, minute, "outputs untouched on error (%s)", in)
	}
}

// ==================== Notification metadata ====================

// metadataMapper is implemented by every typed notification metadata struct.
type metadataMapper interface{ ToMap() NotificationMetadata }

// jsonObject encodes v and decodes it as a generic object, like a jsonb round trip.
func jsonObject(t *testing.T, v any) map[string]any {
	t.Helper()
	b, err := json.Marshal(v)
	require.NoError(t, err)
	var out map[string]any
	require.NoError(t, json.Unmarshal(b, &out))
	return out
}

func TestMetadata_ToMap(t *testing.T) {
	cases := []struct {
		name string
		meta metadataMapper
		want NotificationMetadata
	}{
		{
			"like",
			LikeMetadata{LikerID: 7, LikerUsername: "alice", LikerAvatar: "https://cdn.example.com/a.png", LikedDate: "2026-03-09"},
			NotificationMetadata{"liker_id": uint(7), "liker_username": "alice", "liker_avatar": "https://cdn.example.com/a.png", "liked_date": "2026-03-09"},
		},
		{
			"badge",
			BadgeMetadata{BadgeID: "streak_7", BadgeName: "Week Warrior", BadgeIcon: "🔥"},
			NotificationMetadata{"badge_id": "streak_7", "badge_name": "Week Warrior", "badge_icon": "🔥"},
		},
		{
			"streak",
			StreakMetadata{ActivityType: "study", StreakCount: 30},
			NotificationMetadata{"activity_type": "study", "streak_count": 30},
		},
		{
			"day completed",
			DayCompletedMetadata{CompletedUserID: 3, CompletedUsername: "bob", CompletedUserAvatar: "https://cdn.example.com/b.png", CompletedDate: "2026-03-09"},
			NotificationMetadata{"completed_user_id": uint(3), "completed_username": "bob", "completed_user_avatar": "https://cdn.example.com/b.png", "completed_date": "2026-03-09"},
		},
		{
			"comment",
			CommentMetadata{CommentID: 11, CommentPreview: "Nice día!", DayOwnerUsername: "carol", DayDate: "2026-03-09", AuthorID: 4, AuthorUsername: "dave", AuthorAvatar: "https://cdn.example.com/d.png"},
			NotificationMetadata{"comment_id": uint(11), "comment_preview": "Nice día!", "day_owner_username": "carol", "day_date": "2026-03-09", "author_id": uint(4), "author_username": "dave", "author_avatar": "https://cdn.example.com/d.png"},
		},
		{
			"story liked",
			StoryLikedMetadata{LikerID: 5, LikerUsername: "erin", LikerAvatar: "https://cdn.example.com/e.png", PhotoID: 9, PhotoDate: "2026-03-09"},
			NotificationMetadata{"liker_id": uint(5), "liker_username": "erin", "liker_avatar": "https://cdn.example.com/e.png", "photo_id": uint(9), "photo_date": "2026-03-09"},
		},
		{
			"photo uploaded",
			PhotoUploadedMetadata{UploaderID: 6, UploaderUsername: "frank", UploaderAvatar: "https://cdn.example.com/f.png", PhotoCount: 2, PhotoDate: "2026-03-09"},
			NotificationMetadata{"uploader_id": uint(6), "uploader_username": "frank", "uploader_avatar": "https://cdn.example.com/f.png", "photo_count": 2, "photo_date": "2026-03-09"},
		},
		{
			"follow",
			FollowMetadata{ActorID: 8, ActorUsername: "grace", ActorAvatar: "https://cdn.example.com/g.png"},
			NotificationMetadata{"actor_id": uint(8), "actor_username": "grace", "actor_avatar": "https://cdn.example.com/g.png"},
		},
		{
			"challenge actor",
			ChallengeActorMetadata{ChallengeID: 12, ChallengeTitle: "Study 2h+ 📚", ActorID: 8, ActorUsername: "grace", ActorAvatar: "https://cdn.example.com/g.png"},
			NotificationMetadata{"challenge_id": uint(12), "challenge_title": "Study 2h+ 📚", "actor_id": uint(8), "actor_username": "grace", "actor_avatar": "https://cdn.example.com/g.png"},
		},
		{
			"challenge invite",
			ChallengeInviteMetadata{
				ChallengeActorMetadata: ChallengeActorMetadata{ChallengeID: 12, ChallengeTitle: "Study", ActorID: 8, ActorUsername: "grace", ActorAvatar: "https://cdn.example.com/g.png"},
				InviteCode:             "K7Q2M9XA",
			},
			NotificationMetadata{"challenge_id": uint(12), "challenge_title": "Study", "actor_id": uint(8), "actor_username": "grace", "actor_avatar": "https://cdn.example.com/g.png", "invite_code": "K7Q2M9XA"},
		},
		{
			"challenge ended",
			ChallengeEndedMetadata{ChallengeID: 12, ChallengeTitle: "Study", Rank: 2, DaysMet: 17, DaysPossible: 21, Completed: true},
			NotificationMetadata{"challenge_id": uint(12), "challenge_title": "Study", "rank": 2, "days_met": 17, "days_possible": 21, "completed": true},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := tc.meta.ToMap()
			assert.Equal(t, tc.want, got)
			assert.Equal(t, jsonObject(t, tc.meta), jsonObject(t, got),
				"ToMap uses the same field names as the struct's JSON encoding")
		})
	}
}
