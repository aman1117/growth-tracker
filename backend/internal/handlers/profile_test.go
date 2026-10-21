package handlers

import (
	"net/http"
	"net/url"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/dto"
	"github.com/aman1117/backend/internal/testutil"
	"github.com/aman1117/backend/pkg/models"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

var ghostUser = &models.User{ID: 9999, Username: "ghost"}

func TestProfileHandler_Privacy(t *testing.T) {
	env := newEnv(t)
	user := env.user(t)

	t.Run("malformed json", func(t *testing.T) {
		res := env.do(t, user, http.MethodPost, "/api/update-privacy", `{"is_private":`)
		assertErrorMessage(t, res, http.StatusBadRequest, constants.ErrCodeInvalidRequest, "Invalid request body")
	})

	t.Run("updates and reads the setting", func(t *testing.T) {
		res := env.do(t, user, http.MethodPost, "/api/update-privacy", map[string]bool{"is_private": true})
		require.Equal(t, http.StatusOK, res.Status)
		assert.Equal(t, map[string]any{"success": true, "message": constants.MsgPrivacyUpdated, "is_private": true}, res.JSON(t))

		got := decodeAs[dto.PrivacyResponse](t, env.do(t, user, http.MethodGet, "/api/get-privacy", nil), http.StatusOK)
		assert.Equal(t, dto.PrivacyResponse{Success: true, IsPrivate: true}, got)

		env.do(t, user, http.MethodPost, "/api/update-privacy", map[string]bool{"is_private": false})
		got = decodeAs[dto.PrivacyResponse](t, env.do(t, user, http.MethodGet, "/api/get-privacy", nil), http.StatusOK)
		assert.False(t, got.IsPrivate)
	})

	t.Run("unknown user", func(t *testing.T) {
		res := env.do(t, ghostUser, http.MethodGet, "/api/get-privacy", nil)
		assertErrorMessage(t, res, http.StatusInternalServerError, constants.ErrCodeFetchFailed, "Failed to get privacy setting")
	})
}

func TestProfileHandler_UpdatePrivacy_DatabaseFailure(t *testing.T) {
	res := call(t, brokenStack(t).handlers(), ghostUser, http.MethodPost, "/api/update-privacy", map[string]bool{"is_private": true})
	assertErrorMessage(t, res, http.StatusInternalServerError, constants.ErrCodeUpdateFailed, "Failed to update privacy setting")
}

func TestProfileHandler_Bio(t *testing.T) {
	env := newEnv(t)
	user := env.user(t)

	t.Run("malformed json", func(t *testing.T) {
		res := env.do(t, user, http.MethodPost, "/api/update-bio", `{"bio":`)
		assertError(t, res, http.StatusBadRequest, constants.ErrCodeInvalidRequest)
	})

	t.Run("too long", func(t *testing.T) {
		res := env.do(t, user, http.MethodPost, "/api/update-bio", map[string]string{"bio": strings.Repeat("a", 151)})
		assertErrorMessage(t, res, http.StatusBadRequest, constants.ErrCodeBioTooLong, "Bio must be 150 characters or less")
	})

	t.Run("trims and stores the bio", func(t *testing.T) {
		res := env.do(t, user, http.MethodPost, "/api/update-bio", map[string]string{"bio": "  Learning Go 🚀\n"})
		require.Equal(t, http.StatusOK, res.Status)
		assert.Equal(t, map[string]any{"success": true, "message": constants.MsgBioUpdated, "bio": "Learning Go 🚀"}, res.JSON(t))

		got := decodeAs[dto.BioResponse](t, env.do(t, user, http.MethodGet, "/api/get-bio", nil), http.StatusOK)
		require.NotNil(t, got.Bio)
		assert.Equal(t, "Learning Go 🚀", *got.Bio)
	})

	t.Run("accepts exactly 150 characters", func(t *testing.T) {
		bio := strings.Repeat("b", 150)
		res := env.do(t, user, http.MethodPost, "/api/update-bio", map[string]string{"bio": bio})
		require.Equal(t, http.StatusOK, res.Status)
		got := decodeAs[dto.BioResponse](t, env.do(t, user, http.MethodGet, "/api/get-bio", nil), http.StatusOK)
		assert.Equal(t, bio, *got.Bio)
	})

	t.Run("blank bio clears it", func(t *testing.T) {
		res := env.do(t, user, http.MethodPost, "/api/update-bio", map[string]string{"bio": "   "})
		require.Equal(t, http.StatusOK, res.Status)
		got := decodeAs[dto.BioResponse](t, env.do(t, user, http.MethodGet, "/api/get-bio", nil), http.StatusOK)
		assert.Equal(t, dto.BioResponse{Success: true}, got)
	})

	t.Run("unknown user", func(t *testing.T) {
		res := env.do(t, ghostUser, http.MethodGet, "/api/get-bio", nil)
		assertErrorMessage(t, res, http.StatusInternalServerError, constants.ErrCodeFetchFailed, "Failed to get bio")
	})
}

func TestProfileHandler_UpdateBio_UnicodeLengthCountsCharacters(t *testing.T) {
	env := newEnv(t)
	user := env.user(t)
	bio := strings.Repeat("é", 150) // 300 bytes

	res := env.do(t, user, http.MethodPost, "/api/update-bio", map[string]string{"bio": bio})
	require.Equal(t, http.StatusOK, res.Status, "body: %s", res.Body)
	got := decodeAs[dto.BioResponse](t, env.do(t, user, http.MethodGet, "/api/get-bio", nil), http.StatusOK)
	require.NotNil(t, got.Bio)
	assert.Equal(t, bio, *got.Bio)

	res = env.do(t, user, http.MethodPost, "/api/update-bio", map[string]string{"bio": bio + "é"})
	assertErrorMessage(t, res, http.StatusBadRequest, constants.ErrCodeBioTooLong, "Bio must be 150 characters or less")
}

func TestProfileHandler_UpdateBio_LogsLengthInCharacters(t *testing.T) {
	env := newEnv(t)
	user := env.user(t)
	logs := observeLogs(t)

	res := env.do(t, user, http.MethodPost, "/api/update-bio", map[string]string{"bio": "Grüße 🚀"}) // 7 characters, 12 bytes
	require.Equal(t, http.StatusOK, res.Status)

	entries := logs.FilterMessage("Bio updated").All()
	require.Len(t, entries, 1)
	assert.EqualValues(t, 7, entries[0].ContextMap()["bio_length"])
}

func TestProfileHandler_UpdateBio_DatabaseFailure(t *testing.T) {
	res := call(t, brokenStack(t).handlers(), ghostUser, http.MethodPost, "/api/update-bio", map[string]string{"bio": "hello"})
	assertErrorMessage(t, res, http.StatusInternalServerError, constants.ErrCodeUpdateFailed, "Failed to update bio")
}

func TestProfileHandler_GetProfile(t *testing.T) {
	env := newEnv(t)
	user := env.user(t, withBio("hello"), withPicture("http://pics.example/me.jpg"), verified)
	fan1, fan2 := env.user(t), env.user(t)
	follow(t, env.db, fan1, user)
	follow(t, env.db, fan2, user)
	follow(t, env.db, user, fan1)

	t.Run("returns the full profile with counts", func(t *testing.T) {
		got := decodeAs[dto.ProfileResponse](t, env.do(t, user, http.MethodGet, "/api/profile", nil), http.StatusOK)
		assert.Equal(t, dto.ProfileResponse{
			Success:         true,
			Username:        user.Username,
			Email:           user.Email,
			ProfilePic:      user.ProfilePic,
			ProfilePicThumb: user.ProfilePicThumb,
			Bio:             user.Bio,
			IsVerified:      true,
			EmailVerified:   true,
			FollowersCount:  2,
			FollowingCount:  1,
		}, got)
	})

	t.Run("without a follow service the counts are zero", func(t *testing.T) {
		h := &handlerSet{profile: NewProfileHandler(env.profileSvc, env.authSvc, nil, nil, nil)}
		got := decodeAs[dto.ProfileResponse](t, call(t, h, user, http.MethodGet, "/api/profile", nil), http.StatusOK)
		assert.Equal(t, user.Username, got.Username)
		assert.Zero(t, got.FollowersCount)
		assert.Zero(t, got.FollowingCount)
	})

	t.Run("unknown user", func(t *testing.T) {
		res := env.do(t, ghostUser, http.MethodGet, "/api/profile", nil)
		assertErrorMessage(t, res, http.StatusNotFound, constants.ErrCodeUserNotFound, "User not found")
	})

	t.Run("anonymous request", func(t *testing.T) {
		assertError(t, env.do(t, nil, http.MethodGet, "/api/profile", nil), http.StatusNotFound, constants.ErrCodeUserNotFound)
	})
}

func TestProfileHandler_GetUserProfile(t *testing.T) {
	env := newEnv(t)
	viewer := env.user(t, withBio("my bio"))
	public := env.user(t, withBio("public bio"))
	hidden := env.user(t, private, withBio("secret bio"))
	friend := env.user(t, private, withBio("friend bio"))
	pending := env.user(t, private, withBio("pending bio"))
	follow(t, env.db, viewer, friend)
	requestFollow(t, env.db, viewer, pending)
	testutil.CreateStreak(t, env.db, public.ID, 3, 5, testutil.Day(2026, 3, 9))
	testutil.CreateStreak(t, env.db, public.ID, 0, 5, testutil.Day(2026, 3, 10))
	testutil.CreateStreak(t, env.db, hidden.ID, 2, 2, testutil.Day(2026, 3, 9))
	testutil.CreateStreak(t, env.db, friend.ID, 1, 1, testutil.Day(2026, 3, 11))

	t.Run("invalid id", func(t *testing.T) {
		res := env.do(t, viewer, http.MethodGet, "/api/users/abc/profile", nil)
		assertErrorMessage(t, res, http.StatusBadRequest, constants.ErrCodeInvalidRequest, "Invalid user ID")
	})

	t.Run("unknown user", func(t *testing.T) {
		res := env.do(t, viewer, http.MethodGet, "/api/users/9999/profile", nil)
		assertErrorMessage(t, res, http.StatusNotFound, constants.ErrCodeUserNotFound, "User not found")
	})

	tests := []struct {
		name         string
		viewer       *models.User
		target       *models.User
		relationship string
		bio          *string
		lastLogged   string
		followers    int64
	}{
		{"public profile", viewer, public, "NONE", public.Bio, "2026-03-09", 0},
		{"private profile not followed", viewer, hidden, "NONE", nil, "", 0},
		{"private profile followed", viewer, friend, "FOLLOWING", friend.Bio, "2026-03-11", 1},
		{"private profile with a pending request", viewer, pending, "REQUESTED", nil, "", 0},
		{"own profile", viewer, viewer, "NONE", viewer.Bio, "", 0},
		{"anonymous viewer of a public profile", nil, public, "NONE", public.Bio, "2026-03-09", 0},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			res := env.do(t, tc.viewer, http.MethodGet, "/api/users/"+itoa(tc.target.ID)+"/profile", nil)

			got := decodeAs[dto.PublicProfileResponse](t, res, http.StatusOK)
			assert.True(t, got.Success)
			assert.Equal(t, tc.target.ID, got.ID)
			assert.Equal(t, tc.target.Username, got.Username)
			assert.Equal(t, tc.target.IsPrivate, got.IsPrivate)
			assert.Equal(t, tc.relationship, got.RelationshipState)
			assert.Equal(t, tc.bio, got.Bio)
			assert.Equal(t, tc.followers, got.FollowersCount)
			if tc.lastLogged == "" {
				assert.Nil(t, got.LastLoggedAt)
			} else if assert.NotNil(t, got.LastLoggedAt) {
				assert.Equal(t, tc.lastLogged, got.LastLoggedAt.Format(constants.DateFormat))
			}
		})
	}
}

