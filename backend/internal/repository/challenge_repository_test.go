package repository

import (
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/testutil"
	"github.com/aman1117/backend/pkg/models"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

// ==================== Challenge fixtures ====================

var challengeCodeSeq atomic.Int64

// nextChallengeCode returns a unique, well-formed invite code.
func nextChallengeCode() string {
	n := challengeCodeSeq.Add(1)
	code := []byte("TESTAAAA")
	for i := len(code) - 1; i >= 4 && n > 0; i-- {
		code[i] = constants.ChallengeInviteCodeAlphabet[n%32]
		n /= 32
	}
	return string(code)
}

// seedChallenge inserts a "study 2h+" challenge of days days from start.
func seedChallenge(t *testing.T, db *gorm.DB, creatorID uint, start time.Time, days int, opts ...func(*models.Challenge)) *models.Challenge {
	t.Helper()
	c := &models.Challenge{
		CreatorID:   creatorID,
		Title:       "Study 2h+",
		Activity:    string(models.ActivityStudy),
		GoalType:    models.ChallengeGoalAtLeast,
		TargetHours: 2,
		StartDate:   start,
		EndDate:     start.AddDate(0, 0, days-1),
		InviteCode:  nextChallengeCode(),
	}
	for _, opt := range opts {
		opt(c)
	}
	require.NoError(t, db.Create(c).Error)
	return c
}

func lockedThrough(d time.Time) func(*models.Challenge) {
	return func(c *models.Challenge) { c.LockedThrough = &d }
}

func finalizedAt(at time.Time) func(*models.Challenge) {
	return func(c *models.Challenge) { c.FinalizedAt = &at }
}

var participantSeq atomic.Int64

// seedParticipant adds userID to the challenge; participants seeded later joined later.
func seedParticipant(t *testing.T, db *gorm.DB, challengeID, userID uint, joinedOn time.Time) *models.ChallengeParticipant {
	t.Helper()
	p := &models.ChallengeParticipant{
		ChallengeID: challengeID,
		UserID:      userID,
		JoinedAt:    joinedOn.Add(time.Duration(participantSeq.Add(1)) * time.Second),
		JoinedOn:    joinedOn,
	}
	require.NoError(t, db.Create(p).Error)
	return p
}

// seedDay stores a locked day.
func seedDay(t *testing.T, db *gorm.DB, challengeID, userID uint, date time.Time, hours float64, met bool) *models.ChallengeDay {
	t.Helper()
	d := &models.ChallengeDay{
		ChallengeID: challengeID, UserID: userID, DayDate: date,
		Hours: hours, Logged: hours > 0, Met: met, LockedAt: t0,
	}
	require.NoError(t, db.Create(d).Error)
	return d
}

func challengeCount(t *testing.T, db *gorm.DB, model any, where string, args ...any) int64 {
	t.Helper()
	var n int64
	require.NoError(t, db.Model(model).Where(where, args...).Count(&n).Error)
	return n
}

func loadChallenge(t *testing.T, db *gorm.DB, id uint) models.Challenge {
	t.Helper()
	var c models.Challenge
	require.NoError(t, db.First(&c, id).Error)
	return c
}

func dates(days []models.ChallengeDay) []string {
	out := make([]string, len(days))
	for i, d := range days {
		out[i] = fmt.Sprintf("%d:%s", d.UserID, d.DayDate.Format(dateLayout))
	}
	return out
}

func candidateNames(rows []InviteCandidateRow) []string {
	out := make([]string, len(rows))
	for i, r := range rows {
		out[i] = r.Username
	}
	return out
}

// ==================== Challenges ====================

func TestChallengeRepository_CreateAndFind(t *testing.T) {
	db := testutil.DB(t)
	repo := NewChallengeRepository(db)
	creator := testutil.CreateUser(t, db)

	challenge := &models.Challenge{
		CreatorID: creator.ID, Title: "Read 📚 daily", Activity: "book_reading", GoalType: models.ChallengeGoalAtMost,
		TargetHours: 1.25, StartDate: day, EndDate: day.AddDate(0, 0, 20), InviteCode: "K7Q2M9XA",
	}
	created, err := repo.CreateChallenge(challenge)
	require.NoError(t, err)
	require.True(t, created)
	require.NotZero(t, challenge.ID)

	got, err := repo.FindByID(challenge.ID)
	require.NoError(t, err)
	require.NotNil(t, got)
	assert.Equal(t, creator.ID, got.CreatorID)
	assert.Equal(t, "Read 📚 daily", got.Title)
	assert.Equal(t, "book_reading", got.Activity)
	assert.Equal(t, models.ChallengeGoalAtMost, got.GoalType)
	assert.Equal(t, 1.25, got.TargetHours)
	assert.Equal(t, "2026-03-09", got.StartDate.Format(dateLayout))
	assert.Equal(t, "2026-03-29", got.EndDate.Format(dateLayout))
	assert.Equal(t, 21, got.DurationDays())
	assert.Nil(t, got.LockedThrough)
	assert.Nil(t, got.FinalizedAt)
	assert.False(t, got.CreatedAt.IsZero())

	byCode, err := repo.FindByInviteCode("K7Q2M9XA")
	require.NoError(t, err)
	require.NotNil(t, byCode)
	assert.Equal(t, challenge.ID, byCode.ID)

	t.Run("a taken invite code is reported, not an error", func(t *testing.T) {
		dup := &models.Challenge{
			CreatorID: creator.ID, Title: "Other", Activity: "study", GoalType: models.ChallengeGoalAtLeast,
			TargetHours: 1, StartDate: day, EndDate: day.AddDate(0, 0, 2), InviteCode: "K7Q2M9XA",
		}
		created, err := repo.CreateChallenge(dup)
		require.NoError(t, err)
		assert.False(t, created)
		assert.Zero(t, dup.ID)
		assert.EqualValues(t, 1, challengeCount(t, db, &models.Challenge{}, "invite_code = ?", "K7Q2M9XA"))
	})

	t.Run("missing challenges are nil", func(t *testing.T) {
		missing, err := repo.FindByID(challenge.ID + 100)
		require.NoError(t, err)
		assert.Nil(t, missing)
		missing, err = repo.FindByInviteCode("ZZZZZZZZ")
		require.NoError(t, err)
		assert.Nil(t, missing)
		missing, err = repo.FindByInviteCode("k7q2m9xa")
		require.NoError(t, err)
		assert.Nil(t, missing, "codes are normalised by the caller")
	})

	t.Run("unknown creator", func(t *testing.T) {
		_, err := repo.CreateChallenge(&models.Challenge{
			CreatorID: 9999, Title: "x", Activity: "study", GoalType: models.ChallengeGoalAtLeast,
			TargetHours: 1, StartDate: day, EndDate: day, InviteCode: "ABCDEFGH",
		})
		assert.Error(t, err)
	})

	t.Run("errors", func(t *testing.T) {
		broken := NewChallengeRepository(testutil.BrokenDB(t))
		_, err := broken.FindByID(challenge.ID)
		assert.Error(t, err)
		_, err = broken.FindByInviteCode("K7Q2M9XA")
		assert.Error(t, err)
	})
}

func TestChallengeRepository_WithTransaction(t *testing.T) {
	db := testutil.DB(t)
	repo := NewChallengeRepository(db)
	creator := testutil.CreateUser(t, db)
	newChallenge := func(code string) *models.Challenge {
		return &models.Challenge{
			CreatorID: creator.ID, Title: "t", Activity: "study", GoalType: models.ChallengeGoalAtLeast,
			TargetHours: 1, StartDate: day, EndDate: day.AddDate(0, 0, 2), InviteCode: code,
		}
	}

	require.NoError(t, repo.WithTransaction(func(tx *ChallengeRepository) error {
		_, err := tx.CreateChallenge(newChallenge("COMMITTD"))
		return err
	}))
	assert.EqualValues(t, 1, challengeCount(t, db, &models.Challenge{}, "invite_code = ?", "COMMITTD"))

	errStop := errors.New("stop")
	err := repo.WithTransaction(func(tx *ChallengeRepository) error {
		if _, err := tx.CreateChallenge(newChallenge("R0LLBACK")); err != nil {
			return err
		}
		return errStop
	})
	require.ErrorIs(t, err, errStop)
	assert.Zero(t, challengeCount(t, db, &models.Challenge{}, "invite_code = ?", "R0LLBACK"), "rolled back")
}

func TestChallengeRepository_WithLockedChallenge(t *testing.T) {
	db := testutil.DB(t)
	repo := NewChallengeRepository(db)
	creator := testutil.CreateUser(t, db)
	c := seedChallenge(t, db, creator.ID, day, 5)

	var seen *models.Challenge
	require.NoError(t, repo.WithLockedChallenge(c.ID, func(tx *ChallengeRepository, locked *models.Challenge) error {
		seen = locked
		return tx.AddParticipant(&models.ChallengeParticipant{ChallengeID: locked.ID, UserID: creator.ID, JoinedAt: t0, JoinedOn: day})
	}))
	require.NotNil(t, seen)
	assert.Equal(t, c.InviteCode, seen.InviteCode)
	assert.EqualValues(t, 1, challengeCount(t, db, &models.ChallengeParticipant{}, "challenge_id = ?", c.ID))

	called := false
	err := repo.WithLockedChallenge(c.ID+100, func(*ChallengeRepository, *models.Challenge) error {
		called = true
		return nil
	})
	assert.ErrorIs(t, err, ErrChallengeNotFound)
	assert.False(t, called)

	errStop := errors.New("stop")
	err = repo.WithLockedChallenge(c.ID, func(tx *ChallengeRepository, locked *models.Challenge) error {
		require.NoError(t, tx.Delete(locked.ID))
		return errStop
	})
	require.ErrorIs(t, err, errStop)
	assert.EqualValues(t, 1, challengeCount(t, db, &models.Challenge{}, "id = ?", c.ID), "rolled back")

	err = NewChallengeRepository(testutil.BrokenDB(t)).WithLockedChallenge(c.ID, func(*ChallengeRepository, *models.Challenge) error { return nil })
	require.Error(t, err)
	assert.NotErrorIs(t, err, ErrChallengeNotFound)

	err = NewChallengeRepository(faultyDB(t, on("query", "challenges"))).WithLockedChallenge(c.ID, func(*ChallengeRepository, *models.Challenge) error { return nil })
	assert.ErrorIs(t, err, errInjected)
}

// The row lock serialises concurrent joins, so a participant cap checked inside it can never be
// exceeded.
func TestChallengeRepository_WithLockedChallenge_SerialisesJoins(t *testing.T) {
	db := testutil.DB(t)
	repo := NewChallengeRepository(db)
	creator := testutil.CreateUser(t, db)
	c := seedChallenge(t, db, creator.ID, day, 5)
	const capacity, joiners = 5, 12
	users := make([]*models.User, joiners)
	for i := range users {
		users[i] = testutil.CreateUser(t, db)
	}

	errFull := errors.New("full")
	results := make([]error, joiners)
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i, u := range users {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			results[i] = repo.WithLockedChallenge(c.ID, func(tx *ChallengeRepository, locked *models.Challenge) error {
				n, err := tx.CountParticipants(locked.ID)
				if err != nil {
					return err
				}
				if n >= capacity {
					return errFull
				}
				time.Sleep(2 * time.Millisecond) // widen the race window a check without a lock would lose
				return tx.AddParticipant(&models.ChallengeParticipant{ChallengeID: locked.ID, UserID: u.ID, JoinedAt: t0, JoinedOn: day})
			})
		}()
	}
	close(start)
	wg.Wait()

	joined, full := 0, 0
	for _, err := range results {
		switch {
		case err == nil:
			joined++
		case errors.Is(err, errFull):
			full++
		default:
			t.Errorf("unexpected error: %v", err)
		}
	}
	assert.Equal(t, capacity, joined)
	assert.Equal(t, joiners-capacity, full)
	assert.EqualValues(t, capacity, challengeCount(t, db, &models.ChallengeParticipant{}, "challenge_id = ?", c.ID))
}

