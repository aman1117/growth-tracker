package routes_test

import (
	"crypto/rand"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/aman1117/backend/internal/config"
	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/container"
	"github.com/aman1117/backend/internal/handlers"
	"github.com/aman1117/backend/internal/testutil"
	"github.com/aman1117/backend/pkg/models"
	"github.com/gofiber/fiber/v2"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

// storageRoutes are registered only when Azure Blob Storage is configured.
var storageRoutes = []string{
	"POST /api/profile/upload-picture",
	"DELETE /api/profile/picture",
	"POST /api/activity-photo",
	"DELETE /api/activity-photo/:id",
	"GET /api/activity-photos",
	"GET /api/activity-photos/following",
	"POST /api/activity-photo/:id/view",
	"GET /api/activity-photo/:id/viewers",
	"POST /api/activity-photo/:id/like",
	"DELETE /api/activity-photo/:id/like",
	"GET /api/activity-photo/:id/like-status",
	"GET /api/activity-photo/:id/interactions",
}

// coreRoutes is a sample of the routes that are always registered.
var coreRoutes = []string{
	"GET /",
	"GET /swagger/*",
	"POST /api/register",
	"POST /api/login",
	"GET /api/get-privacy",
	"GET /api/profile",
	"GET /api/notifications/unread-count",
	"GET /api/push/vapid-public-key",
	"POST /api/users/:targetId/follow",
	"GET /api/ws/notifications",
	"POST /api/days/:username/:date/comments",
}

// newApp wires the whole application (container and routes) on db.
func newApp(t *testing.T, cfg *config.Config, db *gorm.DB) *fiber.App {
	t.Helper()
	c, err := container.New(cfg, db)
	require.NoError(t, err)
	app := fiber.New()
	c.Router.Setup(app)
	return app
}

func registeredRoutes(app *fiber.App) map[string]bool {
	routes := map[string]bool{}
	for _, route := range app.GetRoutes(true) {
		routes[route.Method+" "+route.Path] = true
	}
	return routes
}

// tokenFor signs an access token for user with the configuration's JWT secret.
func tokenFor(t *testing.T, cfg *config.Config, user *models.User) string {
	t.Helper()
	token, _, _, err := handlers.NewTokenService(&cfg.JWT).Generate(user)
	require.NoError(t, err)
	return token
}

// fakeStorageConnectionString starts a local Azure Blob endpoint that accepts every request
// and returns a connection string for it with a random account key.
func fakeStorageConnectionString(t *testing.T) string {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusCreated)
	}))
	t.Cleanup(server.Close)
	key := make([]byte, 64)
	_, err := rand.Read(key)
	require.NoError(t, err)
	return "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=" +
		base64.StdEncoding.EncodeToString(key) + ";BlobEndpoint=" + server.URL + "/devstoreaccount1;"
}

func errorBody(message, code string) map[string]any {
	return map[string]any{"success": false, "error": message, "error_code": code}
}

func TestSetup_HealthCheck(t *testing.T) {
	app := newApp(t, testutil.Config(), testutil.DB(t))

	res := testutil.Do(t, app, fiber.MethodGet, "/", nil)

	assert.Equal(t, fiber.StatusOK, res.Status)
	assert.Equal(t, "API is running...", string(res.Body))
}

func TestSetup_SwaggerDocs(t *testing.T) {
	app := newApp(t, testutil.Config(), testutil.DB(t))

	res := testutil.Do(t, app, fiber.MethodGet, "/swagger/doc.json", nil)

	assert.Equal(t, fiber.StatusOK, res.Status)
	assert.Contains(t, string(res.Body), "Growth Tracker API")
}

func TestSetup_RegistersTheCoreRoutes(t *testing.T) {
	routes := registeredRoutes(newApp(t, testutil.Config(), testutil.DB(t)))

	for _, route := range coreRoutes {
		assert.True(t, routes[route], "%s is not registered", route)
	}
}

func TestSetup_LoginThenUseProtectedRoutes(t *testing.T) {
	db := testutil.DB(t)
	user := testutil.CreateUser(t, db, func(u *models.User) { u.IsPrivate = true })
	app := newApp(t, testutil.Config(), db)

	login := testutil.Do(t, app, fiber.MethodPost, "/api/login",
		map[string]string{"identifier": user.Username, "password": testutil.TestPassword})
	require.Equal(t, fiber.StatusOK, login.Status, string(login.Body))
	var session struct {
		AccessToken string `json:"access_token"`
		TokenType   string `json:"token_type"`
	}
	login.Decode(t, &session)
	require.NotEmpty(t, session.AccessToken)
	assert.Equal(t, "Bearer", session.TokenType)

	tests := []struct {
		name     string
		target   string
		wantBody map[string]any
	}{
		{name: "route with its own middleware", target: "/api/get-privacy", wantBody: map[string]any{"success": true, "is_private": true}},
		{name: "route in a protected group", target: "/api/notifications/unread-count", wantBody: map[string]any{"success": true, "unread_count": float64(0)}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			missing := testutil.Do(t, app, fiber.MethodGet, tt.target, nil)
			assert.Equal(t, fiber.StatusUnauthorized, missing.Status)
			assert.Equal(t, errorBody("Missing Authorization Header", constants.ErrCodeMissingAuthHeader), missing.JSON(t))

			invalid := testutil.Do(t, app, fiber.MethodGet, tt.target, nil, testutil.WithToken("not-a-valid-token"))
			assert.Equal(t, fiber.StatusUnauthorized, invalid.Status)
			assert.Equal(t, errorBody("Invalid token", constants.ErrCodeInvalidToken), invalid.JSON(t))

			ok := testutil.Do(t, app, fiber.MethodGet, tt.target, nil, testutil.WithToken(session.AccessToken))
			assert.Equal(t, fiber.StatusOK, ok.Status)
			assert.Equal(t, tt.wantBody, ok.JSON(t))
		})
	}
}

