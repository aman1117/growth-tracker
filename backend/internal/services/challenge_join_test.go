package services

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/testutil"
	"github.com/aman1117/backend/pkg/models"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestChallengeService_JoinByCode(t *testing.T) {
	e := newChEnv(t, cday)
	ctx := context.Background()
	ann, ben := e.user(t, "ann"), e.user(t, "ben", chAvatar)
	created, err := e.svc.Create(ctx, ann.ID, studyRequest(on(2), 7))
	require.NoError(t, err)

	detail, err := e.svc.JoinByCode(ctx, ben.ID, "  "+strings.ToLower(created.InviteCode)+"\t")
	require.NoError(t, err)
	assert.Equal(t, created.ID, detail.ID)
	assert.Equal(t, 2, detail.ParticipantCount)
	assert.False(t, detail.IsCreator)
	assert.True(t, detail.CanLeave)
	assert.Equal(t, 7, detail.Me.DaysPossible)
	me := participantOf(t, detail, ben.ID)
	assert.True(t, me.IsMe)
	assert.Equal(t, "2026-03-09", me.JoinedOn)
	assert.Equal(t, chUser(ben), me.User)

	notifs := typedNotifications(t, e.db, ann.ID, models.NotifTypeChallengeJoined)
	require.Len(t, notifs, 1)
	n := notifs[0]
	assert.Equal(t, "New challenger 🏁", n.Title)
	assert.Equal(t, "ben joined “Study 2h+”", n.Body)
	assert.EqualValues(t, created.ID, n.Metadata["challenge_id"])
	assert.Equal(t, "Study 2h+", n.Metadata["challenge_title"])
	assert.EqualValues(t, ben.ID, n.Metadata["actor_id"])
	assert.Equal(t, "ben", n.Metadata["actor_username"])
	assert.Equal(t, *ben.ProfilePic, n.Metadata["actor_avatar"])

	t.Run("joining again changes nothing", func(t *testing.T) {
		again, err := e.svc.JoinByCode(ctx, ben.ID, created.InviteCode)
		require.NoError(t, err)
		assert.Equal(t, detail, again)
		assert.Len(t, typedNotifications(t, e.db, ann.ID, models.NotifTypeChallengeJoined), 1)
		assert.EqualValues(t, 2, countRows(t, e.db.Where("challenge_id = ?", created.ID), &models.ChallengeParticipant{}))
	})

	t.Run("unknown and malformed codes", func(t *testing.T) {
		for _, code := range []string{"ZZZZZZZZ", "bad", "", "ABCDEFG0", created.InviteCode + "X"} {
			_, err := e.svc.JoinByCode(ctx, ben.ID, code)
			assert.ErrorIs(t, err, ErrChallengeNotFound, "%q", code)
		}
	})

	t.Run("creators are never notified about themselves", func(t *testing.T) {
		require.NoError(t, e.db.Where("challenge_id = ? AND user_id = ?", created.ID, ann.ID).Delete(&models.ChallengeParticipant{}).Error)
		_, err := e.svc.JoinByCode(ctx, ann.ID, created.InviteCode)
		require.NoError(t, err)
		assert.Len(t, typedNotifications(t, e.db, ann.ID, models.NotifTypeChallengeJoined), 1)
	})
}