func TestChallengeRepository_LockUser(t *testing.T) {
	db := testutil.DB(t)
	repo := NewChallengeRepository(db)
	user := testutil.CreateUser(t, db)

	assert.ErrorIs(t, repo.LockUser(user.ID+100), ErrChallengeUserNotFound)
	assert.Error(t, NewChallengeRepository(testutil.BrokenDB(t)).LockUser(user.ID))

	withLockTimeout := func(fn func(tx *gorm.DB) error) error {
		return db.Transaction(func(tx *gorm.DB) error {
			if err := tx.Exec("SET LOCAL lock_timeout = '200ms'").Error; err != nil {
				return err
			}
			return fn(tx)
		})
	}
	require.NoError(t, repo.WithTransaction(func(tx *ChallengeRepository) error {
		require.NoError(t, tx.LockUser(user.ID))

		// A second lock on the same user waits for the first transaction...
		err := withLockTimeout(func(other *gorm.DB) error { return (&ChallengeRepository{db: other}).LockUser(user.ID) })
		require.Error(t, err)
		assert.Contains(t, err.Error(), "lock timeout")

		// ...while rows referencing the user can still be written (foreign key checks only
		// take KEY SHARE locks).
		return withLockTimeout(func(other *gorm.DB) error {
			return other.Create(&models.Activity{UserID: user.ID, Name: models.ActivityStudy, DurationHours: 1, ActivityDate: day}).Error
		})
	}))
}

