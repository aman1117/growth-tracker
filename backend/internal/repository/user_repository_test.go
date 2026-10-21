package repository

import (
	"fmt"
	"testing"

	"github.com/aman1117/backend/internal/testutil"
	"github.com/aman1117/backend/pkg/models"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func usernames[T any](rows []T, name func(T) string) []string {
	out := make([]string, len(rows))
	for i, r := range rows {
		out[i] = name(r)
	}
	return out
}

func autocompleteNames(rows []AutocompleteResult) []string {
	return usernames(rows, func(r AutocompleteResult) string { return r.Username })
}

func TestUserRepository_Create_InitializesFollowCounters(t *testing.T) {
	db := testutil.DB(t)
	repo := NewUserRepository(db)

	require.NoError(t, repo.Create("alice@example.com", "alice", "bcrypt-hash"))

	user, err := repo.FindByEmail("alice@example.com")
	require.NoError(t, err)
	require.NotNil(t, user)
	assert.Equal(t, "alice", user.Username)
	assert.Equal(t, "bcrypt-hash", user.PasswordHash)
	assert.False(t, user.IsPrivate, "accounts are public by default")
	assert.False(t, user.EmailVerified)
	assert.False(t, user.CreatedAt.IsZero())
	assert.Equal(t, counts{}, countsOf(t, db, user.ID), "a zeroed follow_counters row is created")
}

func TestUserRepository_Create_RejectsDuplicates(t *testing.T) {
	db := testutil.DB(t)
	repo := NewUserRepository(db)
	require.NoError(t, repo.Create("alice@example.com", "alice", "hash"))

	assert.Error(t, repo.Create("alice@example.com", "alice2", "hash"), "duplicate email")
	assert.Error(t, repo.Create("alice2@example.com", "alice", "hash"), "duplicate username")

	var users, counters int64
	require.NoError(t, db.Model(&models.User{}).Count(&users).Error)
	require.NoError(t, db.Model(&models.FollowCounter{}).Count(&counters).Error)
	assert.Equal(t, int64(1), users)
	assert.Equal(t, int64(1), counters)
}

func TestUserRepository_Create_RollsBackOnPartialFailure(t *testing.T) {
	db := testutil.DB(t)
	cases := []struct {
		name  string
		match stmtMatcher
	}{
		{"id lookup fails", sqlContains("SELECT id FROM users")},
		{"counter insert fails", sqlContains("INSERT INTO follow_counters")},
	}
	for i, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			repo := NewUserRepository(faultyDB(t, tc.match))
			email := fmt.Sprintf("rollback%d@example.com", i)

			err := repo.Create(email, fmt.Sprintf("rollback%d", i), "hash")

			assert.ErrorIs(t, err, errInjected)
			var n int64
			require.NoError(t, db.Model(&models.User{}).Where("email = ?", email).Count(&n).Error)
			assert.Zero(t, n, "the user insert is rolled back")
		})
	}
}