func TestChallengeService_JoinByCode_Rules(t *testing.T) {
	e := newChEnv(t, cday)
	ctx := context.Background()
	ann, ben := e.user(t, "ann"), e.user(t, "ben")

	t.Run("ended", func(t *testing.T) {
		ended := e.seed(t, ann, on(-10), 5)
		e.join(t, ended, ann, on(-10))
		_, err := e.svc.JoinByCode(ctx, ben.ID, ended.InviteCode)
		assert.ErrorIs(t, err, ErrChallengeEnded)
		detail, err := e.svc.JoinByCode(ctx, ann.ID, ended.InviteCode)
		require.NoError(t, err, "participants still get the challenge")
		assert.Equal(t, ChallengeStatusEnded, detail.Status)
	})

	t.Run("full", func(t *testing.T) {
		full := e.seed(t, ann, on(1), 5)
		for i := 0; i < constants.ChallengeMaxParticipants; i++ {
			e.join(t, full, testutil.CreateUser(t, e.db), cday)
		}
		_, err := e.svc.JoinByCode(ctx, ben.ID, full.InviteCode)
		assert.ErrorIs(t, err, ErrChallengeFull)
		assert.EqualValues(t, constants.ChallengeMaxParticipants, countRows(t, e.db.Where("challenge_id = ?", full.ID), &models.ChallengeParticipant{}))
	})

	t.Run("open challenge limit", func(t *testing.T) {
		busy := e.user(t, "busy")
		for i := 0; i < constants.ChallengeMaxOpenPerUser; i++ {
			c := e.seed(t, ann, on(i), 3)
			e.join(t, c, busy, cday)
		}
		open := e.seed(t, ann, on(1), 3)
		_, err := e.svc.JoinByCode(ctx, busy.ID, open.InviteCode)
		assert.ErrorIs(t, err, ErrChallengeLimitReached)
	})

	t.Run("late joiner", func(t *testing.T) {
		active := e.seed(t, ann, on(-3), 7)
		e.join(t, active, ann, on(-3))
		e.log(t, ben, models.ActivityStudy, 5, on(-1)) // before joining: does not count
		detail, err := e.svc.JoinByCode(ctx, ben.ID, active.InviteCode)
		require.NoError(t, err)
		assert.Equal(t, 4, detail.Me.DaysPossible)
		assert.Equal(t, 1, detail.Me.DaysElapsed)
		assert.Zero(t, detail.Me.DaysMet)
		assert.Zero(t, detail.Me.TotalHours)
		assert.Equal(t, "---PUUU", participantOf(t, detail, ben.ID).Days)
		assert.Equal(t, testutil.Ptr(DayStatusPending), detail.Me.TodayStatus)
	})
}

func TestChallengeService_JoinByCode_ParticipantCapUnderConcurrency(t *testing.T) {
	e := newChEnv(t, cday)
	ctx := context.Background()
	ann := e.user(t, "ann")
	c := e.seed(t, ann, on(1), 5)
	e.join(t, c, ann, cday)
	for i := 1; i < constants.ChallengeMaxParticipants-5; i++ {
		e.join(t, c, testutil.CreateUser(t, e.db), cday)
	}

	const joiners = 12
	users := make([]uint, joiners)
	for i := range users {
		users[i] = e.user(t, "joiner"+string(rune('a'+i))).ID
	}
	errs := make([]error, joiners)
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i, id := range users {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, errs[i] = e.svc.JoinByCode(ctx, id, c.InviteCode)
		}()
	}
	close(start)
	wg.Wait()

	joined, full := 0, 0
	for _, err := range errs {
		switch {
		case err == nil:
			joined++
		case errors.Is(err, ErrChallengeFull):
			full++
		default:
			t.Errorf("unexpected error: %v", err)
		}
	}
	assert.Equal(t, 5, joined)
	assert.Equal(t, joiners-5, full)
	assert.EqualValues(t, constants.ChallengeMaxParticipants, countRows(t, e.db.Where("challenge_id = ?", c.ID), &models.ChallengeParticipant{}))
	assert.Len(t, typedNotifications(t, e.db, ann.ID, models.NotifTypeChallengeJoined), 5)
}

func TestChallengeService_LeaveAndRejoin(t *testing.T) {
	e := newChEnv(t, cday)
	ctx := context.Background()
	ann, ben := e.user(t, "ann"), e.user(t, "ben")
	created, err := e.svc.Create(ctx, ann.ID, studyRequest(cday, 10))
	require.NoError(t, err)
	_, err = e.svc.JoinByCode(ctx, ben.ID, created.InviteCode)
	require.NoError(t, err)
	for i := 0; i < 3; i++ {
		e.log(t, ben, models.ActivityStudy, 3, on(i))
	}
	_, err = e.svc.Cheer(ctx, ann.ID, created.ID, ben.ID)
	require.NoError(t, err)
	require.NoError(t, e.db.Create(&models.ChallengeInvite{ChallengeID: created.ID, InviterID: ann.ID, InviteeID: ben.ID}).Error)

	e.clock.setDay(on(4))
	require.NoError(t, e.svc.RunDailyJob(ctx))
	require.Equal(t, []string{"2026-03-09", "2026-03-10", "2026-03-11"}, challengeDayDates(t, e.db, created.ID, ben.ID))

	require.NoError(t, e.svc.Leave(ctx, ben.ID, created.ID))
	assert.Empty(t, challengeDayDates(t, e.db, created.ID, ben.ID), "their days go")
	assert.Len(t, challengeDayDates(t, e.db, created.ID, ann.ID), 3, "the others' days stay")
	assert.EqualValues(t, 1, countRows(t, e.db.Where("challenge_id = ?", created.ID), &models.ChallengeCheer{}), "cheers are kept")
	assert.EqualValues(t, 1, countRows(t, e.db.Where("challenge_id = ?", created.ID), &models.ChallengeInvite{}), "invites are kept")
	_, err = e.svc.GetDetail(ctx, ben.ID, created.ID)
	assert.ErrorIs(t, err, ErrChallengeNotFound)
	assert.ErrorIs(t, e.svc.Leave(ctx, ben.ID, created.ID), ErrChallengeNotFound, "leaving twice")

	// Re-joining starts a clean window from the new joining date.
	e.clock.setDay(on(5))
	detail, err := e.svc.JoinByCode(ctx, ben.ID, created.InviteCode)
	require.NoError(t, err)
	me := participantOf(t, detail, ben.ID)
	assert.Equal(t, "2026-03-14", me.JoinedOn)
	assert.Equal(t, "-----PUUUU", me.Days)
	assert.Zero(t, me.DaysMet)
	assert.Zero(t, me.TotalHours)
	assert.Equal(t, 5, me.DaysPossible)
	assert.Len(t, typedNotifications(t, e.db, ann.ID, models.NotifTypeChallengeJoined), 1, "no second notification")

	// Later locks never store days before the new window.
	e.clock.setDay(on(8))
	require.NoError(t, e.svc.RunDailyJob(ctx))
	assert.Equal(t, []string{"2026-03-14", "2026-03-15"}, challengeDayDates(t, e.db, created.ID, ben.ID))
}

