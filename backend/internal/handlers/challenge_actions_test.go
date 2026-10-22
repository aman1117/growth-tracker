package handlers

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/dto"
	"github.com/aman1117/backend/internal/testutil"
	"github.com/aman1117/backend/pkg/models"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestChallengeHandler_CheerParticipant(t *testing.T) {
	env := newEnv(t)
	ann, ben, outsider := env.user(t, withUsername("ann")), env.user(t), env.user(t)
	c := seedChallenge(t, env.db, ann, -1, 5, ben)
	upcoming := seedChallenge(t, env.db, ann, 2, 5, ben)

	res := env.do(t, ann, http.MethodPost, challengePath(c, "/cheers"), map[string]any{"user_id": ben.ID})
	require.Equal(t, http.StatusOK, res.Status, string(res.Body))
	assert.Equal(t, map[string]any{"success": true, "already_cheered": false}, res.JSON(t))
	notif := waitNotification(t, env.db, ben.ID, models.NotifTypeChallengeCheer)
	assert.Equal(t, "ann cheered you on in “Study 2h+”", notif.Body)

	res = env.do(t, ann, http.MethodPost, challengePath(c, "/cheers"), map[string]any{"user_id": ben.ID})
	assert.Equal(t, map[string]any{"success": true, "already_cheered": true}, decodeAs[map[string]any](t, res, http.StatusOK))
	assert.EqualValues(t, 1, count(t, env.db, &models.Notification{}, "user_id = ? AND type = ?", ben.ID, models.NotifTypeChallengeCheer))

	tests := []struct {
		name    string
		user    *models.User
		target  string
		body    any
		status  int
		code    string
		message string
	}{
		{"self", ann, challengePath(c, "/cheers"), map[string]any{"user_id": ann.ID}, http.StatusBadRequest,
			constants.ErrCodeCannotCheerSelf, "You cannot cheer yourself"},
		{"not a participant", ann, challengePath(c, "/cheers"), map[string]any{"user_id": outsider.ID}, http.StatusBadRequest,
			constants.ErrCodeInvalidChallenge, "user_id must be a participant of this challenge"},
		{"not active", ann, challengePath(upcoming, "/cheers"), map[string]any{"user_id": ben.ID}, http.StatusConflict,
			constants.ErrCodeChallengeNotActive, "You can only cheer while the challenge is active"},
		{"outsider", outsider, challengePath(c, "/cheers"), map[string]any{"user_id": ben.ID}, http.StatusNotFound,
			constants.ErrCodeChallengeNotFound, "Challenge not found"},
		{"missing user_id", ann, challengePath(c, "/cheers"), map[string]any{}, http.StatusBadRequest,
			constants.ErrCodeInvalidRequest, "user_id is required"},
		{"malformed body", ann, challengePath(c, "/cheers"), map[string]any{"user_id": "ben"}, http.StatusBadRequest,
			constants.ErrCodeInvalidRequest, "Invalid request body"},
		{"invalid ID", ann, "/api/challenges/abc/cheers", map[string]any{"user_id": ben.ID}, http.StatusBadRequest,
			constants.ErrCodeInvalidRequest, "Invalid challenge ID"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res := env.do(t, tt.user, http.MethodPost, tt.target, tt.body)
			assertErrorMessage(t, res, tt.status, tt.code, tt.message)
		})
	}
}