func TestProfileHandler_GetUserProfile_RecordsRecentSearch(t *testing.T) {
	env := newEnv(t, withAsync())
	viewer, target := env.user(t), env.user(t)

	res := env.do(t, viewer, http.MethodGet, "/api/users/"+itoa(target.ID)+"/profile", nil)
	require.Equal(t, http.StatusOK, res.Status)

	eventually(t, func() bool {
		return count(t, env.db, &models.RecentSearch{}, "user_id = ? AND searched_user_id = ?", viewer.ID, target.ID) == 1
	}, "recent search recorded")

	// Viewing your own profile or browsing anonymously never records a search.
	require.Equal(t, http.StatusOK, env.do(t, viewer, http.MethodGet, "/api/users/"+itoa(viewer.ID)+"/profile", nil).Status)
	require.Equal(t, http.StatusOK, env.do(t, nil, http.MethodGet, "/api/users/"+itoa(target.ID)+"/profile", nil).Status)
	assert.EqualValues(t, 1, count(t, env.db, &models.RecentSearch{}, ""))
}

func TestProfileHandler_GetUserProfile_RecentSearchFailureIsOnlyLogged(t *testing.T) {
	env := newEnv(t)
	logs := observeLogs(t)
	viewer, target := env.user(t), env.user(t)
	h := &handlerSet{profile: NewProfileHandler(env.profileSvc, env.authSvc, env.followSvc, env.streakSvc, brokenStack(t).searchSvc)}

	res := call(t, h, viewer, http.MethodGet, "/api/users/"+itoa(target.ID)+"/profile", nil)

	require.Equal(t, http.StatusOK, res.Status)
	waitLog(t, logs, "Failed to save recent search")
}

