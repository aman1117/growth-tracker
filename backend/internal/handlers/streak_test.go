package handlers

import (
	"net/http"
	"testing"

	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/dto"
	"github.com/aman1117/backend/internal/testutil"
	"github.com/aman1117/backend/pkg/models"
	"github.com/stretchr/testify/assert"
)

func streakBody(username, date string) map[string]string {
	return map[string]string{"username": username, "date": date}
}

func TestStreakHandler_GetStreak(t *testing.T) {
	env := newEnv(t)
	owner := env.user(t)
	viewer := env.user(t)
	hidden := env.user(t, private)
	fan := env.user(t)
	follow(t, env.db, fan, hidden)
	streak := testutil.CreateStreak(t, env.db, owner.ID, 3, 8, testutil.Day(2026, 3, 9))
	testutil.CreateStreak(t, env.db, hidden.ID, 1, 1, testutil.Day(2026, 3, 9))

	tests := []struct {
		name    string
		user    *models.User
		body    any
		status  int
		code    string
		message string
	}{
		{"malformed json", viewer, `{"username":`, http.StatusBadRequest, constants.ErrCodeInvalidRequest, "Invalid request body"},
		{"bad date", viewer, streakBody(owner.Username, "March 9"), http.StatusBadRequest, constants.ErrCodeInvalidDate, "Invalid date format, use YYYY-MM-DD"},
		{"unknown user", viewer, streakBody("nobody", "2026-03-09"), http.StatusBadRequest, constants.ErrCodeUserNotFound, "Failed to find user"},
		{"private account", viewer, streakBody(hidden.Username, "2026-03-09"), http.StatusForbidden, constants.ErrCodeAccountPrivate, "This account is private"},
		{"private account, anonymous caller", nil, streakBody(hidden.Username, "2026-03-09"), http.StatusForbidden, constants.ErrCodeAccountPrivate, "This account is private"},
		{"no streak on that day", viewer, streakBody(owner.Username, "2026-03-10"), http.StatusBadRequest, constants.ErrCodeStreakNotFound, "Failed to find streak"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			assertErrorMessage(t, env.do(t, tc.user, http.MethodPost, "/api/get-streak", tc.body), tc.status, tc.code, tc.message)
		})
	}

	t.Run("another user's streak awards nothing", func(t *testing.T) {
		got := decodeAs[dto.StreakResponse](t, env.do(t, viewer, http.MethodPost, "/api/get-streak", streakBody(owner.Username, "2026-03-09")), http.StatusOK)

		assert.Equal(t, dto.StreakResponse{
			Success: true,
			Data:    dto.StreakDTO{ID: streak.ID, Current: 3, Longest: 8, Date: "2026-03-09"},
		}, got)
		assert.Zero(t, count(t, env.db, &models.UserBadge{}, ""))
	})

	t.Run("followers see a private user's streak", func(t *testing.T) {
		got := decodeAs[dto.StreakResponse](t, env.do(t, fan, http.MethodPost, "/api/get-streak", streakBody(hidden.Username, "2026-03-09")), http.StatusOK)
		assert.Equal(t, 1, got.Data.Current)
	})

	t.Run("own streak awards newly earned badges once", func(t *testing.T) {
		got := decodeAs[dto.StreakResponse](t, env.do(t, owner, http.MethodPost, "/api/get-streak", streakBody(owner.Username, "2026-03-09")), http.StatusOK)

		keys := make([]string, 0, len(got.Data.NewBadges))
		for _, b := range got.Data.NewBadges {
			keys = append(keys, b.Key)
			assert.NotEmpty(t, b.EarnedAt)
		}
		assert.Equal(t, []string{"first_step", "spark_starter"}, keys, "thresholds 1 and 7 are below the longest streak of 8")
		assert.EqualValues(t, 2, count(t, env.db, &models.UserBadge{}, "user_id = ?", owner.ID))

		res := env.do(t, owner, http.MethodPost, "/api/get-streak", streakBody(owner.Username, "2026-03-09"))
		again := decodeAs[dto.StreakResponse](t, res, http.StatusOK)
		assert.Empty(t, again.Data.NewBadges)
		assert.NotContains(t, string(res.Body), "new_badges", "omitted when nothing new was earned")
	})
}

func TestStreakHandler_GetStreak_BadgeProblemsDoNotFailTheRequest(t *testing.T) {
	env := newEnv(t)
	owner := env.user(t)
	testutil.CreateStreak(t, env.db, owner.ID, 1, 1, testutil.Day(2026, 3, 9))

	for name, h := range map[string]*StreakHandler{
		"badge service unavailable": NewStreakHandler(env.streakSvc, env.authSvc, env.profileSvc, nil),
		"badge database failure":    NewStreakHandler(env.streakSvc, env.authSvc, env.profileSvc, brokenStack(t).badgeSvc),
	} {
		t.Run(name, func(t *testing.T) {
			got := decodeAs[dto.StreakResponse](t, call(t, &handlerSet{streak: h}, owner, http.MethodPost, "/api/get-streak", streakBody(owner.Username, "2026-03-09")), http.StatusOK)
			assert.Equal(t, 1, got.Data.Current)
			assert.Empty(t, got.Data.NewBadges)
		})
	}
	assert.Zero(t, count(t, env.db, &models.UserBadge{}, ""))
}

func TestStreakHandler_GetStreak_DatabaseFailure(t *testing.T) {
	env := newEnv(t)
	owner := env.user(t)

	t.Run("user lookup", func(t *testing.T) {
		res := call(t, brokenStack(t).handlers(), owner, http.MethodPost, "/api/get-streak", streakBody(owner.Username, "2026-03-09"))
		assertError(t, res, http.StatusBadRequest, constants.ErrCodeUserNotFound)
	})

	t.Run("streak lookup", func(t *testing.T) {
		h := &handlerSet{streak: NewStreakHandler(brokenStack(t).streakSvc, env.authSvc, env.profileSvc, env.badgeSvc)}
		res := call(t, h, owner, http.MethodPost, "/api/get-streak", streakBody(owner.Username, "2026-03-09"))
		assertError(t, res, http.StatusBadRequest, constants.ErrCodeStreakNotFound)
	})
}
