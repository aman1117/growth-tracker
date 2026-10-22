package services

import (
	"context"
	"testing"

	"github.com/aman1117/backend/internal/testutil"
	"github.com/aman1117/backend/pkg/models"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

// Statements of ChallengeRepository, for fault injection.
var (
	failListForUser       = failingOn("row", "", "UNION ALL")
	failListParticipants  = failingOn("row", "", "JOIN users u ON u.id = p.user_id")
	failLockedTotals      = failingOn("row", "", "FILTER (WHERE d.met)")
	failActivityDays      = failingOn("row", "", "FILTER (WHERE a.name = c.activity)")
	failListUserDays      = failingOn("query", "challenge_days", "user_id = ? AND challenge_id IN ?")
	failListDays          = failingOn("query", "challenge_days", "challenge_id = ?")
	failCheeredUserIDs    = failingOn("query", "challenge_cheers")
	failCreateCheer       = failingOn("create", "challenge_cheers")
	failFindByCode        = failingOn("query", "challenges", "invite_code = ?")
	failFindParticipant   = failingOn("query", "challenge_participants", "challenge_id = ? AND user_id = ?")
	failCountOpen         = failingOn("query", "challenge_participants", "c.end_date >= ?")
	failLockUser          = failingOn("row", "", "FOR NO KEY UPDATE")
	failAddParticipant    = failingOn("create", "challenge_participants")
	failCreateChallenge   = failingOn("create", "challenges")
	failRemoveParticipant = failingOn("delete", "challenge_participants")
	failDeleteChallenge   = failingOn("delete", "challenges")
	failCreateInvites     = failingOn("row", "", "INSERT INTO challenge_invites")
	failStaleInvites      = failingOn("raw", "", "DELETE FROM challenge_invites")
	failInviteCandidates  = failingOn("row", "", "ESCAPE")
	failInsertDays        = failingOn("create", "challenge_days")
	failSetLockedThrough  = failingOn("update", "challenges", "locked_through IS NULL OR locked_through < ?")
	failMarkFinalized     = failingOn("update", "challenges", "finalized_at IS NULL")
	failSaveFinalResults  = failingOn("raw", "", "UPDATE challenge_participants AS p")
	failIDsToLock         = failingOn("query", "challenges", "start_date <= ?")
	failIDsToFinalize     = failingOn("query", "challenges", "locked_through >= end_date")
	// failChallengeByID matches FindByID and the row lock of WithLockedChallenge.
	failChallengeByID = failingOn("query", "challenges", "id = ?")
)

// failCountParticipants matches CountParticipants (and not FindParticipant).
func failCountParticipants(s stmtInfo) bool {
	return s.is("query", "challenge_participants") && s.has("challenge_id = ?") && !s.has("user_id")
}

// failingChallenges returns a ChallengeService whose challenge queries run on a faultyDB.
func (e *chEnv) failingChallenges(t *testing.T, fail func(stmtInfo) bool) *ChallengeService {
	t.Helper()
	return e.service(faultyDB(t, fail), e.db, e.db)
}

func TestChallengeService_QueryFailures(t *testing.T) {
	e := newChEnv(t, on(3))
	ctx := context.Background()
	ann, ben, outsider := e.user(t, "ann"), e.user(t, "ben"), e.user(t, "outsider")
	active := e.seed(t, ann, cday, 7)
	e.join(t, active, ann, cday)
	e.join(t, active, ben, cday)
	makeFollow(t, e.db, ann.ID, outsider.ID, models.FollowStateActive)

	tests := []struct {
		name string
		fail func(stmtInfo) bool
		call func(svc *ChallengeService) error
	}{
		{"list: challenges", failListForUser, func(s *ChallengeService) error { _, err := s.List(ctx, ann.ID); return err }},
		{"list: participants", failListParticipants, func(s *ChallengeService) error { _, err := s.List(ctx, ann.ID); return err }},
		{"list: locked totals", failLockedTotals, func(s *ChallengeService) error { _, err := s.List(ctx, ann.ID); return err }},
		{"list: activity", failActivityDays, func(s *ChallengeService) error { _, err := s.List(ctx, ann.ID); return err }},
		{"list: my days", failListUserDays, func(s *ChallengeService) error { _, err := s.List(ctx, ann.ID); return err }},
		{"detail: challenge", failChallengeByID, func(s *ChallengeService) error { _, err := s.GetDetail(ctx, ann.ID, active.ID); return err }},
		{"detail: participants", failListParticipants, func(s *ChallengeService) error { _, err := s.GetDetail(ctx, ann.ID, active.ID); return err }},
		{"detail: locked days", failListDays, func(s *ChallengeService) error { _, err := s.GetDetail(ctx, ann.ID, active.ID); return err }},
		{"detail: activity", failActivityDays, func(s *ChallengeService) error { _, err := s.GetDetail(ctx, ann.ID, active.ID); return err }},
		{"detail: cheers", failCheeredUserIDs, func(s *ChallengeService) error { _, err := s.GetDetail(ctx, ann.ID, active.ID); return err }},
		{"candidates: challenge", failChallengeByID, func(s *ChallengeService) error {
			_, err := s.InviteCandidates(ctx, ann.ID, active.ID, "", 20)
			return err
		}},
		{"candidates: participant", failFindParticipant, func(s *ChallengeService) error {
			_, err := s.InviteCandidates(ctx, ann.ID, active.ID, "", 20)
			return err
		}},
		{"candidates: users", failInviteCandidates, func(s *ChallengeService) error {
			_, err := s.InviteCandidates(ctx, ann.ID, active.ID, "", 20)
			return err
		}},
		{"preview: code", failFindByCode, func(s *ChallengeService) error {
			_, err := s.PreviewByCode(ctx, outsider.ID, active.InviteCode)
			return err
		}},
		{"preview: participants", failListParticipants, func(s *ChallengeService) error {
			_, err := s.PreviewByCode(ctx, outsider.ID, active.InviteCode)
			return err
		}},
		{"preview: open challenges", failCountOpen, func(s *ChallengeService) error {
			_, err := s.PreviewByCode(ctx, outsider.ID, active.InviteCode)
			return err
		}},
		{"cheer: participants", failListParticipants, func(s *ChallengeService) error { _, err := s.Cheer(ctx, ann.ID, active.ID, ben.ID); return err }},
		{"cheer: store", failCreateCheer, func(s *ChallengeService) error { _, err := s.Cheer(ctx, ann.ID, active.ID, ben.ID); return err }},
		{"invite: challenge", failChallengeByID, func(s *ChallengeService) error {
			_, _, err := s.Invite(ctx, ann.ID, active.ID, []uint{outsider.ID})
			return err
		}},
		{"invite: store", failCreateInvites, func(s *ChallengeService) error {
			_, _, err := s.Invite(ctx, ann.ID, active.ID, []uint{outsider.ID})
			return err
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.call(e.failingChallenges(t, tt.fail))
			require.ErrorIs(t, err, errInjected)
			assert.NotErrorIs(t, err, ErrChallengeNotFound)
		})
	}
	assert.Zero(t, countRows(t, e.db, &models.ChallengeCheer{}))
	assert.Zero(t, countRows(t, e.db, &models.ChallengeInvite{}))
}

func TestChallengeService_CommandFailures(t *testing.T) {
	e := newChEnv(t, on(3))
	ctx := context.Background()
	ann, ben, joiner := e.user(t, "ann"), e.user(t, "ben"), e.user(t, "joiner")
	active := e.seed(t, ann, cday, 7)
	e.join(t, active, ann, cday)
	e.join(t, active, ben, cday)

	tests := []struct {
		name string
		fail func(stmtInfo) bool
		call func(svc *ChallengeService) error
	}{
		{"create: lock user", failLockUser, func(s *ChallengeService) error {
			_, err := s.Create(ctx, joiner.ID, studyRequest(on(3), 3))
			return err
		}},
		{"create: open challenges", failCountOpen, func(s *ChallengeService) error {
			_, err := s.Create(ctx, joiner.ID, studyRequest(on(3), 3))
			return err
		}},
		{"create: challenge", failCreateChallenge, func(s *ChallengeService) error {
			_, err := s.Create(ctx, joiner.ID, studyRequest(on(3), 3))
			return err
		}},
		{"create: participant", failAddParticipant, func(s *ChallengeService) error {
			_, err := s.Create(ctx, joiner.ID, studyRequest(on(3), 3))
			return err
		}},
		{"join: code", failFindByCode, func(s *ChallengeService) error { _, err := s.JoinByCode(ctx, joiner.ID, active.InviteCode); return err }},
		{"join: lock", failChallengeByID, func(s *ChallengeService) error { _, err := s.JoinByCode(ctx, joiner.ID, active.InviteCode); return err }},
		{"join: participant", failFindParticipant, func(s *ChallengeService) error { _, err := s.JoinByCode(ctx, joiner.ID, active.InviteCode); return err }},
		{"join: count", failCountParticipants, func(s *ChallengeService) error { _, err := s.JoinByCode(ctx, joiner.ID, active.InviteCode); return err }},
		{"join: lock user", failLockUser, func(s *ChallengeService) error { _, err := s.JoinByCode(ctx, joiner.ID, active.InviteCode); return err }},
		{"join: open challenges", failCountOpen, func(s *ChallengeService) error { _, err := s.JoinByCode(ctx, joiner.ID, active.InviteCode); return err }},
		{"join: store", failAddParticipant, func(s *ChallengeService) error { _, err := s.JoinByCode(ctx, joiner.ID, active.InviteCode); return err }},
		{"leave: participant", failFindParticipant, func(s *ChallengeService) error { return s.Leave(ctx, ben.ID, active.ID) }},
		{"leave: remove", failRemoveParticipant, func(s *ChallengeService) error { return s.Leave(ctx, ben.ID, active.ID) }},
		{"delete: participant", failFindParticipant, func(s *ChallengeService) error { return s.Delete(ctx, ann.ID, active.ID) }},
		{"delete: count", failCountParticipants, func(s *ChallengeService) error { return s.Delete(ctx, ann.ID, active.ID) }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.call(e.failingChallenges(t, tt.fail))
			require.ErrorIs(t, err, errInjected)
		})
	}
	assert.EqualValues(t, 1, countRows(t, e.db, &models.Challenge{}), "nothing was created")
	assert.EqualValues(t, 2, countRows(t, e.db, &models.ChallengeParticipant{}), "nobody joined or left")

	t.Run("loading the result after a successful write", func(t *testing.T) {
		logs := observeChallengeLogs(t)
		created, err := e.failingChallenges(t, failListDays).Create(ctx, joiner.ID, studyRequest(on(3), 3))
		require.ErrorIs(t, err, errInjected)
		assert.Nil(t, created)
		assert.EqualValues(t, 2, countRows(t, e.db, &models.Challenge{}), "the challenge itself was created")

		_, err = e.failingChallenges(t, failListDays).JoinByCode(ctx, joiner.ID, active.InviteCode)
		require.ErrorIs(t, err, errInjected)
		assert.EqualValues(t, 3, countRows(t, e.db.Where("challenge_id = ?", active.ID), &models.ChallengeParticipant{}))
		assert.Equal(t, 1, logs.FilterMessage("Challenge joined").Len(), "the join is logged")
		assert.Equal(t, 1, logs.FilterMessage("Challenge joined notification skipped: loading the challenge failed after the join").Len())
		assert.Empty(t, typedNotifications(t, e.db, ann.ID, models.NotifTypeChallengeJoined))
	})

	t.Run("deleting", func(t *testing.T) {
		alone := e.seed(t, ann, on(1), 3)
		e.join(t, alone, ann, cday)
		require.ErrorIs(t, e.failingChallenges(t, failDeleteChallenge).Delete(ctx, ann.ID, alone.ID), errInjected)
		assert.EqualValues(t, 1, countRows(t, e.db.Where("id = ?", alone.ID), &models.Challenge{}))
	})

	t.Run("a challenge deleted before the join locks it", func(t *testing.T) {
		gone := e.seed(t, ann, on(1), 3)
		e.join(t, gone, ann, cday)
		svc := e.failingChallenges(t, func(s stmtInfo) bool {
			if s.is("query", "challenges") && s.has("id = ?") && !s.has("invite_code") {
				require.NoError(t, e.db.Delete(&models.Challenge{}, gone.ID).Error) // a concurrent delete
			}
			return false
		})
		_, err := svc.JoinByCode(ctx, joiner.ID, gone.InviteCode)
		assert.ErrorIs(t, err, ErrChallengeNotFound)
	})
}