func TestSetup_PublicVapidKey(t *testing.T) {
	cfg := testutil.Config()
	cfg.WebPush.VapidPublicKey = "test-vapid-public-key"
	app := newApp(t, cfg, testutil.DB(t))

	res := testutil.Do(t, app, fiber.MethodGet, "/api/push/vapid-public-key", nil)

	assert.Equal(t, fiber.StatusOK, res.Status)
	assert.Equal(t, map[string]any{"success": true, "keyId": "test", "publicKey": "test-vapid-public-key"}, res.JSON(t))
}

func TestSetup_LoginIsRateLimited(t *testing.T) {
	app := newApp(t, testutil.Config(), testutil.DB(t))

	for i := 1; i <= constants.RateLimitAuthMaxRequests; i++ {
		res := testutil.Do(t, app, fiber.MethodPost, "/api/login", map[string]string{})
		require.Equal(t, fiber.StatusBadRequest, res.Status, "attempt %d", i)
	}
	res := testutil.Do(t, app, fiber.MethodPost, "/api/login", map[string]string{})

	assert.Equal(t, fiber.StatusTooManyRequests, res.Status)
	assert.Equal(t, errorBody(constants.MsgRateLimitAuth, constants.ErrCodeRateLimitExceeded), res.JSON(t))
}

func TestSetup_PushCleanupNeedsAuthAndTheMaintenanceKeyAndIsRateLimited(t *testing.T) {
	db := testutil.DB(t)
	user := testutil.CreateUser(t, db)
	cfg := testutil.Config()
	cfg.MaintenanceAPIKey = "test-maintenance-key"
	app := newApp(t, cfg, db)
	token := testutil.WithToken(tokenFor(t, cfg, user))
	key := testutil.WithHeader(handlers.MaintenanceKeyHeader, cfg.MaintenanceAPIKey)

	res := testutil.Do(t, app, fiber.MethodPost, "/api/push/cleanup", nil, key)
	assert.Equal(t, fiber.StatusUnauthorized, res.Status, "the key does not replace authentication")

	res = testutil.Do(t, app, fiber.MethodPost, "/api/push/cleanup", nil, token)
	assert.Equal(t, fiber.StatusForbidden, res.Status)
	assert.Equal(t, errorBody("Invalid maintenance key", constants.ErrCodeNotAuthorized), res.JSON(t))

	res = testutil.Do(t, app, fiber.MethodPost, "/api/push/cleanup", nil, token, key)
	require.Equal(t, fiber.StatusOK, res.Status, string(res.Body))

	// The route shares the per-user API rate limit, so rejected attempts count as well.
	for i := 3; i <= constants.RateLimitAPIMaxRequests; i++ {
		res := testutil.Do(t, app, fiber.MethodPost, "/api/push/cleanup", nil, token)
		require.Equal(t, fiber.StatusForbidden, res.Status, "request %d", i)
	}
	res = testutil.Do(t, app, fiber.MethodPost, "/api/push/cleanup", nil, token, key)
	assert.Equal(t, fiber.StatusTooManyRequests, res.Status)
	assert.Equal(t, errorBody(constants.MsgRateLimitAPI, constants.ErrCodeRateLimitExceeded), res.JSON(t))
}

func TestSetup_WebSocketRequiresAnUpgrade(t *testing.T) {
	app := newApp(t, testutil.Config(), testutil.DB(t))

	res := testutil.Do(t, app, fiber.MethodGet, "/api/ws/notifications", nil)

	assert.Equal(t, fiber.StatusUpgradeRequired, res.Status)
}

func TestSetup_StorageRoutesDependOnBlobStorage(t *testing.T) {
	db := testutil.DB(t)
	user := testutil.CreateUser(t, db)
	token := tokenFor(t, testutil.Config(), user)

	t.Run("not registered without blob storage", func(t *testing.T) {
		app := newApp(t, testutil.Config(), db)

		routes := registeredRoutes(app)
		for _, route := range storageRoutes {
			assert.False(t, routes[route], "%s should not be registered", route)
		}
		for _, target := range []string{"/api/activity-photo", "/api/profile/upload-picture"} {
			res := testutil.Do(t, app, fiber.MethodPost, target, nil, testutil.WithToken(token))
			assert.Equal(t, fiber.StatusNotFound, res.Status, target)
		}
	})

	t.Run("registered with blob storage", func(t *testing.T) {
		cfg := testutil.Config()
		cfg.AzureStorage.AccountName = "devstoreaccount1"
		cfg.AzureStorage.ConnectionString = fakeStorageConnectionString(t)
		app := newApp(t, cfg, db)

		routes := registeredRoutes(app)
		for _, route := range storageRoutes {
			assert.True(t, routes[route], "%s is not registered", route)
		}

		unauthenticated := testutil.Do(t, app, fiber.MethodPost, "/api/activity-photo", nil)
		assert.Equal(t, fiber.StatusUnauthorized, unauthenticated.Status)

		photo := testutil.Do(t, app, fiber.MethodPost, "/api/activity-photo", nil, testutil.WithToken(token))
		assert.Equal(t, fiber.StatusBadRequest, photo.Status)
		assert.Equal(t, errorBody("activity_name and photo_date are required", constants.ErrCodeMissingFields), photo.JSON(t))

		picture := testutil.Do(t, app, fiber.MethodPost, "/api/profile/upload-picture", nil, testutil.WithToken(token))
		assert.Equal(t, fiber.StatusBadRequest, picture.Status)
		assert.Equal(t, errorBody("No image file provided", constants.ErrCodeInvalidRequest), picture.JSON(t))
	})
}
