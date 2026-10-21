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

func weekBody(username, weekStart string) map[string]string {
	return map[string]string{"username": username, "week_start": weekStart}
}

func TestAnalyticsHandler_GetWeekAnalytics(t *testing.T) {
	env := newEnv(t)
	owner := env.user(t)
	viewer := env.user(t)
	hidden := env.user(t, private)
	monday := testutil.Day(2026, 3, 9)
	testutil.CreateActivity(t, env.db, owner.ID, models.ActivityStudy, 4, monday)
	testutil.CreateActivity(t, env.db, owner.ID, models.ActivitySleep, 8, monday)
	testutil.CreateActivity(t, env.db, owner.ID, models.ActivityStudy, 2, monday.AddDate(0, 0, 2))
	testutil.CreateActivity(t, env.db, owner.ID, models.ActivityWorkout, 7, monday.AddDate(0, 0, -3))
	testutil.CreateStreak(t, env.db, owner.ID, 1, 1, monday.AddDate(0, 0, 1))
	testutil.CreateStreak(t, env.db, owner.ID, 2, 2, monday.AddDate(0, 0, 2))

	tests := []struct {
		name    string
		user    *models.User
		body    any
		status  int
		code    string
		message string
	}{
		{"malformed json", viewer, `{"username":`, http.StatusBadRequest, constants.ErrCodeInvalidRequest, "Invalid request body"},
		{"bad week start", viewer, weekBody(owner.Username, "2026-W11"), http.StatusBadRequest, constants.ErrCodeInvalidDate, "Invalid week_start format, use YYYY-MM-DD"},
		{"unknown user", viewer, weekBody("nobody", "2026-03-09"), http.StatusBadRequest, constants.ErrCodeUserNotFound, "Failed to find user"},
		{"private account", viewer, weekBody(hidden.Username, "2026-03-09"), http.StatusForbidden, constants.ErrCodeAccountPrivate, "This account is private"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			assertErrorMessage(t, env.do(t, tc.user, http.MethodPost, "/api/get-week-analytics", tc.body), tc.status, tc.code, tc.message)
		})
	}

	t.Run("weekly summary", func(t *testing.T) {
		got := decodeAs[dto.WeekAnalyticsResponse](t, env.do(t, viewer, http.MethodPost, "/api/get-week-analytics", weekBody(owner.Username, "2026-03-09")), http.StatusOK)

		assert.True(t, got.Success)
		assert.False(t, got.IsCurrentWeek)
		assert.EqualValues(t, 14, got.TotalHoursThisWeek)
		assert.EqualValues(t, 7, got.TotalHoursPrevWeek)
		assert.InDelta(t, 100, got.PercentageChange, 0.01)
		assert.Equal(t, []dto.ActivitySummary{
			{Name: models.ActivitySleep, TotalHours: 8},
			{Name: models.ActivityStudy, TotalHours: 6},
		}, got.ActivitySummary)
		require.Len(t, got.DailyBreakdown, 7)
		assert.Equal(t, dto.DayAnalytics{
			Date: "2026-03-09", DayName: "Mon", TotalHours: 12,
			Activities: []dto.DayActivityBreakdown{{Name: models.ActivitySleep, Hours: 8}, {Name: models.ActivityStudy, Hours: 4}},
		}, got.DailyBreakdown[0])
		assert.Equal(t, dto.DayAnalytics{
			Date: "2026-03-15", DayName: "Sun", Activities: []dto.DayActivityBreakdown{},
		}, got.DailyBreakdown[6])
		assert.Equal(t, dto.StreakInfo{Current: 2, Longest: 2, LongestStart: "2026-03-10", LongestEnd: "2026-03-11"}, got.Streak)
	})

	t.Run("followers see a private user's analytics", func(t *testing.T) {
		follow(t, env.db, viewer, hidden)
		got := decodeAs[dto.WeekAnalyticsResponse](t, env.do(t, viewer, http.MethodPost, "/api/get-week-analytics", weekBody(hidden.Username, "2026-03-09")), http.StatusOK)
		assert.Zero(t, got.TotalHoursThisWeek)
		assert.Len(t, got.DailyBreakdown, 7)
	})
}

func TestAnalyticsHandler_GetWeekAnalytics_DatabaseFailure(t *testing.T) {
	env := newEnv(t)
	owner := env.user(t)

	t.Run("user lookup", func(t *testing.T) {
		res := call(t, brokenStack(t).handlers(), owner, http.MethodPost, "/api/get-week-analytics", weekBody(owner.Username, "2026-03-09"))
		assertError(t, res, http.StatusBadRequest, constants.ErrCodeUserNotFound)
	})

	t.Run("analytics query", func(t *testing.T) {
		h := &handlerSet{analytics: NewAnalyticsHandler(brokenStack(t).analyticsSvc, env.authSvc, env.profileSvc)}
		res := call(t, h, owner, http.MethodPost, "/api/get-week-analytics", weekBody(owner.Username, "2026-03-09"))
		assertErrorMessage(t, res, http.StatusInternalServerError, constants.ErrCodeFetchFailed, "Failed to fetch analytics")
	})
}