func TestChallengeService_Leave(t *testing.T) {
	e := newChEnv(t, cday)
	ctx := context.Background()
	ann, ben, dan := e.user(t, "ann"), e.user(t, "ben"), e.user(t, "dan")
	upcoming := e.seed(t, ann, on(1), 5)
	ended := e.seed(t, ann, on(-10), 5)
	for _, c := range []*models.Challenge{upcoming, ended} {
		e.join(t, c, ann, c.StartDate)
		e.join(t, c, ben, c.StartDate)
	}

	assert.ErrorIs(t, e.svc.Leave(ctx, ann.ID, upcoming.ID), ErrCreatorCannotLeave)
	assert.ErrorIs(t, e.svc.Leave(ctx, dan.ID, upcoming.ID), ErrChallengeNotFound)
	assert.ErrorIs(t, e.svc.Leave(ctx, ben.ID, upcoming.ID+100), ErrChallengeNotFound)
	assert.ErrorIs(t, e.svc.Leave(ctx, ben.ID, ended.ID), ErrChallengeEnded)

	require.NoError(t, e.svc.Leave(ctx, ben.ID, upcoming.ID))
	assert.EqualValues(t, 1, countRows(t, e.db.Where("challenge_id = ?", upcoming.ID), &models.ChallengeParticipant{}))
}

func TestChallengeService_Delete(t *testing.T) {
	e := newChEnv(t, cday)
	ctx := context.Background()
	ann, ben, dan := e.user(t, "ann"), e.user(t, "ben"), e.user(t, "dan")
	seed := func(start int, withBen bool) *models.Challenge {
		c := e.seed(t, ann, on(start), 5)
		e.join(t, c, ann, on(start))
		if withBen {
			e.join(t, c, ben, on(start))
		}
		return c
	}
	exists := func(c *models.Challenge) bool {
		return countRows(t, e.db.Where("id = ?", c.ID), &models.Challenge{}) == 1
	}

	upcoming := seed(1, true)
	assert.ErrorIs(t, e.svc.Delete(ctx, dan.ID, upcoming.ID), ErrChallengeNotFound)
	assert.ErrorIs(t, e.svc.Delete(ctx, ann.ID, upcoming.ID+100), ErrChallengeNotFound)
	assert.ErrorIs(t, e.svc.Delete(ctx, ben.ID, upcoming.ID), ErrNotChallengeCreator)
	e.snapshot(t, upcoming, ben, on(1), 0, false)
	require.NoError(t, e.svc.Delete(ctx, ann.ID, upcoming.ID), "upcoming: allowed with other participants")
	assert.False(t, exists(upcoming))
	assert.Zero(t, countRows(t, e.db.Where("challenge_id = ?", upcoming.ID), &models.ChallengeParticipant{}))
	assert.Zero(t, countRows(t, e.db.Where("challenge_id = ?", upcoming.ID), &models.ChallengeDay{}))

	active := seed(-1, true)
	assert.ErrorIs(t, e.svc.Delete(ctx, ann.ID, active.ID), ErrChallengeInProgress)
	assert.True(t, exists(active))

	ended := seed(-9, true)
	assert.ErrorIs(t, e.svc.Delete(ctx, ann.ID, ended.ID), ErrChallengeInProgress)

	alone := seed(-1, false)
	require.NoError(t, e.svc.Delete(ctx, ann.ID, alone.ID), "active, the creator alone")
	assert.False(t, exists(alone))

	endedAlone := seed(-9, false)
	require.NoError(t, e.svc.Delete(ctx, ann.ID, endedAlone.ID))
	assert.False(t, exists(endedAlone))
}

