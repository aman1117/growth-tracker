package handlers

import (
	"encoding/base64"
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/dto"
	"github.com/aman1117/backend/internal/testutil"
	"github.com/aman1117/backend/pkg/models"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

// deletedUserID is a user id without a users row (edges have no foreign keys).
const deletedUserID = 9999

var followBase = time.Date(2026, 3, 9, 10, 0, 0, 0, time.UTC)

// setEdgeTime pins the creation time of a follow edge in both edge tables.
func setEdgeTime(t *testing.T, db *gorm.DB, followerID, followeeID uint, at time.Time) {
	t.Helper()
	require.NoError(t, db.Model(&models.FollowEdgeByFollower{}).
		Where("follower_id = ? AND followee_id = ?", followerID, followeeID).Update("created_at", at).Error)
	require.NoError(t, db.Model(&models.FollowEdgeByFollowee{}).
		Where("followee_id = ? AND follower_id = ?", followeeID, followerID).Update("created_at", at).Error)
}

func followAt(t *testing.T, db *gorm.DB, followerID, followeeID uint, state models.FollowState, at time.Time) {
	t.Helper()
	createEdge(t, db, followerID, followeeID, state)
	setEdgeTime(t, db, followerID, followeeID, at)
}

func usernames(users []dto.FollowUserDTO) []string {
	out := make([]string, 0, len(users))
	for _, u := range users {
		out = append(out, u.Username)
	}
	return out
}

func followCounts(t *testing.T, env *testEnv, viewer, target *models.User) testutil.Response {
	t.Helper()
	return env.do(t, viewer, http.MethodGet, "/api/users/"+itoa(target.ID)+"/follow-counts", nil)
}

func TestFollowHandler_RequiresAuthentication(t *testing.T) {
	env := newEnv(t)
	endpoints := []struct{ method, path string }{
		{http.MethodPost, "/api/users/2/follow"},
		{http.MethodDelete, "/api/users/2/follow"},
		{http.MethodPost, "/api/follow-requests/2/cancel"},
		{http.MethodGet, "/api/me/follow-requests/incoming"},
		{http.MethodPost, "/api/me/follow-requests/2/accept"},
		{http.MethodPost, "/api/me/follow-requests/2/decline"},
		{http.MethodDelete, "/api/me/followers/2"},
		{http.MethodGet, "/api/users/2/followers"},
		{http.MethodGet, "/api/users/2/following"},
		{http.MethodGet, "/api/users/2/mutuals"},
		{http.MethodGet, "/api/users/2/follow-counts"},
		{http.MethodPost, "/api/me/follow-counts/reconcile"},
		{http.MethodPost, "/api/relationships/lookup"},
	}
	for _, e := range endpoints {
		t.Run(e.method+" "+e.path, func(t *testing.T) {
			res := env.do(t, nil, e.method, e.path, nil)
			assertErrorMessage(t, res, http.StatusUnauthorized, constants.ErrCodeUnauthorized, "Authentication required")
		})
	}
}

func TestFollowHandler_InvalidIDs(t *testing.T) {
	env := newEnv(t)
	user := env.user(t)
	tests := []struct{ method, path, message string }{
		{http.MethodPost, "/api/users/abc/follow", "Invalid target user ID"},
		{http.MethodDelete, "/api/users/abc/follow", "Invalid target user ID"},
		{http.MethodPost, "/api/follow-requests/-1/cancel", "Invalid target user ID"},
		{http.MethodPost, "/api/me/follow-requests/abc/accept", "Invalid requester ID"},
		{http.MethodPost, "/api/me/follow-requests/1.5/decline", "Invalid requester ID"},
		{http.MethodDelete, "/api/me/followers/abc", "Invalid follower ID"},
		{http.MethodGet, "/api/users/abc/followers", "Invalid user ID"},
		{http.MethodGet, "/api/users/abc/following", "Invalid user ID"},
		{http.MethodGet, "/api/users/abc/mutuals", "Invalid user ID"},
		{http.MethodGet, "/api/users/99999999999/follow-counts", "Invalid user ID"},
	}
	for _, tc := range tests {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			assertErrorMessage(t, env.do(t, user, tc.method, tc.path, nil), http.StatusBadRequest, constants.ErrCodeInvalidRequest, tc.message)
		})
	}
}

