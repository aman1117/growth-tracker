package handlers

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/dto"
	"github.com/aman1117/backend/internal/testutil"
	"github.com/aman1117/backend/pkg/models"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type activitiesResponse struct {
	Success bool              `json:"success"`
	Data    []dto.ActivityDTO `json:"data"`
}

type dailyTotalsResponse struct {
	Success bool               `json:"success"`
	Data    map[string]float32 `json:"data"`
}

func activityBody(username string, activity models.ActivityName, hours float32, date string) map[string]any {
	return map[string]any{"username": username, "activity": activity, "hours": hours, "date": date}
}

func rangeBody(username, start, end string) map[string]string {
	return map[string]string{"username": username, "start_date": start, "end_date": end}
}

func TestActivityHandler_CreateActivity_Validation(t *testing.T) {
	env := newEnv(t)
	user := env.user(t)
	const day = "2026-03-09"

	tests := []struct {
		name    string
		user    *models.User
		body    any
		status  int
		code    string
		message string
	}{
		{"malformed json", user, `{"username":`, http.StatusBadRequest, constants.ErrCodeInvalidRequest, "Invalid request body"},
		{"missing username", user, activityBody("", models.ActivityStudy, 1, day), http.StatusBadRequest, constants.ErrCodeMissingFields, "Invalid request body"},
		{"missing activity", user, activityBody(user.Username, "", 1, day), http.StatusBadRequest, constants.ErrCodeMissingFields, "Invalid request body"},
		{"negative hours", user, activityBody(user.Username, models.ActivityStudy, -1, day), http.StatusBadRequest, constants.ErrCodeMissingFields, "Invalid request body"},
		{"someone else's day", user, activityBody("someone_else", models.ActivityStudy, 1, day), http.StatusBadRequest, constants.ErrCodeNotAuthorized, "You are not authorized to create activity for this username"},
		{"anonymous caller", nil, activityBody(user.Username, models.ActivityStudy, 1, day), http.StatusBadRequest, constants.ErrCodeNotAuthorized, "You are not authorized to create activity for this username"},
		{"unknown activity", user, activityBody(user.Username, "napping", 1, day), http.StatusBadRequest, constants.ErrCodeInvalidActivity, "Invalid activity name"},
		{"custom tile without a uuid", user, activityBody(user.Username, "custom:not-a-uuid", 1, day), http.StatusBadRequest, constants.ErrCodeInvalidActivity, "Invalid activity name"},
		{"bad date", user, activityBody(user.Username, models.ActivityStudy, 1, "09/03/2026"), http.StatusBadRequest, constants.ErrCodeInvalidDate, "Invalid date format, use YYYY-MM-DD"},
		{"missing date", user, activityBody(user.Username, models.ActivityStudy, 1, ""), http.StatusBadRequest, constants.ErrCodeInvalidDate, "Invalid date format, use YYYY-MM-DD"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			res := env.do(t, tc.user, http.MethodPost, "/api/create-activity", tc.body)
			assertErrorMessage(t, res, tc.status, tc.code, tc.message)
		})
	}
	assert.Zero(t, count(t, env.db, &models.Activity{}, ""), "nothing was stored")
}

