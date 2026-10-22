package services

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/dto"
	"github.com/aman1117/backend/internal/testutil"
	"github.com/aman1117/backend/pkg/models"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestChallengeService_Invite(t *testing.T) {
	e := newChEnv(t, cday)
	ctx := context.Background()
	ann, ben := e.user(t, "ann", chAvatar), e.user(t, "ben")
	iFollow, followsMe := e.user(t, "ifollow"), e.user(t, "followsme")
	stranger, pending := e.user(t, "stranger"), e.user(t, "pending")
	makeFollow(t, e.db, ann.ID, iFollow.ID, models.FollowStateActive)
	makeFollow(t, e.db, followsMe.ID, ann.ID, models.FollowStateActive)
	makeFollow(t, e.db, ann.ID, pending.ID, models.FollowStatePending)
	makeFollow(t, e.db, ann.ID, ben.ID, models.FollowStateActive)
	makeFollow(t, e.db, ben.ID, iFollow.ID, models.FollowStateActive)
	created, err := e.svc.Create(ctx, ann.ID, studyRequest(on(1), 7))
	require.NoError(t, err)
	_, err = e.svc.JoinByCode(ctx, ben.ID, created.InviteCode)
	require.NoError(t, err)

	t.Run("validation", func(t *testing.T) {
		_, _, err := e.svc.Invite(ctx, ann.ID, created.ID, nil)
		assertValidationCode(t, err, constants.ErrCodeInvalidChallenge)
		tooMany := make([]uint, constants.ChallengeMaxInvitesPerRequest+1)
		for i := range tooMany {
			tooMany[i] = uint(i + 1)
		}
		_, _, err = e.svc.Invite(ctx, ann.ID, created.ID, tooMany)
		assertValidationCode(t, err, constants.ErrCodeInvalidChallenge)
	})

	t.Run("participants only", func(t *testing.T) {
		_, _, err := e.svc.Invite(ctx, stranger.ID, created.ID, []uint{ann.ID})
		assert.ErrorIs(t, err, ErrChallengeNotFound)
		_, _, err = e.svc.Invite(ctx, ann.ID, created.ID+100, []uint{iFollow.ID})
		assert.ErrorIs(t, err, ErrChallengeNotFound)
	})

	ids := []uint{followsMe.ID, iFollow.ID, stranger.ID, pending.ID, ben.ID, ann.ID, 99999, iFollow.ID, 0}
	invited, skipped, err := e.svc.Invite(ctx, ann.ID, created.ID, ids)
	require.NoError(t, err)
	assert.Equal(t, 2, invited)
	assert.Equal(t, len(ids)-2, skipped, "invited + skipped = number of ids")

	for _, u := range []*models.User{iFollow, followsMe} {
		notifs := typedNotifications(t, e.db, u.ID, models.NotifTypeChallengeInvite)
		require.Len(t, notifs, 1, u.Username)
		n := notifs[0]
		assert.Equal(t, "Challenge invite 🏆", n.Title)
		assert.Equal(t, "ann invited you to “Study 2h+”", n.Body)
		assert.EqualValues(t, created.ID, n.Metadata["challenge_id"])
		assert.Equal(t, "Study 2h+", n.Metadata["challenge_title"])
		assert.Equal(t, created.InviteCode, n.Metadata["invite_code"])
		assert.EqualValues(t, ann.ID, n.Metadata["actor_id"])
		assert.Equal(t, "ann", n.Metadata["actor_username"])
		assert.Equal(t, *ann.ProfilePic, n.Metadata["actor_avatar"])
	}
	for _, u := range []*models.User{stranger, pending, ben} {
		assert.Empty(t, typedNotifications(t, e.db, u.ID, models.NotifTypeChallengeInvite), u.Username)
	}

	invited, skipped, err = e.svc.Invite(ctx, ann.ID, created.ID, []uint{iFollow.ID, followsMe.ID})
	require.NoError(t, err)
	assert.Equal(t, 0, invited, "a user is invited once")
	assert.Equal(t, 2, skipped)
	invited, _, err = e.svc.Invite(ctx, ben.ID, created.ID, []uint{iFollow.ID})
	require.NoError(t, err)
	assert.Equal(t, 0, invited, "...by anyone")
	assert.Len(t, typedNotifications(t, e.db, iFollow.ID, models.NotifTypeChallengeInvite), 1)

	t.Run("ended", func(t *testing.T) {
		ended := e.seed(t, ann, on(-9), 5)
		e.join(t, ended, ann, on(-9))
		_, _, err := e.svc.Invite(ctx, ann.ID, ended.ID, []uint{iFollow.ID})
		assert.ErrorIs(t, err, ErrChallengeEnded)
	})
}