func TestChallengeService_Cheer(t *testing.T) {
	e := newChEnv(t, cday)
	ctx := context.Background()
	ann, ben, cat, dan := e.user(t, "ann", chAvatar), e.user(t, "ben"), e.user(t, "cat"), e.user(t, "dan")
	active := e.seed(t, ann, on(-1), 5)
	upcoming := e.seed(t, ann, on(1), 5)
	ended := e.seed(t, ann, on(-9), 5)
	for _, c := range []*models.Challenge{active, upcoming, ended} {
		for _, u := range []*models.User{ann, ben, cat} {
			e.join(t, c, u, c.StartDate)
		}
	}

	_, err := e.svc.Cheer(ctx, ann.ID, active.ID, ann.ID)
	assert.ErrorIs(t, err, ErrCannotCheerSelf)
	_, err = e.svc.Cheer(ctx, ann.ID, active.ID, dan.ID)
	assertValidationCode(t, err, constants.ErrCodeInvalidChallenge)
	_, err = e.svc.Cheer(ctx, dan.ID, active.ID, ann.ID)
	assert.ErrorIs(t, err, ErrChallengeNotFound, "only participants cheer")
	_, err = e.svc.Cheer(ctx, ann.ID, active.ID+100, ben.ID)
	assert.ErrorIs(t, err, ErrChallengeNotFound)
	for _, c := range []*models.Challenge{upcoming, ended} {
		_, err = e.svc.Cheer(ctx, ann.ID, c.ID, ben.ID)
		assert.ErrorIs(t, err, ErrChallengeNotActive)
	}
	assert.Empty(t, typedNotifications(t, e.db, ben.ID, models.NotifTypeChallengeCheer))

	already, err := e.svc.Cheer(ctx, ann.ID, active.ID, ben.ID)
	require.NoError(t, err)
	assert.False(t, already)
	notifs := typedNotifications(t, e.db, ben.ID, models.NotifTypeChallengeCheer)
	require.Len(t, notifs, 1)
	assert.Equal(t, "You got a cheer 👏", notifs[0].Title)
	assert.Equal(t, "ann cheered you on in “Study 2h+”", notifs[0].Body)
	assert.EqualValues(t, active.ID, notifs[0].Metadata["challenge_id"])
	assert.EqualValues(t, ann.ID, notifs[0].Metadata["actor_id"])
	assert.Equal(t, *ann.ProfilePic, notifs[0].Metadata["actor_avatar"])

	already, err = e.svc.Cheer(ctx, ann.ID, active.ID, ben.ID)
	require.NoError(t, err)
	assert.True(t, already, "once per day")
	assert.Len(t, typedNotifications(t, e.db, ben.ID, models.NotifTypeChallengeCheer), 1)

	already, err = e.svc.Cheer(ctx, cat.ID, active.ID, ben.ID)
	require.NoError(t, err)
	assert.False(t, already, "another participant")
	assert.Len(t, typedNotifications(t, e.db, ben.ID, models.NotifTypeChallengeCheer), 2)

	detail, err := e.svc.GetDetail(ctx, ann.ID, active.ID)
	require.NoError(t, err)
	assert.True(t, participantOf(t, detail, ben.ID).CheeredToday)
	assert.False(t, participantOf(t, detail, cat.ID).CheeredToday)

	e.clock.setDay(on(1))
	already, err = e.svc.Cheer(ctx, ann.ID, active.ID, ben.ID)
	require.NoError(t, err)
	assert.False(t, already, "again the next day")
	assert.Len(t, typedNotifications(t, e.db, ben.ID, models.NotifTypeChallengeCheer), 3)
	detail, err = e.svc.GetDetail(ctx, cat.ID, active.ID)
	require.NoError(t, err)
	assert.False(t, participantOf(t, detail, ben.ID).CheeredToday, "Cat cheered yesterday")
}