func TestFollowHandler_FollowAndUnfollow(t *testing.T) {
	env := newEnv(t)
	viewer := env.user(t)
	public := env.user(t)
	hidden := env.user(t, private)
	followUser := func(t *testing.T, target uint) dto.FollowActionResponse {
		t.Helper()
		return decodeAs[dto.FollowActionResponse](t, env.do(t, viewer, http.MethodPost, "/api/users/"+itoa(target)+"/follow", nil), http.StatusOK)
	}
	unfollow := func(t *testing.T, target uint) testutil.Response {
		t.Helper()
		return env.do(t, viewer, http.MethodDelete, "/api/users/"+itoa(target)+"/follow", nil)
	}

	t.Run("public account", func(t *testing.T) {
		assert.Equal(t, dto.FollowActionResponse{Success: true, State: "ACTIVE", Message: "Now following"}, followUser(t, public.ID))
		assert.Equal(t, models.FollowStateActive, edgeState(t, env.db, viewer.ID, public.ID))
		counts := decodeAs[dto.FollowCountsResponse](t, followCounts(t, env, viewer, public), http.StatusOK)
		assert.EqualValues(t, 1, counts.Counts.FollowersCount)
	})

	t.Run("already following", func(t *testing.T) {
		assert.Equal(t, dto.FollowActionResponse{Success: true, State: "ACTIVE", Message: "Already following"}, followUser(t, public.ID))
	})

	t.Run("private account", func(t *testing.T) {
		assert.Equal(t, dto.FollowActionResponse{Success: true, State: "PENDING", Message: "Follow request sent"}, followUser(t, hidden.ID))
		assert.Equal(t, models.FollowStatePending, edgeState(t, env.db, viewer.ID, hidden.ID))
	})

	t.Run("request already pending", func(t *testing.T) {
		assert.Equal(t, dto.FollowActionResponse{Success: true, State: "PENDING", Message: "Follow request already pending"}, followUser(t, hidden.ID))
	})

	t.Run("unfollow", func(t *testing.T) {
		assertSuccessMessage(t, unfollow(t, public.ID), http.StatusOK, "Unfollowed successfully")
		assert.Equal(t, models.FollowStateRemoved, edgeState(t, env.db, viewer.ID, public.ID))
		counts := decodeAs[dto.FollowCountsResponse](t, followCounts(t, env, viewer, public), http.StatusOK)
		assert.Zero(t, counts.Counts.FollowersCount)
	})

	t.Run("unfollow when not following", func(t *testing.T) {
		assertErrorMessage(t, unfollow(t, public.ID), http.StatusBadRequest, constants.ErrCodeNotFollowing, "Not following this user")
		assertErrorMessage(t, unfollow(t, deletedUserID), http.StatusBadRequest, constants.ErrCodeNotFollowing, "Not following this user")
	})

	t.Run("follow again after unfollowing", func(t *testing.T) {
		assert.Equal(t, dto.FollowActionResponse{Success: true, State: "ACTIVE", Message: "Now following"}, followUser(t, public.ID))
	})

	t.Run("yourself", func(t *testing.T) {
		res := env.do(t, viewer, http.MethodPost, "/api/users/"+itoa(viewer.ID)+"/follow", nil)
		assertErrorMessage(t, res, http.StatusBadRequest, constants.ErrCodeCannotFollowSelf, "Cannot follow yourself")
	})

	t.Run("unknown user", func(t *testing.T) {
		res := env.do(t, viewer, http.MethodPost, "/api/users/"+itoa(deletedUserID)+"/follow", nil)
		assertErrorMessage(t, res, http.StatusNotFound, constants.ErrCodeUserNotFound, "User not found")
	})
}