func TestProfileHandler_GetUserProfile_WithoutOptionalServices(t *testing.T) {
	env := newEnv(t)
	viewer := env.user(t)
	target := env.user(t, withBio("visible"))
	testutil.CreateStreak(t, env.db, target.ID, 4, 4, testutil.Day(2026, 3, 9))
	follow(t, env.db, viewer, target)
	h := &handlerSet{profile: NewProfileHandler(env.profileSvc, env.authSvc, nil, nil, nil)}

	got := decodeAs[dto.PublicProfileResponse](t, call(t, h, viewer, http.MethodGet, "/api/users/"+itoa(target.ID)+"/profile", nil), http.StatusOK)

	assert.Equal(t, "NONE", got.RelationshipState)
	assert.Zero(t, got.FollowersCount)
	assert.Equal(t, target.Bio, got.Bio)
	assert.Nil(t, got.LastLoggedAt)
}

type usersResponse struct {
	Success bool          `json:"success"`
	Data    []dto.UserDTO `json:"data"`
}

func TestProfileHandler_SearchUsers(t *testing.T) {
	env := newEnv(t)
	viewer := env.user(t, withUsername("searcher"))
	env.user(t, withUsername("gopher_public"), withBio("pub bio"))
	friend := env.user(t, withUsername("gopher_friend"), private, withBio("friend bio"))
	env.user(t, withUsername("gopher_stranger"), private, withBio("stranger bio"))
	env.user(t, withUsername("unrelated"))
	follow(t, env.db, viewer, friend)

	bios := func(users []dto.UserDTO) map[string]*string {
		out := map[string]*string{}
		for _, u := range users {
			out[u.Username] = u.Bio
		}
		return out
	}
	str := func(s string) *string { return &s }

	t.Run("malformed json", func(t *testing.T) {
		res := env.do(t, viewer, http.MethodPost, "/api/users", `{"username":`)
		assertError(t, res, http.StatusBadRequest, constants.ErrCodeInvalidRequest)
	})

	t.Run("case-insensitive match with bios only where visible", func(t *testing.T) {
		got := decodeAs[usersResponse](t, env.do(t, viewer, http.MethodPost, "/api/users", map[string]string{"username": "GOPHER"}), http.StatusOK)

		assert.True(t, got.Success)
		assert.Equal(t, map[string]*string{
			"gopher_public":   str("pub bio"),
			"gopher_friend":   str("friend bio"),
			"gopher_stranger": nil,
		}, bios(got.Data))
	})

	t.Run("no match", func(t *testing.T) {
		got := decodeAs[usersResponse](t, env.do(t, viewer, http.MethodPost, "/api/users", map[string]string{"username": "zzz"}), http.StatusOK)
		assert.Empty(t, got.Data)
		assert.NotNil(t, got.Data, "an empty list, not null")
	})

	t.Run("anonymous caller never sees private bios", func(t *testing.T) {
		got := decodeAs[usersResponse](t, env.do(t, nil, http.MethodPost, "/api/users", map[string]string{"username": "gopher_friend"}), http.StatusOK)
		assert.Equal(t, map[string]*string{"gopher_friend": nil}, bios(got.Data))
	})

	t.Run("relationship lookup failure hides private bios", func(t *testing.T) {
		h := &handlerSet{profile: NewProfileHandler(env.profileSvc, env.authSvc, brokenStack(t).followSvc, env.streakSvc, nil)}
		got := decodeAs[usersResponse](t, call(t, h, viewer, http.MethodPost, "/api/users", map[string]string{"username": "gopher_friend"}), http.StatusOK)
		assert.Equal(t, map[string]*string{"gopher_friend": nil}, bios(got.Data))
	})
}