func TestChallengeHandler_GetInviteCandidates(t *testing.T) {
	env := newEnv(t)
	ann, ben := env.user(t, withUsername("ann")), env.user(t, withUsername("ben"))
	amy := env.user(t, withUsername("amy"), withPicture("https://cdn.example.com/amy.jpg"), verified)
	abe, outsider := env.user(t, withUsername("abe")), env.user(t, withUsername("zed"))
	follow(t, env.db, ann, amy)
	follow(t, env.db, abe, ann)
	follow(t, env.db, ann, ben)
	c := seedChallenge(t, env.db, ann, 1, 5, ben)
	require.NoError(t, env.db.Create(&models.ChallengeInvite{ChallengeID: c.ID, InviterID: ann.ID, InviteeID: abe.ID}).Error)

	res := env.do(t, ann, http.MethodGet, challengePath(c, "/invite-candidates"), nil)
	require.Equal(t, http.StatusOK, res.Status, string(res.Body))
	users := res.JSON(t)["users"].([]any)
	require.Len(t, users, 2)
	assert.Equal(t, sorted(append(append([]string{}, challengeUserKeys...), "invited")...), keys(t, users[0]))
	got := decodeAs[dto.InviteCandidatesResponse](t, res, http.StatusOK)
	assert.Equal(t, []dto.InviteCandidate{
		{ChallengeUser: dto.ChallengeUser{ID: abe.ID, Username: "abe"}, Invited: true},
		{ChallengeUser: dto.ChallengeUser{ID: amy.ID, Username: "amy", ProfilePic: amy.ProfilePic, ProfilePicThumb: amy.ProfilePicThumb, IsVerified: true}},
	}, got.Users)

	res = env.do(t, ann, http.MethodGet, challengePath(c, "/invite-candidates?q=AM&limit=100"), nil)
	got = decodeAs[dto.InviteCandidatesResponse](t, res, http.StatusOK)
	require.Len(t, got.Users, 1)
	assert.Equal(t, "amy", got.Users[0].Username)

	res = env.do(t, ann, http.MethodGet, challengePath(c, "/invite-candidates?limit=1"), nil)
	assert.Len(t, decodeAs[dto.InviteCandidatesResponse](t, res, http.StatusOK).Users, 1)

	res = env.do(t, ann, http.MethodGet, challengePath(c, "/invite-candidates?q=nobody"), nil)
	assert.Equal(t, map[string]any{"success": true, "users": []any{}}, res.JSON(t))

	for _, limit := range []string{"abc", "0", "-3", "1.5"} {
		res := env.do(t, ann, http.MethodGet, challengePath(c, "/invite-candidates?limit="+limit), nil)
		assertErrorMessage(t, res, http.StatusBadRequest, constants.ErrCodeInvalidRequest, "limit must be a positive integer")
	}
	res = env.do(t, outsider, http.MethodGet, challengePath(c, "/invite-candidates"), nil)
	assertError(t, res, http.StatusNotFound, constants.ErrCodeChallengeNotFound)
	res = env.do(t, ann, http.MethodGet, "/api/challenges/0/invite-candidates", nil)
	assertError(t, res, http.StatusBadRequest, constants.ErrCodeInvalidRequest)
}

func TestChallengeHandler_InviteUsers(t *testing.T) {
	env := newEnv(t)
	ann, friend, stranger := env.user(t, withUsername("ann")), env.user(t), env.user(t)
	follow(t, env.db, friend, ann)
	c := seedChallenge(t, env.db, ann, 1, 5)
	ended := seedChallenge(t, env.db, ann, -9, 5)

	res := env.do(t, ann, http.MethodPost, challengePath(c, "/invites"), map[string]any{"user_ids": []uint{friend.ID, stranger.ID, 99999}})
	require.Equal(t, http.StatusOK, res.Status, string(res.Body))
	assert.Equal(t, map[string]any{"success": true, "invited": float64(1), "skipped": float64(2)}, res.JSON(t))
	notif := waitNotification(t, env.db, friend.ID, models.NotifTypeChallengeInvite)
	assert.Equal(t, c.InviteCode, notif.Metadata["invite_code"])

	res = env.do(t, ann, http.MethodPost, challengePath(c, "/invites"), map[string]any{"user_ids": []uint{friend.ID}})
	assert.Equal(t, dto.ChallengeInviteResponse{Success: true, Invited: 0, Skipped: 1}, decodeAs[dto.ChallengeInviteResponse](t, res, http.StatusOK))

	tooMany := make([]uint, constants.ChallengeMaxInvitesPerRequest+1)
	tests := []struct {
		name    string
		user    *models.User
		target  string
		body    any
		status  int
		code    string
		message string
	}{
		{"no users", ann, challengePath(c, "/invites"), map[string]any{"user_ids": []uint{}}, http.StatusBadRequest,
			constants.ErrCodeInvalidChallenge, "user_ids must contain between 1 and 20 users"},
		{"missing users", ann, challengePath(c, "/invites"), map[string]any{}, http.StatusBadRequest,
			constants.ErrCodeInvalidChallenge, "user_ids must contain between 1 and 20 users"},
		{"too many users", ann, challengePath(c, "/invites"), map[string]any{"user_ids": tooMany}, http.StatusBadRequest,
			constants.ErrCodeInvalidChallenge, "user_ids must contain between 1 and 20 users"},
		{"malformed body", ann, challengePath(c, "/invites"), map[string]any{"user_ids": "all"}, http.StatusBadRequest,
			constants.ErrCodeInvalidRequest, "Invalid request body"},
		{"ended", ann, challengePath(ended, "/invites"), map[string]any{"user_ids": []uint{friend.ID}}, http.StatusConflict,
			constants.ErrCodeChallengeEnded, "This challenge has ended"},
		{"outsider", stranger, challengePath(c, "/invites"), map[string]any{"user_ids": []uint{friend.ID}}, http.StatusNotFound,
			constants.ErrCodeChallengeNotFound, "Challenge not found"},
		{"invalid ID", ann, "/api/challenges/-4/invites", map[string]any{"user_ids": []uint{friend.ID}}, http.StatusBadRequest,
			constants.ErrCodeInvalidRequest, "Invalid challenge ID"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res := env.do(t, tt.user, http.MethodPost, tt.target, tt.body)
			assertErrorMessage(t, res, tt.status, tt.code, tt.message)
		})
	}
}