func TestActivityHandler_CreateActivity(t *testing.T) {
	env := newEnv(t)
	user := env.user(t)
	const day = "2026-03-09"
	stored := func(t *testing.T, name models.ActivityName) models.Activity {
		t.Helper()
		var a models.Activity
		require.NoError(t, env.db.Where("user_id = ? AND name = ?", user.ID, name).First(&a).Error)
		return a
	}

	body := activityBody(user.Username, models.ActivityStudy, 2.5, day)
	body["note"] = "chapter 3"
	assertSuccessMessage(t, env.do(t, user, http.MethodPost, "/api/create-activity", body), http.StatusOK, constants.MsgActivityUpdated)

	got := stored(t, models.ActivityStudy)
	assert.EqualValues(t, 2.5, got.DurationHours)
	assert.Equal(t, day, got.ActivityDate.Format(constants.DateFormat))
	require.NotNil(t, got.Note)
	assert.Equal(t, "chapter 3", *got.Note)
	assert.Zero(t, count(t, env.db, &models.Streak{}, ""), "past days do not touch the streak")

	t.Run("logging the same activity again replaces its hours", func(t *testing.T) {
		res := env.do(t, user, http.MethodPost, "/api/create-activity", activityBody(user.Username, models.ActivityStudy, 4, day))
		assertSuccessMessage(t, res, http.StatusOK, constants.MsgActivityUpdated)

		got := stored(t, models.ActivityStudy)
		assert.EqualValues(t, 4, got.DurationHours)
		assert.Nil(t, got.Note, "the note is replaced as well")
		assert.EqualValues(t, 1, count(t, env.db, &models.Activity{}, "user_id = ?", user.ID))
	})

	t.Run("a day holds at most 24 hours", func(t *testing.T) {
		res := env.do(t, user, http.MethodPost, "/api/create-activity", activityBody(user.Username, models.ActivitySleep, 20, day))
		assertSuccessMessage(t, res, http.StatusOK, constants.MsgActivityUpdated)

		res = env.do(t, user, http.MethodPost, "/api/create-activity", activityBody(user.Username, models.ActivityWorkout, 0.5, day))
		assertErrorMessage(t, res, http.StatusBadRequest, constants.ErrCodeHoursExceeded, "Total hours cannot be more than 24")
		assert.Zero(t, count(t, env.db, &models.Activity{}, "name = ?", models.ActivityWorkout))
	})

	t.Run("custom tile activity", func(t *testing.T) {
		name := models.ActivityName(models.CustomTilePrefix + uuid.NewString())
		res := env.do(t, user, http.MethodPost, "/api/create-activity", activityBody(user.Username, name, 1, "2026-03-10"))
		assertSuccessMessage(t, res, http.StatusOK, constants.MsgActivityUpdated)
		assert.EqualValues(t, 1, stored(t, name).DurationHours)
	})
}

func TestActivityHandler_CreateActivity_ValidatesTheNoteLength(t *testing.T) {
	env := newEnv(t)
	user := env.user(t)
	withNote := func(note string) map[string]any {
		body := activityBody(user.Username, models.ActivityStudy, 1, "2026-03-09")
		body["note"] = note
		return body
	}

	t.Run("more than 500 characters is rejected before reaching the database", func(t *testing.T) {
		res := env.do(t, user, http.MethodPost, "/api/create-activity", withNote(strings.Repeat("a", 501)))
		assertErrorMessage(t, res, http.StatusBadRequest, constants.ErrCodeInvalidRequest, "Note must be 500 characters or less")
		assert.Zero(t, count(t, env.db, &models.Activity{}, ""))
	})

	t.Run("500 multi-byte characters are accepted", func(t *testing.T) {
		note := strings.Repeat("é", 500)
		res := env.do(t, user, http.MethodPost, "/api/create-activity", withNote(note))
		assertSuccessMessage(t, res, http.StatusOK, constants.MsgActivityUpdated)
		var stored models.Activity
		require.NoError(t, env.db.Where("user_id = ?", user.ID).First(&stored).Error)
		require.NotNil(t, stored.Note)
		assert.Equal(t, note, *stored.Note)
	})
}

func TestActivityHandler_CreateActivity_TodayStartsAStreak(t *testing.T) {
	env := newEnv(t)
	user := env.user(t)
	today := time.Now().UTC().Format(constants.DateFormat)

	res := env.do(t, user, http.MethodPost, "/api/create-activity", activityBody(user.Username, models.ActivityStudy, 1, today))

	assertSuccessMessage(t, res, http.StatusOK, constants.MsgActivityUpdated)
	var streak models.Streak
	require.NoError(t, env.db.Where("user_id = ?", user.ID).First(&streak).Error)
	assert.Equal(t, 1, streak.Current)
	assert.Equal(t, 1, streak.Longest)
	assert.Equal(t, today, streak.ActivityDate.Format(constants.DateFormat))
}

func TestActivityHandler_CreateActivity_NotifiesFollowersWhenTheDayIsComplete(t *testing.T) {
	env := newEnv(t, withAsync())
	logs := observeLogs(t)
	user, fan := env.user(t), env.user(t)
	follow(t, env.db, fan, user)

	res := env.do(t, user, http.MethodPost, "/api/create-activity", activityBody(user.Username, models.ActivitySleep, 24, "2026-03-09"))

	assertSuccessMessage(t, res, http.StatusOK, constants.MsgActivityUpdated)
	n := waitNotification(t, env.db, fan.ID, models.NotifTypeStreakMilestone)
	assert.Equal(t, user.Username+" logged all 24 hours on 9 Mar, 2026", n.Body)
	waitLog(t, logs, "Day completed notifications sent")
}

