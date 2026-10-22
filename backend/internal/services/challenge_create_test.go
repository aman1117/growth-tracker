package services

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/dto"
	"github.com/aman1117/backend/internal/testutil"
	"github.com/aman1117/backend/internal/validator"
	"github.com/aman1117/backend/pkg/models"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNewChallengeService(t *testing.T) {
	t.Setenv("HOSTNAME", "worker-3")
	svc := NewChallengeService(nil, nil, nil)
	assert.Equal(t, "worker-3", svc.instanceID)
	assert.WithinDuration(t, time.Now(), svc.now(), time.Minute, "the wall clock by default")
	assert.Len(t, svc.newCode(), constants.ChallengeInviteCodeLength)

	t.Setenv("HOSTNAME", "")
	assert.Regexp(t, `^instance-\d+$`, NewChallengeService(nil, nil, nil).instanceID)

	// "today" is the IST date: 19:00 UTC on March 8 is 00:30 on March 9 in India.
	fixed := time.Date(2026, 3, 8, 19, 0, 0, 0, time.UTC)
	svc = NewChallengeService(nil, nil, nil, WithChallengeClock(func() time.Time { return fixed }))
	assert.Equal(t, testutil.Day(2026, 3, 9), svc.today())
}

func TestChallengeService_Create(t *testing.T) {
	e := newChEnv(t, cday)
	ctx := context.Background()
	ann := e.user(t, "ann", chAvatar)

	req := studyRequest(on(1), 21)
	req.Title = "  Study 2h+ a day 📚 "
	detail, err := e.svc.Create(ctx, ann.ID, req)
	require.NoError(t, err)

	assert.NotZero(t, detail.ID)
	assert.Equal(t, "Study 2h+ a day 📚", detail.Title, "trimmed")
	assert.Equal(t, "study", detail.Activity)
	assert.Equal(t, models.ChallengeGoalAtLeast, detail.GoalType)
	assert.Equal(t, 2.0, detail.TargetHours)
	assert.Equal(t, "2026-03-10", detail.StartDate)
	assert.Equal(t, "2026-03-30", detail.EndDate)
	assert.Equal(t, 21, detail.DurationDays)
	assert.Equal(t, ChallengeStatusUpcoming, detail.Status)
	assert.False(t, detail.Finalized)
	assert.Nil(t, detail.DayNumber)
	assert.Equal(t, 1, detail.ParticipantCount)
	assert.True(t, detail.IsCreator)
	code, ok := validator.NormalizeInviteCode(detail.InviteCode)
	assert.True(t, ok)
	assert.Equal(t, detail.InviteCode, code)
	assert.Equal(t, "2026-03-09", detail.Today)
	assert.Nil(t, detail.LockedThrough)
	assert.Equal(t, "2026-04-01", detail.ResultsDate, "end date + 2")
	assert.Equal(t, 17, detail.CompletionDays, "ceil(0.8 * 21)")
	assert.Equal(t, 50, detail.MaxParticipants)
	assert.Equal(t, chUser(ann), detail.Creator)
	assert.True(t, detail.CanInvite)
	assert.False(t, detail.CanLeave, "the creator cannot leave")
	assert.True(t, detail.CanDelete)

	progress := dto.ChallengeProgress{DaysPossible: 21}
	assert.Equal(t, progress, detail.Me, "no rank, streak or completion before the start")
	assert.Equal(t, []dto.ChallengeParticipant{{
		ChallengeProgress: progress, User: chUser(ann), JoinedOn: "2026-03-09", IsMe: true, Days: strings.Repeat("U", 21),
	}}, detail.Participants)
	require.Len(t, detail.MyDays, 21)
	assert.Equal(t, dto.ChallengeDay{Date: "2026-03-10", Status: DayStatusUpcoming}, detail.MyDays[0])
	assert.Equal(t, dto.ChallengeDay{Date: "2026-03-30", Status: DayStatusUpcoming}, detail.MyDays[20])

	var stored models.ChallengeParticipant
	require.NoError(t, e.db.Where("challenge_id = ?", detail.ID).First(&stored).Error)
	assert.Equal(t, ann.ID, stored.UserID, "the creator joins automatically")
	assert.Equal(t, "2026-03-09", formatDate(stored.JoinedOn))
	assert.True(t, e.clock.Now().Equal(stored.JoinedAt))

	t.Run("starting today", func(t *testing.T) {
		detail, err := e.svc.Create(ctx, ann.ID, studyRequest(cday, 3))
		require.NoError(t, err)
		assert.Equal(t, ChallengeStatusActive, detail.Status)
		assert.Equal(t, testutil.Ptr(1), detail.DayNumber)
		assert.Equal(t, dto.ChallengeProgress{
			Rank: testutil.Ptr(1), DaysElapsed: 1, DaysPossible: 3,
			TodayHours: testutil.Ptr(0.0), TodayStatus: testutil.Ptr(DayStatusPending),
		}, detail.Me)
		assert.Equal(t, "PUU", detail.Participants[0].Days)
		assert.Equal(t, dto.ChallengeDay{Date: "2026-03-09", Hours: testutil.Ptr(0.0), Status: DayStatusPending}, detail.MyDays[0])
		assert.True(t, detail.CanDelete, "the creator is the only participant")
	})

	t.Run("boundaries", func(t *testing.T) {
		requests := []dto.CreateChallengeRequest{
			{Title: strings.Repeat("🏆", 60), Activity: "reels", GoalType: models.ChallengeGoalAtMost,
				TargetHours: testutil.Ptr(0.0), DurationDays: testutil.Ptr(60), StartDate: "2026-04-08"},
			{Title: "x", Activity: "sleep", GoalType: models.ChallengeGoalAtLeast,
				TargetHours: testutil.Ptr(24.0), DurationDays: testutil.Ptr(3), StartDate: " 2026-03-09 "},
			{Title: "y", Activity: "office", GoalType: models.ChallengeGoalAtMost,
				TargetHours: testutil.Ptr(23.75), DurationDays: testutil.Ptr(3), StartDate: "2026-03-09"},
			{Title: "z", Activity: "workout", GoalType: models.ChallengeGoalAtLeast,
				TargetHours: testutil.Ptr(0.25), DurationDays: testutil.Ptr(3), StartDate: "2026-03-09"},
		}
		for _, req := range requests {
			detail, err := e.svc.Create(ctx, ann.ID, req)
			require.NoError(t, err, "%+v", req)
			assert.Equal(t, *req.TargetHours, detail.TargetHours)
			assert.Equal(t, *req.DurationDays, detail.DurationDays)
		}
	})

	t.Run("validation", func(t *testing.T) {
		before := countRows(t, e.db, &models.Challenge{})
		tests := []struct {
			name   string
			mutate func(r *dto.CreateChallengeRequest)
			field  string
		}{
			{"empty title", func(r *dto.CreateChallengeRequest) { r.Title = "  " }, "title"},
			{"long title", func(r *dto.CreateChallengeRequest) { r.Title = strings.Repeat("a", 61) }, "title"},
			{"custom tile", func(r *dto.CreateChallengeRequest) { r.Activity = "custom:3f2b8c4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f" }, "activity"},
			{"unknown activity", func(r *dto.CreateChallengeRequest) { r.Activity = "swimming" }, "activity"},
			{"unknown goal", func(r *dto.CreateChallengeRequest) { r.GoalType = "exactly" }, "goal_type"},
			{"missing target", func(r *dto.CreateChallengeRequest) { r.TargetHours = nil }, "target_hours"},
			{"not a quarter hour", func(r *dto.CreateChallengeRequest) { r.TargetHours = testutil.Ptr(2.1) }, "target_hours"},
			{"at_least zero", func(r *dto.CreateChallengeRequest) { r.TargetHours = testutil.Ptr(0.0) }, "target_hours"},
			{"at_least over a day", func(r *dto.CreateChallengeRequest) { r.TargetHours = testutil.Ptr(24.25) }, "target_hours"},
			{"at_most a whole day", func(r *dto.CreateChallengeRequest) {
				r.GoalType, r.TargetHours = models.ChallengeGoalAtMost, testutil.Ptr(24.0)
			}, "target_hours"},
			{"too short", func(r *dto.CreateChallengeRequest) { r.DurationDays = testutil.Ptr(2) }, "duration_days"},
			{"too long", func(r *dto.CreateChallengeRequest) { r.DurationDays = testutil.Ptr(61) }, "duration_days"},
			{"missing duration", func(r *dto.CreateChallengeRequest) { r.DurationDays = nil }, "duration_days"},
			{"in the past", func(r *dto.CreateChallengeRequest) { r.StartDate = "2026-03-08" }, "start_date"},
			{"too far ahead", func(r *dto.CreateChallengeRequest) { r.StartDate = "2026-04-09" }, "start_date"},
			{"malformed start", func(r *dto.CreateChallengeRequest) { r.StartDate = "09/03/2026" }, "start_date"},
		}
		for _, tt := range tests {
			t.Run(tt.name, func(t *testing.T) {
				req := studyRequest(on(1), 21)
				tt.mutate(&req)
				_, err := e.svc.Create(ctx, ann.ID, req)
				var valErr *validator.ValidationError
				require.ErrorAs(t, err, &valErr)
				assert.Equal(t, constants.ErrCodeInvalidChallenge, valErr.ErrorCode)
				assert.True(t, strings.HasPrefix(valErr.Message, tt.field+" "), "message %q names %s", valErr.Message, tt.field)
			})
		}
		assert.Equal(t, before, countRows(t, e.db, &models.Challenge{}), "nothing is stored")
	})

	t.Run("unknown user", func(t *testing.T) {
		_, err := e.svc.Create(ctx, ann.ID+1000, studyRequest(on(1), 3))
		require.Error(t, err)
		assert.NotErrorIs(t, err, ErrChallengeLimitReached)
	})
}