func TestChallengeRepository_Delete_Cascades(t *testing.T) {
	db := testutil.DB(t)
	repo := NewChallengeRepository(db)
	alice, bob := testutil.CreateUser(t, db), testutil.CreateUser(t, db)
	doomed := seedChallenge(t, db, alice.ID, day, 5)
	kept := seedChallenge(t, db, alice.ID, day, 5)
	for _, c := range []*models.Challenge{doomed, kept} {
		seedParticipant(t, db, c.ID, alice.ID, day)
		seedParticipant(t, db, c.ID, bob.ID, day)
		seedDay(t, db, c.ID, bob.ID, day, 2, true)
		_, err := repo.CreateCheer(&models.ChallengeCheer{ChallengeID: c.ID, FromUserID: alice.ID, ToUserID: bob.ID, CheerDate: day})
		require.NoError(t, err)
		require.NoError(t, db.Create(&models.ChallengeInvite{ChallengeID: c.ID, InviterID: alice.ID, InviteeID: bob.ID}).Error)
	}

	require.NoError(t, repo.Delete(doomed.ID))

	for _, model := range []any{&models.ChallengeParticipant{}, &models.ChallengeDay{}, &models.ChallengeCheer{}, &models.ChallengeInvite{}} {
		assert.Zero(t, challengeCount(t, db, model, "challenge_id = ?", doomed.ID), "%T of the deleted challenge", model)
		assert.NotZero(t, challengeCount(t, db, model, "challenge_id = ?", kept.ID), "%T of the other challenge", model)
	}
	gone, err := repo.FindByID(doomed.ID)
	require.NoError(t, err)
	assert.Nil(t, gone)
	require.NoError(t, repo.Delete(doomed.ID), "deleting twice is a no-op")

	t.Run("deleting a user removes their challenges and participations", func(t *testing.T) {
		require.NoError(t, db.Delete(&models.User{}, bob.ID).Error)
		assert.Zero(t, challengeCount(t, db, &models.ChallengeParticipant{}, "user_id = ?", bob.ID))
		assert.Zero(t, challengeCount(t, db, &models.ChallengeDay{}, "user_id = ?", bob.ID))
		assert.Zero(t, challengeCount(t, db, &models.ChallengeCheer{}, "to_user_id = ?", bob.ID))
		assert.Zero(t, challengeCount(t, db, &models.ChallengeInvite{}, "invitee_id = ?", bob.ID))

		require.NoError(t, db.Delete(&models.User{}, alice.ID).Error)
		assert.Zero(t, challengeCount(t, db, &models.Challenge{}, "creator_id = ?", alice.ID))
	})
}

func TestChallengeRepository_ListForUser(t *testing.T) {
	db := testutil.DB(t)
	repo := NewChallengeRepository(db)
	me, other := testutil.CreateUser(t, db), testutil.CreateUser(t, db)
	today := day

	active := seedChallenge(t, db, other.ID, today.AddDate(0, 0, -3), 7)
	upcoming := seedChallenge(t, db, me.ID, today.AddDate(0, 0, 5), 3)
	endsToday := seedChallenge(t, db, me.ID, today.AddDate(0, 0, -2), 3)
	seedParticipant(t, db, active.ID, other.ID, active.StartDate)
	activeP := seedParticipant(t, db, active.ID, me.ID, today.AddDate(0, 0, -1))
	seedParticipant(t, db, upcoming.ID, me.ID, today)
	seedParticipant(t, db, endsToday.ID, me.ID, endsToday.StartDate)

	// 22 ended challenges; the 20th and 22nd end on the same date.
	var ended []*models.Challenge
	for i := 0; i < 22; i++ {
		end := today.AddDate(0, 0, -1-i)
		if i == 21 {
			end = today.AddDate(0, 0, -20)
		}
		c := seedChallenge(t, db, me.ID, end.AddDate(0, 0, -2), 3)
		seedParticipant(t, db, c.ID, me.ID, c.StartDate)
		ended = append(ended, c)
	}
	require.NoError(t, repo.SaveFinalResults([]ChallengeFinalResult{{
		ParticipantID: func() uint {
			p, err := repo.FindParticipant(ended[0].ID, me.ID)
			require.NoError(t, err)
			return p.ID
		}(),
		Rank: 1, DaysMet: 3, TotalHours: 7.5, Completed: true,
	}}))

	// Challenges I do not take part in are never listed.
	notMine := seedChallenge(t, db, other.ID, today, 3)
	seedParticipant(t, db, notMine.ID, other.ID, today)

	rows, err := repo.ListForUser(me.ID, today, 20)
	require.NoError(t, err)
	require.Len(t, rows, 23)

	byID := map[uint]UserChallengeRow{}
	for _, r := range rows {
		byID[r.ID] = r
	}
	for _, c := range []*models.Challenge{active, upcoming, endsToday} {
		assert.Contains(t, byID, c.ID, "open challenge %d", c.ID)
	}
	assert.NotContains(t, byID, notMine.ID)

	// The ended part holds the 20 most recent ones: by end date, and the newest of the two
	// that end on the same date (ended[19] and ended[21]) wins the last place.
	var endedIDs []uint
	for _, r := range rows {
		if r.EndDate.Before(today) {
			endedIDs = append(endedIDs, r.ID)
		}
	}
	want := []uint{}
	for i := 0; i < 19; i++ {
		want = append(want, ended[i].ID)
	}
	want = append(want, ended[21].ID)
	assert.ElementsMatch(t, want, endedIDs)

	a := byID[active.ID]
	assert.Equal(t, 2, a.ParticipantCount)
	assert.Equal(t, activeP.JoinedOn.Format(dateLayout), a.JoinedOn.Format(dateLayout))
	assert.Equal(t, "Study 2h+", a.Title)
	assert.Equal(t, other.ID, a.CreatorID)
	assert.Nil(t, a.FinalRank)
	assert.Nil(t, a.Completed)

	first := byID[ended[0].ID]
	assert.Equal(t, 1, first.ParticipantCount)
	require.NotNil(t, first.FinalRank)
	assert.Equal(t, 1, *first.FinalRank)
	assert.Equal(t, 3, *first.FinalDaysMet)
	assert.Equal(t, 7.5, *first.FinalTotalHours)
	assert.True(t, *first.Completed)

	t.Run("no challenges", func(t *testing.T) {
		rows, err := repo.ListForUser(other.ID+100, today, 20)
		require.NoError(t, err)
		assert.Empty(t, rows)
	})

	t.Run("error", func(t *testing.T) {
		_, err := NewChallengeRepository(testutil.BrokenDB(t)).ListForUser(me.ID, today, 20)
		assert.Error(t, err)
	})
}

