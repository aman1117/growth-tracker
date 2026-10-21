package container_test

import (
	"crypto/rand"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"reflect"
	"slices"
	"sync"
	"testing"

	"github.com/aman1117/backend/internal/container"
	"github.com/aman1117/backend/internal/logger"
	"github.com/aman1117/backend/internal/testutil"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
	"go.uber.org/zap/zaptest/observer"
)

// storageDependents are only created when Azure Blob Storage is configured and usable.
var storageDependents = []string{"BlobHandler", "ActivityPhotoService", "ActivityPhotoHandler"}

type blobRequest struct {
	Method  string
	Path    string
	ResType string
}

// fakeBlobStorage is a local Azure Blob endpoint that accepts every request.
type fakeBlobStorage struct {
	server   *httptest.Server
	mu       sync.Mutex
	requests []blobRequest
}

func newFakeBlobStorage(t *testing.T) *fakeBlobStorage {
	t.Helper()
	f := &fakeBlobStorage{}
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.requests = append(f.requests, blobRequest{Method: r.Method, Path: r.URL.Path, ResType: r.URL.Query().Get("restype")})
		f.mu.Unlock()
		w.WriteHeader(http.StatusCreated)
	}))
	t.Cleanup(f.server.Close)
	return f
}

// connectionString points the Azure SDK at the fake endpoint with a random account key.
func (f *fakeBlobStorage) connectionString(t *testing.T) string {
	t.Helper()
	key := make([]byte, 64)
	_, err := rand.Read(key)
	require.NoError(t, err)
	return "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=" +
		base64.StdEncoding.EncodeToString(key) + ";BlobEndpoint=" + f.server.URL + "/devstoreaccount1;"
}

func (f *fakeBlobStorage) received() []blobRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.requests)
}

// assertWired checks that every dependency of the container is set except wantNil, which must
// be nil. Walking the struct keeps the test honest when new dependencies are added.
func assertWired(t *testing.T, c *container.Container, wantNil ...string) {
	t.Helper()
	value := reflect.ValueOf(c).Elem()
	checked := 0
	for i := 0; i < value.NumField(); i++ {
		field := value.Field(i)
		if field.Kind() != reflect.Ptr {
			continue
		}
		checked++
		name := value.Type().Field(i).Name
		if slices.Contains(wantNil, name) {
			assert.True(t, field.IsNil(), "%s should be nil", name)
		} else {
			assert.False(t, field.IsNil(), "%s should be set", name)
		}
	}
	require.Greater(t, checked, len(wantNil))
}

func observeLogs(t *testing.T) *observer.ObservedLogs {
	t.Helper()
	prevLog, prevSugar := logger.Log, logger.Sugar
	t.Cleanup(func() { logger.Log, logger.Sugar = prevLog, prevSugar })
	core, logs := observer.New(zapcore.DebugLevel)
	logger.Log = zap.New(core)
	logger.Sugar = logger.Log.Sugar()
	return logs
}

func TestNew_WithoutBlobStorage(t *testing.T) {
	cfg := testutil.Config()

	c, err := container.New(cfg, testutil.DB(t))

	require.NoError(t, err)
	assert.Same(t, cfg, c.Config)
	assertWired(t, c, storageDependents...)
	assert.False(t, c.BlobService.IsEnabled())
}

func TestNew_WithBlobStorage(t *testing.T) {
	storage := newFakeBlobStorage(t)
	cfg := testutil.Config()
	cfg.AzureStorage.AccountName = "devstoreaccount1"
	cfg.AzureStorage.ConnectionString = storage.connectionString(t)

	c, err := container.New(cfg, testutil.DB(t))

	require.NoError(t, err)
	assertWired(t, c)
	assert.True(t, c.BlobService.IsEnabled())
	assert.True(t, c.BlobHandler.IsEnabled())
	assert.Equal(t, []blobRequest{
		{Method: http.MethodPut, Path: "/devstoreaccount1/profile-pictures", ResType: "container"},
	}, storage.received(), "the profile picture container is created at startup")
}

func TestNew_WithUnusableBlobStorageStillStarts(t *testing.T) {
	cfg := testutil.Config()
	cfg.AzureStorage.ConnectionString = "not-a-connection-string"

	c, err := container.New(cfg, testutil.DB(t))

	require.NoError(t, err)
	assertWired(t, c, storageDependents...)
}

func TestNew_EmailService(t *testing.T) {
	const (
		resendLog = "Email service initialized with Resend API"
		smtpLog   = "Email service initialized with SMTP (Mailpit)"
		apiKey    = "re_test_not_a_real_key"
	)
	db := testutil.DB(t)

	t.Run("uses Resend when an API key is configured", func(t *testing.T) {
		logs := observeLogs(t)
		cfg := testutil.Config()
		cfg.Email.ResendAPIKey = apiKey

		c, err := container.New(cfg, db)

		require.NoError(t, err)
		require.NotNil(t, c.EmailService)
		assert.Len(t, logs.FilterMessage(resendLog).All(), 1)
		assert.Empty(t, logs.FilterMessage(smtpLog).All())
		for _, entry := range logs.All() {
			assert.NotContains(t, entry.Message, apiKey)
			for _, value := range entry.ContextMap() {
				assert.NotEqual(t, apiKey, value, "the API key must not be logged")
			}
		}
	})

	t.Run("falls back to SMTP without an API key", func(t *testing.T) {
		t.Setenv("SMTP_HOST", "")
		t.Setenv("SMTP_PORT", "")
		logs := observeLogs(t)

		c, err := container.New(testutil.Config(), db)

		require.NoError(t, err)
		require.NotNil(t, c.EmailService, "email stays available for local development")
		smtp := logs.FilterMessage(smtpLog).All()
		require.Len(t, smtp, 1)
		assert.Equal(t, map[string]any{"host": "localhost", "port": "1025"}, smtp[0].ContextMap())
		assert.Empty(t, logs.FilterMessage(resendLog).All())
	})
}

func TestNew_ServicesUseTheGivenDatabaseAndSecret(t *testing.T) {
	db := testutil.DB(t)
	user := testutil.CreateUser(t, db)
	cfg := testutil.Config()

	c, err := container.New(cfg, db)
	require.NoError(t, err)

	found, err := c.UserRepo.FindByID(user.ID)
	require.NoError(t, err)
	assert.Equal(t, user.Username, found.Username)

	authenticated, err := c.AuthService.Authenticate(user.Username, testutil.TestPassword)
	require.NoError(t, err)
	assert.Equal(t, user.ID, authenticated.ID)

	token, _, expiresIn, err := c.TokenService.Generate(user)
	require.NoError(t, err)
	assert.Equal(t, int(cfg.JWT.AccessTokenTTL.Seconds()), expiresIn)
	claims, err := c.TokenService.Parse(token)
	require.NoError(t, err)
	assert.Equal(t, user.ID, claims.UserID)
}