func TestFollowHandler_FollowUser_TotalLimit(t *testing.T) {
	cfg := testutil.Config()
	cfg.Follow.MaxTotalFollowing = 1
	env := newEnv(t, withConfig(cfg))
	viewer, first, second := env.user(t), env.user(t), env.user(t)

	require.Equal(t, http.StatusOK, env.do(t, viewer, http.MethodPost, "/api/users/"+itoa(first.ID)+"/follow", nil).Status)
	res := env.do(t, viewer, http.MethodPost, "/api/users/"+itoa(second.ID)+"/follow", nil)

	assertErrorMessage(t, res, http.StatusBadRequest, constants.ErrCodeFollowLimitExceeded,
		"FOLLOW_LIMIT_EXCEEDED: you have reached the maximum following limit of 1")
	assert.Empty(t, edgeState(t, env.db, viewer.ID, second.ID))
}

func TestFollowHandler_FollowUser_DailyLimit(t *testing.T) {
	cfg := testutil.Config()
	cfg.Follow.MaxFollowsPerDay = 1
	env := newEnv(t, withConfig(cfg))
	viewer, first, second := env.user(t), env.user(t), env.user(t)

	require.Equal(t, http.StatusOK, env.do(t, viewer, http.MethodPost, "/api/users/"+itoa(first.ID)+"/follow", nil).Status)
	res := env.do(t, viewer, http.MethodPost, "/api/users/"+itoa(second.ID)+"/follow", nil)

	assertErrorMessage(t, res, http.StatusBadRequest, constants.ErrCodeDailyLimitExceeded,
		"DAILY_LIMIT_EXCEEDED: you have reached the daily follow limit of 1")
}