func TestChallengeRepository_CountOpenForUser(t *testing.T) {
	db := testutil.DB(t)
	repo := NewChallengeRepository(db)
	me, other := testutil.CreateUser(t, db), testutil.CreateUser(t, db)
	today := day

	for _, start := range []time.Time{today.AddDate(0, 0, -2), today.AddDate(0, 0, 3), today.AddDate(0, 0, -4)} {
		c := seedChallenge(t, db, other.ID, start, 5) // the last one ends today
		seedParticipant(t, db, c.ID, me.ID, today)
	}
	ended := seedChallenge(t, db, me.ID, today.AddDate(0, 0, -5), 5)
	seedParticipant(t, db, ended.ID, me.ID, ended.StartDate)
	notMine := seedChallenge(t, db, other.ID, today, 5)
	seedParticipant(t, db, notMine.ID, other.ID, today)

	n, err := repo.CountOpenForUser(me.ID, today)
	require.NoError(t, err)
	assert.EqualValues(t, 3, n)

	n, err = repo.CountOpenForUser(me.ID, today.AddDate(0, 0, 1))
	require.NoError(t, err)
	assert.EqualValues(t, 2, n, "the challenge ending today is no longer open tomorrow")

	_, err = NewChallengeRepository(testutil.BrokenDB(t)).CountOpenForUser(me.ID, today)
	assert.Error(t, err)
}

func TestChallengeRepository_JobSelection(t *testing.T) {
	db := testutil.DB(t)
	repo := NewChallengeRepository(db)
	u := testutil.CreateUser(t, db)
	through := day // today-2 for the job

	unlocked := seedChallenge(t, db, u.ID, through.AddDate(0, 0, -3), 7)
	startsAtThrough := seedChallenge(t, db, u.ID, through, 7)
	partlyLocked := seedChallenge(t, db, u.ID, through.AddDate(0, 0, -5), 10, lockedThrough(through.AddDate(0, 0, -1)))
	seedChallenge(t, db, u.ID, through.AddDate(0, 0, -5), 10, lockedThrough(through)) // locked up to through
	seedChallenge(t, db, u.ID, through.AddDate(0, 0, 1), 7)                           // starts after through
	endedPartlyLocked := seedChallenge(t, db, u.ID, through.AddDate(0, 0, -9), 5, lockedThrough(through.AddDate(0, 0, -7)))
	endedLocked := seedChallenge(t, db, u.ID, through.AddDate(0, 0, -9), 5, lockedThrough(through.AddDate(0, 0, -5)))
	endedNeverLocked := seedChallenge(t, db, u.ID, through.AddDate(0, 0, -9), 5)
	seedChallenge(t, db, u.ID, through.AddDate(0, 0, -20), 5, lockedThrough(through.AddDate(0, 0, -16)), finalizedAt(t0))

	ids, err := repo.ChallengeIDsToLock(through)
	require.NoError(t, err)
	assert.Equal(t, []uint{unlocked.ID, startsAtThrough.ID, partlyLocked.ID, endedPartlyLocked.ID, endedNeverLocked.ID}, ids)

	ids, err = repo.ChallengeIDsToFinalize()
	require.NoError(t, err)
	assert.Equal(t, []uint{endedLocked.ID}, ids)

	broken := NewChallengeRepository(testutil.BrokenDB(t))
	_, err = broken.ChallengeIDsToLock(through)
	assert.Error(t, err)
	_, err = broken.ChallengeIDsToFinalize()
	assert.Error(t, err)
}

func TestChallengeRepository_SetLockedThroughAndMarkFinalized(t *testing.T) {
	db := testutil.DB(t)
	repo := NewChallengeRepository(db)
	u := testutil.CreateUser(t, db)
	c := seedChallenge(t, db, u.ID, day, 10)

	require.NoError(t, repo.SetLockedThrough(c.ID, day.AddDate(0, 0, 2), t0))
	got := loadChallenge(t, db, c.ID)
	require.NotNil(t, got.LockedThrough)
	assert.Equal(t, "2026-03-11", got.LockedThrough.Format(dateLayout))
	assert.True(t, t0.Equal(got.UpdatedAt))

	require.NoError(t, repo.SetLockedThrough(c.ID, day, t0.Add(time.Hour)))
	got = loadChallenge(t, db, c.ID)
	assert.Equal(t, "2026-03-11", got.LockedThrough.Format(dateLayout), "never moves backwards")
	assert.True(t, t0.Equal(got.UpdatedAt))

	require.NoError(t, repo.SetLockedThrough(c.ID, day.AddDate(0, 0, 9), t0.Add(2*time.Hour)))
	assert.Equal(t, "2026-03-18", loadChallenge(t, db, c.ID).LockedThrough.Format(dateLayout))

	require.NoError(t, repo.MarkFinalized(c.ID, t0))
	require.NoError(t, repo.MarkFinalized(c.ID, t0.Add(time.Hour)))
	got = loadChallenge(t, db, c.ID)
	require.NotNil(t, got.FinalizedAt)
	assert.True(t, t0.Equal(*got.FinalizedAt), "finalized once")

	broken := NewChallengeRepository(testutil.BrokenDB(t))
	assert.Error(t, broken.SetLockedThrough(c.ID, day, t0))
	assert.Error(t, broken.MarkFinalized(c.ID, t0))
	assert.Error(t, broken.Delete(c.ID))
}

// ==================== Participants ====================

