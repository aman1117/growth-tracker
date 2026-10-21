package repository

import (
	"testing"
	"time"

	"github.com/aman1117/backend/internal/testutil"
	"github.com/aman1117/backend/pkg/models"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// ==================== Day likes ====================

func TestLikeRepository_CreateAndHasLiked(t *testing.T) {
	db := testutil.DB(t)
	repo := NewLikeRepository(db)
	liker, owner := testutil.CreateUser(t, db), testutil.CreateUser(t, db)

	require.NoError(t, repo.Create(liker.ID, owner.ID, day))
	require.NoError(t, repo.Create(liker.ID, owner.ID, day), "liking twice is idempotent")

	for _, tc := range []struct {
		name          string
		liker, target uint
		date          time.Time
		want          bool
	}{
		{"liked day", liker.ID, owner.ID, day, true},
		{"another day", liker.ID, owner.ID, day.AddDate(0, 0, 1), false},
		{"reverse direction", owner.ID, liker.ID, day, false},
	} {
		liked, err := repo.HasLiked(tc.liker, tc.target, tc.date)
		require.NoError(t, err)
		assert.Equal(t, tc.want, liked, tc.name)
	}

	count, err := repo.CountLikesForDay(owner.ID, day)
	require.NoError(t, err)
	assert.Equal(t, int64(1), count)
}

func TestLikeRepository_Create_UnknownUser(t *testing.T) {
	db := testutil.DB(t)
	repo := NewLikeRepository(db)
	liker := testutil.CreateUser(t, db)

	assert.Error(t, repo.Create(liker.ID, 9999, day), "only duplicate likes are swallowed")
}

func TestLikeRepository_Delete(t *testing.T) {
	db := testutil.DB(t)
	repo := NewLikeRepository(db)
	liker, owner := testutil.CreateUser(t, db), testutil.CreateUser(t, db)
	require.NoError(t, repo.Create(liker.ID, owner.ID, day))
	require.NoError(t, repo.Create(liker.ID, owner.ID, day.AddDate(0, 0, 1)))

	require.NoError(t, repo.Delete(liker.ID, owner.ID, day))

	liked, err := repo.HasLiked(liker.ID, owner.ID, day)
	require.NoError(t, err)
	assert.False(t, liked)
	liked, err = repo.HasLiked(liker.ID, owner.ID, day.AddDate(0, 0, 1))
	require.NoError(t, err)
	assert.True(t, liked, "likes on other days are kept")

	assert.EqualError(t, repo.Delete(liker.ID, owner.ID, day), "like not found")
}

func TestLikeRepository_GetLikesForDay(t *testing.T) {
	db := testutil.DB(t)
	repo := NewLikeRepository(db)
	owner := testutil.CreateUser(t, db)
	alice := namedUser(t, db, "alice", verified, withAvatar)
	bob := namedUser(t, db, "bob")
	carol := namedUser(t, db, "carol")
	require.NoError(t, repo.Create(alice.ID, owner.ID, day))
	require.NoError(t, repo.Create(bob.ID, owner.ID, day))
	require.NoError(t, repo.Create(carol.ID, owner.ID, day.AddDate(0, 0, -1)))
	require.NoError(t, repo.Create(alice.ID, bob.ID, day))
	require.NoError(t, db.Exec("UPDATE likes SET created_at = ? WHERE liker_id = ? AND liked_user_id = ?", t0.Add(2*time.Minute), alice.ID, owner.ID).Error)
	require.NoError(t, db.Exec("UPDATE likes SET created_at = ? WHERE liker_id = ? AND liked_user_id = ?", t0.Add(1*time.Minute), bob.ID, owner.ID).Error)

	likes, err := repo.GetLikesForDay(owner.ID, day)

	require.NoError(t, err)
	require.Len(t, likes, 2)
	assert.Equal(t, alice.ID, likes[0].LikerID, "most recent first")
	assert.Equal(t, "alice", likes[0].Username)
	assert.Equal(t, alice.ProfilePic, likes[0].ProfilePic)
	assert.Equal(t, alice.ProfilePicThumb, likes[0].ProfilePicThumb)
	assert.True(t, likes[0].IsVerified)
	assert.NotZero(t, likes[0].ID)
	assert.True(t, likes[0].CreatedAt.Equal(t0.Add(2*time.Minute)))
	assert.Equal(t, bob.ID, likes[1].LikerID)
	assert.False(t, likes[1].IsVerified)

	count, err := repo.CountLikesForDay(owner.ID, day)
	require.NoError(t, err)
	assert.Equal(t, int64(2), count)

	likes, err = repo.GetLikesForDay(owner.ID, day.AddDate(0, 0, 5))
	require.NoError(t, err)
	assert.Empty(t, likes)
}

func TestLikeRepository_GetLikesByUser(t *testing.T) {
	db := testutil.DB(t)
	repo := NewLikeRepository(db)
	liker, owner, other := testutil.CreateUser(t, db), testutil.CreateUser(t, db), testutil.CreateUser(t, db)
	for i := 1; i <= 3; i++ {
		date := day.AddDate(0, 0, i)
		require.NoError(t, repo.Create(liker.ID, owner.ID, date))
		require.NoError(t, db.Exec("UPDATE likes SET created_at = ? WHERE liker_id = ? AND liked_date = ?", t0.Add(time.Duration(i)*time.Minute), liker.ID, date).Error)
	}
	require.NoError(t, repo.Create(other.ID, owner.ID, day))

	likes, err := repo.GetLikesByUser(liker.ID, 2)

	require.NoError(t, err)
	require.Len(t, likes, 2)
	assert.Equal(t, "2026-03-12", likes[0].LikedDate.Format(dateLayout), "most recent first")
	assert.Equal(t, "2026-03-11", likes[1].LikedDate.Format(dateLayout))
	for _, l := range likes {
		assert.Equal(t, liker.ID, l.LikerID)
	}
}

func TestLikeRepository_DatabaseErrors(t *testing.T) {
	repo := NewLikeRepository(testutil.BrokenDB(t))

	err := repo.Delete(1, 2, day)
	require.Error(t, err)
	assert.NotEqual(t, "like not found", err.Error(), "database errors are not reported as missing likes")

	calls := map[string]func() error{
		"Create":           func() error { return repo.Create(1, 2, day) },
		"HasLiked":         func() error { _, err := repo.HasLiked(1, 2, day); return err },
		"GetLikesForDay":   func() error { _, err := repo.GetLikesForDay(2, day); return err },
		"CountLikesForDay": func() error { _, err := repo.CountLikesForDay(2, day); return err },
		"GetLikesByUser":   func() error { _, err := repo.GetLikesByUser(1, 10); return err },
	}
	for name, call := range calls {
		t.Run(name, func(t *testing.T) { assert.Error(t, call()) })
	}
}

// ==================== Badges ====================

func badgeKeys(badges []models.UserBadge) []string {
	keys := make([]string, len(badges))
	for i, b := range badges {
		keys[i] = b.BadgeKey
	}
	return keys
}

func TestBadgeRepository(t *testing.T) {
	db := testutil.DB(t)
	repo := NewBadgeRepository(db)
	user, other := testutil.CreateUser(t, db), testutil.CreateUser(t, db)

	week := &models.UserBadge{UserID: user.ID, BadgeKey: "streak_7", EarnedAt: t0.Add(2 * time.Hour)}
	require.NoError(t, repo.Create(week))
	assert.NotZero(t, week.ID)
	require.NoError(t, repo.CreateBatch(nil), "empty batches are a no-op")
	require.NoError(t, repo.CreateBatch([]models.UserBadge{
		{UserID: user.ID, BadgeKey: "streak_3", EarnedAt: t0},
		{UserID: other.ID, BadgeKey: "streak_3", EarnedAt: t0.Add(time.Hour)},
	}))

	assert.Error(t, repo.Create(&models.UserBadge{UserID: user.ID, BadgeKey: "streak_7"}), "a badge is earned once")
	assert.Error(t, repo.CreateBatch([]models.UserBadge{{UserID: other.ID, BadgeKey: "streak_3"}}))

	t.Run("FindByUserID", func(t *testing.T) {
		badges, err := repo.FindByUserID(user.ID)
		require.NoError(t, err)
		assert.Equal(t, []string{"streak_3", "streak_7"}, badgeKeys(badges), "in the order they were earned")
	})

	t.Run("FindByUserIDs", func(t *testing.T) {
		badges, err := repo.FindByUserIDs([]uint{user.ID, other.ID})
		require.NoError(t, err)
		require.Len(t, badges, 3)
		assert.Equal(t, []uint{user.ID, other.ID, user.ID}, []uint{badges[0].UserID, badges[1].UserID, badges[2].UserID})
		assert.Equal(t, []string{"streak_3", "streak_3", "streak_7"}, badgeKeys(badges))
	})

	t.Run("ExistsByUserAndKey", func(t *testing.T) {
		exists, err := repo.ExistsByUserAndKey(user.ID, "streak_7")
		require.NoError(t, err)
		assert.True(t, exists)
		exists, err = repo.ExistsByUserAndKey(other.ID, "streak_7")
		require.NoError(t, err)
		assert.False(t, exists)
	})

	t.Run("GetEarnedBadgeKeys", func(t *testing.T) {
		keys, err := repo.GetEarnedBadgeKeys(user.ID)
		require.NoError(t, err)
		assert.ElementsMatch(t, []string{"streak_3", "streak_7"}, keys)
	})

	t.Run("DeleteByUserID", func(t *testing.T) {
		require.NoError(t, repo.DeleteByUserID(user.ID))
		badges, err := repo.FindByUserID(user.ID)
		require.NoError(t, err)
		assert.Empty(t, badges)
		badges, err = repo.FindByUserID(other.ID)
		require.NoError(t, err)
		assert.Len(t, badges, 1, "other users keep their badges")
	})
}

func TestBadgeRepository_DatabaseErrors(t *testing.T) {
	repo := NewBadgeRepository(testutil.BrokenDB(t))
	calls := map[string]func() error{
		"Create":             func() error { return repo.Create(&models.UserBadge{UserID: 1, BadgeKey: "streak_3"}) },
		"CreateBatch":        func() error { return repo.CreateBatch([]models.UserBadge{{UserID: 1, BadgeKey: "streak_3"}}) },
		"FindByUserID":       func() error { _, err := repo.FindByUserID(1); return err },
		"FindByUserIDs":      func() error { _, err := repo.FindByUserIDs([]uint{1}); return err },
		"ExistsByUserAndKey": func() error { _, err := repo.ExistsByUserAndKey(1, "streak_3"); return err },
		"GetEarnedBadgeKeys": func() error { _, err := repo.GetEarnedBadgeKeys(1); return err },
		"DeleteByUserID":     func() error { return repo.DeleteByUserID(1) },
	}
	for name, call := range calls {
		t.Run(name, func(t *testing.T) { assert.Error(t, call()) })
	}
}
