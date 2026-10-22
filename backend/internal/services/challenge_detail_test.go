package services

import (
	"context"
	"testing"

	"github.com/aman1117/backend/internal/dto"
	"github.com/aman1117/backend/internal/testutil"
	"github.com/aman1117/backend/pkg/models"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Study 2h+ over 7 days, on day 5, with the first 3 days locked. Ann (the creator) joined
// before the start, Ben on the start date and Cat on day 4.
func TestChallengeService_GetDetail_AtLeast(t *testing.T) {
	today := on(4)
	e := newChEnv(t, today)
	ctx := context.Background()
	ann, ben, cat, dan := e.user(t, "ann", chAvatar), e.user(t, "ben"), e.user(t, "cat"), e.user(t, "dan")
	c := e.seed(t, ann, cday, 7, func(c *models.Challenge) { lt := on(2); c.LockedThrough = &lt })
	e.join(t, c, ann, on(-1))
	e.join(t, c, ben, cday)
	e.join(t, c, cat, on(3))
	e.snapshot(t, c, ann, cday, 2, true)
	e.snapshot(t, c, ann, on(1), 3, true)
	e.snapshot(t, c, ann, on(2), 1, false)
	e.snapshot(t, c, ben, cday, 2.5, true)
	e.snapshot(t, c, ben, on(1), 2, true)
	e.snapshot(t, c, ben, on(2), 2, true)
	e.log(t, ann, models.ActivityStudy, 5, on(2)) // logged after the day was locked: ignored
	e.log(t, ann, models.ActivityStudy, 2, on(3))
	e.log(t, ann, models.ActivityStudy, 2.5, today)
	e.log(t, ann, models.ActivitySleep, 8, today)
	e.log(t, ben, models.ActivityStudy, 1, on(3))
	e.log(t, cat, models.ActivityStudy, 9, on(2)) // before Cat joined: ignored
	e.log(t, cat, models.ActivityStudy, 4, on(3))
	e.log(t, cat, models.ActivityStudy, 1, today)
	cheered, err := e.svc.Cheer(ctx, ann.ID, c.ID, ben.ID)
	require.NoError(t, err)
	require.False(t, cheered)

	annProgress := dto.ChallengeProgress{
		Rank: testutil.Ptr(1), DaysMet: 4, DaysElapsed: 5, DaysPossible: 7, CurrentStreak: 2, TotalHours: 10.5,
		TodayHours: testutil.Ptr(2.5), TodayStatus: testutil.Ptr(DayStatusMet),
	}
	benProgress := dto.ChallengeProgress{
		Rank: testutil.Ptr(2), DaysMet: 3, DaysElapsed: 5, DaysPossible: 7, CurrentStreak: 0, TotalHours: 7.5,
		TodayHours: testutil.Ptr(0.0), TodayStatus: testutil.Ptr(DayStatusPending),
	}
	catProgress := dto.ChallengeProgress{
		Rank: testutil.Ptr(3), DaysMet: 1, DaysElapsed: 2, DaysPossible: 4, CurrentStreak: 1, TotalHours: 5,
		TodayHours: testutil.Ptr(1.0), TodayStatus: testutil.Ptr(DayStatusPending),
	}

	detail, err := e.svc.GetDetail(ctx, ann.ID, c.ID)
	require.NoError(t, err)
	assert.Equal(t, dto.ChallengeSummary{
		ID: c.ID, Title: "Study 2h+", Activity: "study", GoalType: models.ChallengeGoalAtLeast, TargetHours: 2,
		StartDate: "2026-03-09", EndDate: "2026-03-15", DurationDays: 7, Status: ChallengeStatusActive,
		DayNumber: testutil.Ptr(5), ParticipantCount: 3, IsCreator: true, Me: annProgress,
	}, detail.ChallengeSummary)
	assert.Equal(t, c.InviteCode, detail.InviteCode)
	assert.Equal(t, "2026-03-13", detail.Today)
	assert.Equal(t, testutil.Ptr("2026-03-11"), detail.LockedThrough)
	assert.Equal(t, "2026-03-17", detail.ResultsDate)
	assert.Equal(t, 6, detail.CompletionDays)
	assert.Equal(t, chUser(ann), detail.Creator)
	assert.True(t, detail.CanInvite)
	assert.False(t, detail.CanLeave)
	assert.False(t, detail.CanDelete, "started, with other participants")
	assert.Equal(t, []dto.ChallengeParticipant{
		{ChallengeProgress: annProgress, User: chUser(ann), JoinedOn: "2026-03-08", IsMe: true, Days: "MMXMMUU"},
		{ChallengeProgress: benProgress, User: chUser(ben), JoinedOn: "2026-03-09", CheeredToday: true, Days: "MMMPPUU"},
		{ChallengeProgress: catProgress, User: chUser(cat), JoinedOn: "2026-03-12", Days: "---MPUU"},
	}, detail.Participants)
	assert.Equal(t, []dto.ChallengeDay{
		{Date: "2026-03-09", Hours: testutil.Ptr(2.0), Status: DayStatusMet, Locked: true},
		{Date: "2026-03-10", Hours: testutil.Ptr(3.0), Status: DayStatusMet, Locked: true},
		{Date: "2026-03-11", Hours: testutil.Ptr(1.0), Status: DayStatusMissed, Locked: true},
		{Date: "2026-03-12", Hours: testutil.Ptr(2.0), Status: DayStatusMet},
		{Date: "2026-03-13", Hours: testutil.Ptr(2.5), Status: DayStatusMet},
		{Date: "2026-03-14", Status: DayStatusUpcoming},
		{Date: "2026-03-15", Status: DayStatusUpcoming},
	}, detail.MyDays)

	t.Run("seen by another participant", func(t *testing.T) {
		detail, err := e.svc.GetDetail(ctx, ben.ID, c.ID)
		require.NoError(t, err)
		assert.False(t, detail.IsCreator)
		assert.Equal(t, benProgress, detail.Me)
		assert.True(t, detail.CanLeave)
		assert.False(t, detail.CanDelete)
		assert.True(t, participantOf(t, detail, ben.ID).IsMe)
		assert.False(t, participantOf(t, detail, ann.ID).IsMe)
		for _, p := range detail.Participants {
			assert.False(t, p.CheeredToday, "Ben cheered nobody")
		}
		assert.Equal(t, dto.ChallengeDay{Date: "2026-03-12", Hours: testutil.Ptr(1.0), Status: DayStatusPending}, detail.MyDays[3])
	})

	t.Run("a late joiner's days before joining", func(t *testing.T) {
		detail, err := e.svc.GetDetail(ctx, cat.ID, c.ID)
		require.NoError(t, err)
		assert.Equal(t, catProgress, detail.Me)
		assert.Equal(t, dto.ChallengeDay{Date: "2026-03-09", Status: DayStatusNone, Locked: true}, detail.MyDays[0])
		assert.Equal(t, dto.ChallengeDay{Date: "2026-03-12", Hours: testutil.Ptr(4.0), Status: DayStatusMet}, detail.MyDays[3])
	})

	t.Run("the list agrees", func(t *testing.T) {
		for _, u := range []*models.User{ann, ben, cat} {
			list, err := e.svc.List(ctx, u.ID)
			require.NoError(t, err)
			require.Len(t, list, 1)
			detail, err := e.svc.GetDetail(ctx, u.ID, c.ID)
			require.NoError(t, err)
			assert.Equal(t, detail.ChallengeSummary, list[0], u.Username)
		}
	})

	t.Run("not a participant", func(t *testing.T) {
		_, err := e.svc.GetDetail(ctx, dan.ID, c.ID)
		assert.ErrorIs(t, err, ErrChallengeNotFound)
		_, err = e.svc.GetDetail(ctx, ann.ID, c.ID+100)
		assert.ErrorIs(t, err, ErrChallengeNotFound)
	})
}

// Reels at most 1h a day, on day 3, nothing locked.
func TestChallengeService_GetDetail_AtMost(t *testing.T) {
	today := on(2)
	e := newChEnv(t, today)
	ctx := context.Background()
	maxU, lee, kim := e.user(t, "max"), e.user(t, "lee"), e.user(t, "kim")
	c := e.seed(t, maxU, cday, 5, func(c *models.Challenge) {
		c.Title, c.Activity, c.GoalType, c.TargetHours = "Reels ≤ 1h", string(models.ActivityReels), models.ChallengeGoalAtMost, 1
	})
	e.join(t, c, maxU, cday)
	e.join(t, c, lee, cday)
	e.join(t, c, kim, cday)
	e.log(t, maxU, models.ActivityReels, 0.5, cday)
	e.log(t, maxU, models.ActivityStudy, 3, on(1)) // logged, but no reels at all: met
	e.log(t, lee, models.ActivityReels, 2, cday)   // over the limit: missed
	e.log(t, lee, models.ActivityReels, 0.75, today)
	e.log(t, kim, models.ActivityReels, 0.25, cday)
	e.log(t, kim, models.ActivityReels, 0.25, on(1))

	detail, err := e.svc.GetDetail(ctx, lee.ID, c.ID)
	require.NoError(t, err)
	got := map[string]dto.ChallengeParticipant{}
	order := []string{}
	for _, p := range detail.Participants {
		got[p.User.Username] = p
		order = append(order, p.User.Username)
	}
	assert.Equal(t, []string{"kim", "max", "lee"}, order, "by rank, ties by username")

	assert.Equal(t, dto.ChallengeProgress{
		Rank: testutil.Ptr(1), DaysMet: 2, DaysElapsed: 3, DaysPossible: 5, CurrentStreak: 2, TotalHours: 0.5,
		TodayHours: testutil.Ptr(0.0), TodayStatus: testutil.Ptr(DayStatusPending),
	}, got["max"].ChallengeProgress, "nothing logged today: pending, yesterday's streak counts")
	assert.Equal(t, "MMPUU", got["max"].Days)
	assert.Equal(t, got["max"].ChallengeProgress, got["kim"].ChallengeProgress, "same days and hours share rank 1")
	assert.Equal(t, dto.ChallengeProgress{
		Rank: testutil.Ptr(3), DaysMet: 1, DaysElapsed: 3, DaysPossible: 5, CurrentStreak: 1, TotalHours: 2.75,
		TodayHours: testutil.Ptr(0.75), TodayStatus: testutil.Ptr(DayStatusMet),
	}, got["lee"].ChallengeProgress)
	assert.Equal(t, "XPMUU", got["lee"].Days, "an unlogged past day stays pending until it locks")
	assert.Equal(t, []dto.ChallengeDay{
		{Date: "2026-03-09", Hours: testutil.Ptr(2.0), Status: DayStatusMissed},
		{Date: "2026-03-10", Hours: testutil.Ptr(0.0), Status: DayStatusPending},
		{Date: "2026-03-11", Hours: testutil.Ptr(0.75), Status: DayStatusMet},
		{Date: "2026-03-12", Status: DayStatusUpcoming},
		{Date: "2026-03-13", Status: DayStatusUpcoming},
	}, detail.MyDays)

	// Fewer hours rank higher: one more quarter hour costs Kim the tie.
	e.log(t, kim, models.ActivityReels, 0.25, on(1))
	detail, err = e.svc.GetDetail(ctx, lee.ID, c.ID)
	require.NoError(t, err)
	assert.Equal(t, testutil.Ptr(1), participantOf(t, detail, maxU.ID).Rank)
	assert.Equal(t, testutil.Ptr(2), participantOf(t, detail, kim.ID).Rank)
	assert.Equal(t, testutil.Ptr(3), participantOf(t, detail, lee.ID).Rank)
}

func TestChallengeService_GetDetail_Flags(t *testing.T) {
	e := newChEnv(t, cday)
	ctx := context.Background()
	ann, ben := e.user(t, "ann"), e.user(t, "ben")

	tests := []struct {
		name                        string
		start                       int
		withBen                     bool
		viewer                      *models.User
		canInvite, canLeave, canDel bool
	}{
		{"upcoming, creator with others", 1, true, ann, true, false, true},
		{"upcoming, participant", 1, true, ben, true, true, false},
		{"active, creator alone", -1, false, ann, true, false, true},
		{"active, creator with others", -1, true, ann, true, false, false},
		{"active, participant", -1, true, ben, true, true, false},
		{"ended, creator alone", -9, false, ann, false, false, true},
		{"ended, creator with others", -9, true, ann, false, false, false},
		{"ended, participant", -9, true, ben, false, false, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c := e.seed(t, ann, on(tt.start), 5)
			e.join(t, c, ann, on(tt.start))
			if tt.withBen {
				e.join(t, c, ben, on(tt.start))
			}
			detail, err := e.svc.GetDetail(ctx, tt.viewer.ID, c.ID)
			require.NoError(t, err)
			assert.Equal(t, tt.canInvite, detail.CanInvite, "can_invite")
			assert.Equal(t, tt.canLeave, detail.CanLeave, "can_leave")
			assert.Equal(t, tt.canDel, detail.CanDelete, "can_delete")
		})
	}
}