func TestActivityHandler_CreateActivity_DatabaseFailure(t *testing.T) {
	user := &models.User{ID: 1, Username: "someone"}
	res := call(t, brokenStack(t).handlers(), user, http.MethodPost, "/api/create-activity", activityBody(user.Username, models.ActivityStudy, 1, "2026-03-09"))
	assertErrorMessage(t, res, http.StatusBadRequest, constants.ErrCodeUpdateFailed, "Failed to update activity")
}

// rangeValidationTests are shared by the activity list and daily totals endpoints.
func rangeValidationTests(username string) []struct {
	name    string
	body    any
	code    string
	message string
} {
	return []struct {
		name    string
		body    any
		code    string
		message string
	}{
		{"malformed json", `{"username":`, constants.ErrCodeInvalidRequest, "Invalid request body"},
		{"bad start date", rangeBody(username, "2026-3-1", "2026-03-07"), constants.ErrCodeInvalidDate, "Invalid start_date format, use YYYY-MM-DD"},
		{"bad end date", rangeBody(username, "2026-03-01", "tomorrow"), constants.ErrCodeInvalidDate, "Invalid end_date format, use YYYY-MM-DD"},
		{"start after end", rangeBody(username, "2026-03-08", "2026-03-07"), constants.ErrCodeInvalidDateRange, "Start date must be before end date"},
		{"unknown user", rangeBody("nobody", "2026-03-01", "2026-03-07"), constants.ErrCodeUserNotFound, "Failed to find user"},
	}
}

func TestActivityHandler_GetActivities(t *testing.T) {
	env := newEnv(t)
	owner := env.user(t)
	viewer := env.user(t)
	hidden := env.user(t, private)
	note := "deep work"
	study := testutil.CreateActivity(t, env.db, owner.ID, models.ActivityStudy, 3, testutil.Day(2026, 3, 2))
	require.NoError(t, env.db.Model(study).Update("note", note).Error)
	sleep := testutil.CreateActivity(t, env.db, owner.ID, models.ActivitySleep, 7.5, testutil.Day(2026, 3, 7))
	testutil.CreateActivity(t, env.db, owner.ID, models.ActivityReels, 1, testutil.Day(2026, 3, 8))
	testutil.CreateActivity(t, env.db, hidden.ID, models.ActivityStudy, 1, testutil.Day(2026, 3, 2))

	for _, tc := range rangeValidationTests(owner.Username) {
		t.Run(tc.name, func(t *testing.T) {
			res := env.do(t, viewer, http.MethodPost, "/api/get-activities", tc.body)
			assertErrorMessage(t, res, http.StatusBadRequest, tc.code, tc.message)
		})
	}

	t.Run("private account", func(t *testing.T) {
		res := env.do(t, viewer, http.MethodPost, "/api/get-activities", rangeBody(hidden.Username, "2026-03-01", "2026-03-07"))
		assertErrorMessage(t, res, http.StatusForbidden, constants.ErrCodeAccountPrivate, "This account is private")
	})

	t.Run("own activities include notes", func(t *testing.T) {
		got := decodeAs[activitiesResponse](t, env.do(t, owner, http.MethodPost, "/api/get-activities", rangeBody(owner.Username, "2026-03-01", "2026-03-07")), http.StatusOK)

		assert.True(t, got.Success)
		assert.ElementsMatch(t, []dto.ActivityDTO{
			{ID: study.ID, Name: models.ActivityStudy, DurationHours: 3, Date: "2026-03-02", Note: &note},
			{ID: sleep.ID, Name: models.ActivitySleep, DurationHours: 7.5, Date: "2026-03-07"},
		}, got.Data)
	})

	t.Run("other viewers never see notes", func(t *testing.T) {
		got := decodeAs[activitiesResponse](t, env.do(t, viewer, http.MethodPost, "/api/get-activities", rangeBody(owner.Username, "2026-03-02", "2026-03-02")), http.StatusOK)
		require.Len(t, got.Data, 1)
		assert.Nil(t, got.Data[0].Note)
	})

	t.Run("empty range", func(t *testing.T) {
		got := decodeAs[activitiesResponse](t, env.do(t, viewer, http.MethodPost, "/api/get-activities", rangeBody(owner.Username, "2026-01-01", "2026-01-31")), http.StatusOK)
		assert.NotNil(t, got.Data, "an empty list, not null")
		assert.Empty(t, got.Data)
	})

	t.Run("followers see private activities", func(t *testing.T) {
		follow(t, env.db, viewer, hidden)
		got := decodeAs[activitiesResponse](t, env.do(t, viewer, http.MethodPost, "/api/get-activities", rangeBody(hidden.Username, "2026-03-01", "2026-03-07")), http.StatusOK)
		assert.Len(t, got.Data, 1)
	})
}