func TestChallengeHandler_PreviewChallenge(t *testing.T) {
	env := newEnv(t)
	ann, ben, outsider := env.user(t, withUsername("ann")), env.user(t), env.user(t)
	c := seedChallenge(t, env.db, ann, 2, 7, ben)

	res := env.do(t, outsider, http.MethodGet, "/api/challenge-codes/"+strings.ToLower(c.InviteCode), nil)
	require.Equal(t, http.StatusOK, res.Status, string(res.Body))
	preview := res.JSON(t)["preview"]
	assert.Equal(t, sorted("id", "title", "activity", "goal_type", "target_hours", "start_date", "end_date", "duration_days",
		"status", "finalized", "participant_count", "max_participants", "creator", "participants_preview",
		"is_participant", "can_join", "join_blocked_reason"), keys(t, preview))
	got := decodeAs[dto.ChallengePreviewResponse](t, res, http.StatusOK).Preview
	require.NotNil(t, got)
	assert.Equal(t, c.ID, got.ID)
	assert.Equal(t, "upcoming", got.Status)
	assert.Equal(t, 2, got.ParticipantCount)
	assert.Equal(t, 50, got.MaxParticipants)
	assert.Equal(t, "ann", got.Creator.Username)
	assert.Len(t, got.ParticipantsPreview, 2)
	assert.False(t, got.IsParticipant)
	assert.True(t, got.CanJoin)
	assert.Nil(t, got.JoinBlockedReason)

	res = env.do(t, ben, http.MethodGet, "/api/challenge-codes/"+c.InviteCode, nil)
	got = decodeAs[dto.ChallengePreviewResponse](t, res, http.StatusOK).Preview
	assert.True(t, got.IsParticipant)
	assert.False(t, got.CanJoin)

	ended := seedChallenge(t, env.db, ann, -9, 5)
	res = env.do(t, outsider, http.MethodGet, "/api/challenge-codes/"+ended.InviteCode, nil)
	assert.Equal(t, testutil.Ptr("ended"), decodeAs[dto.ChallengePreviewResponse](t, res, http.StatusOK).Preview.JoinBlockedReason)

	for _, code := range []string{"ABC", "ABCDEFG0", "ABCDEFGHJ", "ABCD%20EFG"} {
		res := env.do(t, outsider, http.MethodGet, "/api/challenge-codes/"+code, nil)
		assertErrorMessage(t, res, http.StatusBadRequest, constants.ErrCodeInvalidRequest, "Invalid invite code")
	}
	// A malformed escape reaches the handler verbatim (the router does not unescape paths).
	req := httptest.NewRequest(http.MethodGet, "/api/challenge-codes/ABCDEFGH", nil)
	req.RequestURI = "/api/challenge-codes/%ZZ"
	resp, err := newApp(env.h, outsider).Test(req, -1)
	require.NoError(t, err)
	defer resp.Body.Close()
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
	res = env.do(t, outsider, http.MethodGet, "/api/challenge-codes/%20"+strings.ToLower(c.InviteCode)+"%20", nil)
	assert.Equal(t, http.StatusOK, res.Status, "surrounding spaces are ignored")
	res = env.do(t, outsider, http.MethodGet, "/api/challenge-codes/ZZZZZZZZ", nil)
	assertErrorMessage(t, res, http.StatusNotFound, constants.ErrCodeChallengeNotFound, "Challenge not found")
}

