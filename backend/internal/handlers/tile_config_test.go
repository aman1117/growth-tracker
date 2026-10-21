package handlers

import (
	"net/http"
	"strings"
	"testing"

	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/testutil"
	"github.com/aman1117/backend/pkg/models"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func tileConfigBody(config map[string]any) map[string]any { return map[string]any{"config": config} }

func customTile(id, name string) map[string]any {
	return map[string]any{"id": id, "name": name, "icon": "Guitar", "color": "#123abc"}
}

func photoLabel(t *testing.T, env *testEnv, photo *models.ActivityPhoto) *string {
	t.Helper()
	var p models.ActivityPhoto
	require.NoError(t, env.db.First(&p, photo.ID).Error)
	return p.ActivityLabel
}

func TestTileConfigHandler_SaveConfig_Validation(t *testing.T) {
	env := newEnv(t)
	user := env.user(t)
	id := uuid.NewString()
	sixTiles := make([]any, 6)
	for i := range sixTiles {
		sixTiles[i] = customTile(uuid.NewString(), "Tile")
	}
	badTile := func(mutate func(map[string]any)) map[string]any {
		tile := customTile(id, "Tile")
		mutate(tile)
		return tileConfigBody(map[string]any{"customTiles": []any{tile}})
	}

	tests := []struct {
		name    string
		body    any
		code    string
		message string
	}{
		{"malformed json", `{"config":`, constants.ErrCodeInvalidRequest, "Invalid request body"},
		{"config is not an object", `{"config":[1,2]}`, constants.ErrCodeInvalidRequest, "Invalid request body"},
		{"fields of the wrong type", tileConfigBody(map[string]any{"order": "study"}), constants.ErrCodeInvalidTileConfig, "Invalid configuration format"},
		{"more than five custom tiles", tileConfigBody(map[string]any{"customTiles": sixTiles}), constants.ErrCodeTileLimitExceeded, "Maximum of 5 custom tiles allowed"},
		{"custom tile without an id", badTile(func(m map[string]any) { m["id"] = "" }), constants.ErrCodeInvalidTileConfig, "custom tile ID is required"},
		{"custom tile id is not a uuid", badTile(func(m map[string]any) { m["id"] = "tile-1" }), constants.ErrCodeInvalidTileConfig, "custom tile ID must be a valid UUID"},
		{"custom tile name too long", badTile(func(m map[string]any) { m["name"] = strings.Repeat("n", 21) }), constants.ErrCodeInvalidTileConfig, "custom tile name cannot exceed 20 characters"},
		{"custom tile color", badTile(func(m map[string]any) { m["color"] = "blue" }), constants.ErrCodeInvalidTileConfig, "custom tile color must be a valid hex color"},
		{"duplicate custom tile ids", tileConfigBody(map[string]any{"customTiles": []any{customTile(id, "A"), customTile(id, "B")}}), constants.ErrCodeInvalidTileConfig, "Duplicate custom tile ID found"},
		{"invalid color override", tileConfigBody(map[string]any{"colors": map[string]any{"study": "red"}}), constants.ErrCodeInvalidColor, "Invalid color format: red"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			res := env.do(t, user, http.MethodPost, "/api/tile-config", tc.body)
			assertErrorMessage(t, res, http.StatusBadRequest, tc.code, tc.message)
		})
	}
	assert.Zero(t, count(t, env.db, &models.TileConfig{}, ""), "nothing was stored")
}

func TestTileConfigHandler_SaveAndGetConfig(t *testing.T) {
	env := newEnv(t)
	user := env.user(t)
	id := uuid.NewString()
	photo := createPhoto(t, env.db, user.ID, models.CustomTilePrefix+id, testutil.Day(2026, 3, 9))
	require.NoError(t, env.db.Model(photo).Update("activity_label", "Guitar").Error)

	t.Run("no configuration yet", func(t *testing.T) {
		res := env.do(t, user, http.MethodGet, "/api/tile-config", nil)
		require.Equal(t, http.StatusOK, res.Status)
		assert.Equal(t, map[string]any{"success": true, "data": nil}, res.JSON(t))
	})

	config := map[string]any{
		"order":       []any{"study", "sleep"},
		"sizes":       map[string]any{"study": "large"},
		"hidden":      []any{"reels"},
		"colors":      map[string]any{"study": "#ff0000"},
		"customTiles": []any{customTile(id, "Guitar")},
	}
	assertSuccessMessage(t, env.do(t, user, http.MethodPost, "/api/tile-config", tileConfigBody(config)), http.StatusOK, constants.MsgTileConfigSaved)

	res := env.do(t, user, http.MethodGet, "/api/tile-config", nil)
	require.Equal(t, http.StatusOK, res.Status)
	assert.Equal(t, map[string]any{"success": true, "data": config}, res.JSON(t))
	assert.Equal(t, "Guitar", *photoLabel(t, env, photo), "unchanged names leave photos alone")

	t.Run("renaming a custom tile relabels its photos", func(t *testing.T) {
		renamed := tileConfigBody(map[string]any{"customTiles": []any{customTile(id, "Piano")}})
		assertSuccessMessage(t, env.do(t, user, http.MethodPost, "/api/tile-config", renamed), http.StatusOK, constants.MsgTileConfigSaved)
		assert.Equal(t, "Piano", *photoLabel(t, env, photo))
	})

	t.Run("saving again replaces the configuration", func(t *testing.T) {
		replacement := map[string]any{"order": []any{"sleep"}}
		assertSuccessMessage(t, env.do(t, user, http.MethodPost, "/api/tile-config", tileConfigBody(replacement)), http.StatusOK, constants.MsgTileConfigSaved)

		res := env.do(t, user, http.MethodGet, "/api/tile-config", nil)
		assert.Equal(t, map[string]any{"success": true, "data": replacement}, res.JSON(t))
		assert.EqualValues(t, 1, count(t, env.db, &models.TileConfig{}, "user_id = ?", user.ID))
	})
}

