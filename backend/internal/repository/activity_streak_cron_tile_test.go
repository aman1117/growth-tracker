package repository

import (
	"testing"
	"time"

	"github.com/aman1117/backend/internal/testutil"
	"github.com/aman1117/backend/pkg/models"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const dateLayout = "2006-01-02"

// ==================== Activities ====================

func TestActivityRepository_CreateAndFindByUserAndDate(t *testing.T) {
	db := testutil.DB(t)
	repo := NewActivityRepository(db)
	user := testutil.CreateUser(t, db)
	other := testutil.CreateUser(t, db)
	note := "Read 30 pages 📚"

	study := &models.Activity{UserID: user.ID, Name: models.ActivityStudy, DurationHours: 2.5, ActivityDate: day, Note: &note}
	require.NoError(t, repo.Create(study))
	assert.NotZero(t, study.ID)
	require.NoError(t, repo.Create(&models.Activity{UserID: user.ID, Name: models.ActivitySleep, DurationHours: 8, ActivityDate: day}))
	require.NoError(t, repo.Create(&models.Activity{UserID: user.ID, Name: models.ActivitySleep, DurationHours: 7, ActivityDate: day.AddDate(0, 0, 1)}))
	require.NoError(t, repo.Create(&models.Activity{UserID: other.ID, Name: models.ActivitySleep, DurationHours: 6, ActivityDate: day}))

	got, err := repo.FindByUserAndDate(user.ID, day)

	require.NoError(t, err)
	require.Len(t, got, 2, "only this user's activities on this day")
	byName := map[models.ActivityName]models.Activity{}
	for _, a := range got {
		byName[a.Name] = a
		assert.Equal(t, "2026-03-09", a.ActivityDate.Format(dateLayout))
	}
	assert.InDelta(t, 2.5, byName[models.ActivityStudy].DurationHours, 0.001)
	require.NotNil(t, byName[models.ActivityStudy].Note)
	assert.Equal(t, note, *byName[models.ActivityStudy].Note)
	assert.Nil(t, byName[models.ActivitySleep].Note)

	got, err = repo.FindByUserAndDate(user.ID, day.AddDate(0, 0, 7))
	require.NoError(t, err)
	assert.Empty(t, got)
}

func TestActivityRepository_CreateRejectsInvalidActivities(t *testing.T) {
	db := testutil.DB(t)
	repo := NewActivityRepository(db)
	user := testutil.CreateUser(t, db)

	err := repo.Create(&models.Activity{UserID: user.ID, Name: "swimming", DurationHours: 1, ActivityDate: day})
	assert.EqualError(t, err, "invalid activity name: swimming")

	err = repo.Create(&models.Activity{UserID: user.ID, Name: models.ActivityStudy, DurationHours: 24.5, ActivityDate: day})
	assert.EqualError(t, err, "duration_hours must be between 0 and 24")

	var count int64
	require.NoError(t, db.Model(&models.Activity{}).Count(&count).Error)
	assert.Zero(t, count)
}

func TestActivityRepository_Update(t *testing.T) {
	db := testutil.DB(t)
	repo := NewActivityRepository(db)
	user := testutil.CreateUser(t, db)
	activity := testutil.CreateActivity(t, db, user.ID, models.ActivityWorkout, 1, day)

	activity.DurationHours = 1.75
	require.NoError(t, repo.Update(activity))

	activity.DurationHours = 30
	assert.Error(t, repo.Update(activity), "updates are validated too")

	got, err := repo.FindByUserAndDate(user.ID, day)
	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.Equal(t, activity.ID, got[0].ID)
	assert.InDelta(t, 1.75, got[0].DurationHours, 0.001)
}

func TestActivityRepository_FindByUserAndDateRange(t *testing.T) {
	db := testutil.DB(t)
	repo := NewActivityRepository(db)
	user := testutil.CreateUser(t, db)
	other := testutil.CreateUser(t, db)
	for _, d := range []int{1, 5, 8, 10, 11} {
		testutil.CreateActivity(t, db, user.ID, models.ActivityStudy, 1, testutil.Day(2026, time.March, d))
	}
	testutil.CreateActivity(t, db, other.ID, models.ActivityStudy, 1, testutil.Day(2026, time.March, 6))

	got, err := repo.FindByUserAndDateRange(user.ID, testutil.Day(2026, time.March, 5), testutil.Day(2026, time.March, 10))

	require.NoError(t, err)
	var dates []string
	for _, a := range got {
		dates = append(dates, a.ActivityDate.Format(dateLayout))
	}
	assert.ElementsMatch(t, []string{"2026-03-05", "2026-03-08", "2026-03-10"}, dates, "bounds are inclusive")
}

func TestActivityRepository_DatabaseErrors(t *testing.T) {
	repo := NewActivityRepository(testutil.BrokenDB(t))
	valid := func() *models.Activity {
		return &models.Activity{UserID: 1, Name: models.ActivitySleep, DurationHours: 8, ActivityDate: day}
	}

	assert.Error(t, repo.Create(valid()))
	assert.Error(t, repo.Update(valid()))
	_, err := repo.FindByUserAndDate(1, day)
	assert.Error(t, err)
	_, err = repo.FindByUserAndDateRange(1, day, day)
	assert.Error(t, err)
}

// ==================== Streaks ====================

func TestStreakRepository_LatestAndPrevious(t *testing.T) {
	db := testutil.DB(t)
	repo := NewStreakRepository(db)
	user := testutil.CreateUser(t, db)
	other := testutil.CreateUser(t, db)

	t.Run("no streaks yet", func(t *testing.T) {
		latest, err := repo.FindLatestByUser(user.ID)
		assert.NoError(t, err)
		assert.Nil(t, latest)
		active, err := repo.FindLatestActiveByUser(user.ID)
		assert.NoError(t, err)
		assert.Nil(t, active)
		previous, err := repo.FindPreviousByUser(user.ID)
		assert.NoError(t, err)
		assert.Nil(t, previous)
	})

	require.NoError(t, repo.Create(&models.Streak{UserID: user.ID, Current: 1, Longest: 1, ActivityDate: testutil.Day(2026, time.March, 7)}))

	t.Run("a single streak has no previous one", func(t *testing.T) {
		previous, err := repo.FindPreviousByUser(user.ID)
		assert.NoError(t, err)
		assert.Nil(t, previous)
	})

	require.NoError(t, repo.Create(&models.Streak{UserID: user.ID, Current: 2, Longest: 2, ActivityDate: testutil.Day(2026, time.March, 8)}))
	require.NoError(t, repo.Create(&models.Streak{UserID: user.ID, Current: 0, Longest: 2, ActivityDate: testutil.Day(2026, time.March, 9)}))
	testutil.CreateStreak(t, db, other.ID, 9, 9, testutil.Day(2026, time.March, 20))

	t.Run("latest by date", func(t *testing.T) {
		latest, err := repo.FindLatestByUser(user.ID)
		require.NoError(t, err)
		require.NotNil(t, latest)
		assert.Equal(t, "2026-03-09", latest.ActivityDate.Format(dateLayout))
		assert.Zero(t, latest.Current)
	})

	t.Run("latest active skips missed days", func(t *testing.T) {
		active, err := repo.FindLatestActiveByUser(user.ID)
		require.NoError(t, err)
		require.NotNil(t, active)
		assert.Equal(t, "2026-03-08", active.ActivityDate.Format(dateLayout))
		assert.Equal(t, 2, active.Current)
	})

	t.Run("previous is the second most recent", func(t *testing.T) {
		previous, err := repo.FindPreviousByUser(user.ID)
		require.NoError(t, err)
		require.NotNil(t, previous)
		assert.Equal(t, "2026-03-08", previous.ActivityDate.Format(dateLayout))
	})
}

func TestStreakRepository_FindByUserAndDate(t *testing.T) {
	db := testutil.DB(t)
	repo := NewStreakRepository(db)
	user := testutil.CreateUser(t, db)
	testutil.CreateStreak(t, db, user.ID, 1, 4, day)
	newest := testutil.CreateStreak(t, db, user.ID, 2, 4, day)

	got, err := repo.FindByUserAndDate(user.ID, day)
	require.NoError(t, err)
	require.NotNil(t, got)
	assert.Equal(t, newest.ID, got.ID, "the most recently written row wins")

	got, err = repo.FindByUserAndDate(user.ID, day.AddDate(0, 0, 1))
	assert.NoError(t, err)
	assert.Nil(t, got)
}

func TestStreakRepository_UpdateAndFindAllByUser(t *testing.T) {
	db := testutil.DB(t)
	repo := NewStreakRepository(db)
	user := testutil.CreateUser(t, db)
	other := testutil.CreateUser(t, db)
	later := testutil.CreateStreak(t, db, user.ID, 1, 1, testutil.Day(2026, time.March, 9))
	testutil.CreateStreak(t, db, user.ID, 5, 5, testutil.Day(2026, time.March, 2))
	testutil.CreateStreak(t, db, other.ID, 3, 3, testutil.Day(2026, time.March, 5))

	later.Current, later.Longest = 6, 6
	require.NoError(t, repo.Update(later))

	got, err := repo.FindAllByUser(user.ID)
	require.NoError(t, err)
	require.Len(t, got, 2)
	assert.Equal(t, "2026-03-02", got[0].ActivityDate.Format(dateLayout), "oldest first")
	assert.Equal(t, "2026-03-09", got[1].ActivityDate.Format(dateLayout))
	assert.Equal(t, 6, got[1].Current)
	assert.Equal(t, 6, got[1].Longest)
}

func TestStreakRepository_FindUsersMissedStreak(t *testing.T) {
	db := testutil.DB(t)
	repo := NewStreakRepository(db)
	missed := testutil.CreateUser(t, db)
	active := testutil.CreateUser(t, db)
	missedOtherDay := testutil.CreateUser(t, db)
	testutil.CreateStreak(t, db, missed.ID, 0, 3, day)
	testutil.CreateStreak(t, db, missed.ID, 0, 3, day) // duplicate rows are reported once
	testutil.CreateStreak(t, db, active.ID, 4, 4, day)
	testutil.CreateStreak(t, db, missedOtherDay.ID, 0, 1, day.AddDate(0, 0, -1))

	ids, err := repo.FindUsersMissedStreak("2026-03-09")
	require.NoError(t, err)
	assert.Equal(t, []uint{missed.ID}, ids)

	ids, err = repo.FindUsersMissedStreak("2026-01-01")
	require.NoError(t, err)
	assert.Empty(t, ids)
}

func TestStreakRepository_DatabaseErrors(t *testing.T) {
	repo := NewStreakRepository(testutil.BrokenDB(t))

	assert.Error(t, repo.Create(&models.Streak{UserID: 1, ActivityDate: day}))
	assert.Error(t, repo.Update(&models.Streak{ID: 1, UserID: 1, ActivityDate: day}))
	calls := map[string]func() error{
		"FindLatestByUser":       func() error { _, err := repo.FindLatestByUser(1); return err },
		"FindLatestActiveByUser": func() error { _, err := repo.FindLatestActiveByUser(1); return err },
		"FindPreviousByUser":     func() error { _, err := repo.FindPreviousByUser(1); return err },
		"FindByUserAndDate":      func() error { _, err := repo.FindByUserAndDate(1, day); return err },
		"FindAllByUser":          func() error { _, err := repo.FindAllByUser(1); return err },
		"FindUsersMissedStreak":  func() error { _, err := repo.FindUsersMissedStreak("2026-03-09"); return err },
	}
	for name, call := range calls {
		t.Run(name, func(t *testing.T) { assert.Error(t, call()) })
	}
}

// ==================== Cron job logs ====================

func TestCronJobLogRepository_TryClaimJob(t *testing.T) {
	db := testutil.DB(t)
	repo := NewCronJobLogRepository(db)

	first, claimed, err := repo.TryClaimJob(models.CronJobDailyStreak, day, "replica-a")
	require.NoError(t, err)
	require.True(t, claimed)
	require.NotNil(t, first)
	assert.NotZero(t, first.ID)
	assert.Equal(t, models.CronJobStatusRunning, first.Status)
	assert.Equal(t, "replica-a", first.InstanceID)
	assert.Equal(t, "2026-03-09", first.JobDate.Format(dateLayout))
	assert.WithinDuration(t, time.Now(), first.StartedAt, time.Minute)
	assert.Zero(t, first.UsersCount)

	second, claimed, err := repo.TryClaimJob(models.CronJobDailyStreak, day, "replica-b")
	require.NoError(t, err)
	assert.False(t, claimed, "a job can be claimed once per day")
	require.NotNil(t, second)
	assert.Equal(t, first.ID, second.ID, "the existing claim is returned")
	assert.Equal(t, "replica-a", second.InstanceID)

	_, claimed, err = repo.TryClaimJob(models.CronJobDailyStreak, day.AddDate(0, 0, 1), "replica-b")
	require.NoError(t, err)
	assert.True(t, claimed, "the next day is a new claim")

	_, claimed, err = repo.TryClaimJob(models.CronJobStreakReminder, day, "replica-b")
	require.NoError(t, err)
	assert.True(t, claimed, "other jobs are independent")

	var count int64
	require.NoError(t, db.Model(&models.CronJobLog{}).Count(&count).Error)
	assert.Equal(t, int64(3), count)
}

func TestCronJobLogRepository_TryClaimJob_LookupFailures(t *testing.T) {
	db := testutil.DB(t)
	repo := NewCronJobLogRepository(faultyDB(t, on("query", "cron_job_logs")))

	t.Run("after claiming", func(t *testing.T) {
		log, claimed, err := repo.TryClaimJob(models.CronJobDailyStreak, day, "replica-a")
		assert.ErrorIs(t, err, errInjected)
		assert.False(t, claimed)
		assert.Nil(t, log)
	})

	t.Run("when already claimed", func(t *testing.T) {
		_, claimed, err := NewCronJobLogRepository(db).TryClaimJob(models.CronJobStreakReminder, day, "replica-a")
		require.NoError(t, err)
		require.True(t, claimed)

		log, claimed, err := repo.TryClaimJob(models.CronJobStreakReminder, day, "replica-b")
		assert.ErrorIs(t, err, errInjected)
		assert.False(t, claimed)
		assert.Nil(t, log)
	})
}

func TestCronJobLogRepository_FindCompletedAndRecent(t *testing.T) {
	db := testutil.DB(t)
	repo := NewCronJobLogRepository(db)
	completed := &models.CronJobLog{
		JobName: models.CronJobDailyStreak, JobDate: testutil.Day(2026, time.March, 8),
		StartedAt: t0, CompletedAt: t0.Add(time.Minute), Status: models.CronJobStatusCompleted, UsersCount: 5, InstanceID: "a",
	}
	running := &models.CronJobLog{
		JobName: models.CronJobDailyStreak, JobDate: day,
		StartedAt: t0.Add(24 * time.Hour), Status: models.CronJobStatusRunning, InstanceID: "b",
	}
	otherJob := &models.CronJobLog{
		JobName: models.CronJobStreakReminder, JobDate: day,
		StartedAt: t0.Add(48 * time.Hour), Status: models.CronJobStatusCompleted, InstanceID: "c",
	}
	for _, l := range []*models.CronJobLog{completed, running, otherJob} {
		require.NoError(t, repo.Create(l))
	}

	got, err := repo.FindByJobNameAndDate(models.CronJobDailyStreak, testutil.Day(2026, time.March, 8))
	require.NoError(t, err)
	require.NotNil(t, got)
	assert.Equal(t, completed.ID, got.ID)
	assert.Equal(t, 5, got.UsersCount)

	got, err = repo.FindByJobNameAndDate(models.CronJobDailyStreak, day)
	require.NoError(t, err)
	assert.Nil(t, got, "only completed runs count")

	running.Status, running.CompletedAt, running.UsersCount = models.CronJobStatusCompleted, running.StartedAt.Add(time.Minute), 7
	require.NoError(t, repo.Update(running))
	got, err = repo.FindByJobNameAndDate(models.CronJobDailyStreak, day)
	require.NoError(t, err)
	require.NotNil(t, got)
	assert.Equal(t, 7, got.UsersCount)

	recent, err := repo.FindRecentByJobName(models.CronJobDailyStreak, 10)
	require.NoError(t, err)
	require.Len(t, recent, 2, "other jobs are excluded")
	assert.Equal(t, running.ID, recent[0].ID, "newest first")
	assert.Equal(t, completed.ID, recent[1].ID)

	recent, err = repo.FindRecentByJobName(models.CronJobDailyStreak, 1)
	require.NoError(t, err)
	require.Len(t, recent, 1)
	assert.Equal(t, running.ID, recent[0].ID)
}

func TestCronJobLogRepository_DatabaseErrors(t *testing.T) {
	repo := NewCronJobLogRepository(testutil.BrokenDB(t))
	log := &models.CronJobLog{JobName: models.CronJobDailyStreak, JobDate: day, StartedAt: t0, Status: models.CronJobStatusRunning}

	assert.Error(t, repo.Create(log))
	assert.Error(t, repo.Update(log))
	_, claimed, err := repo.TryClaimJob(models.CronJobDailyStreak, day, "a")
	assert.Error(t, err)
	assert.False(t, claimed)
	_, err = repo.FindByJobNameAndDate(models.CronJobDailyStreak, day)
	assert.Error(t, err)
	_, err = repo.FindRecentByJobName(models.CronJobDailyStreak, 5)
	assert.Error(t, err)
}

// ==================== Tile configs ====================

func TestTileConfigRepository_SaveCreatesThenUpdates(t *testing.T) {
	db := testutil.DB(t)
	repo := NewTileConfigRepository(db)
	user := testutil.CreateUser(t, db)
	other := testutil.CreateUser(t, db)

	got, err := repo.FindByUserID(user.ID)
	require.NoError(t, err)
	assert.Nil(t, got, "no config yet")

	require.NoError(t, repo.Save(user.ID, models.JSONB{"order": []string{"sleep", "study"}}))
	created, err := repo.FindByUserID(user.ID)
	require.NoError(t, err)
	require.NotNil(t, created)
	assert.Equal(t, []interface{}{"sleep", "study"}, created.Config["order"])

	require.NoError(t, repo.Save(user.ID, models.JSONB{
		"order": []string{"study"},
		"sizes": map[string]string{"study": "large"},
	}))
	updated, err := repo.FindByUserID(user.ID)
	require.NoError(t, err)
	require.NotNil(t, updated)
	assert.Equal(t, created.ID, updated.ID, "the existing row is updated")
	assert.Equal(t, models.JSONB{
		"order": []interface{}{"study"},
		"sizes": map[string]interface{}{"study": "large"},
	}, updated.Config)

	data, err := updated.GetConfigData()
	require.NoError(t, err)
	assert.Equal(t, []string{"study"}, data.Order)

	var rows int64
	require.NoError(t, db.Model(&models.TileConfig{}).Where("user_id = ?", user.ID).Count(&rows).Error)
	assert.Equal(t, int64(1), rows)

	got, err = repo.FindByUserID(other.ID)
	require.NoError(t, err)
	assert.Nil(t, got)
}

func TestTileConfigRepository_DatabaseErrors(t *testing.T) {
	repo := NewTileConfigRepository(testutil.BrokenDB(t))

	_, err := repo.FindByUserID(1)
	assert.Error(t, err)
	assert.Error(t, repo.Save(1, models.JSONB{"order": []string{}}))
}
