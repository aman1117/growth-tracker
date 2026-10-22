package services

import (
	"context"
	"strconv"
	"testing"

	"github.com/aman1117/backend/internal/dto"
	"github.com/aman1117/backend/internal/repository"
	"github.com/aman1117/backend/internal/testutil"
	"github.com/aman1117/backend/pkg/models"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// lockedDays returns a participant's locked days as "date:met|missed:hours".
func lockedDays(t *testing.T, e *chEnv, c *models.Challenge, u *models.User) []string {
	t.Helper()
	var days []models.ChallengeDay
	require.NoError(t, e.db.Where("challenge_id = ? AND user_id = ?", c.ID, u.ID).Order("day_date").Find(&days).Error)
	out := make([]string, len(days))
	for i, d := range days {
		result := DayStatusMissed
		if d.Met {
			result = DayStatusMet
		}
		out[i] = formatDate(d.DayDate) + ":" + result + ":" + strconv.FormatFloat(d.Hours, 'f', -1, 64)
	}
	return out
}

func reloadChallenge(t *testing.T, e *chEnv, c *models.Challenge) models.Challenge {
	t.Helper()
	var got models.Challenge
	require.NoError(t, e.db.First(&got, c.ID).Error)
	return got
}

// Study 2h+ from S to S+4. Ann (the creator) joined before the start, Ben on S+2.
func TestChallengeService_RunDailyJob(t *testing.T) {
	e := newChEnv(t, on(3))
	ctx := context.Background()
	t.Setenv("HOSTNAME", "job-test")
	e.svc = e.service(e.db, e.db, e.db)
	ann, ben := e.user(t, "ann"), e.user(t, "ben")
	c := e.seed(t, ann, cday, 5)
	e.join(t, c, ann, on(-1))
	e.join(t, c, ben, on(2))
	upcoming := e.seed(t, ann, on(10), 5)
	e.join(t, upcoming, ann, cday)
	startsToday := e.seed(t, ann, on(3), 10)
	e.join(t, startsToday, ann, on(3))

	e.log(t, ann, models.ActivityStudy, 2, cday)
	e.log(t, ann, models.ActivityStudy, 1, on(1))
	e.log(t, ann, models.ActivitySleep, 8, on(1))
	e.log(t, ann, models.ActivityStudy, 3, on(2))
	e.log(t, ann, models.ActivityStudy, 2, on(3))
	e.log(t, ann, models.ActivityStudy, 2.5, on(4))
	e.log(t, ben, models.ActivityStudy, 5, on(1)) // before Ben joined
	e.log(t, ben, models.ActivityStudy, 2, on(2))
	e.log(t, ben, models.ActivityStudy, 4, on(4))

	// On S+3, S and S+1 can no longer change.
	require.NoError(t, e.svc.RunDailyJob(ctx))
	assert.Equal(t, []string{"2026-03-09:met:2", "2026-03-10:missed:1"}, lockedDays(t, e, c, ann))
	assert.Empty(t, lockedDays(t, e, c, ben), "nothing before Ben's window")
	got := reloadChallenge(t, e, c)
	require.NotNil(t, got.LockedThrough)
	assert.Equal(t, "2026-03-10", formatDate(*got.LockedThrough))
	assert.Nil(t, got.FinalizedAt)
	assert.Nil(t, reloadChallenge(t, e, upcoming).LockedThrough)
	assert.Nil(t, reloadChallenge(t, e, startsToday).LockedThrough)
	var day models.ChallengeDay
	require.NoError(t, e.db.Where("challenge_id = ? AND user_id = ? AND day_date = ?", c.ID, ann.ID, on(1)).First(&day).Error)
	assert.True(t, day.Logged, "something was logged that day")
	assert.True(t, e.clock.Now().Equal(day.LockedAt))

	logs := cronJobLogs(t, e.db, models.CronJobChallengeDaily)
	require.Len(t, logs, 1)
	assert.Equal(t, models.CronJobStatusCompleted, logs[0].Status)
	assert.Equal(t, "2026-03-12", formatDate(logs[0].JobDate))
	assert.Equal(t, "job-test", logs[0].InstanceID)
	assert.Equal(t, 1, logs[0].UsersCount, "challenges processed")
	assert.Empty(t, logs[0].Error)

	// Editing a locked day changes nothing.
	require.NoError(t, e.db.Exec("UPDATE activities SET duration_hours = 4 WHERE user_id = ? AND activity_date = ? AND name = ?",
		ann.ID, on(1), models.ActivityStudy).Error)
	detail, err := e.svc.GetDetail(ctx, ann.ID, c.ID)
	require.NoError(t, err)
	assert.Equal(t, dto.ChallengeDay{Date: "2026-03-10", Hours: testutil.Ptr(1.0), Status: DayStatusMissed, Locked: true}, detail.MyDays[1])

	// A second run on the same day (another replica) does nothing.
	require.NoError(t, e.svc.RunDailyJob(ctx))
	assert.Len(t, cronJobLogs(t, e.db, models.CronJobChallengeDaily), 1)

	// Without job logs a re-run is still harmless.
	unclaimed := e.service(e.db, nil, e.db)
	require.NoError(t, unclaimed.RunDailyJob(ctx))
	assert.Len(t, lockedDays(t, e, c, ann), 2)

	// S+4..S+8 were missed: the next run catches up and finalizes.
	e.clock.setDay(on(9))
	require.NoError(t, e.svc.RunDailyJob(ctx))
	assert.Equal(t, []string{"2026-03-09:met:2", "2026-03-10:missed:1", "2026-03-11:met:3", "2026-03-12:met:2", "2026-03-13:met:2.5"},
		lockedDays(t, e, c, ann))
	assert.Equal(t, []string{"2026-03-11:met:2", "2026-03-12:missed:0", "2026-03-13:met:4"}, lockedDays(t, e, c, ben))
	got = reloadChallenge(t, e, c)
	assert.Equal(t, "2026-03-13", formatDate(*got.LockedThrough))
	require.NotNil(t, got.FinalizedAt)
	assert.True(t, e.clock.Now().Equal(*got.FinalizedAt))
	assert.Equal(t, "2026-03-16", formatDate(*reloadChallenge(t, e, startsToday).LockedThrough), "through today-2")
	logs = cronJobLogs(t, e.db, models.CronJobChallengeDaily)
	require.Len(t, logs, 2)
	assert.Equal(t, 3, logs[1].UsersCount, "two challenges locked, one finalized")

	var participants []models.ChallengeParticipant
	require.NoError(t, e.db.Where("challenge_id = ?", c.ID).Order("user_id").Find(&participants).Error)
	require.Len(t, participants, 2)
	assert.Equal(t, testutil.Ptr(1), participants[0].FinalRank)
	assert.Equal(t, testutil.Ptr(4), participants[0].FinalDaysMet)
	assert.Equal(t, testutil.Ptr(10.5), participants[0].FinalTotalHours, "the locked hours, not the later edit")
	assert.Equal(t, testutil.Ptr(true), participants[0].Completed, "4 of 5 days")
	assert.Equal(t, testutil.Ptr(2), participants[1].FinalRank)
	assert.Equal(t, testutil.Ptr(2), participants[1].FinalDaysMet)
	assert.Equal(t, testutil.Ptr(6.0), participants[1].FinalTotalHours)
	assert.Equal(t, testutil.Ptr(false), participants[1].Completed, "2 of 3 days")

	annEnded := typedNotifications(t, e.db, ann.ID, models.NotifTypeChallengeEnded)
	require.Len(t, annEnded, 1)
	assert.Equal(t, "Challenge complete 🎉", annEnded[0].Title)
	assert.Equal(t, "“Study 2h+” is over: you finished #1 with 4/5 days.", annEnded[0].Body)
	assert.Equal(t, models.NotificationMetadata{
		"challenge_id": float64(c.ID), "challenge_title": "Study 2h+", "rank": float64(1),
		"days_met": float64(4), "days_possible": float64(5), "completed": true,
	}, annEnded[0].Metadata)
	benEnded := typedNotifications(t, e.db, ben.ID, models.NotifTypeChallengeEnded)
	require.Len(t, benEnded, 1)
	assert.Equal(t, "Challenge ended", benEnded[0].Title)
	assert.Equal(t, "“Study 2h+” is over: you finished #2 with 2/3 days.", benEnded[0].Body)

	detail, err = e.svc.GetDetail(ctx, ben.ID, c.ID)
	require.NoError(t, err)
	assert.True(t, detail.Finalized)
	assert.Equal(t, ChallengeStatusEnded, detail.Status)
	assert.Equal(t, dto.ChallengeProgress{
		Rank: testutil.Ptr(2), DaysMet: 2, DaysElapsed: 3, DaysPossible: 3, CurrentStreak: 1, TotalHours: 6,
		Completed: testutil.Ptr(false),
	}, detail.Me)
	assert.Equal(t, "--MXM", participantOf(t, detail, ben.ID).Days)

	// Later runs leave finalized challenges alone and notify nobody twice.
	e.clock.setDay(on(10))
	require.NoError(t, e.svc.RunDailyJob(ctx))
	require.NoError(t, unclaimed.RunDailyJob(ctx))
	assert.Len(t, typedNotifications(t, e.db, ann.ID, models.NotifTypeChallengeEnded), 1)
	assert.Len(t, typedNotifications(t, e.db, ben.ID, models.NotifTypeChallengeEnded), 1)
	assert.True(t, got.FinalizedAt.Equal(*reloadChallenge(t, e, c).FinalizedAt))
	assert.Equal(t, "2026-03-17", formatDate(*reloadChallenge(t, e, startsToday).LockedThrough))
}

type finalStanding struct {
	rank      int
	daysMet   int
	hours     float64
	completed bool
}

// Reels at most 1h over 3 days: fewer hours rank higher and equal results share a rank.
func TestChallengeService_RunDailyJob_AtMostRanking(t *testing.T) {
	e := newChEnv(t, on(5))
	kim, ned, lee, mo := e.user(t, "kim"), e.user(t, "ned"), e.user(t, "lee"), e.user(t, "mo")
	c := e.seed(t, kim, cday, 3, func(c *models.Challenge) {
		c.Activity, c.GoalType, c.TargetHours = string(models.ActivityReels), models.ChallengeGoalAtMost, 1
	})
	for _, u := range []*models.User{kim, ned, lee, mo} {
		e.join(t, c, u, cday)
	}
	for i := 0; i < 3; i++ {
		e.log(t, kim, models.ActivityReels, 0.5, on(i))
		e.log(t, ned, models.ActivityReels, 0.5, on(i))
		e.log(t, lee, models.ActivityReels, 0.5, on(i))
		e.log(t, mo, models.ActivityStudy, 1, on(i)) // logged, but no reels: met with 0 hours
	}
	e.log(t, lee, models.ActivityReels, 1, on(1)) // 1.5 hours: missed

	require.NoError(t, e.svc.RunDailyJob(context.Background()))

	rows, err := e.svc.repo.ListParticipants([]uint{c.ID})
	require.NoError(t, err)
	got := map[string]finalStanding{}
	for _, r := range rows {
		require.NotNil(t, r.FinalRank, r.Username)
		got[r.Username] = finalStanding{*r.FinalRank, *r.FinalDaysMet, *r.FinalTotalHours, *r.Completed}
	}
	assert.Equal(t, map[string]finalStanding{
		"mo":  {1, 3, 0, true},
		"kim": {2, 3, 1.5, true},
		"ned": {2, 3, 1.5, true},
		"lee": {4, 2, 2.5, false},
	}, got)
	assert.Len(t, typedNotifications(t, e.db, lee.ID, models.NotifTypeChallengeEnded), 1)
	assert.Equal(t, "“Study 2h+” is over: you finished #4 with 2/3 days.",
		typedNotifications(t, e.db, lee.ID, models.NotifTypeChallengeEnded)[0].Body)
}

func TestChallengeService_LockAndFinalizeAreIdempotent(t *testing.T) {
	e := newChEnv(t, on(9))
	ann := e.user(t, "ann")
	c := e.seed(t, ann, cday, 3)
	e.join(t, c, ann, cday)

	require.NoError(t, e.svc.lockChallengeDays(c.ID, on(7)))
	assert.Len(t, lockedDays(t, e, c, ann), 3)
	require.NoError(t, e.svc.lockChallengeDays(c.ID, on(7)), "already locked")
	assert.Len(t, lockedDays(t, e, c, ann), 3)

	finalized, results, err := e.svc.finalizeChallenge(c.ID)
	require.NoError(t, err)
	require.NotNil(t, finalized)
	assert.Equal(t, c.ID, finalized.ID)
	assert.Equal(t, []endedResult{{userID: ann.ID, rank: 1, daysMet: 0, daysPossible: 3, completed: false}}, results)

	again, results, err := e.svc.finalizeChallenge(c.ID)
	require.NoError(t, err)
	assert.Nil(t, again, "finalized already")
	assert.Empty(t, results)

	done := e.seed(t, ann, cday, 3, func(c *models.Challenge) { c.FinalizedAt = testutil.Ptr(e.clock.Now()) })
	e.join(t, done, ann, cday)
	require.NoError(t, e.svc.lockChallengeDays(done.ID, on(7)))
	assert.Empty(t, lockedDays(t, e, done, ann), "finalized challenges are never locked again")

	notLocked := e.seed(t, ann, cday, 3)
	again, _, err = e.svc.finalizeChallenge(notLocked.ID)
	require.NoError(t, err)
	assert.Nil(t, again, "not every day is locked")
}

func TestChallengeService_UpdateJobLog(t *testing.T) {
	db := testDB(t)
	log := &models.CronJobLog{ID: 1}
	(&ChallengeService{}).updateJobLog(log, models.CronJobStatusCompleted, 1, "")
	assert.Empty(t, log.Status, "nothing to do without a repository")

	svc := &ChallengeService{jobLogRepo: repository.NewCronJobLogRepository(db)}
	svc.updateJobLog(nil, models.CronJobStatusCompleted, 1, "")
	unsaved := &models.CronJobLog{}
	svc.updateJobLog(unsaved, models.CronJobStatusCompleted, 1, "")
	assert.Empty(t, unsaved.Status, "logs that were never stored are left alone")

	logs := observeChallengeLogs(t)
	broken := &ChallengeService{jobLogRepo: repository.NewCronJobLogRepository(testutil.BrokenDB(t))}
	log = &models.CronJobLog{ID: 7}
	broken.updateJobLog(log, models.CronJobStatusFailed, 3, "boom") // the failure is only logged
	assert.Equal(t, models.CronJobStatusFailed, log.Status)
	assert.Equal(t, 3, log.UsersCount)
	assert.Equal(t, "boom", log.Error)
	assert.Equal(t, 1, logs.FilterMessage("Failed to update the challenge job log").Len())
}