func TestUserRepository_Lookups(t *testing.T) {
	db := testutil.DB(t)
	repo := NewUserRepository(db)
	alice := testutil.CreateUser(t, db, func(u *models.User) { u.Username, u.Email = "alice", "alice@example.com" })
	bob := testutil.CreateUser(t, db, func(u *models.User) { u.Username, u.Email = "bob", "bob@example.com" })

	t.Run("FindByID", func(t *testing.T) {
		got, err := repo.FindByID(alice.ID)
		require.NoError(t, err)
		require.NotNil(t, got)
		assert.Equal(t, "alice", got.Username)

		got, err = repo.FindByID(9999)
		assert.NoError(t, err, "not found is not an error")
		assert.Nil(t, got)
	})

	t.Run("FindByIdentifier", func(t *testing.T) {
		got, err := repo.FindByIdentifier("alice@example.com")
		require.NoError(t, err)
		require.NotNil(t, got)
		assert.Equal(t, alice.ID, got.ID, "by email")

		got, err = repo.FindByIdentifier("bob")
		require.NoError(t, err)
		require.NotNil(t, got)
		assert.Equal(t, bob.ID, got.ID, "by username")

		got, err = repo.FindByIdentifier("carol")
		assert.NoError(t, err)
		assert.Nil(t, got)
	})

	t.Run("FindByUsername", func(t *testing.T) {
		got, err := repo.FindByUsername("bob")
		require.NoError(t, err)
		require.NotNil(t, got)
		assert.Equal(t, bob.ID, got.ID)

		got, err = repo.FindByUsername("bob@example.com")
		assert.NoError(t, err)
		assert.Nil(t, got, "emails are not usernames")
	})

	t.Run("FindByEmail", func(t *testing.T) {
		got, err := repo.FindByEmail("bob@example.com")
		require.NoError(t, err)
		require.NotNil(t, got)
		assert.Equal(t, bob.ID, got.ID)

		got, err = repo.FindByEmail("bob")
		assert.NoError(t, err)
		assert.Nil(t, got)
	})

	t.Run("FindByUsernames", func(t *testing.T) {
		got, err := repo.FindByUsernames([]string{"alice", "bob", "ghost"})
		require.NoError(t, err)
		assert.ElementsMatch(t, []string{"alice", "bob"}, usernames(got, func(u models.User) string { return u.Username }))

		got, err = repo.FindByUsernames(nil)
		assert.NoError(t, err)
		assert.Empty(t, got)
	})

	t.Run("GetAll", func(t *testing.T) {
		got, err := repo.GetAll()
		require.NoError(t, err)
		assert.ElementsMatch(t, []uint{alice.ID, bob.ID}, usernamesToIDs(got))
	})
}

func usernamesToIDs(users []models.User) []uint {
	ids := make([]uint, len(users))
	for i, u := range users {
		ids[i] = u.ID
	}
	return ids
}

func TestUserRepository_Updates(t *testing.T) {
	db := testutil.DB(t)
	repo := NewUserRepository(db)
	user := testutil.CreateUser(t, db)
	other := testutil.CreateUser(t, db, func(u *models.User) { u.Username = "taken" })
	reload := func(id uint) *models.User {
		t.Helper()
		u, err := repo.FindByID(id)
		require.NoError(t, err)
		require.NotNil(t, u)
		return u
	}

	t.Run("username", func(t *testing.T) {
		require.NoError(t, repo.UpdateUsername(user.ID, "renamed"))
		assert.Equal(t, "renamed", reload(user.ID).Username)

		assert.Error(t, repo.UpdateUsername(user.ID, "taken"), "usernames are unique")
		assert.Equal(t, "renamed", reload(user.ID).Username)
	})

	t.Run("password", func(t *testing.T) {
		require.NoError(t, repo.UpdatePassword(user.ID, "new-hash"))
		assert.Equal(t, "new-hash", reload(user.ID).PasswordHash)
	})

	t.Run("privacy", func(t *testing.T) {
		require.NoError(t, repo.UpdatePrivacy(user.ID, true))
		isPrivate, err := repo.GetPrivacy(user.ID)
		require.NoError(t, err)
		assert.True(t, isPrivate)

		require.NoError(t, repo.UpdatePrivacy(user.ID, false))
		isPrivate, err = repo.GetPrivacy(user.ID)
		require.NoError(t, err)
		assert.False(t, isPrivate, "false is written, not skipped as a zero value")
	})

	t.Run("bio", func(t *testing.T) {
		require.NoError(t, repo.UpdateBio(user.ID, "Learning Go every día 🚀"))
		bio, err := repo.GetBio(user.ID)
		require.NoError(t, err)
		require.NotNil(t, bio)
		assert.Equal(t, "Learning Go every día 🚀", *bio)

		require.NoError(t, repo.UpdateBio(user.ID, ""))
		bio, err = repo.GetBio(user.ID)
		require.NoError(t, err)
		assert.Nil(t, bio, "an empty bio is stored as NULL")
	})

	t.Run("profile picture", func(t *testing.T) {
		pic, thumb := "https://blob.example.com/p.jpg", "https://blob.example.com/p_thumb.jpg"
		require.NoError(t, repo.UpdateProfilePic(user.ID, &pic, &thumb))
		got := reload(user.ID)
		require.NotNil(t, got.ProfilePic)
		require.NotNil(t, got.ProfilePicThumb)
		assert.Equal(t, pic, *got.ProfilePic)
		assert.Equal(t, thumb, *got.ProfilePicThumb)

		require.NoError(t, repo.UpdateProfilePic(user.ID, nil, nil))
		got = reload(user.ID)
		assert.Nil(t, got.ProfilePic)
		assert.Nil(t, got.ProfilePicThumb)
	})

	t.Run("email verified", func(t *testing.T) {
		require.NoError(t, repo.UpdateEmailVerified(user.ID, false))
		assert.False(t, reload(user.ID).EmailVerified)
		require.NoError(t, repo.UpdateEmailVerified(user.ID, true))
		assert.True(t, reload(user.ID).EmailVerified)
	})

	t.Run("other users are untouched", func(t *testing.T) {
		got := reload(other.ID)
		assert.Equal(t, "taken", got.Username)
		assert.Equal(t, other.PasswordHash, got.PasswordHash)
		assert.Nil(t, got.Bio)
		assert.False(t, got.IsPrivate)
		assert.True(t, got.EmailVerified)
	})

	t.Run("missing user", func(t *testing.T) {
		_, err := repo.GetPrivacy(9999)
		assert.ErrorIs(t, err, gorm.ErrRecordNotFound)
		_, err = repo.GetBio(9999)
		assert.ErrorIs(t, err, gorm.ErrRecordNotFound)
	})
}

