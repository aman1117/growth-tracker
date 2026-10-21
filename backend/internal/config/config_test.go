package config

import (
	"io"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// loadEnvKeys lists every environment variable Load reads.
var loadEnvKeys = []string{
	"ENV", "PORT", "FRONTEND_BASE_URL", "SERVER_READ_TIMEOUT", "SERVER_WRITE_TIMEOUT",
	"DATABASE_URL", "DB_HOST", "DB_PORT", "DB_NAME", "DB_USERNAME", "DB_PASSWORD", "DB_SSLMODE",
	"DB_MAX_IDLE_CONNS", "DB_MAX_OPEN_CONNS", "DB_CONN_MAX_LIFETIME", "DB_CONN_MAX_IDLE_TIME",
	"REDIS_URL",
	"JWT_SECRET_KEY", "TTL_ACCESS_TOKEN", "TTL_REFRESH_TOKEN",
	"AZURE_STORAGE_ACCOUNT_NAME", "AZURE_STORAGE_CONNECTION_STRING", "AZURE_STORAGE_CONTAINER",
	"AZURE_SERVICEBUS_CONNECTION_STRING", "AZURE_SERVICEBUS_QUEUE_NAME",
	"VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT", "VAPID_KEY_ID",
	"PUSH_SEND_RATE_LIMIT", "PUSH_MAX_CONCURRENT", "PUSH_DEDUPE_WINDOW_SECONDS",
	"FOLLOW_MAX_PER_MINUTE", "FOLLOW_MAX_PER_DAY", "FOLLOW_MAX_TOTAL", "FOLLOW_TOMBSTONE_RETENTION_DAYS",
	"RESEND_API_KEY", "EMAIL_FROM_ADDRESS", "EMAIL_FROM_NAME",
	"AXIOM_DATASET", "AXIOM_API_TOKEN",
	"PPROF_ENABLED", "PPROF_PREFIX", "PPROF_TOKEN",
	"MAINTENANCE_API_KEY",
}

// setEnv gives Load a hermetic environment: every variable it reads is set to the empty string
// (which Load treats as unset) unless vars overrides it. t.Setenv restores the originals.
func setEnv(t *testing.T, vars map[string]string) {
	t.Helper()
	for key := range vars {
		require.Contains(t, loadEnvKeys, key, "Load does not read %s", key)
	}
	for _, key := range loadEnvKeys {
		t.Setenv(key, vars[key])
	}
}

// load calls Load, checks it installed the result as AppConfig and restores AppConfig afterwards.
func load(t *testing.T) *Config {
	t.Helper()
	previous := AppConfig
	t.Cleanup(func() { AppConfig = previous })

	cfg, err := Load()
	require.NoError(t, err)
	require.NotNil(t, cfg)
	assert.Same(t, cfg, AppConfig)
	return cfg
}

// captureStdout returns what fn prints to standard output.
func captureStdout(t *testing.T, fn func()) string {
	t.Helper()
	r, w, err := os.Pipe()
	require.NoError(t, err)
	original := os.Stdout
	os.Stdout = w

	output := make(chan string, 1)
	go func() {
		data, _ := io.ReadAll(r)
		output <- string(data)
	}()

	func() {
		defer func() {
			os.Stdout = original
			_ = w.Close()
		}()
		fn()
	}()

	out := <-output
	require.NoError(t, r.Close())
	return out
}

func defaultConfig() Config {
	return Config{
		Env: "development",
		Server: ServerConfig{
			Port:         "8000",
			FrontendURL:  "http://localhost:5173",
			ReadTimeout:  30 * time.Second,
			WriteTimeout: 30 * time.Second,
		},
		Database: DatabaseConfig{
			Port:            "5432",
			SSLMode:         "require",
			MaxIdleConns:    10,
			MaxOpenConns:    100,
			ConnMaxLifetime: time.Hour,
			ConnMaxIdleTime: 10 * time.Minute,
		},
		JWT: JWTConfig{
			AccessTokenTTL:  24 * time.Hour,
			RefreshTokenTTL: 7 * 24 * time.Hour,
		},
		AzureStorage:    AzureStorageConfig{ContainerName: "profile-pictures"},
		AzureServiceBus: AzureServiceBusConfig{QueueName: "push-notifications"},
		WebPush: WebPushConfig{
			VapidSubject: "mailto:aman@amancodes.dev",
			VapidKeyID:   "default",
		},
		PushWorker: PushWorkerConfig{
			SendRateLimit:       100,
			MaxConcurrent:       10,
			DedupeWindowSeconds: 60,
		},
		Follow: FollowConfig{
			MaxFollowsPerMinute:    60,
			MaxFollowsPerDay:       5000,
			MaxTotalFollowing:      7500,
			TombstoneRetentionDays: 7,
		},
		Email: EmailConfig{
			FromAddress: "noreply@example.com",
			FromName:    "Growth Tracker",
		},
		Pprof: PprofConfig{
			Enabled: true,
			Prefix:  "/debug/pprof",
		},
	}
}

func TestLoad_Defaults(t *testing.T) {
	setEnv(t, nil)

	var cfg *Config
	out := captureStdout(t, func() { cfg = load(t) })

	assert.Equal(t, defaultConfig(), *cfg)
	assert.Contains(t, out, "Warning: Required environment variable JWT_SECRET_KEY is not set")
	assert.True(t, cfg.IsDevelopment())
	assert.False(t, cfg.IsProduction())
}

func TestLoad_ReadsEveryVariable(t *testing.T) {
	setEnv(t, map[string]string{
		"ENV":                                "production",
		"PORT":                               "9090",
		"FRONTEND_BASE_URL":                  "https://growth.example.com",
		"SERVER_READ_TIMEOUT":                "5s",
		"SERVER_WRITE_TIMEOUT":               "1m30s",
		"DATABASE_URL":                       "postgresql://app@db.example.com:5432/growth",
		"DB_HOST":                            "db.internal",
		"DB_PORT":                            "6543",
		"DB_NAME":                            "growth",
		"DB_USERNAME":                        "app",
		"DB_PASSWORD":                        "test-password",
		"DB_SSLMODE":                         "disable",
		"DB_MAX_IDLE_CONNS":                  "5",
		"DB_MAX_OPEN_CONNS":                  "50",
		"DB_CONN_MAX_LIFETIME":               "30m",
		"DB_CONN_MAX_IDLE_TIME":              "90s",
		"REDIS_URL":                          "redis://localhost:6379/1",
		"JWT_SECRET_KEY":                     "test-jwt-secret",
		"TTL_ACCESS_TOKEN":                   "15",
		"TTL_REFRESH_TOKEN":                  "1440",
		"AZURE_STORAGE_ACCOUNT_NAME":         "growthstore",
		"AZURE_STORAGE_CONNECTION_STRING":    "test-storage-connection-string",
		"AZURE_STORAGE_CONTAINER":            "avatars",
		"AZURE_SERVICEBUS_CONNECTION_STRING": "test-servicebus-connection-string",
		"AZURE_SERVICEBUS_QUEUE_NAME":        "push-test",
		"VAPID_PUBLIC_KEY":                   "test-vapid-public",
		"VAPID_PRIVATE_KEY":                  "test-vapid-private",
		"VAPID_SUBJECT":                      "mailto:ops@example.com",
		"VAPID_KEY_ID":                       "prod-2026-01",
		"PUSH_SEND_RATE_LIMIT":               "250",
		"PUSH_MAX_CONCURRENT":                "4",
		"PUSH_DEDUPE_WINDOW_SECONDS":         "120",
		"FOLLOW_MAX_PER_MINUTE":              "30",
		"FOLLOW_MAX_PER_DAY":                 "1000",
		"FOLLOW_MAX_TOTAL":                   "2000",
		"FOLLOW_TOMBSTONE_RETENTION_DAYS":    "14",
		"RESEND_API_KEY":                     "test-resend-key",
		"EMAIL_FROM_ADDRESS":                 "hello@example.com",
		"EMAIL_FROM_NAME":                    "Growth Tracker Test",
		"AXIOM_DATASET":                      "growth-logs",
		"AXIOM_API_TOKEN":                    "test-axiom-token",
		"PPROF_ENABLED":                      "false",
		"PPROF_PREFIX":                       "/ops",
		"PPROF_TOKEN":                        "test-pprof-token",
		"MAINTENANCE_API_KEY":                "test-maintenance-key",
	})

	var cfg *Config
	out := captureStdout(t, func() { cfg = load(t) })

	assert.Empty(t, out, "no warning when the JWT secret is set")
	assert.Equal(t, Config{
		Env: "production",
		Server: ServerConfig{
			Port:         "9090",
			FrontendURL:  "https://growth.example.com",
			ReadTimeout:  5 * time.Second,
			WriteTimeout: 90 * time.Second,
		},
		Database: DatabaseConfig{
			URL:             "postgresql://app@db.example.com:5432/growth",
			Host:            "db.internal",
			Port:            "6543",
			Name:            "growth",
			Username:        "app",
			Password:        "test-password",
			SSLMode:         "disable",
			MaxIdleConns:    5,
			MaxOpenConns:    50,
			ConnMaxLifetime: 30 * time.Minute,
			ConnMaxIdleTime: 90 * time.Second,
		},
		Redis: RedisConfig{URL: "redis://localhost:6379/1"},
		JWT: JWTConfig{
			SecretKey:       "test-jwt-secret",
			AccessTokenTTL:  15 * time.Minute,
			RefreshTokenTTL: 24 * time.Hour,
		},
		AzureStorage: AzureStorageConfig{
			AccountName:      "growthstore",
			ConnectionString: "test-storage-connection-string",
			ContainerName:    "avatars",
		},
		AzureServiceBus: AzureServiceBusConfig{
			ConnectionString: "test-servicebus-connection-string",
			QueueName:        "push-test",
		},
		WebPush: WebPushConfig{
			VapidPublicKey:  "test-vapid-public",
			VapidPrivateKey: "test-vapid-private",
			VapidSubject:    "mailto:ops@example.com",
			VapidKeyID:      "prod-2026-01",
		},
		PushWorker: PushWorkerConfig{SendRateLimit: 250, MaxConcurrent: 4, DedupeWindowSeconds: 120},
		Follow: FollowConfig{
			MaxFollowsPerMinute:    30,
			MaxFollowsPerDay:       1000,
			MaxTotalFollowing:      2000,
			TombstoneRetentionDays: 14,
		},
		Email: EmailConfig{
			ResendAPIKey: "test-resend-key",
			FromAddress:  "hello@example.com",
			FromName:     "Growth Tracker Test",
		},
		Axiom:             AxiomConfig{Dataset: "growth-logs", APIToken: "test-axiom-token"},
		Pprof:             PprofConfig{Enabled: false, Prefix: "/ops", Token: "test-pprof-token"},
		MaintenanceAPIKey: "test-maintenance-key",
	}, *cfg)
	assert.True(t, cfg.IsProduction())
	assert.False(t, cfg.IsDevelopment())
}

func TestLoad_InvalidValuesFallBackToDefaults(t *testing.T) {
	defaults := defaultConfig()
	tests := []struct {
		key   string
		value string
		got   func(*Config) any
		want  any
	}{
		{key: "DB_MAX_IDLE_CONNS", value: "ten", got: func(c *Config) any { return c.Database.MaxIdleConns }, want: defaults.Database.MaxIdleConns},
		{key: "DB_MAX_OPEN_CONNS", value: "1.5", got: func(c *Config) any { return c.Database.MaxOpenConns }, want: defaults.Database.MaxOpenConns},
		{key: "PUSH_SEND_RATE_LIMIT", value: "fast", got: func(c *Config) any { return c.PushWorker.SendRateLimit }, want: defaults.PushWorker.SendRateLimit},
		{key: "FOLLOW_MAX_PER_DAY", value: "5k", got: func(c *Config) any { return c.Follow.MaxFollowsPerDay }, want: defaults.Follow.MaxFollowsPerDay},
		{key: "SERVER_READ_TIMEOUT", value: "30", got: func(c *Config) any { return c.Server.ReadTimeout }, want: defaults.Server.ReadTimeout},
		{key: "SERVER_WRITE_TIMEOUT", value: "soon", got: func(c *Config) any { return c.Server.WriteTimeout }, want: defaults.Server.WriteTimeout},
		{key: "DB_CONN_MAX_LIFETIME", value: "1 hour", got: func(c *Config) any { return c.Database.ConnMaxLifetime }, want: defaults.Database.ConnMaxLifetime},
		{key: "DB_CONN_MAX_IDLE_TIME", value: "10min", got: func(c *Config) any { return c.Database.ConnMaxIdleTime }, want: defaults.Database.ConnMaxIdleTime},
		{key: "TTL_ACCESS_TOKEN", value: "1h", got: func(c *Config) any { return c.JWT.AccessTokenTTL }, want: defaults.JWT.AccessTokenTTL},
		{key: "TTL_REFRESH_TOKEN", value: "seven days", got: func(c *Config) any { return c.JWT.RefreshTokenTTL }, want: defaults.JWT.RefreshTokenTTL},
		{key: "PPROF_ENABLED", value: "maybe", got: func(c *Config) any { return c.Pprof.Enabled }, want: defaults.Pprof.Enabled},
	}
	for _, tt := range tests {
		t.Run(tt.key+"="+tt.value, func(t *testing.T) {
			setEnv(t, map[string]string{"JWT_SECRET_KEY": "test-jwt-secret", tt.key: tt.value})

			cfg := load(t)

			assert.Equal(t, tt.want, tt.got(cfg))
		})
	}
}

func TestLoad_PprofEnabledAcceptsCommonBooleansInAnyCase(t *testing.T) {
	tests := map[string]bool{
		"true": true, "1": true, "yes": true, "on": true,
		"TRUE": true, "True": true, "YES": true, "On": true,
		"false": false, "0": false, "no": false, "off": false,
		"FALSE": false, "False": false, "NO": false, "Off": false,
	}
	for value, want := range tests {
		t.Run(value, func(t *testing.T) {
			setEnv(t, map[string]string{"JWT_SECRET_KEY": "test-jwt-secret", "PPROF_ENABLED": value})

			assert.Equal(t, want, load(t).Pprof.Enabled)
		})
	}
}

func TestGetBoolFromEnv_IgnoresLetterCase(t *testing.T) {
	const key = "GROWTH_TRACKER_TEST_BOOL"
	tests := []struct {
		value string
		want  bool
	}{
		{value: "TRUE", want: true},
		{value: "True", want: true},
		{value: "tRuE", want: true},
		{value: "YES", want: true},
		{value: "On", want: true},
		{value: "FALSE", want: false},
		{value: "False", want: false},
		{value: "fAlSe", want: false},
		{value: "NO", want: false},
		{value: "OFF", want: false},
	}
	for _, tt := range tests {
		t.Run(tt.value, func(t *testing.T) {
			t.Setenv(key, tt.value)

			// The opposite default proves the value was parsed rather than defaulted.
			assert.Equal(t, tt.want, getBoolFromEnv(key, !tt.want))
		})
	}
}

func TestGetBoolFromEnv_UsesDefaultWhenUnsetOrInvalid(t *testing.T) {
	const key = "GROWTH_TRACKER_TEST_BOOL"
	for _, value := range []string{"", "maybe", "2"} {
		t.Run("value "+value, func(t *testing.T) {
			t.Setenv(key, value)

			assert.True(t, getBoolFromEnv(key, true))
			assert.False(t, getBoolFromEnv(key, false))
		})
	}
}

func TestDatabaseConfig_DSN(t *testing.T) {
	t.Run("full URL takes precedence over components", func(t *testing.T) {
		cfg := DatabaseConfig{
			URL:      "postgresql://app@db.example.com:5432/growth?sslmode=require",
			Host:     "ignored",
			Port:     "1",
			Name:     "ignored",
			Username: "ignored",
			Password: "ignored",
			SSLMode:  "disable",
		}

		assert.Equal(t, "postgresql://app@db.example.com:5432/growth?sslmode=require", cfg.DSN())
	})

	t.Run("built from components", func(t *testing.T) {
		cfg := DatabaseConfig{
			Host:     "db.internal",
			Port:     "6543",
			Name:     "growth",
			Username: "app",
			Password: "test-password",
			SSLMode:  "verify-full",
		}

		dsn := cfg.DSN()

		assert.Equal(t, "postgresql://app:test-password@db.internal:6543/growth?sslmode=verify-full", dsn)
		parsed, err := url.Parse(dsn)
		require.NoError(t, err)
		assert.Equal(t, "app", parsed.User.Username())
		assert.Equal(t, "db.internal:6543", parsed.Host)
		assert.Equal(t, "/growth", parsed.Path)
	})

	t.Run("loaded from the environment", func(t *testing.T) {
		setEnv(t, map[string]string{
			"JWT_SECRET_KEY": "test-jwt-secret",
			"DB_HOST":        "localhost",
			"DB_NAME":        "growth",
			"DB_USERNAME":    "app",
			"DB_PASSWORD":    "test-password",
		})

		assert.Equal(t, "postgresql://app:test-password@localhost:5432/growth?sslmode=require", load(t).Database.DSN())
	})
}

// The driver must read back exactly the configured values, whatever characters they contain.
func TestDatabaseConfig_DSN_EscapesSpecialCharacters(t *testing.T) {
	tests := []struct {
		name     string
		username string
		password string
		database string
	}{
		{name: "URL delimiters in the password", username: "app", password: "p@ss/w:rd#1?", database: "growth"},
		{name: "percent sign and spaces in the password", username: "app", password: "100% sure pass", database: "growth"},
		{name: "reserved characters in the user name", username: "app@corp:admin", password: "secret", database: "growth"},
		{name: "non-ASCII password", username: "app", password: "pässwörd✓", database: "growth"},
		{name: "special characters in the database name", username: "app", password: "secret", database: "growth #1?"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := DatabaseConfig{
				Host:     "db.internal",
				Port:     "6543",
				Name:     tt.database,
				Username: tt.username,
				Password: tt.password,
				SSLMode:  "disable",
			}

			parsed, err := pgconn.ParseConfig(cfg.DSN())

			require.NoError(t, err)
			assert.Equal(t, "db.internal", parsed.Host)
			assert.Equal(t, uint16(6543), parsed.Port)
			assert.Equal(t, tt.username, parsed.User)
			assert.Equal(t, tt.password, parsed.Password)
			assert.Equal(t, tt.database, parsed.Database)
			assert.Nil(t, parsed.TLSConfig, "sslmode=disable is preserved")
		})
	}
}

func TestConfig_Environment(t *testing.T) {
	tests := []struct {
		env             string
		wantProduction  bool
		wantDevelopment bool
	}{
		{env: "production", wantProduction: true},
		{env: "development", wantDevelopment: true},
		{env: "staging"},
		{env: ""},
	}
	for _, tt := range tests {
		t.Run(tt.env, func(t *testing.T) {
			cfg := &Config{Env: tt.env}
			assert.Equal(t, tt.wantProduction, cfg.IsProduction())
			assert.Equal(t, tt.wantDevelopment, cfg.IsDevelopment())
		})
	}
}