func TestChallengeHandler_JoinChallenge(t *testing.T) {
	env := newEnv(t)
	ann, ben := env.user(t, withUsername("ann")), env.user(t, withUsername("ben"))
	c := seedChallenge(t, env.db, ann, 1, 5)

	res := env.do(t, ben, http.MethodPost, "/api/challenge-codes/"+strings.ToLower(c.InviteCode)+"/join", nil)
	require.Equal(t, http.StatusOK, res.Status, string(res.Body))
	assertDetailShape(t, res.JSON(t)["challenge"])
	detail := decodeAs[dto.ChallengeResponse](t, res, http.StatusOK).Challenge
	assert.Equal(t, 2, detail.ParticipantCount)
	assert.True(t, detail.CanLeave)
	notif := waitNotification(t, env.db, ann.ID, models.NotifTypeChallengeJoined)
	assert.Equal(t, "ben joined “Study 2h+”", notif.Body)

	res = env.do(t, ben, http.MethodPost, "/api/challenge-codes/"+c.InviteCode+"/join", nil)
	assert.Equal(t, http.StatusOK, res.Status, "joining again succeeds")
	assert.EqualValues(t, 1, count(t, env.db, &models.Notification{}, "user_id = ? AND type = ?", ann.ID, models.NotifTypeChallengeJoined))

	ended := seedChallenge(t, env.db, ann, -9, 5)
	full := seedChallenge(t, env.db, ann, 1, 5)
	for i := 1; i < constants.ChallengeMaxParticipants; i++ {
		u := testutil.CreateUser(t, env.db)
		require.NoError(t, env.db.Create(&models.ChallengeParticipant{ChallengeID: full.ID, UserID: u.ID, JoinedOn: chDate(0), JoinedAt: challengeClock()}).Error)
	}
	busy := env.user(t)
	for i := 0; i < constants.ChallengeMaxOpenPerUser; i++ {
		seedChallenge(t, env.db, busy, 1, 5)
	}

	tests := []struct {
		name    string
		user    *models.User
		code    string
		status  int
		errCode string
		message string
	}{
		{"ended", ben, ended.InviteCode, http.StatusConflict, constants.ErrCodeChallengeEnded, "This challenge has ended"},
		{"full", ben, full.InviteCode, http.StatusConflict, constants.ErrCodeChallengeFull, "This challenge is full"},
		{"limit", busy, c.InviteCode, http.StatusConflict, constants.ErrCodeChallengeLimitReached,
			"You already take part in the maximum number of open challenges"},
		{"unknown", ben, "ZZZZZZZZ", http.StatusNotFound, constants.ErrCodeChallengeNotFound, "Challenge not found"},
		{"malformed", ben, "nope", http.StatusBadRequest, constants.ErrCodeInvalidRequest, "Invalid invite code"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res := env.do(t, tt.user, http.MethodPost, "/api/challenge-codes/"+tt.code+"/join", nil)
			assertErrorMessage(t, res, tt.status, tt.errCode, tt.message)
		})
	}
}

func TestChallengeHandler_ServerErrors(t *testing.T) {
	env := newEnv(t)
	ann, ben := env.user(t), env.user(t)
	c := seedChallenge(t, env.db, ann, -1, 5, ben)
	logs := observeLogs(t)
	h := &handlerSet{challenge: NewChallengeHandler(brokenStack(t).challengeSvc)}

	tests := []struct {
		method, target string
		body           any
		code, message  string
	}{
		{http.MethodGet, "/api/challenges", nil, constants.ErrCodeFetchFailed, "Failed to load challenges"},
		{http.MethodPost, "/api/challenges", createBody(chDate(1), 5), constants.ErrCodeCreateFailed, "Failed to create challenge"},
		{http.MethodGet, challengePath(c, ""), nil, constants.ErrCodeFetchFailed, "Failed to load challenge"},
		{http.MethodDelete, challengePath(c, ""), nil, constants.ErrCodeDeleteFailed, "Failed to delete challenge"},
		{http.MethodPost, challengePath(c, "/leave"), nil, constants.ErrCodeDeleteFailed, "Failed to leave challenge"},
		{http.MethodPost, challengePath(c, "/cheers"), map[string]any{"user_id": ben.ID}, constants.ErrCodeCreateFailed, "Failed to cheer"},
		{http.MethodGet, challengePath(c, "/invite-candidates"), nil, constants.ErrCodeFetchFailed, "Failed to load invite candidates"},
		{http.MethodPost, challengePath(c, "/invites"), map[string]any{"user_ids": []uint{ben.ID}}, constants.ErrCodeCreateFailed, "Failed to send invites"},
		{http.MethodGet, "/api/challenge-codes/" + c.InviteCode, nil, constants.ErrCodeFetchFailed, "Failed to load challenge"},
		{http.MethodPost, "/api/challenge-codes/" + c.InviteCode + "/join", nil, constants.ErrCodeCreateFailed, "Failed to join challenge"},
	}
	for _, tt := range tests {
		t.Run(tt.method+" "+tt.target, func(t *testing.T) {
			res := call(t, h, ann, tt.method, tt.target, tt.body)
			assertErrorMessage(t, res, http.StatusInternalServerError, tt.code, tt.message)
		})
	}

	entries := logs.FilterMessage("Failed to load challenge").All()
	require.NotEmpty(t, entries)
	fields := entries[0].ContextMap()
	assert.EqualValues(t, c.ID, fields["challenge_id"])
	assert.NotEmpty(t, fields["error"])
	assert.Equal(t, "responded with 500; the client may retry", fields["action"])
}