func TestFollowHandler_FollowRequests(t *testing.T) {
	env := newEnv(t)
	owner := env.user(t, private)
	early := env.user(t, withBio("early bio"), withPicture("http://pics.example/early.jpg"), verified)
	late := env.user(t)
	stranger := env.user(t)
	followAt(t, env.db, deletedUserID, owner.ID, models.FollowStatePending, followBase.Add(-time.Hour))
	followAt(t, env.db, early.ID, owner.ID, models.FollowStatePending, followBase)
	followAt(t, env.db, late.ID, owner.ID, models.FollowStatePending, followBase.Add(time.Hour))
	incoming := func(t *testing.T, query string) dto.FollowRequestListResponse {
		t.Helper()
		return decodeAs[dto.FollowRequestListResponse](t, env.do(t, owner, http.MethodGet, "/api/me/follow-requests/incoming"+query, nil), http.StatusOK)
	}
	act := func(t *testing.T, user, requester *models.User, action string) testutil.Response {
		t.Helper()
		return env.do(t, user, http.MethodPost, "/api/me/follow-requests/"+itoa(requester.ID)+"/"+action, nil)
	}

	t.Run("lists incoming requests newest first", func(t *testing.T) {
		assert.Equal(t, dto.FollowRequestListResponse{
			Success: true,
			Requests: []dto.FollowRequestDTO{
				{ID: late.ID, Username: late.Username, RequestedAt: "2026-03-09T11:00:00Z"},
				{ID: early.ID, Username: early.Username, ProfilePic: early.ProfilePic, ProfilePicThumb: early.ProfilePicThumb,
					Bio: early.Bio, IsVerified: true, RequestedAt: "2026-03-09T10:00:00Z"},
			},
		}, incoming(t, ""), "requests from deleted accounts are skipped")
	})

	t.Run("pages with a cursor", func(t *testing.T) {
		first := incoming(t, "?limit=1")
		require.Len(t, first.Requests, 1)
		assert.Equal(t, late.ID, first.Requests[0].ID)
		assert.True(t, first.HasMore)
		assert.Equal(t, encodeCursor(followBase.Add(time.Hour), late.ID), first.NextCursor)

		second := incoming(t, "?limit=1&cursor="+url.QueryEscape(first.NextCursor))
		require.Len(t, second.Requests, 1)
		assert.Equal(t, early.ID, second.Requests[0].ID)
		assert.True(t, second.HasMore)

		last := incoming(t, "?limit=1&cursor="+url.QueryEscape(second.NextCursor))
		assert.Empty(t, last.Requests)
		assert.NotNil(t, last.Requests)
		assert.False(t, last.HasMore)
		assert.Empty(t, last.NextCursor)
	})

	t.Run("decline", func(t *testing.T) {
		assertSuccessMessage(t, act(t, owner, late, "decline"), http.StatusOK, "Follow request declined")
		assert.Equal(t, models.FollowStateRemoved, edgeState(t, env.db, late.ID, owner.ID))
	})

	t.Run("accept", func(t *testing.T) {
		assertSuccessMessage(t, act(t, owner, early, "accept"), http.StatusOK, "Follow request accepted")
		assert.Equal(t, models.FollowStateActive, edgeState(t, env.db, early.ID, owner.ID))
		counts := decodeAs[dto.FollowCountsResponse](t, followCounts(t, env, owner, owner), http.StatusOK)
		assert.Equal(t, dto.FollowCountsDTO{FollowersCount: 1, PendingRequestsCount: 1}, counts.Counts, "only the deleted account's request is left")
	})

	t.Run("no pending request", func(t *testing.T) {
		for _, action := range []string{"accept", "decline"} {
			res := act(t, owner, stranger, action)
			assertErrorMessage(t, res, http.StatusBadRequest, constants.ErrCodeNoFollowRequest, "No pending request found")
		}
		res := act(t, owner, early, "accept")
		assertErrorMessage(t, res, http.StatusBadRequest, constants.ErrCodeNoFollowRequest, "No pending request found")
	})

	t.Run("cancel an outgoing request", func(t *testing.T) {
		sent := decodeAs[dto.FollowActionResponse](t, env.do(t, stranger, http.MethodPost, "/api/users/"+itoa(owner.ID)+"/follow", nil), http.StatusOK)
		require.Equal(t, "PENDING", sent.State)

		res := env.do(t, stranger, http.MethodPost, "/api/follow-requests/"+itoa(owner.ID)+"/cancel", nil)

		assertSuccessMessage(t, res, http.StatusOK, "Follow request cancelled")
		assert.Equal(t, models.FollowStateRemoved, edgeState(t, env.db, stranger.ID, owner.ID))
	})

	t.Run("cancel without a request", func(t *testing.T) {
		res := env.do(t, stranger, http.MethodPost, "/api/follow-requests/"+itoa(owner.ID)+"/cancel", nil)
		assertErrorMessage(t, res, http.StatusBadRequest, constants.ErrCodeNoFollowRequest, "No pending request found")
	})
}

func TestFollowHandler_RemoveFollower(t *testing.T) {
	env := newEnv(t)
	owner, fan, stranger := env.user(t), env.user(t), env.user(t)
	follow(t, env.db, fan, owner)

	res := env.do(t, owner, http.MethodDelete, "/api/me/followers/"+itoa(fan.ID), nil)
	assertSuccessMessage(t, res, http.StatusOK, "Follower removed")
	assert.Equal(t, models.FollowStateRemoved, edgeState(t, env.db, fan.ID, owner.ID))

	for _, u := range []*models.User{fan, stranger} {
		res := env.do(t, owner, http.MethodDelete, "/api/me/followers/"+itoa(u.ID), nil)
		assertErrorMessage(t, res, http.StatusBadRequest, constants.ErrCodeNotFollowing, "User is not following you")
	}
}