func TestChallengeService_RunDailyJob_Failures(t *testing.T) {
	ctx := context.Background()

	// setup creates one challenge to lock (S..S+4, today S+3) and one to finalize.
	setup := func(t *testing.T) (*chEnv, *models.Challenge, *models.Challenge) {
		e := newChEnv(t, on(3))
		ann, ben := e.user(t, "ann"), e.user(t, "ben")
		toLock := e.seed(t, ann, cday, 5)
		e.join(t, toLock, ann, cday)
		toFinalize := e.seed(t, ann, on(-6), 3, func(c *models.Challenge) { lt := on(-4); c.LockedThrough = &lt })
		e.join(t, toFinalize, ann, on(-6))
		e.join(t, toFinalize, ben, on(-6))
		return e, toLock, toFinalize
	}
	jobLog := func(t *testing.T, db *gorm.DB) models.CronJobLog {
		t.Helper()
		logs := cronJobLogs(t, db, models.CronJobChallengeDaily)
		require.Len(t, logs, 1)
		return logs[0]
	}

	tests := []struct {
		name              string
		fail              func(stmtInfo) bool
		locked, finalized bool
		processed         int
	}{
		{"listing challenges to lock", failIDsToLock, false, true, 1},
		{"lock: row lock", nthStmt(1, failChallengeByID), false, true, 1},
		{"lock: participants", nthStmt(1, failListParticipants), false, true, 1},
		{"lock: activity", failActivityDays, false, true, 1},
		{"lock: store days", failInsertDays, false, true, 1},
		{"lock: locked_through", failSetLockedThrough, false, true, 1},
		{"listing challenges to finalize", failIDsToFinalize, true, false, 1},
		{"finalize: row lock", nthStmt(2, failChallengeByID), true, false, 1},
		{"finalize: participants", nthStmt(2, failListParticipants), true, false, 1},
		{"finalize: totals", failLockedTotals, true, false, 1},
		{"finalize: results", failSaveFinalResults, true, false, 1},
		{"finalize: mark", failMarkFinalized, true, false, 1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e, toLock, toFinalize := setup(t)
			svc := e.service(faultyDB(t, tt.fail), e.db, e.db)

			err := svc.RunDailyJob(ctx)
			require.ErrorIs(t, err, errInjected)

			assert.Equal(t, tt.locked, reloadChallenge(t, e, toLock).LockedThrough != nil, "locked")
			assert.Equal(t, tt.finalized, reloadChallenge(t, e, toFinalize).FinalizedAt != nil, "finalized")
			if !tt.finalized {
				var completed int64
				require.NoError(t, e.db.Model(&models.ChallengeParticipant{}).
					Where("challenge_id = ? AND final_rank IS NOT NULL", toFinalize.ID).Count(&completed).Error)
				assert.Zero(t, completed, "no partial results")
				assert.Zero(t, countRows(t, e.db, &models.Notification{}))
			}
			log := jobLog(t, e.db)
			assert.Equal(t, models.CronJobStatusFailed, log.Status)
			assert.Equal(t, tt.processed, log.UsersCount)
			assert.Contains(t, log.Error, errInjected.Error())

			// The next run retries and succeeds.
			e.clock.setDay(on(4))
			require.NoError(t, e.svc.RunDailyJob(ctx))
			assert.NotNil(t, reloadChallenge(t, e, toLock).LockedThrough)
			assert.NotNil(t, reloadChallenge(t, e, toFinalize).FinalizedAt)
			assert.EqualValues(t, 2, countRows(t, e.db.Where("type = ?", models.NotifTypeChallengeEnded), &models.Notification{}))
		})
	}

	t.Run("one failing challenge does not stop the others", func(t *testing.T) {
		e, toLock, toFinalize := setup(t)
		other := e.seed(t, e.user(t, "cat"), cday, 5)
		e.join(t, other, e.user(t, "dan"), cday)
		svc := e.service(faultyDB(t, nthStmt(1, failInsertDays)), e.db, e.db)

		err := svc.RunDailyJob(ctx)
		require.ErrorIs(t, err, errInjected)
		assert.Contains(t, err.Error(), "lock challenge")
		assert.Nil(t, reloadChallenge(t, e, toLock).LockedThrough, "the first challenge failed")
		assert.NotNil(t, reloadChallenge(t, e, other).LockedThrough)
		assert.NotNil(t, reloadChallenge(t, e, toFinalize).FinalizedAt)
		assert.Equal(t, 2, jobLog(t, e.db).UsersCount)
	})

	t.Run("claiming fails", func(t *testing.T) {
		e, toLock, _ := setup(t)
		logs := observeChallengeLogs(t)
		svc := e.service(e.db, testutil.BrokenDB(t), e.db)

		require.NoError(t, svc.RunDailyJob(ctx), "the job runs anyway: it is idempotent")
		assert.NotNil(t, reloadChallenge(t, e, toLock).LockedThrough)
		assert.Equal(t, 1, logs.FilterMessage("Failed to claim the challenge job, running without a job log").Len())
	})

	t.Run("finalized meanwhile", func(t *testing.T) {
		e, _, toFinalize := setup(t)
		listed := false
		svc := e.service(faultyDB(t, func(s stmtInfo) bool {
			switch {
			case failIDsToFinalize(s):
				listed = true
			case listed && failChallengeByID(s):
				listed = false
				// Another replica finalizes the challenge before this one locks it.
				require.NoError(t, e.db.Exec("UPDATE challenges SET finalized_at = now() WHERE id = ?", toFinalize.ID).Error)
			}
			return false
		}), nil, e.db)

		require.NoError(t, svc.RunDailyJob(ctx))
		assert.Zero(t, countRows(t, e.db, &models.Notification{}), "whoever finalized it notifies")
		var rows int64
		require.NoError(t, e.db.Model(&models.ChallengeParticipant{}).
			Where("challenge_id = ? AND final_rank IS NOT NULL", toFinalize.ID).Count(&rows).Error)
		assert.Zero(t, rows)
	})
}