func TestChallengeRepository_Participants(t *testing.T) {
	db := testutil.DB(t)
	repo := NewChallengeRepository(db)
	alice := namedUser(t, db, "alice", withAvatar, verified)
	bob := namedUser(t, db, "bob")
	carol := namedUser(t, db, "carol")
	c1 := seedChallenge(t, db, alice.ID, day, 7)
	c2 := seedChallenge(t, db, bob.ID, day, 7)

	require.NoError(t, repo.AddParticipant(&models.ChallengeParticipant{ChallengeID: c1.ID, UserID: alice.ID, JoinedAt: t0.Add(2 * time.Hour), JoinedOn: day}))
	require.NoError(t, repo.AddParticipant(&models.ChallengeParticipant{ChallengeID: c1.ID, UserID: bob.ID, JoinedAt: t0, JoinedOn: day.AddDate(0, 0, -1)}))
	require.NoError(t, repo.AddParticipant(&models.ChallengeParticipant{ChallengeID: c2.ID, UserID: carol.ID, JoinedAt: t0, JoinedOn: day}))
	assert.Error(t, repo.AddParticipant(&models.ChallengeParticipant{ChallengeID: c1.ID, UserID: bob.ID, JoinedAt: t0, JoinedOn: day}),
		"a user takes part once")

	p, err := repo.FindParticipant(c1.ID, bob.ID)
	require.NoError(t, err)
	require.NotNil(t, p)
	assert.Equal(t, "2026-03-08", p.JoinedOn.Format(dateLayout))
	assert.True(t, t0.Equal(p.JoinedAt))
	missing, err := repo.FindParticipant(c1.ID, carol.ID)
	require.NoError(t, err)
	assert.Nil(t, missing)

	n, err := repo.CountParticipants(c1.ID)
	require.NoError(t, err)
	assert.EqualValues(t, 2, n)

	rows, err := repo.ListParticipants([]uint{c2.ID, c1.ID})
	require.NoError(t, err)
	require.Len(t, rows, 3)
	assert.Equal(t, []uint{bob.ID, alice.ID, carol.ID}, []uint{rows[0].UserID, rows[1].UserID, rows[2].UserID},
		"by challenge, then joining order")
	assert.Equal(t, c1.ID, rows[0].ChallengeID)
	a := rows[1]
	assert.Equal(t, "alice", a.Username)
	assert.Equal(t, alice.ProfilePic, a.ProfilePic)
	assert.Equal(t, alice.ProfilePicThumb, a.ProfilePicThumb)
	assert.True(t, a.IsVerified)
	assert.NotZero(t, a.ID)
	assert.Equal(t, "2026-03-09", a.JoinedOn.Format(dateLayout))
	assert.Nil(t, rows[0].ProfilePic)
	assert.False(t, rows[0].IsVerified)

	empty, err := repo.ListParticipants(nil)
	require.NoError(t, err)
	assert.Empty(t, empty)

	broken := NewChallengeRepository(testutil.BrokenDB(t))
	_, err = broken.FindParticipant(c1.ID, bob.ID)
	assert.Error(t, err)
	_, err = broken.CountParticipants(c1.ID)
	assert.Error(t, err)
	_, err = broken.ListParticipants([]uint{c1.ID})
	assert.Error(t, err)
}

func TestChallengeRepository_RemoveParticipant(t *testing.T) {
	db := testutil.DB(t)
	repo := NewChallengeRepository(db)
	alice, bob := testutil.CreateUser(t, db), testutil.CreateUser(t, db)
	c := seedChallenge(t, db, alice.ID, day, 7)
	other := seedChallenge(t, db, alice.ID, day, 7)
	for _, ch := range []*models.Challenge{c, other} {
		seedParticipant(t, db, ch.ID, alice.ID, day)
		seedParticipant(t, db, ch.ID, bob.ID, day)
		seedDay(t, db, ch.ID, alice.ID, day, 3, true)
		seedDay(t, db, ch.ID, bob.ID, day, 3, true)
		seedDay(t, db, ch.ID, bob.ID, day.AddDate(0, 0, 1), 0, false)
	}
	_, err := repo.CreateCheer(&models.ChallengeCheer{ChallengeID: c.ID, FromUserID: alice.ID, ToUserID: bob.ID, CheerDate: day})
	require.NoError(t, err)
	_, err = repo.CreateCheer(&models.ChallengeCheer{ChallengeID: c.ID, FromUserID: bob.ID, ToUserID: alice.ID, CheerDate: day})
	require.NoError(t, err)
	require.NoError(t, db.Create(&models.ChallengeInvite{ChallengeID: c.ID, InviterID: alice.ID, InviteeID: bob.ID}).Error)

	t.Run("failure rolls back", func(t *testing.T) {
		faulty := NewChallengeRepository(faultyDB(t, on("delete", "challenge_participants")))
		require.ErrorIs(t, faulty.RemoveParticipant(c.ID, bob.ID), errInjected)
		assert.EqualValues(t, 2, challengeCount(t, db, &models.ChallengeDay{}, "challenge_id = ? AND user_id = ?", c.ID, bob.ID))

		faulty = NewChallengeRepository(faultyDB(t, on("delete", "challenge_days")))
		require.ErrorIs(t, faulty.RemoveParticipant(c.ID, bob.ID), errInjected)
		assert.EqualValues(t, 1, challengeCount(t, db, &models.ChallengeParticipant{}, "challenge_id = ? AND user_id = ?", c.ID, bob.ID))
	})

	require.NoError(t, repo.RemoveParticipant(c.ID, bob.ID))

	assert.Zero(t, challengeCount(t, db, &models.ChallengeParticipant{}, "challenge_id = ? AND user_id = ?", c.ID, bob.ID))
	assert.Zero(t, challengeCount(t, db, &models.ChallengeDay{}, "challenge_id = ? AND user_id = ?", c.ID, bob.ID), "their days go")
	assert.EqualValues(t, 1, challengeCount(t, db, &models.ChallengeDay{}, "challenge_id = ? AND user_id = ?", c.ID, alice.ID))
	assert.EqualValues(t, 2, challengeCount(t, db, &models.ChallengeDay{}, "challenge_id = ? AND user_id = ?", other.ID, bob.ID),
		"other challenges are untouched")
	assert.EqualValues(t, 2, challengeCount(t, db, &models.ChallengeCheer{}, "challenge_id = ?", c.ID), "cheers are kept")
	assert.EqualValues(t, 1, challengeCount(t, db, &models.ChallengeInvite{}, "challenge_id = ?", c.ID), "invites are kept")
}