func TestFollowHandler_FollowLists(t *testing.T) {
	env := newEnv(t)
	viewer := env.user(t)
	star := env.user(t)
	hidden := env.user(t, private)
	fan := env.user(t, withBio("fan bio"), withPicture("http://pics.example/fan.jpg"), verified)
	shy := env.user(t, private, withBio("shy bio"))
	followAt(t, env.db, deletedUserID, star.ID, models.FollowStateActive, followBase.Add(-time.Hour))
	followAt(t, env.db, fan.ID, star.ID, models.FollowStateActive, followBase)
	followAt(t, env.db, shy.ID, star.ID, models.FollowStateActive, followBase.Add(time.Hour))
	followAt(t, env.db, star.ID, fan.ID, models.FollowStateActive, followBase)
	followAt(t, env.db, star.ID, deletedUserID, models.FollowStateActive, followBase.Add(time.Hour))
	followAt(t, env.db, fan.ID, hidden.ID, models.FollowStateActive, followBase)
	list := func(t *testing.T, user *models.User, target *models.User, kind, query string) dto.FollowListResponse {
		t.Helper()
		res := env.do(t, user, http.MethodGet, "/api/users/"+itoa(target.ID)+"/"+kind+query, nil)
		return decodeAs[dto.FollowListResponse](t, res, http.StatusOK)
	}

	t.Run("followers newest first", func(t *testing.T) {
		assert.Equal(t, dto.FollowListResponse{
			Success: true,
			Users: []dto.FollowUserDTO{
				{ID: shy.ID, Username: shy.Username, Bio: shy.Bio, IsPrivate: true, FollowedAt: "2026-03-09T11:00:00Z"},
				{ID: fan.ID, Username: fan.Username, ProfilePic: fan.ProfilePic, ProfilePicThumb: fan.ProfilePicThumb,
					Bio: fan.Bio, IsVerified: true, FollowedAt: "2026-03-09T10:00:00Z"},
			},
		}, list(t, viewer, star, "followers", ""), "deleted accounts are skipped")
	})

	t.Run("followers pages", func(t *testing.T) {
		first := list(t, viewer, star, "followers", "?limit=1")
		assert.Equal(t, []string{shy.Username}, usernames(first.Users))
		assert.True(t, first.HasMore)
		assert.Equal(t, encodeCursor(followBase.Add(time.Hour), shy.ID), first.NextCursor)

		second := list(t, viewer, star, "followers", "?limit=1&cursor="+url.QueryEscape(first.NextCursor))
		assert.Equal(t, []string{fan.Username}, usernames(second.Users))

		last := list(t, viewer, star, "followers", "?limit=1&cursor="+url.QueryEscape(second.NextCursor))
		assert.Empty(t, last.Users)
		assert.False(t, last.HasMore)
	})

	t.Run("following", func(t *testing.T) {
		got := list(t, viewer, star, "following", "")
		assert.Equal(t, []string{fan.Username}, usernames(got.Users))

		first := list(t, viewer, star, "following", "?limit=1")
		assert.Empty(t, first.Users, "the newest edge points to a deleted account")
		assert.True(t, first.HasMore)
		assert.Equal(t, encodeCursor(followBase.Add(time.Hour), deletedUserID), first.NextCursor)
		second := list(t, viewer, star, "following", "?limit=1&cursor="+url.QueryEscape(first.NextCursor))
		assert.Equal(t, []string{fan.Username}, usernames(second.Users))
		assert.False(t, second.HasMore)
	})

	t.Run("invalid cursors and limits fall back to the first page", func(t *testing.T) {
		notJSON := base64.URLEncoding.EncodeToString([]byte("not json"))
		for _, query := range []string{"?cursor=%25%25%25", "?cursor=" + notJSON, "?limit=0", "?limit=1000", "?limit=abc"} {
			got := list(t, viewer, star, "followers", query)
			assert.Equal(t, []string{shy.Username, fan.Username}, usernames(got.Users), query)
		}
	})

	t.Run("private account", func(t *testing.T) {
		for _, kind := range []string{"followers", "following"} {
			res := env.do(t, viewer, http.MethodGet, "/api/users/"+itoa(hidden.ID)+"/"+kind, nil)
			assertErrorMessage(t, res, http.StatusForbidden, constants.ErrCodeAccountPrivate, "This account is private")
		}
	})

	t.Run("private account seen by a follower or its owner", func(t *testing.T) {
		assert.Equal(t, []string{fan.Username}, usernames(list(t, fan, hidden, "followers", "").Users))
		assert.Equal(t, []string{fan.Username}, usernames(list(t, hidden, hidden, "followers", "").Users))
	})

	t.Run("unknown user", func(t *testing.T) {
		for _, kind := range []string{"followers", "following"} {
			res := env.do(t, viewer, http.MethodGet, "/api/users/"+itoa(deletedUserID-1)+"/"+kind, nil)
			assertErrorMessage(t, res, http.StatusNotFound, constants.ErrCodeUserNotFound, "User not found")
		}
	})
}