func TestChallengeService_InviteCandidates(t *testing.T) {
	e := newChEnv(t, cday)
	ctx := context.Background()
	ann, ben, stranger := e.user(t, "ann"), e.user(t, "ben"), e.user(t, "stranger")
	amy, abe := e.user(t, "amy", chAvatar), e.user(t, "abe")
	makeFollow(t, e.db, ann.ID, amy.ID, models.FollowStateActive)
	makeFollow(t, e.db, abe.ID, ann.ID, models.FollowStateActive)
	makeFollow(t, e.db, ann.ID, ben.ID, models.FollowStateActive)
	c := e.seed(t, ann, on(1), 5)
	e.join(t, c, ann, cday)
	e.join(t, c, ben, cday)
	require.NoError(t, e.db.Create(&models.ChallengeInvite{ChallengeID: c.ID, InviterID: ben.ID, InviteeID: abe.ID}).Error)

	_, err := e.svc.InviteCandidates(ctx, stranger.ID, c.ID, "", 20)
	assert.ErrorIs(t, err, ErrChallengeNotFound)
	_, err = e.svc.InviteCandidates(ctx, ann.ID, c.ID+100, "", 20)
	assert.ErrorIs(t, err, ErrChallengeNotFound)

	users, err := e.svc.InviteCandidates(ctx, ann.ID, c.ID, "", 0)
	require.NoError(t, err)
	assert.Equal(t, []dto.InviteCandidate{
		{ChallengeUser: chUser(abe), Invited: true},
		{ChallengeUser: chUser(amy)},
	}, users, "ben takes part already")

	users, err = e.svc.InviteCandidates(ctx, ann.ID, c.ID, "  AM ", 20)
	require.NoError(t, err)
	assert.Equal(t, []dto.InviteCandidate{{ChallengeUser: chUser(amy)}}, users, "trimmed, case-insensitive prefix")

	users, err = e.svc.InviteCandidates(ctx, ann.ID, c.ID, strings.Repeat("a", constants.UsernameMaxLength+1), 20)
	require.NoError(t, err)
	assert.NotNil(t, users)
	assert.Empty(t, users, "no username is that long")

	users, err = e.svc.InviteCandidates(ctx, ann.ID, c.ID, "", 1)
	require.NoError(t, err)
	assert.Len(t, users, 1)

	t.Run("at most 50", func(t *testing.T) {
		for i := 0; i < constants.ChallengeCandidatesMax+1; i++ {
			u := testutil.CreateUser(t, e.db, func(u *models.User) { u.Username = fmt.Sprintf("friend%02d", i) })
			require.NoError(t, e.db.Create(&models.FollowEdgeByFollower{FollowerID: ann.ID, FolloweeID: u.ID, State: models.FollowStateActive}).Error)
		}
		users, err := e.svc.InviteCandidates(ctx, ann.ID, c.ID, "friend", 500)
		require.NoError(t, err)
		assert.Len(t, users, constants.ChallengeCandidatesMax)
	})
}

func TestChallengeService_PreviewByCode(t *testing.T) {
	e := newChEnv(t, cday)
	ctx := context.Background()
	ann, outsider := e.user(t, "ann", chAvatar), e.user(t, "outsider")
	c := e.seed(t, ann, on(2), 7)
	e.join(t, c, ann, cday)
	var members []*models.User
	for i := 0; i < 6; i++ {
		u := e.user(t, fmt.Sprintf("member%d", i))
		e.join(t, c, u, cday)
		members = append(members, u)
	}

	preview, err := e.svc.PreviewByCode(ctx, outsider.ID, " "+strings.ToLower(c.InviteCode))
	require.NoError(t, err)
	assert.Equal(t, &dto.ChallengePreview{
		ID: c.ID, Title: "Study 2h+", Activity: "study", GoalType: models.ChallengeGoalAtLeast, TargetHours: 2,
		StartDate: "2026-03-11", EndDate: "2026-03-17", DurationDays: 7, Status: ChallengeStatusUpcoming,
		ParticipantCount: 7, MaxParticipants: 50, Creator: chUser(ann),
		ParticipantsPreview: []dto.ChallengeUser{chUser(ann), chUser(members[0]), chUser(members[1]), chUser(members[2]), chUser(members[3])},
		CanJoin:             true,
	}, preview)

	preview, err = e.svc.PreviewByCode(ctx, members[5].ID, c.InviteCode)
	require.NoError(t, err)
	assert.True(t, preview.IsParticipant)
	assert.False(t, preview.CanJoin)
	assert.Nil(t, preview.JoinBlockedReason)

	for _, code := range []string{"ZZZZZZZZ", "nope"} {
		_, err = e.svc.PreviewByCode(ctx, outsider.ID, code)
		assert.ErrorIs(t, err, ErrChallengeNotFound)
	}

	blocked := func(t *testing.T, code, reason string) {
		t.Helper()
		preview, err := e.svc.PreviewByCode(ctx, outsider.ID, code)
		require.NoError(t, err)
		assert.False(t, preview.CanJoin)
		assert.Equal(t, testutil.Ptr(reason), preview.JoinBlockedReason)
	}

	t.Run("ended", func(t *testing.T) {
		ended := e.seed(t, ann, on(-9), 5, func(c *models.Challenge) { c.FinalizedAt = testutil.Ptr(e.clock.Now()) })
		e.join(t, ended, ann, on(-9))
		blocked(t, ended.InviteCode, JoinBlockedEnded)
		preview, err := e.svc.PreviewByCode(ctx, outsider.ID, ended.InviteCode)
		require.NoError(t, err)
		assert.True(t, preview.Finalized)
		assert.Equal(t, ChallengeStatusEnded, preview.Status)
	})

	t.Run("full", func(t *testing.T) {
		full := e.seed(t, ann, on(1), 5)
		for i := 0; i < constants.ChallengeMaxParticipants; i++ {
			e.join(t, full, testutil.CreateUser(t, e.db), cday)
		}
		blocked(t, full.InviteCode, JoinBlockedFull)
		preview, err := e.svc.PreviewByCode(ctx, outsider.ID, full.InviteCode)
		require.NoError(t, err)
		assert.Len(t, preview.ParticipantsPreview, constants.ChallengePreviewParticipants)
		assert.Equal(t, constants.ChallengeMaxParticipants, preview.ParticipantCount)
	})

	t.Run("open challenge limit", func(t *testing.T) {
		for i := 0; i < constants.ChallengeMaxOpenPerUser; i++ {
			other := e.seed(t, ann, on(1), 5)
			e.join(t, other, outsider, cday)
		}
		blocked(t, c.InviteCode, JoinBlockedLimit)
	})
}