func TestTileConfigHandler_SaveConfig_Failures(t *testing.T) {
	env := newEnv(t)
	user := env.user(t)

	t.Run("database failure", func(t *testing.T) {
		res := call(t, brokenStack(t).handlers(), user, http.MethodPost, "/api/tile-config", tileConfigBody(map[string]any{"order": []any{"study"}}))
		assertErrorMessage(t, res, http.StatusInternalServerError, constants.ErrCodeSaveFailed, "Failed to save tile configuration")
	})

	t.Run("unknown user", func(t *testing.T) {
		res := env.do(t, ghostUser, http.MethodPost, "/api/tile-config", tileConfigBody(map[string]any{"order": []any{"study"}}))
		assertError(t, res, http.StatusInternalServerError, constants.ErrCodeSaveFailed)
	})

	t.Run("relabelling photos fails", func(t *testing.T) {
		id := uuid.NewString()
		original := map[string]any{"customTiles": []any{customTile(id, "Guitar")}}
		require.NoError(t, env.db.Create(&models.TileConfig{UserID: user.ID, Config: original}).Error)
		faulty := newStack(faultyDB(t, failOn("update", "activity_photos")), env.cfg, false)
		h := &handlerSet{tileConfig: NewTileConfigHandler(faulty.tileConfigSvc, faulty.authSvc, faulty.profileSvc)}

		res := call(t, h, user, http.MethodPost, "/api/tile-config", tileConfigBody(map[string]any{"customTiles": []any{customTile(id, "Piano")}}))

		assertError(t, res, http.StatusInternalServerError, constants.ErrCodeSaveFailed)
		got := env.do(t, user, http.MethodGet, "/api/tile-config", nil)
		assert.Equal(t, map[string]any{"success": true, "data": original}, got.JSON(t), "the configuration is not saved")
	})
}

func TestTileConfigHandler_GetConfig_DatabaseFailure(t *testing.T) {
	res := call(t, brokenStack(t).handlers(), ghostUser, http.MethodGet, "/api/tile-config", nil)
	// not {"data": null}: the app would take the default tiles for the user's saved ones
	assertErrorMessage(t, res, http.StatusInternalServerError, constants.ErrCodeFetchFailed, "Failed to get tile configuration")
}

func TestTileConfigHandler_GetConfigByUsername(t *testing.T) {
	env := newEnv(t)
	viewer := env.user(t)
	owner := env.user(t)
	hidden := env.user(t, private)
	fan := env.user(t)
	follow(t, env.db, fan, hidden)
	config := map[string]any{"order": []any{"study"}}
	require.NoError(t, env.db.Create(&models.TileConfig{UserID: owner.ID, Config: config}).Error)
	require.NoError(t, env.db.Create(&models.TileConfig{UserID: hidden.ID, Config: config}).Error)

	tests := []struct {
		name    string
		body    any
		status  int
		code    string
		message string
	}{
		{"malformed json", `{"username":`, http.StatusBadRequest, constants.ErrCodeInvalidRequest, "Invalid request body"},
		{"missing username", map[string]string{"username": ""}, http.StatusBadRequest, constants.ErrCodeMissingFields, "Username is required"},
		{"unknown user", map[string]string{"username": "nobody"}, http.StatusNotFound, constants.ErrCodeUserNotFound, "User not found"},
		{"private account", map[string]string{"username": hidden.Username}, http.StatusForbidden, constants.ErrCodeAccountPrivate, "This account is private"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			assertErrorMessage(t, env.do(t, viewer, http.MethodPost, "/api/tile-config/user", tc.body), tc.status, tc.code, tc.message)
		})
	}

	cases := []struct {
		name   string
		caller *models.User
		target *models.User
		want   any
	}{
		{"public account", viewer, owner, config},
		{"public account, anonymous caller", nil, owner, config},
		{"private account followed by the caller", fan, hidden, config},
		{"account without a configuration", owner, viewer, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res := env.do(t, tc.caller, http.MethodPost, "/api/tile-config/user", map[string]string{"username": tc.target.Username})
			require.Equal(t, http.StatusOK, res.Status)
			assert.Equal(t, map[string]any{"success": true, "data": tc.want}, res.JSON(t))
		})
	}
}

func TestTileConfigHandler_GetConfigByUsername_DatabaseFailure(t *testing.T) {
	env := newEnv(t)
	owner := env.user(t)

	t.Run("user lookup", func(t *testing.T) {
		res := call(t, brokenStack(t).handlers(), owner, http.MethodPost, "/api/tile-config/user", map[string]string{"username": owner.Username})
		assertErrorMessage(t, res, http.StatusNotFound, constants.ErrCodeUserNotFound, "User not found")
	})

	t.Run("config lookup", func(t *testing.T) {
		h := &handlerSet{tileConfig: NewTileConfigHandler(brokenStack(t).tileConfigSvc, env.authSvc, env.profileSvc)}
		res := call(t, h, owner, http.MethodPost, "/api/tile-config/user", map[string]string{"username": owner.Username})
		assertErrorMessage(t, res, http.StatusInternalServerError, constants.ErrCodeFetchFailed, "Failed to get tile configuration")
	})
}
