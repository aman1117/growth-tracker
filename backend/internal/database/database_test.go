package database_test

import (
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/aman1117/backend/internal/config"
	"github.com/aman1117/backend/internal/database"
	"github.com/aman1117/backend/internal/testutil"
	"github.com/aman1117/backend/pkg/models"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
	gormlogger "gorm.io/gorm/logger"
)

// malformedDSN fails while the DSN is parsed, before any network access.
const malformedDSN = "postgres://localhost:not-a-port/growth"

// useEnvironment installs a configuration for env as config.AppConfig; "" removes it.
func useEnvironment(t *testing.T, env string) {
	t.Helper()
	previous := config.AppConfig
	t.Cleanup(func() { config.AppConfig = previous })
	if env == "" {
		config.AppConfig = nil
		return
	}
	testutil.Config().Env = env
}

// initDB connects the database package to the test database in the given environment and
// closes and forgets the connection when the test ends.
func initDB(t *testing.T, env string) *gorm.DB {
	t.Helper()
	useEnvironment(t, env)
	database.ResetForTest()
	t.Cleanup(func() {
		_ = database.Close()
		database.ResetForTest()
	})

	db, err := database.Init(&config.DatabaseConfig{
		URL:             testutil.DSN(t),
		MaxIdleConns:    2,
		MaxOpenConns:    5,
		ConnMaxLifetime: time.Minute,
		ConnMaxIdleTime: 30 * time.Second,
	})
	require.NoError(t, err)
	require.NotNil(t, db)
	return db
}

// sqlLogLevel reads the level of GORM's default logger, which exposes no getter.
func sqlLogLevel(t *testing.T, db *gorm.DB) gormlogger.LogLevel {
	t.Helper()
	value := reflect.Indirect(reflect.ValueOf(db.Logger))
	require.Equal(t, reflect.Struct, value.Kind(), "unexpected GORM logger %T", db.Logger)
	level := value.FieldByName("LogLevel")
	require.True(t, level.IsValid(), "GORM logger %T has no LogLevel field", db.Logger)
	return gormlogger.LogLevel(level.Int())
}

func TestBeforeInit(t *testing.T) {
	database.ResetForTest()

	assert.Nil(t, database.Get())
	assert.Nil(t, database.WithTimeout(time.Second))
	assert.EqualError(t, database.AutoMigrate(), "database not initialized")
	assert.NoError(t, database.Close(), "closing an unopened database is a no-op")
}

func TestInit_ConnectsAndConfiguresThePool(t *testing.T) {
	db := initDB(t, "development")

	assert.Same(t, db, database.Get())
	assert.True(t, db.PrepareStmt, "prepared statements are enabled")

	sqlDB, err := db.DB()
	require.NoError(t, err)
	require.NoError(t, sqlDB.Ping())
	assert.Equal(t, 5, sqlDB.Stats().MaxOpenConnections)

	var one int
	require.NoError(t, db.Raw("SELECT 1").Scan(&one).Error)
	assert.Equal(t, 1, one)
}

func TestInit_ConnectsOnlyOnce(t *testing.T) {
	db := initDB(t, "development")

	again, err := database.Init(&config.DatabaseConfig{URL: malformedDSN})

	require.NoError(t, err)
	assert.Same(t, db, again, "later calls return the first connection and ignore their configuration")
}

func TestInit_SQLLogLevelDependsOnTheEnvironment(t *testing.T) {
	tests := []struct {
		env  string
		want gormlogger.LogLevel
	}{
		{env: "production", want: gormlogger.Warn},
		{env: "development", want: gormlogger.Info},
		{env: "staging", want: gormlogger.Info},
		{env: "", want: gormlogger.Info}, // no application configuration loaded
	}
	for _, tt := range tests {
		t.Run("env "+tt.env, func(t *testing.T) {
			db := initDB(t, tt.env)

			assert.Equal(t, tt.want, sqlLogLevel(t, db))
		})
	}
}

