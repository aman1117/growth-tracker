package handlers

import (
	"net/http"
	"testing"

	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/dto"
	"github.com/aman1117/backend/internal/testutil"
	"github.com/aman1117/backend/pkg/models"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// earnedBadges returns the keys of the earned badges and checks that the full catalogue is
// listed in order.
func earnedBadges(t *testing.T, got dto.BadgesResponse) []string {
	t.Helper()
	assert.True(t, got.Success)
	all := constants.GetAllBadges()
	require.Len(t, got.Badges, len(all))
	var earned []string
	for i, b := range got.Badges {
		assert.Equal(t, all[i].Key, b.Key)
		if b.Earned {
			earned = append(earned, b.Key)
		}
	}
	return earned
}

func TestBadgeHandler_GetBadges(t *testing.T) {
	env := newEnv(t)
	user := env.user(t)
	require.NoError(t, env.db.Create(&models.UserBadge{UserID: user.ID, BadgeKey: "first_step", EarnedAt: testutil.Day(2026, 3, 9)}).Error)

	t.Run("lists every badge with the earned ones marked", func(t *testing.T) {
		got := decodeAs[dto.BadgesResponse](t, env.do(t, user, http.MethodGet, "/api/badges", nil), http.StatusOK)

		assert.Equal(t, []string{"first_step"}, earnedBadges(t, got))
		assert.Equal(t, dto.BadgeDTO{
			Key: "first_step", Name: "First Step", Icon: "Footprints", Color: "#22c55e",
			Threshold: 1, Earned: true, EarnedAt: "2026-03-09",
		}, got.Badges[0])
		assert.Empty(t, got.Badges[1].EarnedAt)
		assert.Nil(t, got.NextBadge)
	})

	t.Run("anonymous caller gets the unearned catalogue", func(t *testing.T) {
		got := decodeAs[dto.BadgesResponse](t, env.do(t, nil, http.MethodGet, "/api/badges", nil), http.StatusOK)
		assert.Empty(t, earnedBadges(t, got))
	})
}

func TestBadgeHandler_GetBadges_DatabaseFailure(t *testing.T) {
	res := call(t, brokenStack(t).handlers(), ghostUser, http.MethodGet, "/api/badges", nil)
	assertErrorMessage(t, res, http.StatusInternalServerError, constants.ErrCodeServerError, "Failed to get badges")
}

func TestBadgeHandler_GetBadgesByUsername(t *testing.T) {
	env := newEnv(t)
	viewer := env.user(t)
	hidden := env.user(t, private)
	require.NoError(t, env.db.Create(&models.UserBadge{UserID: hidden.ID, BadgeKey: "spark_starter", EarnedAt: testutil.Day(2026, 3, 9)}).Error)

	t.Run("malformed json", func(t *testing.T) {
		assertErrorMessage(t, env.do(t, viewer, http.MethodPost, "/api/badges/user", `{"username":`), http.StatusBadRequest, constants.ErrCodeInvalidRequest, "Invalid request body")
	})

	t.Run("unknown user", func(t *testing.T) {
		res := env.do(t, viewer, http.MethodPost, "/api/badges/user", map[string]string{"username": "nobody"})
		assertErrorMessage(t, res, http.StatusBadRequest, constants.ErrCodeUserNotFound, "Failed to find user")
	})

	t.Run("badges are public even for private accounts", func(t *testing.T) {
		for _, caller := range []*models.User{viewer, nil} {
			got := decodeAs[dto.BadgesResponse](t, env.do(t, caller, http.MethodPost, "/api/badges/user", map[string]string{"username": hidden.Username}), http.StatusOK)
			assert.Equal(t, []string{"spark_starter"}, earnedBadges(t, got))
		}
	})
}

func TestBadgeHandler_GetBadgesByUsername_DatabaseFailure(t *testing.T) {
	env := newEnv(t)
	target := env.user(t)

	t.Run("user lookup", func(t *testing.T) {
		res := call(t, brokenStack(t).handlers(), ghostUser, http.MethodPost, "/api/badges/user", map[string]string{"username": target.Username})
		assertError(t, res, http.StatusBadRequest, constants.ErrCodeUserNotFound)
	})

	t.Run("badge query", func(t *testing.T) {
		h := &handlerSet{badge: NewBadgeHandler(brokenStack(t).badgeSvc, env.authSvc)}
		res := call(t, h, ghostUser, http.MethodPost, "/api/badges/user", map[string]string{"username": target.Username})
		assertErrorMessage(t, res, http.StatusInternalServerError, constants.ErrCodeServerError, "Failed to get badges")
	})
}