func TestChallengeRepository_SaveFinalResults(t *testing.T) {
	db := testutil.DB(t)
	repo := NewChallengeRepository(db)
	alice, bob, carol := testutil.CreateUser(t, db), testutil.CreateUser(t, db), testutil.CreateUser(t, db)
	c := seedChallenge(t, db, alice.ID, day, 60)
	pa := seedParticipant(t, db, c.ID, alice.ID, day)
	pb := seedParticipant(t, db, c.ID, bob.ID, day)
	seedParticipant(t, db, c.ID, carol.ID, day)

	require.NoError(t, repo.SaveFinalResults(nil))
	require.NoError(t, repo.SaveFinalResults([]ChallengeFinalResult{
		{ParticipantID: pa.ID, Rank: 1, DaysMet: 55, TotalHours: 1234.25, Completed: true},
		{ParticipantID: pb.ID, Rank: 2, DaysMet: 0, TotalHours: 0, Completed: false},
	}))

	rows, err := repo.ListParticipants([]uint{c.ID})
	require.NoError(t, err)
	require.Len(t, rows, 3)
	a, b, cc := rows[0], rows[1], rows[2]
	require.NotNil(t, a.FinalRank)
	assert.Equal(t, 1, *a.FinalRank)
	assert.Equal(t, 55, *a.FinalDaysMet)
	assert.Equal(t, 1234.25, *a.FinalTotalHours)
	assert.True(t, *a.Completed)
	require.NotNil(t, b.FinalRank)
	assert.Equal(t, 2, *b.FinalRank)
	assert.Equal(t, 0, *b.FinalDaysMet)
	assert.Equal(t, 0.0, *b.FinalTotalHours)
	assert.False(t, *b.Completed)
	assert.Nil(t, cc.FinalRank, "participants not in the results are untouched")
	assert.Nil(t, cc.Completed)

	assert.Error(t, NewChallengeRepository(testutil.BrokenDB(t)).SaveFinalResults([]ChallengeFinalResult{{ParticipantID: pa.ID}}))
}

// ==================== Days ====================

func TestChallengeRepository_ActivityDays(t *testing.T) {
	db := testutil.DB(t)
	repo := NewChallengeRepository(db)
	a, b, outsider := namedUser(t, db, "ann"), namedUser(t, db, "ben"), namedUser(t, db, "out")
	s := day

	// Study challenge S..S+4 locked through S: live dates start at S+1. Ann joined before the
	// start; Ben joined on S+2.
	study := seedChallenge(t, db, a.ID, s, 5, lockedThrough(s))
	seedParticipant(t, db, study.ID, a.ID, s.AddDate(0, 0, -3))
	seedParticipant(t, db, study.ID, b.ID, s.AddDate(0, 0, 2))
	// Sleep challenge S+1..S+3, never locked; only Ann takes part.
	sleep := seedChallenge(t, db, b.ID, s.AddDate(0, 0, 1), 3, func(c *models.Challenge) {
		c.Activity, c.GoalType, c.TargetHours = string(models.ActivitySleep), models.ChallengeGoalAtMost, 8
	})
	seedParticipant(t, db, sleep.ID, a.ID, s)

	act := func(u *models.User, name models.ActivityName, hours float32, offset int) {
		testutil.CreateActivity(t, db, u.ID, name, hours, s.AddDate(0, 0, offset))
	}
	act(a, models.ActivityStudy, 2, -1) // before the start
	act(a, models.ActivityStudy, 3, 0)  // locked
	act(a, models.ActivityStudy, 1.5, 1)
	act(a, models.ActivitySleep, 8, 1)
	act(a, models.ActivitySleep, 7, 2) // nothing studied, but something logged
	act(a, models.ActivityStudy, 15, 3)
	act(a, models.ActivityStudy, 15, 3) // duplicate rows: capped at 24 hours
	act(a, models.ActivityStudy, 2, 4)  // after "through"
	act(b, models.ActivityStudy, 3, 1)  // before Ben joined
	act(b, models.ActivityStudy, 0, 2)  // a zero-hour row is not "logged"
	act(b, models.ActivityWorkout, 1, 3)
	act(outsider, models.ActivityStudy, 5, 1)

	through := s.AddDate(0, 0, 3)
	rows, err := repo.ActivityDays([]uint{sleep.ID, study.ID}, through)
	require.NoError(t, err)

	type row struct {
		challenge, user uint
		date            string
		hours           float64
		logged          bool
	}
	got := make([]row, len(rows))
	for i, r := range rows {
		got[i] = row{r.ChallengeID, r.UserID, r.DayDate.Format(dateLayout), r.Hours, r.Logged}
	}
	date := func(offset int) string { return s.AddDate(0, 0, offset).Format(dateLayout) }
	assert.Equal(t, []row{
		{study.ID, a.ID, date(1), 1.5, true},
		{study.ID, a.ID, date(2), 0, true},
		{study.ID, a.ID, date(3), 24, true},
		{study.ID, b.ID, date(2), 0, false},
		{study.ID, b.ID, date(3), 0, true},
		{sleep.ID, a.ID, date(1), 8, true},
		{sleep.ID, a.ID, date(2), 7, true},
		{sleep.ID, a.ID, date(3), 0, true},
	}, got)

	t.Run("nothing before the start", func(t *testing.T) {
		rows, err := repo.ActivityDays([]uint{sleep.ID}, s)
		require.NoError(t, err)
		assert.Empty(t, rows)
	})

	t.Run("no challenges", func(t *testing.T) {
		rows, err := repo.ActivityDays(nil, through)
		require.NoError(t, err)
		assert.Empty(t, rows)
	})

	t.Run("error", func(t *testing.T) {
		_, err := NewChallengeRepository(testutil.BrokenDB(t)).ActivityDays([]uint{study.ID}, through)
		assert.Error(t, err)
	})
}

func TestChallengeRepository_InsertAndListDays(t *testing.T) {
	db := testutil.DB(t)
	repo := NewChallengeRepository(db)
	alice, bob := testutil.CreateUser(t, db), testutil.CreateUser(t, db)
	c := seedChallenge(t, db, alice.ID, day, 7)
	other := seedChallenge(t, db, alice.ID, day, 7)

	mk := func(challengeID, userID uint, offset int, hours float64, met bool) models.ChallengeDay {
		return models.ChallengeDay{ChallengeID: challengeID, UserID: userID, DayDate: day.AddDate(0, 0, offset),
			Hours: hours, Logged: hours > 0, Met: met, LockedAt: t0}
	}
	n, err := repo.InsertDays([]models.ChallengeDay{mk(c.ID, bob.ID, 1, 2.5, true), mk(c.ID, alice.ID, 0, 1, false), mk(c.ID, bob.ID, 0, 0, false)})
	require.NoError(t, err)
	assert.EqualValues(t, 3, n)

	// Re-locking is idempotent: stored days are never rewritten.
	n, err = repo.InsertDays([]models.ChallengeDay{mk(c.ID, bob.ID, 1, 9, false), mk(c.ID, bob.ID, 2, 3, true), mk(other.ID, bob.ID, 0, 4, true)})
	require.NoError(t, err)
	assert.EqualValues(t, 2, n)

	n, err = repo.InsertDays(nil)
	require.NoError(t, err)
	assert.Zero(t, n)

	days, err := repo.ListDays(c.ID)
	require.NoError(t, err)
	assert.Equal(t, []string{
		fmt.Sprintf("%d:2026-03-09", alice.ID),
		fmt.Sprintf("%d:2026-03-09", bob.ID),
		fmt.Sprintf("%d:2026-03-10", bob.ID),
		fmt.Sprintf("%d:2026-03-11", bob.ID),
	}, dates(days))
	assert.Equal(t, 2.5, days[2].Hours, "the first snapshot is kept")
	assert.True(t, days[2].Met)
	assert.True(t, days[2].Logged)
	assert.False(t, days[1].Logged)

	mine, err := repo.ListUserDays(bob.ID, []uint{other.ID, c.ID})
	require.NoError(t, err)
	require.Len(t, mine, 4)
	assert.Equal(t, []uint{c.ID, c.ID, c.ID, other.ID}, []uint{mine[0].ChallengeID, mine[1].ChallengeID, mine[2].ChallengeID, mine[3].ChallengeID})
	mine, err = repo.ListUserDays(bob.ID, []uint{other.ID})
	require.NoError(t, err)
	assert.Len(t, mine, 1)
	mine, err = repo.ListUserDays(bob.ID, nil)
	require.NoError(t, err)
	assert.Empty(t, mine)

	broken := NewChallengeRepository(testutil.BrokenDB(t))
	_, err = broken.InsertDays([]models.ChallengeDay{mk(c.ID, bob.ID, 5, 1, false)})
	assert.Error(t, err)
	_, err = broken.ListDays(c.ID)
	assert.Error(t, err)
	_, err = broken.ListUserDays(bob.ID, []uint{c.ID})
	assert.Error(t, err)
}