func TestChallengeService_Create_OpenChallengeLimit(t *testing.T) {
	e := newChEnv(t, cday)
	ctx := context.Background()
	lim, other := e.user(t, "lim"), e.user(t, "other")

	ended := e.seed(t, other, on(-10), 5) // ended challenges do not count
	e.join(t, ended, lim, on(-10))
	joined := e.seed(t, other, on(2), 5) // joined ones do
	e.join(t, joined, lim, cday)
	for i := 0; i < 9; i++ {
		_, err := e.svc.Create(ctx, lim.ID, studyRequest(on(i), 3))
		require.NoError(t, err, "challenge %d", i+1)
	}

	_, err := e.svc.Create(ctx, lim.ID, studyRequest(on(1), 3))
	require.ErrorIs(t, err, ErrChallengeLimitReached)
	assert.EqualValues(t, 9, countRows(t, e.db.Where("creator_id = ?", lim.ID), &models.Challenge{}))

	// Three days later the first one has ended, which makes room for one more.
	e.clock.setDay(on(3))
	_, err = e.svc.Create(ctx, lim.ID, studyRequest(on(3), 3))
	require.NoError(t, err)
	_, err = e.svc.Create(ctx, lim.ID, studyRequest(on(3), 3))
	require.ErrorIs(t, err, ErrChallengeLimitReached)
}