func TestInit_InvalidDSNReturnsAnError(t *testing.T) {
	database.ResetForTest()
	t.Cleanup(database.ResetForTest)

	_, err := database.Init(&config.DatabaseConfig{URL: malformedDSN})

	assert.Error(t, err)
}

func TestInit_ReturnsTheFirstErrorOnLaterCalls(t *testing.T) {
	database.ResetForTest()
	t.Cleanup(database.ResetForTest)
	_, firstErr := database.Init(&config.DatabaseConfig{URL: malformedDSN})
	require.Error(t, firstErr)

	for i := 0; i < 2; i++ {
		_, err := database.Init(&config.DatabaseConfig{URL: testutil.DSN(t)})

		require.ErrorIs(t, err, firstErr, "a failed connection must not be reported as success later")
	}
}

func TestModels(t *testing.T) {
	all := database.Models()

	require.Len(t, all, 21)
	assert.IsType(t, &models.User{}, all[0], "users must be migrated before the tables that reference them")
	seen := map[reflect.Type]bool{}
	for _, model := range all {
		typ := reflect.TypeOf(model)
		assert.Equal(t, reflect.Ptr, typ.Kind(), "%v must be a pointer for AutoMigrate", typ)
		assert.False(t, seen[typ], "%v is listed twice", typ)
		seen[typ] = true
	}
	for _, model := range []any{&models.Comment{}, &models.ActivityPhoto{}, &models.PushSubscription{}, &models.FollowCounter{}} {
		assert.True(t, seen[reflect.TypeOf(model)], "%T is missing", model)
	}
}

func TestAutoMigrate_CreatesEveryTableAndIsIdempotent(t *testing.T) {
	db := initDB(t, "production")

	require.NoError(t, database.AutoMigrate())
	require.NoError(t, database.AutoMigrate(), "running the migration again is a no-op")

	for _, model := range database.Models() {
		assert.True(t, db.Migrator().HasTable(model), "missing table for %T", model)
	}
}

func TestWithTimeout_ReturnsTheSharedConnection(t *testing.T) {
	db := initDB(t, "production")

	assert.Same(t, db, database.WithTimeout(5*time.Second))
}

func TestTransaction(t *testing.T) {
	shared := testutil.DB(t) // an independent connection, also emptied when the test ends
	initDB(t, "production")

	countUsers := func(t *testing.T, username string) int64 {
		t.Helper()
		var count int64
		require.NoError(t, shared.Model(&models.User{}).Where("username = ?", username).Count(&count).Error)
		return count
	}
	named := func(username string) func(*models.User) {
		return func(u *models.User) { u.Username = username }
	}

	t.Run("commits when the function succeeds", func(t *testing.T) {
		err := database.Transaction(func(tx *gorm.DB) error {
			testutil.CreateUser(t, tx, named("committed"))
			return nil
		})

		require.NoError(t, err)
		assert.EqualValues(t, 1, countUsers(t, "committed"))
	})

	t.Run("rolls back and returns the error when the function fails", func(t *testing.T) {
		errAbort := errors.New("abort")

		err := database.Transaction(func(tx *gorm.DB) error {
			testutil.CreateUser(t, tx, named("rolled_back"))
			return errAbort
		})

		require.ErrorIs(t, err, errAbort)
		assert.Zero(t, countUsers(t, "rolled_back"))
	})

	t.Run("rolls back when the function panics", func(t *testing.T) {
		assert.PanicsWithValue(t, "boom", func() {
			_ = database.Transaction(func(tx *gorm.DB) error {
				testutil.CreateUser(t, tx, named("panicked"))
				panic("boom")
			})
		})

		assert.Zero(t, countUsers(t, "panicked"))
	})
}

func TestClose_ClosesTheConnection(t *testing.T) {
	db := initDB(t, "production")

	require.NoError(t, database.Close())

	sqlDB, err := db.DB()
	require.NoError(t, err)
	assert.Error(t, sqlDB.Ping())
	assert.Error(t, db.Exec("SELECT 1").Error)
}
