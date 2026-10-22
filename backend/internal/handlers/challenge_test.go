package handlers

import (
	"crypto/rand"
	"net/http"
	"sort"
	"testing"
	"time"

	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/dto"
	"github.com/aman1117/backend/internal/services"
	"github.com/aman1117/backend/internal/testutil"
	"github.com/aman1117/backend/pkg/models"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

// ==================== Challenge fixtures ====================

// chDate returns the date offset days after challengeToday.
func chDate(offset int) time.Time { return challengeToday.AddDate(0, 0, offset) }

func randomInviteCode(t *testing.T) string {
	t.Helper()
	b := make([]byte, constants.ChallengeInviteCodeLength)
	_, err := rand.Read(b)
	require.NoError(t, err)
	for i := range b {
		b[i] = constants.ChallengeInviteCodeAlphabet[int(b[i])%len(constants.ChallengeInviteCodeAlphabet)]
	}
	return string(b)
}

// seedChallenge inserts a "Study 2h+" challenge of days days from start(offset) created by
// creator, who takes part with the other participants (in that joining order).
func seedChallenge(t *testing.T, db *gorm.DB, creator *models.User, start, days int, others ...*models.User) *models.Challenge {
	t.Helper()
	c := &models.Challenge{
		CreatorID: creator.ID, Title: "Study 2h+", Activity: "study", GoalType: models.ChallengeGoalAtLeast,
		TargetHours: 2, StartDate: chDate(start), EndDate: chDate(start + days - 1), InviteCode: randomInviteCode(t),
	}
	require.NoError(t, db.Create(c).Error)
	joinedOn := chDate(min(start, 0))
	for i, u := range append([]*models.User{creator}, others...) {
		require.NoError(t, db.Create(&models.ChallengeParticipant{
			ChallengeID: c.ID, UserID: u.ID, JoinedOn: joinedOn, JoinedAt: joinedOn.Add(time.Duration(i) * time.Minute),
		}).Error)
	}
	return c
}

func challengePath(c *models.Challenge, suffix string) string {
	return "/api/challenges/" + itoa(c.ID) + suffix
}

func createBody(start time.Time, days int) map[string]any {
	return map[string]any{
		"title": "Study 2h+", "activity": "study", "goal_type": "at_least",
		"target_hours": 2, "duration_days": days, "start_date": start.Format(constants.DateFormat),
	}
}

// keys returns the sorted keys of a JSON object.
func keys(t *testing.T, v any) []string {
	t.Helper()
	m, ok := v.(map[string]any)
	require.True(t, ok, "%v is not an object", v)
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func sorted(s ...string) []string {
	sort.Strings(s)
	return s
}

var (
	challengeUserKeys     = sorted("id", "username", "profile_pic", "profile_pic_thumb", "is_verified")
	challengeProgressKeys = []string{"rank", "days_met", "days_elapsed", "days_possible", "current_streak",
		"total_hours", "today_hours", "today_status", "completed"}
	challengeSummaryKeys = []string{"id", "title", "activity", "goal_type", "target_hours", "start_date", "end_date",
		"duration_days", "status", "finalized", "day_number", "participant_count", "is_creator", "me"}
	challengeDetailKeys = sorted(append(append([]string{}, challengeSummaryKeys...), "invite_code", "today", "locked_through",
		"results_date", "completion_days", "max_participants", "creator", "can_invite", "can_leave", "can_delete",
		"participants", "my_days")...)
	challengeParticipantKeys = sorted(append(append([]string{}, challengeProgressKeys...), "user", "joined_on", "is_me",
		"cheered_today", "days")...)
)

// assertDetailShape checks the JSON shape of a ChallengeDetail.
func assertDetailShape(t *testing.T, challenge any) {
	t.Helper()
	assert.Equal(t, challengeDetailKeys, keys(t, challenge))
	c := challenge.(map[string]any)
	assert.Equal(t, sorted(challengeProgressKeys...), keys(t, c["me"]))
	assert.Equal(t, challengeUserKeys, keys(t, c["creator"]))
	participants := c["participants"].([]any)
	require.NotEmpty(t, participants)
	assert.Equal(t, challengeParticipantKeys, keys(t, participants[0]))
	assert.Equal(t, challengeUserKeys, keys(t, participants[0].(map[string]any)["user"]))
	days := c["my_days"].([]any)
	require.NotEmpty(t, days)
	assert.Equal(t, sorted("date", "hours", "status", "locked"), keys(t, days[0]))
}

// ==================== Tests ====================

func TestChallengeHandler_RequiresAuth(t *testing.T) {
	env := newEnv(t)
	routes := []struct{ method, target string }{
		{http.MethodGet, "/api/challenges"},
		{http.MethodPost, "/api/challenges"},
		{http.MethodGet, "/api/challenges/1"},
		{http.MethodDelete, "/api/challenges/1"},
		{http.MethodPost, "/api/challenges/1/leave"},
		{http.MethodPost, "/api/challenges/1/cheers"},
		{http.MethodGet, "/api/challenges/1/invite-candidates"},
		{http.MethodPost, "/api/challenges/1/invites"},
		{http.MethodGet, "/api/challenge-codes/ABCDEFGH"},
		{http.MethodPost, "/api/challenge-codes/ABCDEFGH/join"},
	}
	for _, r := range routes {
		t.Run(r.method+" "+r.target, func(t *testing.T) {
			res := env.do(t, nil, r.method, r.target, nil)
			assertErrorMessage(t, res, http.StatusUnauthorized, constants.ErrCodeUnauthorized, "Authentication required")
		})
	}
}

func TestChallengeHandler_CreateChallenge(t *testing.T) {
	env := newEnv(t)
	ann := env.user(t, withUsername("ann"), withPicture("https://cdn.example.com/ann.jpg"), verified)

	res := env.do(t, ann, http.MethodPost, "/api/challenges", map[string]any{
		"title": "  Study 2h+ a day 📚 ", "activity": "study", "goal_type": "at_least",
		"target_hours": 2.5, "duration_days": 21, "start_date": "2026-03-10",
	})
	require.Equal(t, http.StatusCreated, res.Status, string(res.Body))
	body := res.JSON(t)
	assert.Equal(t, true, body["success"])
	assertDetailShape(t, body["challenge"])

	created := decodeAs[dto.ChallengeResponse](t, res, http.StatusCreated)
	c := created.Challenge
	require.NotNil(t, c)
	assert.Equal(t, "Study 2h+ a day 📚", c.Title)
	assert.Equal(t, 2.5, c.TargetHours)
	assert.Equal(t, "2026-03-10", c.StartDate)
	assert.Equal(t, "2026-03-30", c.EndDate)
	assert.Equal(t, services.ChallengeStatusUpcoming, c.Status)
	assert.Len(t, c.InviteCode, constants.ChallengeInviteCodeLength)
	assert.Equal(t, "2026-03-09", c.Today)
	assert.True(t, c.IsCreator)
	assert.Equal(t, dto.ChallengeUser{ID: ann.ID, Username: "ann", ProfilePic: ann.ProfilePic, ProfilePicThumb: ann.ProfilePicThumb, IsVerified: true}, c.Creator)
	require.Len(t, c.Participants, 1)
	assert.True(t, c.Participants[0].IsMe)
	assert.Len(t, c.MyDays, 21)

	t.Run("malformed body", func(t *testing.T) {
		for _, body := range []any{"not json", map[string]any{"duration_days": "three"}, []int{1}} {
			res := env.do(t, ann, http.MethodPost, "/api/challenges", body)
			assertError(t, res, http.StatusBadRequest, constants.ErrCodeInvalidRequest)
		}
	})

	t.Run("validation", func(t *testing.T) {
		tests := []struct {
			name    string
			mutate  func(b map[string]any)
			message string
		}{
			{"title", func(b map[string]any) { b["title"] = " " }, "title must be between 1 and 60 characters"},
			{"activity", func(b map[string]any) { b["activity"] = "custom:3f2b8c4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f" }, "activity must be one of the predefined activities"},
			{"goal", func(b map[string]any) { b["goal_type"] = "exactly" }, "goal_type must be at_least or at_most"},
			{"target", func(b map[string]any) { b["target_hours"] = 1.1 }, "target_hours must be a multiple of 0.25 between 0.25 and 24"},
			{"missing target", func(b map[string]any) { delete(b, "target_hours") }, "target_hours is required"},
			{"duration", func(b map[string]any) { b["duration_days"] = 61 }, "duration_days must be between 3 and 60"},
			{"start", func(b map[string]any) { b["start_date"] = "2026-03-08" }, "start_date must be between today and 30 days from today"},
		}
		for _, tt := range tests {
			t.Run(tt.name, func(t *testing.T) {
				body := createBody(chDate(1), 7)
				tt.mutate(body)
				res := env.do(t, ann, http.MethodPost, "/api/challenges", body)
				assertErrorMessage(t, res, http.StatusBadRequest, constants.ErrCodeInvalidChallenge, tt.message)
			})
		}
	})

	t.Run("open challenge limit", func(t *testing.T) {
		busy := env.user(t)
		for i := 0; i < constants.ChallengeMaxOpenPerUser; i++ {
			seedChallenge(t, env.db, busy, 1, 5)
		}
		res := env.do(t, busy, http.MethodPost, "/api/challenges", createBody(chDate(1), 7))
		assertErrorMessage(t, res, http.StatusConflict, constants.ErrCodeChallengeLimitReached,
			"You already take part in the maximum number of open challenges")
	})
}

func TestChallengeHandler_ListChallenges(t *testing.T) {
	env := newEnv(t)
	ann, ben := env.user(t), env.user(t)

	res := env.do(t, ann, http.MethodGet, "/api/challenges", nil)
	require.Equal(t, http.StatusOK, res.Status)
	assert.Equal(t, map[string]any{"success": true, "challenges": []any{}}, res.JSON(t))

	active := seedChallenge(t, env.db, ann, -2, 7, ben)
	upcoming := seedChallenge(t, env.db, ben, 3, 5, ann)
	seedChallenge(t, env.db, ben, 1, 5) // not ann's

	res = env.do(t, ann, http.MethodGet, "/api/challenges", nil)
	list := decodeAs[dto.ChallengeListResponse](t, res, http.StatusOK)
	assert.True(t, list.Success)
	require.Len(t, list.Challenges, 2)
	assert.Equal(t, active.ID, list.Challenges[0].ID)
	assert.Equal(t, upcoming.ID, list.Challenges[1].ID)
	assert.True(t, list.Challenges[0].IsCreator)
	assert.Equal(t, 2, list.Challenges[0].ParticipantCount)
	assert.Equal(t, testutil.Ptr(3), list.Challenges[0].DayNumber)

	summary := res.JSON(t)["challenges"].([]any)[0]
	assert.Equal(t, sorted(challengeSummaryKeys...), keys(t, summary))
	assert.Equal(t, sorted(challengeProgressKeys...), keys(t, summary.(map[string]any)["me"]))
}

func TestChallengeHandler_GetChallenge(t *testing.T) {
	env := newEnv(t)
	ann, ben, outsider := env.user(t), env.user(t), env.user(t)
	c := seedChallenge(t, env.db, ann, -1, 5, ben)
	testutil.CreateActivity(t, env.db, ben.ID, models.ActivityStudy, 2.5, chDate(0))

	res := env.do(t, ben, http.MethodGet, challengePath(c, ""), nil)
	require.Equal(t, http.StatusOK, res.Status, string(res.Body))
	assertDetailShape(t, res.JSON(t)["challenge"])
	detail := decodeAs[dto.ChallengeResponse](t, res, http.StatusOK).Challenge
	assert.Equal(t, c.ID, detail.ID)
	assert.False(t, detail.IsCreator)
	assert.Equal(t, testutil.Ptr(2.5), detail.Me.TodayHours)
	assert.Equal(t, testutil.Ptr("met"), detail.Me.TodayStatus)
	assert.Equal(t, testutil.Ptr(1), detail.Me.Rank)
	assert.Equal(t, c.InviteCode, detail.InviteCode)

	t.Run("invalid IDs", func(t *testing.T) {
		for _, id := range []string{"abc", "0", "-1", "1.5", "4294967296", "99999999999999999999"} {
			res := env.do(t, ben, http.MethodGet, "/api/challenges/"+id, nil)
			assertErrorMessage(t, res, http.StatusBadRequest, constants.ErrCodeInvalidRequest, "Invalid challenge ID")
		}
	})

	t.Run("non-participants and unknown challenges look the same", func(t *testing.T) {
		for _, target := range []string{challengePath(c, ""), "/api/challenges/" + itoa(c.ID+100)} {
			res := env.do(t, outsider, http.MethodGet, target, nil)
			assertErrorMessage(t, res, http.StatusNotFound, constants.ErrCodeChallengeNotFound, "Challenge not found")
		}
	})
}

func TestChallengeHandler_DeleteChallenge(t *testing.T) {
	env := newEnv(t)
	ann, ben, outsider := env.user(t), env.user(t), env.user(t)

	upcoming := seedChallenge(t, env.db, ann, 1, 5, ben)
	res := env.do(t, ben, http.MethodDelete, challengePath(upcoming, ""), nil)
	assertErrorMessage(t, res, http.StatusForbidden, constants.ErrCodeNotAuthorized, "Only the creator can delete this challenge")
	res = env.do(t, outsider, http.MethodDelete, challengePath(upcoming, ""), nil)
	assertError(t, res, http.StatusNotFound, constants.ErrCodeChallengeNotFound)
	res = env.do(t, ann, http.MethodDelete, "/api/challenges/x", nil)
	assertError(t, res, http.StatusBadRequest, constants.ErrCodeInvalidRequest)

	res = env.do(t, ann, http.MethodDelete, challengePath(upcoming, ""), nil)
	require.Equal(t, http.StatusOK, res.Status, string(res.Body))
	assert.Equal(t, map[string]any{"success": true}, res.JSON(t))
	assert.Zero(t, count(t, env.db, &models.Challenge{}, "id = ?", upcoming.ID))

	active := seedChallenge(t, env.db, ann, -1, 5, ben)
	res = env.do(t, ann, http.MethodDelete, challengePath(active, ""), nil)
	assertErrorMessage(t, res, http.StatusConflict, constants.ErrCodeChallengeInProgress,
		"A challenge can only be deleted before it starts or while you are its only participant")
}

func TestChallengeHandler_LeaveChallenge(t *testing.T) {
	env := newEnv(t)
	ann, ben, outsider := env.user(t), env.user(t), env.user(t)
	c := seedChallenge(t, env.db, ann, -1, 5, ben)
	ended := seedChallenge(t, env.db, ann, -9, 5, ben)

	res := env.do(t, ann, http.MethodPost, challengePath(c, "/leave"), nil)
	assertErrorMessage(t, res, http.StatusConflict, constants.ErrCodeCreatorCannotLeave, "The creator cannot leave the challenge")
	res = env.do(t, ben, http.MethodPost, challengePath(ended, "/leave"), nil)
	assertErrorMessage(t, res, http.StatusConflict, constants.ErrCodeChallengeEnded, "This challenge has ended")
	res = env.do(t, outsider, http.MethodPost, challengePath(c, "/leave"), nil)
	assertError(t, res, http.StatusNotFound, constants.ErrCodeChallengeNotFound)
	res = env.do(t, ben, http.MethodPost, "/api/challenges/0/leave", nil)
	assertError(t, res, http.StatusBadRequest, constants.ErrCodeInvalidRequest)

	res = env.do(t, ben, http.MethodPost, challengePath(c, "/leave"), nil)
	require.Equal(t, http.StatusOK, res.Status, string(res.Body))
	assert.Equal(t, map[string]any{"success": true}, res.JSON(t))
	assert.Zero(t, count(t, env.db, &models.ChallengeParticipant{}, "challenge_id = ? AND user_id = ?", c.ID, ben.ID))
}
