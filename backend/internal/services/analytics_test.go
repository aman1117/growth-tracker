package services

import (
	"testing"
	"time"

	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/dto"
	"github.com/aman1117/backend/internal/repository"
	"github.com/aman1117/backend/internal/testutil"
	"github.com/aman1117/backend/pkg/models"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func newAnalyticsService(activities, streaks *gorm.DB) *AnalyticsService {
	return NewAnalyticsService(repository.NewActivityRepository(activities), repository.NewStreakRepository(streaks),
		repository.NewUserRepository(activities))
}

// mondayThisWeek returns the start of the current week (Monday, 00:00 UTC), the week the
// service compares past weeks with.
func mondayThisWeek() time.Time {
	now := time.Now().UTC()
	daysSinceMonday := (int(now.Weekday()) + 6) % 7
	return testutil.Day(now.Year(), now.Month(), now.Day()).AddDate(0, 0, -daysSinceMonday)
}

func TestAnalyticsService_PastWeek(t *testing.T) {
	db := testDB(t)
	user := newUser(t, db)
	current := mondayThisWeek()
	week := current.AddDate(0, 0, -14)

	// The selected week: Monday, Wednesday and Sunday.
	testutil.CreateActivity(t, db, user.ID, models.ActivityWorkout, 1, week)
	testutil.CreateActivity(t, db, user.ID, models.ActivityStudy, 2, week)
	testutil.CreateActivity(t, db, user.ID, models.ActivitySleep, 8, week.AddDate(0, 0, 2))
	testutil.CreateActivity(t, db, user.ID, models.ActivityReels, 0, week.AddDate(0, 0, 2))
	testutil.CreateActivity(t, db, user.ID, models.ActivityStudy, 1, week.AddDate(0, 0, 6))
	// The week before, the current week, a day outside all three weeks and another user.
	testutil.CreateActivity(t, db, user.ID, models.ActivityStudy, 6, week.AddDate(0, 0, -6))
	testutil.CreateActivity(t, db, user.ID, models.ActivityStudy, 3, current)
	testutil.CreateActivity(t, db, user.ID, models.ActivityStudy, 5, week.AddDate(0, 0, -8))
	testutil.CreateActivity(t, db, newUser(t, db).ID, models.ActivityStudy, 4, week)

	got, err := newAnalyticsService(db, db).GetWeekAnalytics(user.ID, week)
	require.NoError(t, err)

	assert.True(t, got.Success)
	assert.False(t, got.IsCurrentWeek)
	assert.Equal(t, float32(12), got.TotalHoursThisWeek)
	assert.Equal(t, float32(6), got.TotalHoursPrevWeek)
	assert.Equal(t, float32(3), got.TotalHoursCurrentWeek)
	assert.Equal(t, float32(100), got.PercentageChange)
	assert.Equal(t, float32(300), got.PercentageVsCurrent)

	require.Len(t, got.DailyBreakdown, 7)
	for i, name := range []string{"Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"} {
		assert.Equal(t, week.AddDate(0, 0, i).Format(constants.DateFormat), got.DailyBreakdown[i].Date)
		assert.Equal(t, name, got.DailyBreakdown[i].DayName)
	}
	monday, tuesday, wednesday, sunday := got.DailyBreakdown[0], got.DailyBreakdown[1], got.DailyBreakdown[2], got.DailyBreakdown[6]
	assert.Equal(t, float32(3), monday.TotalHours)
	assert.Equal(t, []dto.DayActivityBreakdown{{Name: models.ActivityStudy, Hours: 2}, {Name: models.ActivityWorkout, Hours: 1}},
		monday.Activities, "sorted by hours")
	assert.Equal(t, float32(8), wednesday.TotalHours)
	assert.Equal(t, []dto.DayActivityBreakdown{{Name: models.ActivitySleep, Hours: 8}}, wednesday.Activities,
		"zero-hour entries are left out")
	assert.Equal(t, []dto.DayActivityBreakdown{{Name: models.ActivityStudy, Hours: 1}}, sunday.Activities)
	assert.Zero(t, tuesday.TotalHours)
	assert.Equal(t, []dto.DayActivityBreakdown{}, tuesday.Activities, "empty days have an empty list, not null")

	assert.Equal(t, []dto.ActivitySummary{
		{Name: models.ActivitySleep, TotalHours: 8},
		{Name: models.ActivityStudy, TotalHours: 3},
		{Name: models.ActivityWorkout, TotalHours: 1},
	}, got.ActivitySummary)
}

func TestAnalyticsService_CurrentWeek(t *testing.T) {
	db := testDB(t)
	user := newUser(t, db)
	week := mondayThisWeek()
	testutil.CreateActivity(t, db, user.ID, models.ActivityStudy, 2.5, week)

	got, err := newAnalyticsService(db, db).GetWeekAnalytics(user.ID, week)
	require.NoError(t, err)

	assert.True(t, got.IsCurrentWeek)
	assert.Equal(t, float32(2.5), got.TotalHoursThisWeek)
	assert.Zero(t, got.TotalHoursPrevWeek)
	assert.Equal(t, float32(100), got.PercentageChange, "any activity after an empty week counts as +100%")
	assert.Zero(t, got.TotalHoursCurrentWeek, "only past weeks are compared with the current one")
	assert.Zero(t, got.PercentageVsCurrent)
}

func TestAnalyticsService_EmptyWeeks(t *testing.T) {
	db := testDB(t)
	svc := newAnalyticsService(db, db)
	user := newUser(t, db)
	week := mondayThisWeek().AddDate(0, 0, -35)

	got, err := svc.GetWeekAnalytics(user.ID, week)
	require.NoError(t, err)
	assert.Zero(t, got.TotalHoursThisWeek)
	assert.Zero(t, got.PercentageChange)
	assert.Zero(t, got.PercentageVsCurrent)
	assert.Equal(t, []dto.ActivitySummary{}, got.ActivitySummary)
	assert.Equal(t, dto.StreakInfo{}, got.Streak)
	for _, day := range got.DailyBreakdown {
		assert.Empty(t, day.Activities)
	}

	testutil.CreateActivity(t, db, user.ID, models.ActivityFamily, 4, week.AddDate(0, 0, 3))
	got, err = svc.GetWeekAnalytics(user.ID, week)
	require.NoError(t, err)
	assert.Equal(t, float32(100), got.PercentageChange)
	assert.Equal(t, float32(100), got.PercentageVsCurrent, "compared with an empty current week")
}

func TestAnalyticsService_StreakInfo(t *testing.T) {
	db := testDB(t)
	user := newUser(t, db)
	today := todayUTC()
	day := func(offset int) time.Time { return today.AddDate(0, 0, offset) }
	testutil.CreateStreak(t, db, user.ID, 1, 1, day(-10))
	testutil.CreateStreak(t, db, user.ID, 2, 2, day(-9))
	testutil.CreateStreak(t, db, user.ID, 0, 2, day(-8))
	testutil.CreateStreak(t, db, user.ID, 1, 2, day(-4))
	testutil.CreateStreak(t, db, user.ID, 2, 2, day(-3))
	testutil.CreateStreak(t, db, user.ID, 0, 2, day(-1))

	got, err := newAnalyticsService(db, db).GetWeekAnalytics(user.ID, mondayThisWeek())
	require.NoError(t, err)
	assert.Equal(t, dto.StreakInfo{
		Current:      0,
		Longest:      2,
		LongestStart: day(-4).Format(constants.DateFormat),
		LongestEnd:   day(-3).Format(constants.DateFormat),
	}, got.Streak, "the latest of equally long streaks is reported")

	got, err = newAnalyticsService(db, faultyDB(t, failingOn("query", "streaks"))).GetWeekAnalytics(user.ID, mondayThisWeek())
	require.NoError(t, err, "streak lookups are best effort")
	assert.Equal(t, dto.StreakInfo{}, got.Streak)
}

func TestAnalyticsService_ActivityQueryFailures(t *testing.T) {
	db := testDB(t)
	user := newUser(t, db)
	pastWeek := mondayThisWeek().AddDate(0, 0, -7)

	// The selected week, the week before and the current week are loaded in that order.
	for failing := 1; failing <= 3; failing++ {
		queries := 0
		activities := faultyDB(t, func(s stmtInfo) bool {
			if s.is("query", "activities") {
				queries++
				return queries == failing
			}
			return false
		})
		_, err := newAnalyticsService(activities, db).GetWeekAnalytics(user.ID, pastWeek)
		assert.ErrorIs(t, err, errInjected, "activity query %d", failing)
	}
}