func TestChallengeRepository_LockedTotals(t *testing.T) {
	db := testutil.DB(t)
	repo := NewChallengeRepository(db)
	ann, ben, left := testutil.CreateUser(t, db), testutil.CreateUser(t, db), testutil.CreateUser(t, db)
	s := day
	c := seedChallenge(t, db, ann.ID, s, 7, lockedThrough(s.AddDate(0, 0, 2)))
	seedParticipant(t, db, c.ID, ann.ID, s.AddDate(0, 0, -1))
	seedParticipant(t, db, c.ID, ben.ID, s.AddDate(0, 0, 2))
	unlocked := seedChallenge(t, db, ann.ID, s, 7)
	seedParticipant(t, db, unlocked.ID, ann.ID, s)

	seedDay(t, db, c.ID, ann.ID, s.AddDate(0, 0, -1), 5, true) // before the start
	seedDay(t, db, c.ID, ann.ID, s, 3, true)
	seedDay(t, db, c.ID, ann.ID, s.AddDate(0, 0, 1), 2, true)
	seedDay(t, db, c.ID, ann.ID, s.AddDate(0, 0, 2), 0.5, false)
	seedDay(t, db, c.ID, ann.ID, s.AddDate(0, 0, 3), 4, true) // after locked_through
	seedDay(t, db, c.ID, ben.ID, s.AddDate(0, 0, 1), 6, true) // before Ben's window
	seedDay(t, db, c.ID, ben.ID, s.AddDate(0, 0, 2), 2.25, true)
	seedDay(t, db, c.ID, left.ID, s, 8, true)       // not a participant
	seedDay(t, db, unlocked.ID, ann.ID, s, 8, true) // nothing is locked there

	totals, err := repo.LockedTotals([]uint{c.ID, unlocked.ID})
	require.NoError(t, err)
	assert.Equal(t, []ChallengeLockedTotal{
		{ChallengeID: c.ID, UserID: ann.ID, DaysMet: 2, TotalHours: 5.5},
		{ChallengeID: c.ID, UserID: ben.ID, DaysMet: 1, TotalHours: 2.25},
	}, totals)

	empty, err := repo.LockedTotals(nil)
	require.NoError(t, err)
	assert.Empty(t, empty)

	_, err = NewChallengeRepository(testutil.BrokenDB(t)).LockedTotals([]uint{c.ID})
	assert.Error(t, err)
}

// ==================== Cheers and invites ====================

func TestChallengeRepository_Cheers(t *testing.T) {
	db := testutil.DB(t)
	repo := NewChallengeRepository(db)
	ann, ben, cat := testutil.CreateUser(t, db), testutil.CreateUser(t, db), testutil.CreateUser(t, db)
	c := seedChallenge(t, db, ann.ID, day, 7)

	cheer := func(from, to *models.User, date time.Time) bool {
		created, err := repo.CreateCheer(&models.ChallengeCheer{ChallengeID: c.ID, FromUserID: from.ID, ToUserID: to.ID, CheerDate: date})
		require.NoError(t, err)
		return created
	}
	assert.True(t, cheer(ann, ben, day))
	assert.False(t, cheer(ann, ben, day), "once per day")
	assert.True(t, cheer(ann, ben, day.AddDate(0, 0, 1)), "again the next day")
	assert.True(t, cheer(ann, cat, day))
	assert.True(t, cheer(ben, ann, day))

	ids, err := repo.CheeredUserIDs(c.ID, ann.ID, day)
	require.NoError(t, err)
	assert.Equal(t, []uint{ben.ID, cat.ID}, ids)
	ids, err = repo.CheeredUserIDs(c.ID, ann.ID, day.AddDate(0, 0, 1))
	require.NoError(t, err)
	assert.Equal(t, []uint{ben.ID}, ids)
	ids, err = repo.CheeredUserIDs(c.ID, cat.ID, day)
	require.NoError(t, err)
	assert.Empty(t, ids)
	assert.EqualValues(t, 4, challengeCount(t, db, &models.ChallengeCheer{}, "challenge_id = ?", c.ID))

	broken := NewChallengeRepository(testutil.BrokenDB(t))
	_, err = broken.CreateCheer(&models.ChallengeCheer{ChallengeID: c.ID, FromUserID: cat.ID, ToUserID: ann.ID, CheerDate: day})
	assert.Error(t, err)
	_, err = broken.CheeredUserIDs(c.ID, ann.ID, day)
	assert.Error(t, err)
}

