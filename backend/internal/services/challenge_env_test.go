package services

import (
	"sync"
	"testing"
	"time"

	"github.com/aman1117/backend/internal/dto"
	"github.com/aman1117/backend/internal/logger"
	"github.com/aman1117/backend/internal/repository"
	"github.com/aman1117/backend/internal/testutil"
	"github.com/aman1117/backend/pkg/models"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
	"go.uber.org/zap/zaptest/observer"
	"gorm.io/gorm"
)

// ==================== Challenge test environment ====================

// chClock is a manual clock; ChallengeService reads "today" (IST) from it.
type chClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *chClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

// setDay moves the clock to noon IST on date d.
func (c *chClock) setDay(d time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = time.Date(d.Year(), d.Month(), d.Day(), 12, 0, 0, 0, istLocation)
}

// chEnv is a ChallengeService on the package database with a manual clock.
type chEnv struct {
	db    *gorm.DB
	clock *chClock
	svc   *ChallengeService
}

// newChEnv must be called from a top-level test (it uses testDB).
func newChEnv(t *testing.T, today time.Time) *chEnv {
	t.Helper()
	e := &chEnv{db: testDB(t), clock: &chClock{}}
	e.clock.setDay(today)
	e.svc = e.service(e.db, e.db, e.db)
	return e
}

// service builds a ChallengeService on the given databases (challenges, job logs and
// notifications); a nil database leaves that dependency out.
func (e *chEnv) service(challenges, jobLogs, notifs *gorm.DB) *ChallengeService {
	var jobLogRepo *repository.CronJobLogRepository
	if jobLogs != nil {
		jobLogRepo = repository.NewCronJobLogRepository(jobLogs)
	}
	var notifSvc *NotificationService
	if notifs != nil {
		notifSvc = newNotificationService(notifs)
	}
	return NewChallengeService(repository.NewChallengeRepository(challenges), jobLogRepo, notifSvc,
		WithChallengeClock(e.clock.Now))
}

// user creates a user (with its follow counters) named name.
func (e *chEnv) user(t *testing.T, name string, opts ...func(*models.User)) *models.User {
	t.Helper()
	return newUser(t, e.db, append([]func(*models.User){func(u *models.User) { u.Username = name }}, opts...)...)
}

// chAvatar gives a user profile pictures and the verified badge.
func chAvatar(u *models.User) {
	pic := "https://cdn.example.com/" + u.Username + ".jpg"
	thumb := "https://cdn.example.com/" + u.Username + "_thumb.jpg"
	u.ProfilePic, u.ProfilePicThumb, u.IsVerified = &pic, &thumb, true
}

// seed inserts a "Study 2h+" challenge directly (any dates allowed), without participants.
func (e *chEnv) seed(t *testing.T, creator *models.User, start time.Time, days int, opts ...func(*models.Challenge)) *models.Challenge {
	t.Helper()
	c := &models.Challenge{
		CreatorID:   creator.ID,
		Title:       "Study 2h+",
		Activity:    string(models.ActivityStudy),
		GoalType:    models.ChallengeGoalAtLeast,
		TargetHours: 2,
		StartDate:   start,
		EndDate:     start.AddDate(0, 0, days-1),
		InviteCode:  generateInviteCode(),
	}
	for _, opt := range opts {
		opt(c)
	}
	require.NoError(t, e.db.Create(c).Error)
	return c
}

var chJoinSeq struct {
	sync.Mutex
	n int
}

// join adds a participant directly; participants added later joined later.
func (e *chEnv) join(t *testing.T, c *models.Challenge, u *models.User, joinedOn time.Time) {
	t.Helper()
	chJoinSeq.Lock()
	chJoinSeq.n++
	n := chJoinSeq.n
	chJoinSeq.Unlock()
	require.NoError(t, e.db.Create(&models.ChallengeParticipant{
		ChallengeID: c.ID, UserID: u.ID, JoinedOn: joinedOn,
		JoinedAt: joinedOn.Add(time.Duration(n) * time.Second),
	}).Error)
}