func TestChallengeService_OpenChallengeLimitUnderConcurrency(t *testing.T) {
	e := newChEnv(t, cday)
	ctx := context.Background()
	owner, racer := e.user(t, "owner"), e.user(t, "racer")
	for i := 0; i < constants.ChallengeMaxOpenPerUser-2; i++ {
		c := e.seed(t, owner, on(1), 5)
		e.join(t, c, racer, cday)
	}
	var targets []*models.Challenge
	for i := 0; i < 3; i++ {
		c := e.seed(t, owner, on(1), 5)
		e.join(t, c, owner, cday)
		targets = append(targets, c)
	}

	// Two joins and two creates race for the last two places.
	errs := make([]error, 5)
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := range errs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			if i < len(targets) {
				_, errs[i] = e.svc.JoinByCode(ctx, racer.ID, targets[i].InviteCode)
				return
			}
			_, errs[i] = e.svc.Create(ctx, racer.ID, studyRequest(on(1), 3))
		}()
	}
	close(start)
	wg.Wait()

	succeeded, limited := 0, 0
	for _, err := range errs {
		switch {
		case err == nil:
			succeeded++
		case errors.Is(err, ErrChallengeLimitReached):
			limited++
		default:
			t.Errorf("unexpected error: %v", err)
		}
	}
	assert.Equal(t, 2, succeeded)
	assert.Equal(t, 3, limited)
	open, err := e.svc.repo.CountOpenForUser(racer.ID, cday)
	require.NoError(t, err)
	assert.EqualValues(t, constants.ChallengeMaxOpenPerUser, open)
}

func TestChallengeService_Create_InviteCodeCollisions(t *testing.T) {
	e := newChEnv(t, cday)
	ctx := context.Background()
	ann := e.user(t, "ann")
	first, err := e.svc.Create(ctx, ann.ID, studyRequest(on(1), 3))
	require.NoError(t, err)
	logs := observeChallengeLogs(t)

	codes := []string{first.InviteCode, first.InviteCode, "NEWCQDE2"}
	calls := 0
	e.svc.newCode = func() string {
		calls++
		return codes[min(calls, len(codes))-1]
	}
	second, err := e.svc.Create(ctx, ann.ID, studyRequest(on(1), 3))
	require.NoError(t, err)
	assert.Equal(t, "NEWCQDE2", second.InviteCode)
	assert.Equal(t, 3, calls)
	assert.Equal(t, 2, logs.FilterMessage("Challenge invite code collision, retrying with a new code").Len())

	calls = 0
	e.svc.newCode = func() string {
		calls++
		return first.InviteCode
	}
	_, err = e.svc.Create(ctx, ann.ID, studyRequest(on(1), 3))
	require.ErrorIs(t, err, errInviteCodeTaken)
	assert.Equal(t, maxInviteCodeAttempts, calls)
	assert.EqualValues(t, 2, countRows(t, e.db, &models.Challenge{}))
	assert.EqualValues(t, 2, countRows(t, e.db, &models.ChallengeParticipant{}), "nothing is left behind")
}