func TestFollowHandler_GetMutuals(t *testing.T) {
	env := newEnv(t)
	viewer := env.user(t)
	target := env.user(t, private)
	a := env.user(t)
	b := env.user(t, withBio("b bio"), withPicture("http://pics.example/b.jpg"))
	c := env.user(t)
	followAt(t, env.db, viewer.ID, a.ID, models.FollowStateActive, followBase)
	followAt(t, env.db, viewer.ID, b.ID, models.FollowStateActive, followBase.Add(time.Hour))
	followAt(t, env.db, viewer.ID, c.ID, models.FollowStateActive, followBase.Add(2*time.Hour))
	followAt(t, env.db, viewer.ID, deletedUserID, models.FollowStateActive, followBase.Add(-time.Hour))
	for _, id := range []uint{a.ID, b.ID, deletedUserID} {
		createEdge(t, env.db, id, target.ID, models.FollowStateActive)
	}
	mutuals := func(t *testing.T, query string) dto.MutualsResponse {
		t.Helper()
		return decodeAs[dto.MutualsResponse](t, env.do(t, viewer, http.MethodGet, "/api/users/"+itoa(target.ID)+"/mutuals"+query, nil), http.StatusOK)
	}

	t.Run("people you follow who follow the target, even when it is private", func(t *testing.T) {
		assert.Equal(t, dto.MutualsResponse{
			Success: true,
			Users: []dto.FollowUserDTO{
				{ID: b.ID, Username: b.Username, ProfilePic: b.ProfilePic, Bio: b.Bio, FollowedAt: "2026-03-09T11:00:00Z"},
				{ID: a.ID, Username: a.Username, FollowedAt: "2026-03-09T10:00:00Z"},
			},
		}, mutuals(t, ""))
	})

	t.Run("pages", func(t *testing.T) {
		first := mutuals(t, "?limit=2")
		assert.Equal(t, []string{b.Username, a.Username}, usernames(first.Users))
		assert.True(t, first.HasMore)
		assert.Equal(t, encodeCursor(followBase, a.ID), first.NextCursor)

		last := mutuals(t, "?limit=2&cursor="+url.QueryEscape(first.NextCursor))
		assert.Empty(t, last.Users, "only the deleted account is left")
		assert.False(t, last.HasMore)
	})
}

func TestFollowHandler_LookupRelationships(t *testing.T) {
	env := newEnv(t)
	viewer, followed, requested, requester, stranger := env.user(t), env.user(t), env.user(t), env.user(t), env.user(t)
	follow(t, env.db, viewer, followed)
	requestFollow(t, env.db, viewer, requested)
	requestFollow(t, env.db, requester, viewer)
	lookup := func(t *testing.T, body any) testutil.Response {
		t.Helper()
		return env.do(t, viewer, http.MethodPost, "/api/relationships/lookup", body)
	}

	t.Run("malformed json", func(t *testing.T) {
		assertErrorMessage(t, lookup(t, `{"target_ids":`), http.StatusBadRequest, constants.ErrCodeInvalidRequest, "Invalid request body")
	})

	t.Run("no ids", func(t *testing.T) {
		res := lookup(t, map[string]any{"target_ids": []uint{}})
		require.Equal(t, http.StatusOK, res.Status)
		assert.Equal(t, map[string]any{"success": true, "relationships": map[string]any{}}, res.JSON(t))
	})

	t.Run("states", func(t *testing.T) {
		ids := []uint{followed.ID, requested.ID, requester.ID, stranger.ID, deletedUserID}
		got := decodeAs[dto.RelationshipLookupResponse](t, lookup(t, map[string]any{"target_ids": ids}), http.StatusOK)
		assert.Equal(t, dto.RelationshipLookupResponse{Success: true, Relationships: map[uint]string{
			followed.ID:   "FOLLOWING",
			requested.ID:  "REQUESTED",
			requester.ID:  "INCOMING_PENDING",
			stranger.ID:   "NONE",
			deletedUserID: "NONE",
		}}, got)
	})

	t.Run("at most 100 ids are looked up", func(t *testing.T) {
		ids := make([]uint, 150)
		for i := range ids {
			ids[i] = uint(1000 + i)
		}
		got := decodeAs[dto.RelationshipLookupResponse](t, lookup(t, map[string]any{"target_ids": ids}), http.StatusOK)
		assert.Len(t, got.Relationships, 100)
		assert.Contains(t, got.Relationships, uint(1099))
		assert.NotContains(t, got.Relationships, uint(1100))
	})
}