func TestChallengeService_NotificationFailuresDoNotFailRequests(t *testing.T) {
	e := newChEnv(t, cday)
	ctx := context.Background()
	logs := observeChallengeLogs(t)
	ann, ben, friend := e.user(t, "ann"), e.user(t, "ben"), e.user(t, "friend")
	makeFollow(t, e.db, ann.ID, friend.ID, models.FollowStateActive)
	svc := e.service(e.db, e.db, faultyDB(t, failingOn("create", "notifications")))

	created, err := svc.Create(ctx, ann.ID, studyRequest(cday, 3))
	require.NoError(t, err)
	_, err = svc.JoinByCode(ctx, ben.ID, created.InviteCode)
	require.NoError(t, err, "join")
	already, err := svc.Cheer(ctx, ann.ID, created.ID, ben.ID)
	require.NoError(t, err, "cheer")
	assert.False(t, already)
	invited, _, err := svc.Invite(ctx, ann.ID, created.ID, []uint{friend.ID})
	require.NoError(t, err, "invite")
	assert.Equal(t, 1, invited)
	e.clock.setDay(on(5))
	require.NoError(t, svc.RunDailyJob(ctx), "the job")
	assert.NotNil(t, reloadChallenge(t, e, &models.Challenge{ID: created.ID}).FinalizedAt)

	assert.Zero(t, countRows(t, e.db, &models.Notification{}))
	warnings := logs.FilterMessage("Challenge notification failed; the action itself succeeded")
	kinds := map[string]int{}
	for _, entry := range warnings.All() {
		kinds[entry.ContextMap()["type"].(string)]++
		assert.EqualValues(t, created.ID, entry.ContextMap()["challenge_id"])
	}
	assert.Equal(t, map[string]int{"challenge_joined": 1, "challenge_cheer": 1, "challenge_invite": 1, "challenge_ended": 2}, kinds)

	t.Run("without a notification service", func(t *testing.T) {
		quiet := e.service(e.db, nil, nil)
		c := e.seed(t, ann, on(6), 3)
		e.join(t, c, ann, on(5))
		_, err := quiet.JoinByCode(ctx, friend.ID, c.InviteCode)
		require.NoError(t, err)
		assert.Zero(t, countRows(t, e.db, &models.Notification{}))
	})
}