func TestChallengeRepository_CreateInvites(t *testing.T) {
	db := testutil.DB(t)
	repo := NewChallengeRepository(db)
	me := namedUser(t, db, "me")
	mate := namedUser(t, db, "mate")
	iFollow, followsMe := namedUser(t, db, "ifollow"), namedUser(t, db, "followsme")
	pending, removed, stranger := namedUser(t, db, "pending"), namedUser(t, db, "removed"), namedUser(t, db, "stranger")
	participant, invitedBefore := namedUser(t, db, "participant"), namedUser(t, db, "invited")
	c := seedChallenge(t, db, me.ID, day, 7)
	seedParticipant(t, db, c.ID, me.ID, day)
	seedParticipant(t, db, c.ID, mate.ID, day)
	seedParticipant(t, db, c.ID, participant.ID, day)

	follow(t, db, me.ID, iFollow.ID, models.FollowStateActive, t0)
	follow(t, db, followsMe.ID, me.ID, models.FollowStateActive, t0)
	follow(t, db, me.ID, pending.ID, models.FollowStatePending, t0)
	follow(t, db, removed.ID, me.ID, models.FollowStateRemoved, t0)
	follow(t, db, mate.ID, stranger.ID, models.FollowStateActive, t0) // someone else's friend
	follow(t, db, me.ID, participant.ID, models.FollowStateActive, t0)
	follow(t, db, me.ID, invitedBefore.ID, models.FollowStateActive, t0)
	require.NoError(t, db.Create(&models.ChallengeInvite{ChallengeID: c.ID, InviterID: mate.ID, InviteeID: invitedBefore.ID}).Error)

	at := t0.Add(time.Hour)
	ids := []uint{followsMe.ID, iFollow.ID, pending.ID, removed.ID, stranger.ID, participant.ID, invitedBefore.ID, me.ID, 99999}
	invited, err := repo.CreateInvites(c.ID, me.ID, ids, at)
	require.NoError(t, err)
	assert.Equal(t, []uint{iFollow.ID, followsMe.ID}, invited, "ascending IDs")

	var stored []models.ChallengeInvite
	require.NoError(t, db.Where("challenge_id = ?", c.ID).Order("invitee_id").Find(&stored).Error)
	require.Len(t, stored, 3)
	for _, inv := range stored {
		if inv.InviteeID == invitedBefore.ID {
			assert.Equal(t, mate.ID, inv.InviterID, "the first invite is kept")
			continue
		}
		assert.Equal(t, me.ID, inv.InviterID)
		assert.True(t, at.Equal(inv.CreatedAt))
	}

	again, err := repo.CreateInvites(c.ID, me.ID, ids, at)
	require.NoError(t, err)
	assert.Empty(t, again, "a user is invited once per challenge")

	none, err := repo.CreateInvites(c.ID, me.ID, nil, at)
	require.NoError(t, err)
	assert.Empty(t, none)

	_, err = NewChallengeRepository(testutil.BrokenDB(t)).CreateInvites(c.ID, me.ID, ids, at)
	assert.Error(t, err)
}

func TestChallengeRepository_InviteCandidates(t *testing.T) {
	db := testutil.DB(t)
	repo := NewChallengeRepository(db)
	me := namedUser(t, db, "me")
	c := seedChallenge(t, db, me.ID, day, 7)
	seedParticipant(t, db, c.ID, me.ID, day)

	friend := func(name string, opts ...func(*models.User)) *models.User {
		u := namedUser(t, db, name, opts...)
		follow(t, db, me.ID, u.ID, models.FollowStateActive, t0)
		return u
	}
	amy := friend("amy", withAvatar, verified)
	anna := namedUser(t, db, "anna")
	follow(t, db, anna.ID, me.ID, models.FollowStateActive, t0) // follows me
	anton := friend("anton")
	follow(t, db, anton.ID, me.ID, models.FollowStateActive, t0) // both directions: listed once
	friend("bob")
	ava := friend("ava")
	seedParticipant(t, db, c.ID, ava.ID, day) // already takes part
	abe := namedUser(t, db, "abe")
	follow(t, db, me.ID, abe.ID, models.FollowStatePending, t0)
	alf := namedUser(t, db, "alf")
	follow(t, db, alf.ID, me.ID, models.FollowStateRemoved, t0)
	namedUser(t, db, "art") // no relationship
	follow(t, db, me.ID, me.ID, models.FollowStateActive, t0)
	other := namedUser(t, db, "other")
	follow(t, db, other.ID, namedUser(t, db, "andy").ID, models.FollowStateActive, t0) // not my friend
	require.NoError(t, db.Create(&models.ChallengeInvite{ChallengeID: c.ID, InviterID: me.ID, InviteeID: anna.ID}).Error)

	list := func(prefix string, limit int) []InviteCandidateRow {
		t.Helper()
		rows, err := repo.InviteCandidates(c.ID, me.ID, prefix, limit)
		require.NoError(t, err)
		return rows
	}

	all := list("", 50)
	assert.Equal(t, []string{"amy", "anna", "anton", "bob"}, candidateNames(all))
	assert.Equal(t, amy.ID, all[0].ID)
	assert.Equal(t, amy.ProfilePic, all[0].ProfilePic)
	assert.Equal(t, amy.ProfilePicThumb, all[0].ProfilePicThumb)
	assert.True(t, all[0].IsVerified)
	assert.False(t, all[0].Invited)
	assert.True(t, all[1].Invited, "anna was invited already")
	assert.Nil(t, all[2].ProfilePic)
	assert.Equal(t, anton.ID, all[2].ID)

	assert.Equal(t, []string{"amy", "anna"}, candidateNames(list("", 2)), "limit")
	assert.Equal(t, []string{"anna", "anton"}, candidateNames(list("an", 50)))
	assert.Equal(t, []string{"anna", "anton"}, candidateNames(list("AN", 50)), "case-insensitive")
	assert.Equal(t, []string{"anton"}, candidateNames(list("anton", 50)))
	assert.Empty(t, list("antonio", 50))
	assert.Empty(t, list("ava", 50), "participants are excluded")
	assert.Empty(t, list("me", 50), "the viewer is excluded")

	t.Run("usernames are matched case-insensitively", func(t *testing.T) {
		friend("Bea") // created before usernames were lower-case only
		assert.Equal(t, []string{"Bea", "bob"}, candidateNames(list("b", 50)))
		assert.Equal(t, []string{"Bea"}, candidateNames(list("bE", 50)))
	})

	t.Run("LIKE wildcards match literally", func(t *testing.T) {
		friend("z_z")
		friend("zxz")
		friend("z%z")
		friend(`z\z`)
		assert.Equal(t, []string{"z_z"}, candidateNames(list("z_", 50)))
		assert.Equal(t, []string{"z%z"}, candidateNames(list("z%", 50)))
		assert.Equal(t, []string{`z\z`}, candidateNames(list(`z\`, 50)))
		assert.Empty(t, list("%", 50))
		assert.Empty(t, list("_", 50))
		assert.Len(t, list("z", 50), 4)
	})

	t.Run("error", func(t *testing.T) {
		_, err := NewChallengeRepository(testutil.BrokenDB(t)).InviteCandidates(c.ID, me.ID, "", 20)
		assert.Error(t, err)
	})
}