func TestFollowHandler_FollowCountsAndReconcile(t *testing.T) {
	env := newEnv(t)
	owner := env.user(t, private)
	fan, requester, other := env.user(t), env.user(t), env.user(t)
	follow(t, env.db, fan, owner)
	requestFollow(t, env.db, requester, owner)
	follow(t, env.db, owner, other)

	t.Run("someone else's counts", func(t *testing.T) {
		res := followCounts(t, env, fan, owner)
		got := decodeAs[dto.FollowCountsResponse](t, res, http.StatusOK)
		assert.Equal(t, dto.FollowCountsResponse{Success: true, Counts: dto.FollowCountsDTO{FollowersCount: 1, FollowingCount: 1}}, got)
		assert.NotContains(t, string(res.Body), "pending_requests_count", "pending requests are private")
	})

	t.Run("own counts include pending requests", func(t *testing.T) {
		got := decodeAs[dto.FollowCountsResponse](t, followCounts(t, env, owner, owner), http.StatusOK)
		assert.Equal(t, dto.FollowCountsDTO{FollowersCount: 1, FollowingCount: 1, PendingRequestsCount: 1}, got.Counts)
	})

	t.Run("reconcile repairs drifted counters", func(t *testing.T) {
		require.NoError(t, env.db.Model(&models.FollowCounter{}).Where("user_id = ?", owner.ID).
			Updates(map[string]any{"followers_count": 42, "following_count": -3}).Error)
		drifted := decodeAs[dto.FollowCountsResponse](t, followCounts(t, env, fan, owner), http.StatusOK)
		require.EqualValues(t, 42, drifted.Counts.FollowersCount)

		assertSuccessMessage(t, env.do(t, owner, http.MethodPost, "/api/me/follow-counts/reconcile", nil), http.StatusOK, "Follow counts reconciled")

		got := decodeAs[dto.FollowCountsResponse](t, followCounts(t, env, fan, owner), http.StatusOK)
		assert.Equal(t, dto.FollowCountsDTO{FollowersCount: 1, FollowingCount: 1}, got.Counts)
	})
}