func TestProfileHandler_SearchUsers_DoesNotExposeEmails(t *testing.T) {
	env := newEnv(t)
	viewer := env.user(t)
	other := env.user(t)

	res := env.do(t, viewer, http.MethodPost, "/api/users", map[string]string{"username": other.Username})

	require.Equal(t, http.StatusOK, res.Status)
	var got struct {
		Data []map[string]any `json:"data"`
	}
	res.Decode(t, &got)
	require.Len(t, got.Data, 1)
	assert.Equal(t, other.Username, got.Data[0]["username"])
	assert.NotContains(t, got.Data[0], "email")
	assert.NotContains(t, string(res.Body), other.Email)
}

func TestProfileHandler_SearchUsers_BlankQueryReturnsNoUsers(t *testing.T) {
	env := newEnv(t)
	viewer := env.user(t)
	env.user(t)
	// Every query against this stack fails, so a 200 proves the database was not searched.
	broken := brokenStack(t).handlers()

	for _, body := range []any{
		map[string]string{"username": ""},
		map[string]string{"username": "   "},
		map[string]string{"username": "\t\n"},
		map[string]string{},
	} {
		for _, h := range []*handlerSet{env.h, broken} {
			got := decodeAs[usersResponse](t, call(t, h, viewer, http.MethodPost, "/api/users", body), http.StatusOK)
			assert.True(t, got.Success)
			assert.NotNil(t, got.Data, "an empty list, not null")
			assert.Empty(t, got.Data)
		}
	}
}