func TestActivityHandler_GetActivities_DatabaseFailure(t *testing.T) {
	env := newEnv(t)
	owner := env.user(t)
	h := &handlerSet{activity: NewActivityHandler(brokenStack(t).activitySvc, env.authSvc, env.profileSvc)}

	res := call(t, h, owner, http.MethodPost, "/api/get-activities", rangeBody(owner.Username, "2026-03-01", "2026-03-07"))

	assertErrorMessage(t, res, http.StatusBadRequest, constants.ErrCodeFetchFailed, "Failed to find activities")
}

func TestActivityHandler_GetDailyTotals(t *testing.T) {
	env := newEnv(t)
	owner := env.user(t)
	viewer := env.user(t)
	hidden := env.user(t, private)
	testutil.CreateActivity(t, env.db, owner.ID, models.ActivityStudy, 3, testutil.Day(2026, 3, 2))
	testutil.CreateActivity(t, env.db, owner.ID, models.ActivitySleep, 7.5, testutil.Day(2026, 3, 2))
	testutil.CreateActivity(t, env.db, owner.ID, models.ActivityReels, 1, testutil.Day(2026, 3, 5))
	testutil.CreateActivity(t, env.db, owner.ID, models.ActivityReels, 1, testutil.Day(2026, 6, 5))

	for _, tc := range rangeValidationTests(owner.Username) {
		t.Run(tc.name, func(t *testing.T) {
			res := env.do(t, viewer, http.MethodPost, "/api/get-daily-totals", tc.body)
			assertErrorMessage(t, res, http.StatusBadRequest, tc.code, tc.message)
		})
	}

	t.Run("range longer than 93 days", func(t *testing.T) {
		res := env.do(t, viewer, http.MethodPost, "/api/get-daily-totals", rangeBody(owner.Username, "2026-01-01", "2026-04-05"))
		assertErrorMessage(t, res, http.StatusBadRequest, constants.ErrCodeInvalidDateRange, "Date range cannot exceed 93 days")
	})

	t.Run("private account", func(t *testing.T) {
		res := env.do(t, nil, http.MethodPost, "/api/get-daily-totals", rangeBody(hidden.Username, "2026-03-01", "2026-03-07"))
		assertErrorMessage(t, res, http.StatusForbidden, constants.ErrCodeAccountPrivate, "This account is private")
	})

	t.Run("sums hours per day", func(t *testing.T) {
		got := decodeAs[dailyTotalsResponse](t, env.do(t, viewer, http.MethodPost, "/api/get-daily-totals", rangeBody(owner.Username, "2026-03-01", "2026-03-31")), http.StatusOK)
		assert.True(t, got.Success)
		assert.Equal(t, map[string]float32{"2026-03-02": 10.5, "2026-03-05": 1}, got.Data)
	})

	t.Run("exactly 93 days", func(t *testing.T) {
		got := decodeAs[dailyTotalsResponse](t, env.do(t, viewer, http.MethodPost, "/api/get-daily-totals", rangeBody(owner.Username, "2026-03-05", "2026-06-06")), http.StatusOK)
		assert.Equal(t, map[string]float32{"2026-03-05": 1, "2026-06-05": 1}, got.Data)
	})

	t.Run("no data", func(t *testing.T) {
		got := decodeAs[dailyTotalsResponse](t, env.do(t, viewer, http.MethodPost, "/api/get-daily-totals", rangeBody(owner.Username, "2026-01-01", "2026-01-31")), http.StatusOK)
		assert.NotNil(t, got.Data, "an empty object, not null")
		assert.Empty(t, got.Data)
	})
}

func TestActivityHandler_GetDailyTotals_DatabaseFailure(t *testing.T) {
	env := newEnv(t)
	owner := env.user(t)
	h := &handlerSet{activity: NewActivityHandler(brokenStack(t).activitySvc, env.authSvc, env.profileSvc)}

	res := call(t, h, owner, http.MethodPost, "/api/get-daily-totals", rangeBody(owner.Username, "2026-03-01", "2026-03-07"))

	assertErrorMessage(t, res, http.StatusBadRequest, constants.ErrCodeFetchFailed, "Failed to fetch daily totals")
}
