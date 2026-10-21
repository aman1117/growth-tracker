package constants_test

import (
	"strings"
	"testing"

	"github.com/aman1117/backend/internal/constants"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

var allBadgeKeys = []string{
	"first_step", "spark_starter", "flame_keeper", "iron_will", "diamond_mind", "titan", "legendary",
}

func TestBadges_AreOrderedByThresholdWithUniqueKeys(t *testing.T) {
	badges := constants.GetAllBadges()
	require.Len(t, badges, len(allBadgeKeys))

	for i, badge := range badges {
		assert.Equal(t, allBadgeKeys[i], badge.Key)
		assert.NotEmpty(t, badge.Name, badge.Key)
		assert.NotEmpty(t, badge.Icon, badge.Key)
		assert.Regexp(t, `^#[0-9a-f]{6}$`, badge.Color, badge.Key)
		assert.Positive(t, badge.Threshold, badge.Key)
		if i > 0 {
			assert.Greater(t, badge.Threshold, badges[i-1].Threshold, "badges must be sorted by threshold")
		}
	}

	require.Len(t, constants.BadgeMap, len(badges), "every badge key must be unique")
	for _, badge := range badges {
		assert.Equal(t, badge, constants.BadgeMap[badge.Key])
	}
}

func TestGetEligibleBadgeKeys(t *testing.T) {
	tests := []struct {
		name          string
		longestStreak int
		want          []string
	}{
		{name: "negative streak earns nothing", longestStreak: -1, want: nil},
		{name: "no streak earns nothing", longestStreak: 0, want: nil},
		{name: "first day", longestStreak: 1, want: allBadgeKeys[:1]},
		{name: "one day short of the second badge", longestStreak: 6, want: allBadgeKeys[:1]},
		{name: "exactly on a threshold", longestStreak: 7, want: allBadgeKeys[:2]},
		{name: "between thresholds", longestStreak: 29, want: allBadgeKeys[:3]},
		{name: "one day short of the last badge", longestStreak: 359, want: allBadgeKeys[:6]},
		{name: "last threshold", longestStreak: 360, want: allBadgeKeys},
		{name: "beyond every threshold", longestStreak: 10_000, want: allBadgeKeys},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, constants.GetEligibleBadgeKeys(tt.longestStreak))
		})
	}
}

func TestGetNextBadge(t *testing.T) {
	tests := []struct {
		name          string
		longestStreak int
		wantKey       string // empty when every badge is earned
	}{
		{name: "no streak", longestStreak: 0, wantKey: "first_step"},
		{name: "first badge earned", longestStreak: 1, wantKey: "spark_starter"},
		{name: "just below a threshold", longestStreak: 89, wantKey: "diamond_mind"},
		{name: "exactly on a threshold moves to the next badge", longestStreak: 90, wantKey: "titan"},
		{name: "only the last badge left", longestStreak: 359, wantKey: "legendary"},
		{name: "all badges earned", longestStreak: 360, wantKey: ""},
		{name: "far beyond the last badge", longestStreak: 5000, wantKey: ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			next := constants.GetNextBadge(tt.longestStreak)
			if tt.wantKey == "" {
				assert.Nil(t, next)
				return
			}
			require.NotNil(t, next)
			assert.Equal(t, constants.BadgeMap[tt.wantKey], *next)
		})
	}
}

func TestGetNextBadge_ReturnsACopy(t *testing.T) {
	next := constants.GetNextBadge(0)
	require.NotNil(t, next)
	next.Threshold = 999

	assert.Equal(t, 1, constants.GetAllBadges()[0].Threshold)
}

func TestGetBadgeByKey(t *testing.T) {
	for _, key := range allBadgeKeys {
		t.Run(key, func(t *testing.T) {
			badge := constants.GetBadgeByKey(key)
			require.NotNil(t, badge)
			assert.Equal(t, key, badge.Key)
			assert.Equal(t, constants.BadgeMap[key], *badge)
		})
	}

	for _, key := range []string{"", "unknown", "FIRST_STEP", " first_step"} {
		t.Run("unknown key "+key, func(t *testing.T) {
			assert.Nil(t, constants.GetBadgeByKey(key))
		})
	}

	t.Run("returns a copy", func(t *testing.T) {
		badge := constants.GetBadgeByKey("titan")
		require.NotNil(t, badge)
		badge.Name = "changed"

		assert.Equal(t, "Titan", constants.GetBadgeByKey("titan").Name)
	})
}

func TestImageTypes_EveryAllowedExtensionHasAContentType(t *testing.T) {
	require.Equal(t, len(constants.AllowedImageExtensions), len(constants.ImageContentTypes))
	for ext, allowed := range constants.AllowedImageExtensions {
		assert.True(t, allowed, ext)
		assert.True(t, strings.HasPrefix(ext, "."), "extension %q must include the dot", ext)
		assert.Equal(t, strings.ToLower(ext), ext, "extensions are matched after lower-casing")
		assert.True(t, strings.HasPrefix(constants.ImageContentTypes[ext], "image/"), ext)
	}
}

// TestInvariants guards relationships between constants that other code relies on.
func TestInvariants(t *testing.T) {
	// middleware.RequestLogger slices a UUID string (36 characters) to this length.
	assert.Positive(t, constants.TraceIDLength)
	assert.LessOrEqual(t, constants.TraceIDLength, 36)

	// middleware.Auth strips this prefix before parsing the token.
	assert.Equal(t, "Bearer ", constants.BearerPrefix)

	assert.Less(t, constants.UsernameMinLength, constants.UsernameMaxLength)
	assert.Positive(t, constants.PasswordMinLength)
	assert.GreaterOrEqual(t, constants.CommentBodyMinLength, 1)
	assert.Less(t, constants.CommentBodyMinLength, constants.CommentBodyMaxLength)
	assert.Less(t, constants.CommentPreviewLength, constants.CommentBodyMaxLength)

	assert.LessOrEqual(t, constants.CommentListDefaultLimit, constants.CommentListMaxLimit)
	assert.LessOrEqual(t, constants.CommentReplyDefaultLimit, constants.CommentReplyMaxLimit)
	assert.LessOrEqual(t, constants.FollowListDefaultLimit, constants.FollowListMaxLimit)

	// WebSocket connection tracking and read deadlines must outlive the heartbeat.
	assert.Greater(t, constants.NotifWSConnTTL, constants.WSPingInterval)
	assert.Greater(t, constants.WSReadTimeout, constants.WSPingInterval)
	assert.Less(t, constants.NotifReadRetentionDays, constants.NotifUnreadRetentionDays)

	for name, max := range map[string]int{
		"auth":         constants.RateLimitAuthMaxRequests,
		"password":     constants.RateLimitPasswordMaxRequests,
		"api":          constants.RateLimitAPIMaxRequests,
		"upload":       constants.RateLimitUploadMaxRequests,
		"follow":       constants.RateLimitFollowMaxRequests,
		"autocomplete": constants.RateLimitAutocompleteMaxRequests,
		"comment":      constants.RateLimitCommentMaxRequests,
		"comment like": constants.RateLimitCommentLikeMaxRequests,
	} {
		assert.Positive(t, max, name)
	}
}
