package repository

import (
	"testing"
	"time"

	"github.com/aman1117/backend/internal/testutil"
	"github.com/aman1117/backend/pkg/models"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func recentIDs(rows []RecentSearchResult) []uint {
	ids := make([]uint, len(rows))
	for i, r := range rows {
		ids[i] = r.ID
	}
	return ids
}

func trendingIDs(rows []TrendingUserResult) []uint {
	ids := make([]uint, len(rows))
	for i, r := range rows {
		ids[i] = r.ID
	}
	return ids
}

func setSearchedAt(t *testing.T, db *gorm.DB, userID, searchedID uint, sqlExpr string) time.Time {
	t.Helper()
	require.NoError(t, db.Exec("UPDATE recent_searches SET searched_at = "+sqlExpr+" WHERE user_id = ? AND searched_user_id = ?",
		userID, searchedID).Error)
	return searchedAt(t, db, userID, searchedID)
}

func searchedAt(t *testing.T, db *gorm.DB, userID, searchedID uint) time.Time {
	t.Helper()
	var rs models.RecentSearch
	require.NoError(t, db.Where("user_id = ? AND searched_user_id = ?", userID, searchedID).First(&rs).Error)
	return rs.SearchedAt
}

func TestRecentSearchRepository_SaveAndGetRecentSearches(t *testing.T) {
	db := testutil.DB(t)
	repo := NewRecentSearchRepository(db)
	me := testutil.CreateUser(t, db)
	a := namedUser(t, db, "anna", verified, withAvatar)
	b := testutil.CreateUser(t, db)
	c := testutil.CreateUser(t, db, private)
	setCounters(t, db, a.ID, counts{Followers: 12})

	for _, u := range []*models.User{a, b, c} {
		require.NoError(t, repo.SaveRecentSearch(me.ID, u.ID))
	}
	setSearchedAt(t, db, me.ID, a.ID, "NOW() - INTERVAL '1 minute'")
	setSearchedAt(t, db, me.ID, b.ID, "NOW() - INTERVAL '3 minutes'")
	setSearchedAt(t, db, me.ID, c.ID, "NOW() - INTERVAL '2 minutes'")

	got, err := repo.GetRecentSearches(me.ID, 10)

	require.NoError(t, err)
	require.Equal(t, userIDs(a, c, b), recentIDs(got), "most recent first, private accounts included")
	assert.Equal(t, RecentSearchResult{
		ID: a.ID, Username: "anna", ProfilePic: a.ProfilePic, ProfilePicThumb: a.ProfilePicThumb,
		IsVerified: true, FollowersCount: 12,
	}, got[0])
	assert.Zero(t, got[1].FollowersCount, "no counters row counts as 0")

	got, err = repo.GetRecentSearches(me.ID, 2)
	require.NoError(t, err)
	assert.Equal(t, userIDs(a, c), recentIDs(got))

	got, err = repo.GetRecentSearches(a.ID, 10)
	require.NoError(t, err)
	assert.Empty(t, got, "searches are per user")
}

func TestRecentSearchRepository_SaveIgnoresInvalidIDsAndSelf(t *testing.T) {
	db := testutil.DB(t)
	repo := NewRecentSearchRepository(db)
	me := testutil.CreateUser(t, db)

	assert.NoError(t, repo.SaveRecentSearch(0, me.ID))
	assert.NoError(t, repo.SaveRecentSearch(me.ID, 0))
	assert.NoError(t, repo.SaveRecentSearch(me.ID, me.ID))

	var count int64
	require.NoError(t, db.Model(&models.RecentSearch{}).Count(&count).Error)
	assert.Zero(t, count)
}

func TestRecentSearchRepository_SaveThrottlesRepeatedSearches(t *testing.T) {
	db := testutil.DB(t)
	repo := NewRecentSearchRepository(db)
	me := testutil.CreateUser(t, db)
	target := testutil.CreateUser(t, db)
	require.NoError(t, repo.SaveRecentSearch(me.ID, target.ID))

	t.Run("within 60 seconds the timestamp is kept", func(t *testing.T) {
		before := setSearchedAt(t, db, me.ID, target.ID, "NOW() - INTERVAL '10 seconds'")
		require.NoError(t, repo.SaveRecentSearch(me.ID, target.ID))
		assert.True(t, searchedAt(t, db, me.ID, target.ID).Equal(before))
	})

	t.Run("after 60 seconds the timestamp is refreshed", func(t *testing.T) {
		before := setSearchedAt(t, db, me.ID, target.ID, "NOW() - INTERVAL '2 minutes'")
		require.NoError(t, repo.SaveRecentSearch(me.ID, target.ID))
		assert.True(t, searchedAt(t, db, me.ID, target.ID).After(before.Add(time.Minute)))
	})

	var count int64
	require.NoError(t, db.Model(&models.RecentSearch{}).Count(&count).Error)
	assert.Equal(t, int64(1), count, "repeated searches upsert a single row")
}

func TestRecentSearchRepository_GetRecentSearchesLimits(t *testing.T) {
	db := testutil.DB(t)
	repo := NewRecentSearchRepository(db)
	me := testutil.CreateUser(t, db)
	for i := 0; i < 12; i++ {
		require.NoError(t, repo.SaveRecentSearch(me.ID, testutil.CreateUser(t, db).ID))
	}

	for limit, want := range map[int]int{-1: 5, 0: 5, 3: 3, 10: 10, 11: 10, 50: 10} {
		got, err := repo.GetRecentSearches(me.ID, limit)
		require.NoError(t, err)
		assert.Len(t, got, want, "limit %d", limit)
	}

	got, err := repo.GetRecentSearches(0, 5)
	assert.NoError(t, err)
	assert.Nil(t, got, "user 0 has no searches")
}

func TestRecentSearchRepository_DeleteAndClear(t *testing.T) {
	db := testutil.DB(t)
	repo := NewRecentSearchRepository(db)
	me := testutil.CreateUser(t, db)
	other := testutil.CreateUser(t, db)
	a := testutil.CreateUser(t, db)
	b := testutil.CreateUser(t, db)
	require.NoError(t, repo.SaveRecentSearch(me.ID, a.ID))
	require.NoError(t, repo.SaveRecentSearch(me.ID, b.ID))
	require.NoError(t, repo.SaveRecentSearch(other.ID, a.ID))
	list := func(userID uint) []uint {
		got, err := repo.GetRecentSearches(userID, 10)
		require.NoError(t, err)
		return recentIDs(got)
	}

	require.NoError(t, repo.DeleteRecentSearch(me.ID, a.ID))
	assert.Equal(t, []uint{b.ID}, list(me.ID))
	assert.Equal(t, []uint{a.ID}, list(other.ID), "other users keep their entry")

	assert.NoError(t, repo.DeleteRecentSearch(0, b.ID), "invalid IDs are ignored")
	assert.NoError(t, repo.DeleteRecentSearch(me.ID, 0))
	assert.Equal(t, []uint{b.ID}, list(me.ID))

	require.NoError(t, repo.ClearRecentSearches(me.ID))
	assert.Empty(t, list(me.ID))
	assert.Equal(t, []uint{a.ID}, list(other.ID))

	assert.NoError(t, repo.ClearRecentSearches(0))
	assert.Equal(t, []uint{a.ID}, list(other.ID))
}

// trendingFixture builds a small social graph around "me":
//
//	followers of me: f1, f2 (ACTIVE) and f3 (PENDING, so not a follower)
//	I follow: k (who follows private t4, making t4 a mutual)
//	recent interactions by my followers: t1 (day like by f1, follow by f2),
//	t2 (verified; story like by f1), t3 (private, no mutual; day like by f1),
//	t4 (private, mutual; day like by f2), k (day like by f1), t5 (day like by pending f3),
//	t6 (verified; day like by f1 eight days ago)
type trendingFixture struct {
	me, f1, f2, f3, k, t1, t2, t3, t4, t5, t6 *models.User
}

func newTrendingFixture(t *testing.T, db *gorm.DB) trendingFixture {
	t.Helper()
	f := trendingFixture{
		me: testutil.CreateUser(t, db),
		f1: testutil.CreateUser(t, db),
		f2: testutil.CreateUser(t, db),
		f3: testutil.CreateUser(t, db),
		k:  testutil.CreateUser(t, db),
		t1: testutil.CreateUser(t, db, withAvatar),
		t2: testutil.CreateUser(t, db, verified),
		t3: testutil.CreateUser(t, db, private),
		t4: testutil.CreateUser(t, db, private),
		t5: testutil.CreateUser(t, db),
		t6: testutil.CreateUser(t, db, verified),
	}
	now := time.Now()
	follow(t, db, f.f1.ID, f.me.ID, models.FollowStateActive, now)
	follow(t, db, f.f2.ID, f.me.ID, models.FollowStateActive, now)
	follow(t, db, f.f3.ID, f.me.ID, models.FollowStatePending, now)
	follow(t, db, f.me.ID, f.k.ID, models.FollowStateActive, now)
	follow(t, db, f.k.ID, f.t4.ID, models.FollowStateActive, now)
	follow(t, db, f.f2.ID, f.t1.ID, models.FollowStateActive, now)

	likeDay := func(liker, liked *models.User) {
		require.NoError(t, db.Create(&models.Like{LikerID: liker.ID, LikedUserID: liked.ID, LikedDate: day}).Error)
	}
	likeDay(f.f1, f.t1)
	likeDay(f.f1, f.t3)
	likeDay(f.f2, f.t4)
	likeDay(f.f1, f.k)
	likeDay(f.f3, f.t5)
	likeDay(f.f1, f.t6)
	require.NoError(t, db.Exec("UPDATE likes SET created_at = NOW() - INTERVAL '8 days' WHERE liked_user_id = ?", f.t6.ID).Error)

	photo := createPhoto(t, db, f.t2.ID, "study", day, now)
	require.NoError(t, db.Create(&models.StoryLike{LikerID: f.f1.ID, PhotoID: photo.ID}).Error)

	// Distinct follower counts make the global fallback order deterministic.
	setCounters(t, db, f.t5.ID, counts{Followers: 50})
	setCounters(t, db, f.f1.ID, counts{Followers: 3})
	setCounters(t, db, f.f2.ID, counts{Followers: 2})
	setCounters(t, db, f.f3.ID, counts{Followers: 1})
	setCounters(t, db, f.t1.ID, counts{Followers: 7})
	return f
}

func TestRecentSearchRepository_GetTrendingUsersForUser(t *testing.T) {
	db := testutil.DB(t)
	repo := NewRecentSearchRepository(db)
	f := newTrendingFixture(t, db)

	t.Run("personalized results first", func(t *testing.T) {
		got, err := repo.GetTrendingUsersForUser(f.me.ID, 3)

		require.NoError(t, err)
		require.Equal(t, userIDs(f.t2, f.t1, f.t4), trendingIDs(got),
			"verified first, then by number of my followers who engaged")
		assert.Equal(t, 1, got[0].InteractionCount)
		assert.Equal(t, 2, got[1].InteractionCount, "a day like and a follow from two followers")
		assert.Equal(t, 1, got[2].InteractionCount)
		assert.Equal(t, TrendingUserResult{
			ID: f.t1.ID, Username: f.t1.Username, ProfilePic: f.t1.ProfilePic, ProfilePicThumb: f.t1.ProfilePicThumb,
			FollowersCount: 7, InteractionCount: 2,
		}, got[1])
	})

	t.Run("padded with global trending", func(t *testing.T) {
		got, err := repo.GetTrendingUsersForUser(f.me.ID, 10)

		require.NoError(t, err)
		assert.Equal(t, userIDs(f.t2, f.t1, f.t4, f.t6, f.t5, f.f1, f.f2, f.f3), trendingIDs(got),
			"global users follow, verified first then by followers; self, followed users and "+
				"private accounts without mutuals never appear")
		for _, row := range got[3:] {
			assert.Zero(t, row.InteractionCount, "global fallback rows have no interactions")
		}
	})

	t.Run("invalid user", func(t *testing.T) {
		got, err := repo.GetTrendingUsersForUser(0, 5)
		assert.NoError(t, err)
		assert.Nil(t, got)
	})
}

func TestRecentSearchRepository_GetTrendingUsersForUser_Limits(t *testing.T) {
	db := testutil.DB(t)
	repo := NewRecentSearchRepository(db)
	me := testutil.CreateUser(t, db)
	for i := 0; i < 12; i++ {
		u := testutil.CreateUser(t, db)
		setCounters(t, db, u.ID, counts{Followers: int64(100 - i)})
	}

	for limit, want := range map[int]int{-1: 6, 0: 6, 4: 4, 10: 10, 11: 10, 50: 10} {
		got, err := repo.GetTrendingUsersForUser(me.ID, limit)
		require.NoError(t, err)
		assert.Len(t, got, want, "limit %d", limit)
	}
}

func TestRecentSearchRepository_DatabaseErrors(t *testing.T) {
	repo := NewRecentSearchRepository(testutil.BrokenDB(t))
	calls := map[string]func() error{
		"SaveRecentSearch":    func() error { return repo.SaveRecentSearch(1, 2) },
		"GetRecentSearches":   func() error { _, err := repo.GetRecentSearches(1, 5); return err },
		"DeleteRecentSearch":  func() error { return repo.DeleteRecentSearch(1, 2) },
		"ClearRecentSearches": func() error { return repo.ClearRecentSearches(1) },
		"GetTrendingUsersForUser": func() error {
			_, err := repo.GetTrendingUsersForUser(1, 5)
			return err
		},
	}
	for name, call := range calls {
		t.Run(name, func(t *testing.T) { assert.Error(t, call()) })
	}
}