func TestFollowHandler_DatabaseFailures(t *testing.T) {
	h := brokenStack(t).handlers()
	tests := []struct {
		method, path string
		body         any
		message      string
	}{
		{http.MethodPost, "/api/users/2/follow", nil, "Failed to follow user"},
		{http.MethodDelete, "/api/users/2/follow", nil, "Failed to unfollow user"},
		{http.MethodPost, "/api/follow-requests/2/cancel", nil, "Failed to cancel request"},
		{http.MethodGet, "/api/me/follow-requests/incoming", nil, "Failed to get requests"},
		{http.MethodPost, "/api/me/follow-requests/2/accept", nil, "Failed to accept request"},
		{http.MethodPost, "/api/me/follow-requests/2/decline", nil, "Failed to decline request"},
		{http.MethodDelete, "/api/me/followers/2", nil, "Failed to remove follower"},
		{http.MethodGet, "/api/users/2/followers", nil, "Failed to get followers"},
		{http.MethodGet, "/api/users/2/following", nil, "Failed to get following"},
		{http.MethodGet, "/api/users/2/mutuals", nil, "Failed to get mutuals"},
		{http.MethodGet, "/api/users/2/follow-counts", nil, "Failed to get counts"},
		{http.MethodPost, "/api/me/follow-counts/reconcile", nil, "Failed to reconcile counts"},
		{http.MethodPost, "/api/relationships/lookup", map[string]any{"target_ids": []uint{2}}, "Failed to lookup relationships"},
	}
	for _, tc := range tests {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			res := call(t, h, ghostUser, tc.method, tc.path, tc.body)
			assertErrorMessage(t, res, http.StatusInternalServerError, constants.ErrCodeServerError, tc.message)
		})
	}
}

func TestFollowHandler_Notifications(t *testing.T) {
	env := newEnv(t, withAsync())
	fan := env.user(t, withPicture("http://pics.example/fan.jpg"))
	public, hidden := env.user(t), env.user(t, private, withPicture("http://pics.example/hidden.jpg"))

	t.Run("new follower", func(t *testing.T) {
		require.Equal(t, http.StatusOK, env.do(t, fan, http.MethodPost, "/api/users/"+itoa(public.ID)+"/follow", nil).Status)
		n := waitNotification(t, env.db, public.ID, models.NotifTypeNewFollower)
		assert.Equal(t, fan.Username+" started following you", n.Body)
		assert.Equal(t, *fan.ProfilePic, n.Metadata["actor_avatar"])
	})

	t.Run("follow request", func(t *testing.T) {
		require.Equal(t, http.StatusOK, env.do(t, fan, http.MethodPost, "/api/users/"+itoa(hidden.ID)+"/follow", nil).Status)
		n := waitNotification(t, env.db, hidden.ID, models.NotifTypeFollowRequest)
		assert.Equal(t, fan.Username+" wants to follow you", n.Body)
	})

	t.Run("request accepted", func(t *testing.T) {
		require.Equal(t, http.StatusOK, env.do(t, hidden, http.MethodPost, "/api/me/follow-requests/"+itoa(fan.ID)+"/accept", nil).Status)
		n := waitNotification(t, env.db, fan.ID, models.NotifTypeFollowAccepted)
		assert.Equal(t, hidden.Username+" accepted your follow request", n.Body)
		assert.Equal(t, *hidden.ProfilePic, n.Metadata["actor_avatar"])
	})
}

func TestFollowHandler_NotificationHelpersSkipMissingData(t *testing.T) {
	env := newEnv(t)
	user, target := env.user(t), env.user(t)
	withNotifications := NewFollowHandler(env.followSvc, env.userRepo, env.notifSvc)
	without := NewFollowHandler(env.followSvc, env.userRepo, nil)

	without.sendFollowNotification(nil, user.ID, target.ID, models.FollowStateActive)
	without.sendAcceptedNotification(nil, target.ID, user.ID)
	withNotifications.sendFollowNotification(nil, deletedUserID, target.ID, models.FollowStateActive)
	withNotifications.sendAcceptedNotification(nil, deletedUserID, user.ID)
	withNotifications.sendFollowNotification(nil, user.ID, target.ID, models.FollowStateRemoved)

	assert.Zero(t, count(t, env.db, &models.Notification{}, ""))
}

func TestFollowCursor(t *testing.T) {
	at := time.Date(2026, 3, 9, 10, 30, 0, 123456000, time.UTC)

	got := decodeCursor(encodeCursor(at, 42))

	require.NotNil(t, got)
	assert.True(t, at.Equal(got.CreatedAt))
	assert.Equal(t, uint(42), got.UserID)
	for _, bad := range []string{"", "%%%", base64.URLEncoding.EncodeToString([]byte("not json"))} {
		assert.Nil(t, decodeCursor(bad), bad)
	}
}