func TestProfileHandler_SearchUsers_DatabaseFailure(t *testing.T) {
	res := call(t, brokenStack(t).handlers(), ghostUser, http.MethodPost, "/api/users", map[string]string{"username": "a"})
	assertErrorMessage(t, res, http.StatusBadRequest, constants.ErrCodeFetchFailed, "Failed to find users")
}

func TestProfileHandler_AutocompleteUsers(t *testing.T) {
	env := newEnv(t)
	viewer := env.user(t)
	env.user(t, withUsername("gopher"))
	popular := env.user(t, withUsername("gopher_pro"), verified)
	env.user(t, withUsername("gopher_dev"))
	env.user(t, withUsername("rustacean"))
	follow(t, env.db, viewer, popular)

	texts := func(r dto.AutocompleteResponse) []string {
		out := make([]string, 0, len(r.Suggestions))
		for _, s := range r.Suggestions {
			out = append(out, s.Text)
		}
		return out
	}

	t.Run("requires a query", func(t *testing.T) {
		for _, target := range []string{"/api/autocomplete/users", "/api/autocomplete/users?q=%20%20"} {
			res := env.do(t, viewer, http.MethodGet, target, nil)
			assertErrorMessage(t, res, http.StatusBadRequest, constants.ErrCodeMissingFields, "Query parameter 'q' is required")
		}
	})

	t.Run("ranks exact match, then prefix matches by popularity", func(t *testing.T) {
		got := decodeAs[dto.AutocompleteResponse](t, env.do(t, viewer, http.MethodGet, "/api/autocomplete/users?q=Gopher", nil), http.StatusOK)

		assert.Equal(t, "Gopher", got.Query)
		_, err := uuid.Parse(got.RequestID)
		assert.NoError(t, err, "request id is a UUID")
		require.Equal(t, []string{"gopher", "gopher_pro", "gopher_dev"}, texts(got))
		assert.Equal(t, 100.0, got.Suggestions[0].Score)
		assert.Greater(t, got.Suggestions[1].Score, 50.0)
		for _, s := range got.Suggestions {
			assert.Equal(t, "user", s.Kind)
		}
		assert.Equal(t, dto.AutocompleteSuggestionMeta{IsVerified: true, FollowersCount: 1}, got.Suggestions[1].Meta)
	})

	t.Run("limit", func(t *testing.T) {
		for limit, want := range map[string]int{"1": 1, "0": 3, "21": 3, "abc": 3} {
			got := decodeAs[dto.AutocompleteResponse](t, env.do(t, viewer, http.MethodGet, "/api/autocomplete/users?q=gopher&limit="+limit, nil), http.StatusOK)
			assert.Len(t, got.Suggestions, want, "limit=%s", limit)
		}
	})

	t.Run("long queries are truncated to 80 characters", func(t *testing.T) {
		got := decodeAs[dto.AutocompleteResponse](t, env.do(t, viewer, http.MethodGet, "/api/autocomplete/users?q="+strings.Repeat("q", 100), nil), http.StatusOK)
		assert.Equal(t, strings.Repeat("q", 80), got.Query)
		assert.Empty(t, got.Suggestions)
		assert.NotNil(t, got.Suggestions)
	})
}