func TestChallengeService_List(t *testing.T) {
	today := on(10)
	e := newChEnv(t, today)
	ctx := context.Background()
	me, rival := e.user(t, "me"), e.user(t, "rival")

	active1 := e.seed(t, rival, on(5), 10) // ends on(14)
	e.join(t, active1, rival, on(4))
	e.join(t, active1, me, on(4))
	active2 := e.seed(t, me, on(8), 5) // ends on(12)
	e.join(t, active2, me, on(8))
	upcoming1 := e.seed(t, me, on(15), 5)
	e.join(t, upcoming1, me, today)
	upcoming2 := e.seed(t, rival, on(12), 3)
	e.join(t, upcoming2, rival, today)
	e.join(t, upcoming2, me, today)
	var ended []*models.Challenge
	for i := 0; i < 22; i++ {
		c := e.seed(t, me, on(7-i), 3) // ends on(9-i)
		e.join(t, c, me, on(7-i))
		ended = append(ended, c)
	}
	finalized := ended[3]
	e.finalize(t, finalized, me, 3, 2, 9.5, false)
	notMine := e.seed(t, rival, today, 3)
	e.join(t, notMine, rival, today)

	e.log(t, me, models.ActivityStudy, 2.5, today)
	e.log(t, rival, models.ActivityStudy, 3, on(9))

	list, err := e.svc.List(ctx, me.ID)
	require.NoError(t, err)
	ids := make([]uint, len(list))
	for i, s := range list {
		ids[i] = s.ID
	}
	want := []uint{active2.ID, active1.ID, upcoming2.ID, upcoming1.ID}
	for i := 0; i < 20; i++ {
		want = append(want, ended[i].ID)
	}
	assert.Equal(t, want, ids, "active by end date, upcoming by start date, then the 20 most recent ended")

	a1 := list[1]
	assert.Equal(t, ChallengeStatusActive, a1.Status)
	assert.Equal(t, testutil.Ptr(6), a1.DayNumber)
	assert.Equal(t, 2, a1.ParticipantCount)
	assert.False(t, a1.IsCreator)
	assert.Equal(t, dto.ChallengeProgress{
		Rank: testutil.Ptr(2), DaysMet: 1, DaysElapsed: 6, DaysPossible: 10, CurrentStreak: 1, TotalHours: 2.5,
		TodayHours: testutil.Ptr(2.5), TodayStatus: testutil.Ptr(DayStatusMet),
	}, a1.Me, "rival met a day with more hours")

	assert.True(t, list[0].IsCreator)
	assert.Equal(t, testutil.Ptr(1), list[0].Me.Rank)
	assert.Equal(t, dto.ChallengeProgress{DaysPossible: 3}, list[2].Me, "upcoming: no rank")
	assert.Equal(t, ChallengeStatusUpcoming, list[2].Status)

	e0 := list[4]
	assert.Equal(t, ChallengeStatusEnded, e0.Status)
	assert.False(t, e0.Finalized)
	assert.Nil(t, e0.DayNumber)
	assert.Equal(t, dto.ChallengeProgress{Rank: testutil.Ptr(1), DaysElapsed: 3, DaysPossible: 3}, e0.Me,
		"completion is unknown until finalized")

	f := list[7]
	require.Equal(t, finalized.ID, f.ID)
	assert.True(t, f.Finalized)
	assert.Equal(t, dto.ChallengeProgress{
		Rank: testutil.Ptr(3), DaysMet: 2, DaysElapsed: 3, DaysPossible: 3, TotalHours: 9.5, Completed: testutil.Ptr(false),
	}, f.Me, "the stored results")

	// The list shows what the detail shows.
	for _, s := range list {
		detail, err := e.svc.GetDetail(ctx, me.ID, s.ID)
		require.NoError(t, err)
		assert.Equal(t, s, detail.ChallengeSummary, "challenge %d", s.ID)
	}

	t.Run("rival", func(t *testing.T) {
		list, err := e.svc.List(ctx, rival.ID)
		require.NoError(t, err)
		require.Len(t, list, 3)
		assert.Equal(t, []uint{notMine.ID, active1.ID, upcoming2.ID}, []uint{list[0].ID, list[1].ID, list[2].ID})
		assert.Equal(t, testutil.Ptr(1), list[1].Me.Rank, "more hours than me on as many days")
	})

	t.Run("no challenges", func(t *testing.T) {
		list, err := e.svc.List(ctx, e.user(t, "nobody").ID)
		require.NoError(t, err)
		assert.NotNil(t, list)
		assert.Empty(t, list)
	})
}