// snapshot stores a locked day.
func (e *chEnv) snapshot(t *testing.T, c *models.Challenge, u *models.User, date time.Time, hours float64, met bool) {
	t.Helper()
	require.NoError(t, e.db.Create(&models.ChallengeDay{
		ChallengeID: c.ID, UserID: u.ID, DayDate: date, Hours: hours, Logged: hours > 0, Met: met, LockedAt: e.clock.Now(),
	}).Error)
}

// log records an activity.
func (e *chEnv) log(t *testing.T, u *models.User, name models.ActivityName, hours float32, date time.Time) {
	t.Helper()
	testutil.CreateActivity(t, e.db, u.ID, name, hours, date)
}

// finalize stores final results for one participant and marks the challenge finalized.
func (e *chEnv) finalize(t *testing.T, c *models.Challenge, u *models.User, rank, daysMet int, hours float64, completed bool) {
	t.Helper()
	require.NoError(t, e.db.Model(&models.ChallengeParticipant{}).
		Where("challenge_id = ? AND user_id = ?", c.ID, u.ID).
		Updates(map[string]any{"final_rank": rank, "final_days_met": daysMet, "final_total_hours": hours, "completed": completed}).Error)
	require.NoError(t, e.db.Model(&models.Challenge{}).Where("id = ?", c.ID).
		Updates(map[string]any{"locked_through": c.EndDate, "finalized_at": e.clock.Now()}).Error)
}

// studyRequest is a valid "Study 2h+" create request.
func studyRequest(start time.Time, days int) dto.CreateChallengeRequest {
	return dto.CreateChallengeRequest{
		Title:        "Study 2h+",
		Activity:     string(models.ActivityStudy),
		GoalType:     models.ChallengeGoalAtLeast,
		TargetHours:  testutil.Ptr(2.0),
		DurationDays: testutil.Ptr(days),
		StartDate:    formatDate(start),
	}
}

// chUser is the ChallengeUser of u.
func chUser(u *models.User) dto.ChallengeUser {
	return dto.ChallengeUser{ID: u.ID, Username: u.Username, ProfilePic: u.ProfilePic, ProfilePicThumb: u.ProfilePicThumb, IsVerified: u.IsVerified}
}

// participantOf returns the participant entry of userID in a detail.
func participantOf(t *testing.T, d *dto.ChallengeDetail, userID uint) dto.ChallengeParticipant {
	t.Helper()
	for _, p := range d.Participants {
		if p.User.ID == userID {
			return p
		}
	}
	t.Fatalf("user %d is not a participant", userID)
	return dto.ChallengeParticipant{}
}

// typedNotifications returns a user's notifications of one type, oldest first.
func typedNotifications(t *testing.T, db *gorm.DB, userID uint, typ models.NotificationType) []models.Notification {
	t.Helper()
	var notifs []models.Notification
	require.NoError(t, db.Where("user_id = ? AND type = ?", userID, typ).Order("id").Find(&notifs).Error)
	return notifs
}

// challengeDayDates lists the locked dates of a participant.
func challengeDayDates(t *testing.T, db *gorm.DB, challengeID, userID uint) []string {
	t.Helper()
	var days []models.ChallengeDay
	require.NoError(t, db.Where("challenge_id = ? AND user_id = ?", challengeID, userID).Order("day_date").Find(&days).Error)
	out := make([]string, len(days))
	for i, d := range days {
		out[i] = formatDate(d.DayDate)
	}
	return out
}

// observeChallengeLogs routes logger.Sugar to an in-memory observer until the test ends.
func observeChallengeLogs(t *testing.T) *observer.ObservedLogs {
	t.Helper()
	core, logs := observer.New(zap.DebugLevel)
	prevLog, prevSugar := logger.Log, logger.Sugar
	logger.Log = zap.New(core)
	logger.Sugar = logger.Log.Sugar()
	t.Cleanup(func() { logger.Log, logger.Sugar = prevLog, prevSugar })
	return logs
}

// nthStmt narrows a faultyDB predicate to its nth (1-based) matching statement.
func nthStmt(n int, match func(stmtInfo) bool) func(stmtInfo) bool {
	var mu sync.Mutex
	seen := 0
	return func(s stmtInfo) bool {
		if !match(s) {
			return false
		}
		mu.Lock()
		defer mu.Unlock()
		seen++
		return seen == n
	}
}
