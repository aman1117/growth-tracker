package handlers

import (
	"net/http"
	"testing"
	"time"

	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/dto"
	"github.com/aman1117/backend/internal/testutil"
	"github.com/aman1117/backend/pkg/models"
	"github.com/aman1117/backend/pkg/redis"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type suggestionsEnv struct {
	*testEnv
	me      *models.User
	recent  []*models.User // most recent first
	popular []*models.User // most followers first
}

// newSuggestionsEnv creates a user with two recent searches and seven popular public users with
// distinct follower counts. One recent search is also the most followed user overall.
func newSuggestionsEnv(t *testing.T) *suggestionsEnv {
	t.Helper()
	env := newEnv(t)
	s := &suggestionsEnv{testEnv: env, me: env.user(t)}
	older := env.user(t)
	newer := env.user(t, withPicture("http://pics.example/newer.jpg"), verified)
	s.recent = []*models.User{newer, older}
	setFollowers(t, env, older, 50)
	for _, followers := range []int{30, 20, 10, 5, 3, 2, 1} {
		u := env.user(t)
		setFollowers(t, env, u, followers)
		s.popular = append(s.popular, u)
	}
	searchedAt := time.Now().Add(-time.Hour)
	addRecentSearch(t, env, s.me, older, searchedAt)
	addRecentSearch(t, env, s.me, newer, searchedAt.Add(time.Minute))
	return s
}

func setFollowers(t *testing.T, env *testEnv, u *models.User, n int) {
	t.Helper()
	require.NoError(t, env.db.Model(&models.FollowCounter{}).Where("user_id = ?", u.ID).Update("followers_count", n).Error)
}

func addRecentSearch(t *testing.T, env *testEnv, me, searched *models.User, at time.Time) {
	t.Helper()
	require.NoError(t, env.db.Create(&models.RecentSearch{UserID: me.ID, SearchedUserID: searched.ID, SearchedAt: at}).Error)
}

func suggestionIDs(users []dto.SearchSuggestionUser) []uint {
	out := make([]uint, 0, len(users))
	for _, u := range users {
		out = append(out, u.ID)
	}
	return out
}

func userIDsOf(users ...*models.User) []uint {
	out := make([]uint, 0, len(users))
	for _, u := range users {
		out = append(out, u.ID)
	}
	return out
}

func (s *suggestionsEnv) suggestions(t *testing.T, h *handlerSet) dto.SearchSuggestionsResponse {
	t.Helper()
	if h == nil {
		h = s.h
	}
	return decodeAs[dto.SearchSuggestionsResponse](t, call(t, h, s.me, http.MethodGet, "/api/search/suggestions", nil), http.StatusOK)
}

func TestSearchSuggestionsHandler_RequiresUserContext(t *testing.T) {
	env := newEnv(t)
	for _, e := range []struct{ method, path string }{
		{http.MethodGet, "/api/search/suggestions"},
		{http.MethodDelete, "/api/search/recent/2"},
		{http.MethodDelete, "/api/search/recent"},
	} {
		t.Run(e.method+" "+e.path, func(t *testing.T) {
			res := env.do(t, nil, e.method, e.path, nil)
			assertErrorMessage(t, res, http.StatusBadRequest, constants.ErrCodeInvalidRequest, "Invalid user context")
		})
	}
}

func TestSearchSuggestionsHandler_GetSearchSuggestions(t *testing.T) {
	s := newSuggestionsEnv(t)

	got := s.suggestions(t, nil)

	newer := s.recent[0]
	assert.Equal(t, dto.SearchSuggestionUser{
		ID: newer.ID, Username: newer.Username, ProfilePic: newer.ProfilePic, ProfilePicThumb: newer.ProfilePicThumb, IsVerified: true,
	}, got.Recent[0])
	assert.Equal(t, userIDsOf(s.recent...), suggestionIDs(got.Recent))
	assert.Equal(t, userIDsOf(s.popular[:4]...), suggestionIDs(got.Trending),
		"six suggestions in total, most followed first, without users already in the recent list")
	assert.EqualValues(t, 30, got.Trending[0].FollowersCount)
}

func TestSearchSuggestionsHandler_FiveRecentSearchesLeaveOneTrendingSlot(t *testing.T) {
	s := newSuggestionsEnv(t)
	base := time.Now().Add(-30 * time.Minute)
	for i, u := range s.popular[3:6] {
		addRecentSearch(t, s.testEnv, s.me, u, base.Add(time.Duration(i)*time.Minute))
	}

	got := s.suggestions(t, nil)

	assert.Len(t, got.Recent, 5)
	assert.Equal(t, userIDsOf(s.popular[0]), suggestionIDs(got.Trending))
}

func TestSearchSuggestionsHandler_NothingToSuggest(t *testing.T) {
	env := newEnv(t)
	me := env.user(t)

	res := env.do(t, me, http.MethodGet, "/api/search/suggestions", nil)

	require.Equal(t, http.StatusOK, res.Status)
	assert.Equal(t, map[string]any{"recent": []any{}, "trending": []any{}}, res.JSON(t))
}

func TestSearchSuggestionsHandler_TrendingCache(t *testing.T) {
	s := newSuggestionsEnv(t)
	mr := testutil.StartRedis(t)
	key := trendingCacheKey(s.me.ID)
	require.Equal(t, "trending:user:"+itoa(s.me.ID), key)

	first := s.suggestions(t, nil)
	require.Len(t, first.Trending, 4)
	assert.True(t, mr.Exists(key), "trending users are cached")
	assert.Equal(t, redis.TrendingCacheTTL, mr.TTL(key))

	t.Run("cache hit drops users that are now recent searches", func(t *testing.T) {
		cached := []dto.SearchSuggestionUser{{ID: s.recent[1].ID, Username: "stale"}, {ID: 4242, Username: "cached_only"}}
		require.NoError(t, mr.Set(key, string(mustJSON(t, cached))))

		got := s.suggestions(t, nil)

		assert.Equal(t, []dto.SearchSuggestionUser{{ID: 4242, Username: "cached_only"}}, got.Trending)
	})

	t.Run("corrupt cache entry is replaced", func(t *testing.T) {
		require.NoError(t, mr.Set(key, "{not json"))
		got := s.suggestions(t, nil)
		assert.Equal(t, userIDsOf(s.popular[:4]...), suggestionIDs(got.Trending))
		stored, err := mr.Get(key)
		require.NoError(t, err)
		assert.Contains(t, stored, s.popular[0].Username)
	})

	t.Run("redis failure falls back to the database", func(t *testing.T) {
		mr.SetError("ERR boom")
		defer mr.SetError("")
		got := s.suggestions(t, nil)
		assert.Equal(t, userIDsOf(s.popular[:4]...), suggestionIDs(got.Trending))
	})
}

func TestSearchSuggestionsHandler_QueryFailuresDegradeGracefully(t *testing.T) {
	s := newSuggestionsEnv(t)

	t.Run("recent searches unavailable", func(t *testing.T) {
		faulty := newStack(faultyDB(t, failSQL("FROM recent_searches rs")), s.cfg, false)
		got := s.suggestions(t, &handlerSet{searchSuggestions: NewSearchSuggestionsHandler(faulty.searchSvc)})
		assert.Empty(t, got.Recent)
		assert.Equal(t, userIDsOf(s.recent[0], s.recent[1], s.popular[0], s.popular[1], s.popular[2], s.popular[3]), suggestionIDs(got.Trending),
			"verified users first, then by followers; recent searches are not filtered out when they cannot be loaded")
	})

	t.Run("everything unavailable", func(t *testing.T) {
		got := s.suggestions(t, brokenStack(t).handlers())
		assert.Equal(t, dto.SearchSuggestionsResponse{Recent: []dto.SearchSuggestionUser{}, Trending: []dto.SearchSuggestionUser{}}, got)
	})
}

func TestSearchSuggestionsHandler_DeleteRecentSearch(t *testing.T) {
	s := newSuggestionsEnv(t)
	other := s.user(t)
	addRecentSearch(t, s.testEnv, other, s.recent[0], time.Now())

	for _, id := range []string{"abc", "0", "-5"} {
		t.Run("invalid id "+id, func(t *testing.T) {
			res := call(t, s.h, s.me, http.MethodDelete, "/api/search/recent/"+id, nil)
			assertErrorMessage(t, res, http.StatusBadRequest, constants.ErrCodeInvalidRequest, "Invalid user ID")
		})
	}

	t.Run("deletes one entry", func(t *testing.T) {
		res := call(t, s.h, s.me, http.MethodDelete, "/api/search/recent/"+itoa(s.recent[0].ID), nil)
		assertSuccessMessage(t, res, http.StatusOK, "Recent search deleted")
		assert.Equal(t, userIDsOf(s.recent[1]), suggestionIDs(s.suggestions(t, nil).Recent))
		assert.EqualValues(t, 1, count(t, s.db, &models.RecentSearch{}, "user_id = ?", other.ID), "other users keep their history")
	})

	t.Run("unknown entry", func(t *testing.T) {
		res := call(t, s.h, s.me, http.MethodDelete, "/api/search/recent/"+itoa(deletedUserID), nil)
		assertSuccessMessage(t, res, http.StatusOK, "Recent search deleted")
	})

	t.Run("database failure", func(t *testing.T) {
		res := call(t, brokenStack(t).handlers(), s.me, http.MethodDelete, "/api/search/recent/"+itoa(s.recent[1].ID), nil)
		assertErrorMessage(t, res, http.StatusInternalServerError, constants.ErrCodeDeleteFailed, "Failed to delete recent search")
	})
}

func TestSearchSuggestionsHandler_ClearRecentSearches(t *testing.T) {
	s := newSuggestionsEnv(t)
	other := s.user(t)
	addRecentSearch(t, s.testEnv, other, s.recent[0], time.Now())

	res := call(t, s.h, s.me, http.MethodDelete, "/api/search/recent", nil)

	assertSuccessMessage(t, res, http.StatusOK, "Recent searches cleared")
	assert.Zero(t, count(t, s.db, &models.RecentSearch{}, "user_id = ?", s.me.ID))
	assert.EqualValues(t, 1, count(t, s.db, &models.RecentSearch{}, "user_id = ?", other.ID))

	res = call(t, brokenStack(t).handlers(), s.me, http.MethodDelete, "/api/search/recent", nil)
	assertErrorMessage(t, res, http.StatusInternalServerError, constants.ErrCodeDeleteFailed, "Failed to clear recent searches")
}
