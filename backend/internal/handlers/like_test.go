package handlers

import (
	"net/http"
	"strconv"
	"testing"
	"time"

	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/dto"
	"github.com/aman1117/backend/internal/testutil"
	"github.com/aman1117/backend/pkg/models"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

var likeEndpoints = []string{"/api/like-day", "/api/unlike-day", "/api/get-likes"}

func likeBody(username, date string) map[string]string {
	return map[string]string{"username": username, "date": date}
}

func likesCacheKey(userID uint, date string) string {
	return "likes:" + strconv.FormatUint(uint64(userID), 10) + ":" + date
}

// insertLike stores a like with a fixed creation time.
func insertLike(t *testing.T, env *testEnv, liker, owner *models.User, day time.Time, createdAt time.Time) {
	t.Helper()
	require.NoError(t, env.db.Create(&models.Like{LikerID: liker.ID, LikedUserID: owner.ID, LikedDate: day, CreatedAt: createdAt}).Error)
}

func likeNotifications(t *testing.T, env *testEnv, owner *models.User) int64 {
	t.Helper()
	return count(t, env.db, &models.Notification{}, "user_id = ? AND type = ?", owner.ID, models.NotifTypeLikeReceived)
}

func TestLikeHandler_Validation(t *testing.T) {
	env := newEnv(t)
	user := env.user(t)

	tests := []struct {
		name    string
		body    any
		code    string
		message string
	}{
		{"malformed json", `{"username":`, constants.ErrCodeInvalidRequest, "Invalid request body"},
		{"missing username", likeBody("", "2026-03-09"), constants.ErrCodeMissingFields, "Username and date are required"},
		{"missing date", likeBody(user.Username, ""), constants.ErrCodeMissingFields, "Username and date are required"},
		{"bad date", likeBody(user.Username, "2026-13-01"), constants.ErrCodeInvalidDate, "Invalid date format, use YYYY-MM-DD"},
		{"unknown user", likeBody("nobody", "2026-03-09"), constants.ErrCodeUserNotFound, "User not found"},
	}
	for _, path := range likeEndpoints {
		for _, tc := range tests {
			t.Run(path+" "+tc.name, func(t *testing.T) {
				assertErrorMessage(t, env.do(t, user, http.MethodPost, path, tc.body), http.StatusBadRequest, tc.code, tc.message)
			})
		}
	}
}

func TestLikeHandler_UserLookupFailure(t *testing.T) {
	h := brokenStack(t).handlers()
	for _, path := range likeEndpoints {
		t.Run(path, func(t *testing.T) {
			res := call(t, h, ghostUser, http.MethodPost, path, likeBody("someone", "2026-03-09"))
			assertErrorMessage(t, res, http.StatusBadRequest, constants.ErrCodeDatabaseError, "Failed to find user")
		})
	}
}

func TestLikeHandler_LikeAndUnlikeDay(t *testing.T) {
	env := newEnv(t)
	owner := env.user(t)
	liker := env.user(t, withPicture("http://pics.example/liker.jpg"))
	other := env.user(t)
	const day = "2026-03-09"
	action := func(t *testing.T, user *models.User, path string) dto.LikeActionResponse {
		t.Helper()
		return decodeAs[dto.LikeActionResponse](t, env.do(t, user, http.MethodPost, path, likeBody(owner.Username, day)), http.StatusOK)
	}

	t.Run("like notifies the owner", func(t *testing.T) {
		assert.Equal(t, dto.LikeActionResponse{Success: true, Liked: true, NewCount: 1}, action(t, liker, "/api/like-day"))

		var n models.Notification
		require.NoError(t, env.db.Where("user_id = ? AND type = ?", owner.ID, models.NotifTypeLikeReceived).First(&n).Error)
		assert.Equal(t, "New Like!", n.Title)
		assert.Equal(t, liker.Username+" liked your 9 Mar, 2026 activities", n.Body)
		assert.Equal(t, *liker.ProfilePic, n.Metadata["liker_avatar"])
		assert.Equal(t, day, n.Metadata["liked_date"])
	})

	t.Run("liking again is idempotent", func(t *testing.T) {
		assert.Equal(t, dto.LikeActionResponse{Success: true, Liked: true, NewCount: 1}, action(t, liker, "/api/like-day"))
		assert.EqualValues(t, 1, count(t, env.db, &models.Like{}, ""))
		assert.EqualValues(t, 1, likeNotifications(t, env, owner))
	})

	t.Run("a second liker", func(t *testing.T) {
		assert.Equal(t, dto.LikeActionResponse{Success: true, Liked: true, NewCount: 2}, action(t, other, "/api/like-day"))
		assert.EqualValues(t, 2, likeNotifications(t, env, owner))
	})

	t.Run("unlike", func(t *testing.T) {
		assert.Equal(t, dto.LikeActionResponse{Success: true, Liked: false, NewCount: 1}, action(t, liker, "/api/unlike-day"))
		assert.Zero(t, count(t, env.db, &models.Like{}, "liker_id = ?", liker.ID))
	})

	t.Run("unlike without a like", func(t *testing.T) {
		assert.Equal(t, dto.LikeActionResponse{Success: true, Liked: false, NewCount: 1}, action(t, liker, "/api/unlike-day"))
	})

	t.Run("re-liking does not notify twice", func(t *testing.T) {
		assert.Equal(t, dto.LikeActionResponse{Success: true, Liked: true, NewCount: 2}, action(t, liker, "/api/like-day"))
		assert.EqualValues(t, 2, likeNotifications(t, env, owner))
	})

	t.Run("liking your own day sends no notification", func(t *testing.T) {
		assert.Equal(t, dto.LikeActionResponse{Success: true, Liked: true, NewCount: 3}, action(t, owner, "/api/like-day"))
		assert.EqualValues(t, 2, likeNotifications(t, env, owner))
	})
}

func TestLikeHandler_LikeDay_NotificationProblemsDoNotFailTheLike(t *testing.T) {
	env := newEnv(t)
	owner, liker := env.user(t), env.user(t)

	for name, h := range map[string]*LikeHandler{
		"without a notification service": NewLikeHandler(env.likeRepo, env.authSvc, env.profileSvc, nil),
		"notification database failure":  NewLikeHandler(env.likeRepo, env.authSvc, env.profileSvc, brokenStack(t).notifSvc),
	} {
		t.Run(name, func(t *testing.T) {
			require.NoError(t, env.db.Where("1 = 1").Delete(&models.Like{}).Error)
			res := call(t, &handlerSet{like: h}, liker, http.MethodPost, "/api/like-day", likeBody(owner.Username, "2026-03-09"))
			assert.Equal(t, dto.LikeActionResponse{Success: true, Liked: true, NewCount: 1}, decodeAs[dto.LikeActionResponse](t, res, http.StatusOK))
		})
	}
	assert.Zero(t, likeNotifications(t, env, owner))
}

func TestLikeHandler_PrivateAccounts(t *testing.T) {
	env := newEnv(t)
	hidden := env.user(t, private)
	stranger, fan := env.user(t), env.user(t)
	follow(t, env.db, fan, hidden)
	body := likeBody(hidden.Username, "2026-03-09")

	t.Run("strangers cannot like", func(t *testing.T) {
		res := env.do(t, stranger, http.MethodPost, "/api/like-day", body)
		assertErrorMessage(t, res, http.StatusForbidden, constants.ErrCodeAccountPrivate, "Cannot like a private account's day")
	})

	t.Run("strangers cannot see likes", func(t *testing.T) {
		res := env.do(t, stranger, http.MethodPost, "/api/get-likes", body)
		assertErrorMessage(t, res, http.StatusForbidden, constants.ErrCodeAccountPrivate, "Cannot view likes for a private account")
	})

	t.Run("followers can like and see likes", func(t *testing.T) {
		liked := decodeAs[dto.LikeActionResponse](t, env.do(t, fan, http.MethodPost, "/api/like-day", body), http.StatusOK)
		assert.EqualValues(t, 1, liked.NewCount)

		got := decodeAs[dto.LikesResponse](t, env.do(t, fan, http.MethodPost, "/api/get-likes", body), http.StatusOK)
		assert.EqualValues(t, 1, got.Count)
		assert.True(t, got.UserHasLiked)
	})
}

func TestLikeHandler_GetLikes(t *testing.T) {
	env := newEnv(t)
	owner := env.user(t)
	early := env.user(t, withPicture("http://pics.example/early.jpg"), verified)
	late := env.user(t)
	viewer := env.user(t)
	day := testutil.Day(2026, 3, 9)
	likedAt := time.Date(2026, 3, 9, 10, 0, 0, 0, time.UTC)
	insertLike(t, env, early, owner, day, likedAt)
	insertLike(t, env, late, owner, day, likedAt.Add(time.Hour))
	insertLike(t, env, viewer, owner, day.AddDate(0, 0, 1), likedAt)

	t.Run("lists likers newest first", func(t *testing.T) {
		got := decodeAs[dto.LikesResponse](t, env.do(t, viewer, http.MethodPost, "/api/get-likes", likeBody(owner.Username, "2026-03-09")), http.StatusOK)

		assert.Equal(t, dto.LikesResponse{
			Success: true,
			Count:   2,
			Data: []dto.LikerDTO{
				{ID: late.ID, Username: late.Username, LikedAt: "2026-03-09T11:00:00Z"},
				{ID: early.ID, Username: early.Username, ProfilePic: early.ProfilePic, ProfilePicThumb: early.ProfilePicThumb,
					IsVerified: true, LikedAt: "2026-03-09T10:00:00Z"},
			},
		}, got)
	})

	t.Run("reports whether the caller liked the day", func(t *testing.T) {
		got := decodeAs[dto.LikesResponse](t, env.do(t, early, http.MethodPost, "/api/get-likes", likeBody(owner.Username, "2026-03-09")), http.StatusOK)
		assert.True(t, got.UserHasLiked)
	})

	t.Run("day without likes", func(t *testing.T) {
		got := decodeAs[dto.LikesResponse](t, env.do(t, viewer, http.MethodPost, "/api/get-likes", likeBody(owner.Username, "2026-03-11")), http.StatusOK)
		assert.Zero(t, got.Count)
		assert.NotNil(t, got.Data, "an empty list, not null")
		assert.Empty(t, got.Data)
	})
}

func TestLikeHandler_GetLikes_Cache(t *testing.T) {
	env := newEnv(t)
	mr := testutil.StartRedis(t)
	owner, fan, viewer := env.user(t), env.user(t), env.user(t)
	const day = "2026-03-09"
	key := likesCacheKey(owner.ID, day)
	body := likeBody(owner.Username, day)
	getLikes := func(t *testing.T, caller *models.User) dto.LikesResponse {
		t.Helper()
		return decodeAs[dto.LikesResponse](t, env.do(t, caller, http.MethodPost, "/api/get-likes", body), http.StatusOK)
	}
	insertLike(t, env, fan, owner, testutil.Day(2026, 3, 9), time.Date(2026, 3, 9, 10, 0, 0, 0, time.UTC))

	first := getLikes(t, viewer)
	require.EqualValues(t, 1, first.Count)
	cached, err := mr.Get(key)
	require.NoError(t, err, "the likers are cached")
	assert.Contains(t, cached, fan.Username)
	assert.Equal(t, constants.LikesCacheTTL, mr.TTL(key))

	t.Run("served from the cache", func(t *testing.T) {
		require.NoError(t, env.db.Where("1 = 1").Delete(&models.Like{}).Error)
		got := getLikes(t, fan)
		assert.Equal(t, first.Data, got.Data)
		assert.False(t, got.UserHasLiked, "computed live, never cached")
	})

	t.Run("corrupt entry falls back to the database", func(t *testing.T) {
		require.NoError(t, mr.Set(key, "{not json"))
		assert.Zero(t, getLikes(t, viewer).Count)
		cached, err := mr.Get(key)
		require.NoError(t, err)
		assert.Equal(t, "[]", cached, "the cache is repaired")
	})

	t.Run("liking invalidates the cache", func(t *testing.T) {
		require.Equal(t, http.StatusOK, env.do(t, fan, http.MethodPost, "/api/like-day", body).Status)
		assert.False(t, mr.Exists(key))
		assert.EqualValues(t, 1, getLikes(t, viewer).Count)
	})

	t.Run("unliking invalidates the cache", func(t *testing.T) {
		require.True(t, mr.Exists(key))
		require.Equal(t, http.StatusOK, env.do(t, fan, http.MethodPost, "/api/unlike-day", body).Status)
		assert.False(t, mr.Exists(key))
	})

	t.Run("redis read failure falls back to the database", func(t *testing.T) {
		require.NoError(t, mr.Set(key, "[]"))
		insertLike(t, env, viewer, owner, testutil.Day(2026, 3, 9), time.Date(2026, 3, 9, 12, 0, 0, 0, time.UTC))
		failRedisCommand(mr, "GET", "likes:")
		defer mr.Server().SetPreHook(nil)

		got := getLikes(t, viewer)
		assert.EqualValues(t, 1, got.Count)
		assert.True(t, got.UserHasLiked)
	})

	t.Run("redis write failures are only logged", func(t *testing.T) {
		mr.FlushAll()
		failRedisCommand(mr, "SET", "likes:")
		assert.EqualValues(t, 1, getLikes(t, viewer).Count)
		assert.False(t, mr.Exists(key))

		failRedisCommand(mr, "DEL", "likes:")
		defer mr.Server().SetPreHook(nil)
		assert.Equal(t, http.StatusOK, env.do(t, fan, http.MethodPost, "/api/like-day", body).Status)
		assert.Equal(t, http.StatusOK, env.do(t, fan, http.MethodPost, "/api/unlike-day", body).Status)
	})
}

func TestLikeHandler_DatabaseFailures(t *testing.T) {
	env := newEnv(t)
	owner, fan := env.user(t), env.user(t)
	body := likeBody(owner.Username, "2026-03-09")

	t.Run("checking the like status", func(t *testing.T) {
		h := &handlerSet{like: NewLikeHandler(brokenStack(t).likeRepo, env.authSvc, env.profileSvc, env.notifSvc)}
		res := call(t, h, fan, http.MethodPost, "/api/like-day", body)
		assertErrorMessage(t, res, http.StatusInternalServerError, constants.ErrCodeDatabaseError, "Failed to process like")
	})

	t.Run("storing the like", func(t *testing.T) {
		faulty := newStack(faultyDB(t, failOn("create", "likes")), env.cfg, false)
		h := &handlerSet{like: NewLikeHandler(faulty.likeRepo, env.authSvc, env.profileSvc, env.notifSvc)}
		res := call(t, h, fan, http.MethodPost, "/api/like-day", body)
		assertErrorMessage(t, res, http.StatusInternalServerError, constants.ErrCodeCreateFailed, "Failed to like day")
		assert.Zero(t, likeNotifications(t, env, owner))
	})

	t.Run("listing likes", func(t *testing.T) {
		h := &handlerSet{like: NewLikeHandler(brokenStack(t).likeRepo, env.authSvc, env.profileSvc, env.notifSvc)}
		res := call(t, h, fan, http.MethodPost, "/api/get-likes", body)
		assertErrorMessage(t, res, http.StatusInternalServerError, constants.ErrCodeFetchFailed, "Failed to get likes")
	})

	t.Run("like status lookup failure on a cache hit", func(t *testing.T) {
		mr := testutil.StartRedis(t)
		require.NoError(t, mr.Set(likesCacheKey(owner.ID, "2026-03-09"), "[]"))
		h := &handlerSet{like: NewLikeHandler(brokenStack(t).likeRepo, env.authSvc, env.profileSvc, env.notifSvc)}

		got := decodeAs[dto.LikesResponse](t, call(t, h, fan, http.MethodPost, "/api/get-likes", body), http.StatusOK)

		assert.Equal(t, dto.LikesResponse{Success: true, Data: []dto.LikerDTO{}}, got)
	})
}

func TestLikeHandler_UnlikeDay_DatabaseFailureReturnsServerError(t *testing.T) {
	env := newEnv(t)
	owner, fan := env.user(t), env.user(t)
	h := &handlerSet{like: NewLikeHandler(brokenStack(t).likeRepo, env.authSvc, env.profileSvc, env.notifSvc)}

	res := call(t, h, fan, http.MethodPost, "/api/unlike-day", likeBody(owner.Username, "2026-03-09"))

	assertErrorMessage(t, res, http.StatusInternalServerError, constants.ErrCodeDeleteFailed, "Failed to unlike day")
}