func TestUserRepository_SearchByUsername(t *testing.T) {
	db := testutil.DB(t)
	repo := NewUserRepository(db)
	namedUser(t, db, "GrowthGuru")
	namedUser(t, db, "guru.private", private)
	namedUser(t, db, "alice")

	got, err := repo.SearchByUsername("GURU")
	require.NoError(t, err)
	assert.ElementsMatch(t, []string{"GrowthGuru", "guru.private"},
		usernames(got, func(u models.User) string { return u.Username }),
		"case-insensitive substring match that includes private accounts")

	got, err = repo.SearchByUsername("nobody")
	require.NoError(t, err)
	assert.Empty(t, got)
}

func TestUserRepository_AutocompleteUsers_Ranking(t *testing.T) {
	db := testutil.DB(t)
	repo := NewUserRepository(db)
	exact := namedUser(t, db, "alex", verified, private, withAvatar)
	namedUser(t, db, "alexab")
	popular := namedUser(t, db, "alexba")
	namedUser(t, db, "xalex")
	namedUser(t, db, "zzzz")
	setCounters(t, db, popular.ID, counts{Followers: 10})
	setCounters(t, db, exact.ID, counts{Followers: 3})

	results, err := repo.AutocompleteUsers("alex", 10)

	require.NoError(t, err)
	require.Equal(t, []string{"alex", "alexba", "alexab", "xalex"}, autocompleteNames(results),
		"exact match, then prefix matches, then fuzzy matches; unrelated names are excluded")

	top := results[0]
	assert.Equal(t, exact.ID, top.ID)
	assert.InDelta(t, 100.0, top.Score, 1e-9)
	assert.True(t, top.IsVerified)
	assert.True(t, top.IsPrivate, "private accounts are still suggested")
	assert.Equal(t, exact.ProfilePic, top.ProfilePic)
	assert.Equal(t, exact.ProfilePicThumb, top.ProfilePicThumb)
	assert.Equal(t, int64(3), top.FollowersCount)

	require.InDelta(t, results[1].Score, results[2].Score, 1e-9, "precondition: both prefix matches score the same")
	assert.GreaterOrEqual(t, results[1].Score, 50.0)
	assert.Less(t, results[1].Score, 80.0)
	assert.Equal(t, int64(10), results[1].FollowersCount, "equal scores are ordered by follower count")
	assert.Zero(t, results[2].FollowersCount, "users without a counters row have 0 followers")

	assert.Greater(t, results[3].Score, 0.15*30)
	assert.Less(t, results[3].Score, 30.0)

	upper, err := repo.AutocompleteUsers("ALEX", 1)
	require.NoError(t, err)
	require.Len(t, upper, 1)
	assert.Equal(t, "alex", upper[0].Username, "exact matching ignores case")
	assert.InDelta(t, 100.0, upper[0].Score, 1e-9)
}