func TestProfileHandler_AutocompleteUsers_TruncatesMultiByteQueriesByCharacter(t *testing.T) {
	env := newEnv(t)
	viewer := env.user(t)

	tests := []struct{ name, query, want string }{
		// Cutting these at 80 bytes would split a character and PostgreSQL rejects invalid UTF-8.
		{"two-byte characters after a one-byte prefix", "a" + strings.Repeat("é", 100), "a" + strings.Repeat("é", 79)},
		{"three-byte characters", strings.Repeat("€", 100), strings.Repeat("€", 80)},
		// 80 bytes would be only 20 emoji.
		{"emoji", strings.Repeat("🚀", 100), strings.Repeat("🚀", 80)},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			res := env.do(t, viewer, http.MethodGet, "/api/autocomplete/users?q="+url.QueryEscape(tc.query), nil)

			got := decodeAs[dto.AutocompleteResponse](t, res, http.StatusOK)
			assert.Equal(t, tc.want, got.Query)
			assert.Equal(t, 80, utf8.RuneCountInString(got.Query))
			assert.NotNil(t, got.Suggestions)
		})
	}
}

func TestProfileHandler_AutocompleteUsers_Cache(t *testing.T) {
	env := newEnv(t)
	mr := testutil.StartRedis(t)
	viewer := env.user(t)
	cached := env.user(t, withUsername("cachey"))
	key := "autocomplete:users:cachey"

	first := decodeAs[dto.AutocompleteResponse](t, env.do(t, viewer, http.MethodGet, "/api/autocomplete/users?q=Cachey", nil), http.StatusOK)
	require.Len(t, first.Suggestions, 1)
	stored, err := mr.Get(key)
	require.NoError(t, err, "results are cached under the lower-cased query")
	assert.Contains(t, stored, `"requestId":""`, "the request id is not cached")

	require.NoError(t, env.db.Model(cached).Update("username", "renamed").Error)

	t.Run("cache hit", func(t *testing.T) {
		got := decodeAs[dto.AutocompleteResponse](t, env.do(t, viewer, http.MethodGet, "/api/autocomplete/users?q=cachey", nil), http.StatusOK)
		assert.Equal(t, []dto.AutocompleteSuggestion{first.Suggestions[0]}, got.Suggestions)
		assert.NotEmpty(t, got.RequestID)
		assert.NotEqual(t, first.RequestID, got.RequestID, "each response gets a fresh request id")
	})

	t.Run("corrupt cache entry falls back to the database", func(t *testing.T) {
		require.NoError(t, mr.Set(key, "{not json"))
		got := decodeAs[dto.AutocompleteResponse](t, env.do(t, viewer, http.MethodGet, "/api/autocomplete/users?q=cachey", nil), http.StatusOK)
		assert.Empty(t, got.Suggestions)
	})

	t.Run("redis failure falls back to the database", func(t *testing.T) {
		mr.SetError("ERR boom")
		defer mr.SetError("")
		got := decodeAs[dto.AutocompleteResponse](t, env.do(t, viewer, http.MethodGet, "/api/autocomplete/users?q=renamed", nil), http.StatusOK)
		require.Len(t, got.Suggestions, 1)
		assert.Equal(t, "renamed", got.Suggestions[0].Text)
	})
}

func TestProfileHandler_AutocompleteUsers_DatabaseFailure(t *testing.T) {
	res := call(t, brokenStack(t).handlers(), ghostUser, http.MethodGet, "/api/autocomplete/users?q=abc", nil)
	assertErrorMessage(t, res, http.StatusInternalServerError, constants.ErrCodeFetchFailed, "Failed to search users")
}
