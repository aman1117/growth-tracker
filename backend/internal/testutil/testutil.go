// Package testutil provides shared helpers for the backend test suites: a real PostgreSQL
// database per test package, an in-memory Redis, quiet logging, a test configuration, HTTP
// helpers for Fiber handlers and a few data fixtures.
//
// Import it only from _test.go files. To avoid import cycles it depends only on config,
// logger, database, models and pkg/redis, never on handlers, services or repositories, so
// those packages can use it from their own (internal) tests.
//
// Typical database-backed test package:
//
//	func TestMain(m *testing.M) { os.Exit(testutil.RunWithDatabase(m)) }
//
//	func TestSomething(t *testing.T) {
//		db := testutil.DB(t) // shared schema, truncated when the test ends
//		user := testutil.CreateUser(t, db)
//		...
//	}
package testutil

import (
	"time"

	"github.com/aman1117/backend/internal/config"
	"github.com/aman1117/backend/internal/logger"
	"go.uber.org/zap"
)

// JWTSecret is the signing key in the configuration returned by Config.
const JWTSecret = "test-only-jwt-secret-not-used-anywhere-else"

// Setup prepares process-wide state shared by every test: silent logging, a test
// configuration installed as config.AppConfig and UTC as the local time zone, so results do
// not depend on the machine running the tests (production servers run in UTC).
func Setup() {
	SilenceLogger()
	Config()
	time.Local = time.UTC
}

// SilenceLogger points the global loggers at a no-op logger.
func SilenceLogger() {
	logger.Log = zap.NewNop()
	logger.Sugar = logger.Log.Sugar()
}

// Config returns a fresh development configuration and installs it as config.AppConfig.
// Optional integrations (blob storage, Service Bus, email, Web Push keys, Redis) are left
// unset; tests that need them set the fields on the returned value.
func Config() *config.Config {
	cfg := &config.Config{
		Env: "development",
		Server: config.ServerConfig{
			Port:         "0",
			FrontendURL:  "http://localhost:5173",
			ReadTimeout:  30 * time.Second,
			WriteTimeout: 30 * time.Second,
		},
		JWT: config.JWTConfig{
			SecretKey:       JWTSecret,
			AccessTokenTTL:  24 * time.Hour,
			RefreshTokenTTL: 7 * 24 * time.Hour,
		},
		AzureStorage: config.AzureStorageConfig{
			ContainerName: "profile-pictures",
		},
		AzureServiceBus: config.AzureServiceBusConfig{
			QueueName: "push-notifications",
		},
		WebPush: config.WebPushConfig{
			VapidSubject: "mailto:test@example.com",
			VapidKeyID:   "test",
		},
		PushWorker: config.PushWorkerConfig{
			SendRateLimit:       100,
			MaxConcurrent:       10,
			DedupeWindowSeconds: 60,
		},
		Follow: config.FollowConfig{
			MaxFollowsPerMinute:    60,
			MaxFollowsPerDay:       5000,
			MaxTotalFollowing:      7500,
			TombstoneRetentionDays: 7,
		},
		Email: config.EmailConfig{
			FromAddress: "noreply@example.com",
			FromName:    "Growth Tracker",
		},
		Pprof: config.PprofConfig{
			Prefix: "/debug/pprof",
		},
	}
	config.AppConfig = cfg
	return cfg
}