func TestUserRepository_AutocompleteUsers_TiesOrderedByUsername(t *testing.T) {
	db := testutil.DB(t)
	repo := NewUserRepository(db)
	namedUser(t, db, "alexbb")
	namedUser(t, db, "alexab")

	results, err := repo.AutocompleteUsers("alex", 10)

	require.NoError(t, err)
	require.Len(t, results, 2)
	require.InDelta(t, results[0].Score, results[1].Score, 1e-9, "precondition: equal scores")
	assert.Equal(t, []string{"alexab", "alexbb"}, autocompleteNames(results))
}

func TestUserRepository_AutocompleteUsers_EscapesLikeWildcards(t *testing.T) {
	db := testutil.DB(t)
	repo := NewUserRepository(db)
	namedUser(t, db, "alice")
	namedUser(t, db, "carol")
	namedUser(t, db, "a_bob")
	namedUser(t, db, "axbob")

	for _, q := range []string{"%", "_", `\`, "%%"} {
		results, err := repo.AutocompleteUsers(q, 10)
		require.NoError(t, err)
		assert.Empty(t, results, "%q is matched literally, not as a wildcard", q)
	}

	results, err := repo.AutocompleteUsers("a_b", 10)
	require.NoError(t, err)
	names := autocompleteNames(results)
	assert.Contains(t, names, "a_bob", "a literal underscore still matches as a prefix")
	assert.NotContains(t, names, "axbob", "underscore is not a single-character wildcard")
}

func TestUserRepository_AutocompleteUsers_Limit(t *testing.T) {
	db := testutil.DB(t)
	repo := NewUserRepository(db)
	for i := 1; i <= 22; i++ {
		namedUser(t, db, fmt.Sprintf("sam%02d", i))
	}

	for limit, want := range map[int]int{-1: 12, 0: 12, 3: 3, 20: 20, 21: 20, 100: 20} {
		results, err := repo.AutocompleteUsers("sam", limit)
		require.NoError(t, err)
		assert.Len(t, results, want, "limit %d", limit)
	}
}

func TestUserRepository_DatabaseErrors(t *testing.T) {
	repo := NewUserRepository(testutil.BrokenDB(t))
	pic := "https://blob.example.com/p.jpg"

	calls := map[string]func() error{
		"Create":           func() error { return repo.Create("a@example.com", "a", "hash") },
		"FindByID":         func() error { _, err := repo.FindByID(1); return err },
		"FindByIdentifier": func() error { _, err := repo.FindByIdentifier("a"); return err },
		"FindByUsername":   func() error { _, err := repo.FindByUsername("a"); return err },
		"FindByUsernames":  func() error { _, err := repo.FindByUsernames([]string{"a"}); return err },
		"FindByEmail":      func() error { _, err := repo.FindByEmail("a@example.com"); return err },
		"UpdateUsername":   func() error { return repo.UpdateUsername(1, "b") },
		"UpdatePassword":   func() error { return repo.UpdatePassword(1, "hash") },
		"UpdatePrivacy":    func() error { return repo.UpdatePrivacy(1, true) },
		"GetPrivacy":       func() error { _, err := repo.GetPrivacy(1); return err },
		"UpdateBio":        func() error { return repo.UpdateBio(1, "bio") },
		"GetBio":           func() error { _, err := repo.GetBio(1); return err },
		"UpdateProfilePic": func() error { return repo.UpdateProfilePic(1, &pic, &pic) },
		"UpdateEmailVerified": func() error {
			return repo.UpdateEmailVerified(1, true)
		},
		"SearchByUsername":  func() error { _, err := repo.SearchByUsername("a"); return err },
		"AutocompleteUsers": func() error { _, err := repo.AutocompleteUsers("a", 5); return err },
		"GetAll":            func() error { _, err := repo.GetAll(); return err },
	}
	for name, call := range calls {
		t.Run(name, func(t *testing.T) { assert.Error(t, call()) })
	}
}
