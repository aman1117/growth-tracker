package testutil

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aman1117/backend/internal/database"
	"github.com/aman1117/backend/pkg/models"
	embeddedpostgres "github.com/fergusstrange/embedded-postgres"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	gormlogger "gorm.io/gorm/logger"
)

// EnvDatabaseURL names the variable pointing tests at an existing PostgreSQL server, such as
// the CI service container or `docker compose up postgres`. When it is unset, an embedded
// PostgreSQL 16 (the version used in docker-compose.yml) is started for the test binary.
const EnvDatabaseURL = "TEST_DATABASE_URL"

const embeddedVersion = embeddedpostgres.V16

var (
	sharedDB  *gorm.DB
	sharedDSN string
	// resetSQL empties every table and restarts identities in one round trip. DELETE is ~5x
	// faster than TRUNCATE on small tables; foreign-key triggers are disabled for the
	// transaction so the order of the deletes does not matter.
	resetSQL string
	// truncateSQL is the fallback when the role may not change session_replication_role.
	truncateSQL string
)

// RunWithDatabase is a TestMain helper. It calls Setup, starts (or connects to) PostgreSQL,
// creates a database unique to this test binary, migrates the schema, runs the tests and
// finally drops the database and stops any embedded server.
//
//	func TestMain(m *testing.M) { os.Exit(testutil.RunWithDatabase(m)) }
func RunWithDatabase(m *testing.M) int {
	Setup()

	server, err := startServer()
	if err != nil {
		fmt.Fprintf(os.Stderr, "testutil: %v\n", err)
		return 1
	}
	defer server.stop()

	admin, err := openGorm(server.url, false)
	if err != nil {
		fmt.Fprintf(os.Stderr, "testutil: connect to %s: %v\n", redactURL(server.url), err)
		return 1
	}
	defer closeGorm(admin)

	name := "gt_test_" + randomHex(6)
	if err := admin.Exec("CREATE DATABASE " + name).Error; err != nil {
		fmt.Fprintf(os.Stderr, "testutil: create database: %v\n", err)
		return 1
	}
	defer admin.Exec("DROP DATABASE IF EXISTS " + name + " WITH (FORCE)")

	dsn, err := withDatabase(server.url, name)
	if err != nil {
		fmt.Fprintf(os.Stderr, "testutil: %v\n", err)
		return 1
	}
	db, err := openGorm(dsn, true)
	if err != nil {
		fmt.Fprintf(os.Stderr, "testutil: connect to test database: %v\n", err)
		return 1
	}
	if err := migrate(db); err != nil {
		closeGorm(db)
		fmt.Fprintf(os.Stderr, "testutil: migrate: %v\n", err)
		return 1
	}

	sharedDB, sharedDSN = db, dsn
	code := m.Run()
	closeGorm(db)
	return code
}

// DB returns the package database. Every table is truncated (and identities reset) when the
// test ends, so each top-level test starts from an empty schema. Call it from the top-level
// test: subtests share their parent's data. Tests using the database must not call
// t.Parallel.
func DB(t testing.TB) *gorm.DB {
	t.Helper()
	if sharedDB == nil {
		t.Fatal("testutil.DB: TestMain must call testutil.RunWithDatabase")
	}
	t.Cleanup(func() { Truncate(t) })
	return sharedDB
}

// DSN returns the connection string of the package database.
func DSN(t testing.TB) string {
	t.Helper()
	if sharedDSN == "" {
		t.Fatal("testutil.DSN: TestMain must call testutil.RunWithDatabase")
	}
	return sharedDSN
}

// Truncate empties every table and resets identity sequences.
func Truncate(t testing.TB) {
	t.Helper()
	sqlDB, err := sharedDB.DB()
	if err != nil {
		t.Fatalf("testutil: reset: %v", err)
	}
	if _, err := sqlDB.Exec(resetSQL); err == nil {
		return
	}
	if _, err := sqlDB.Exec(truncateSQL); err != nil {
		t.Fatalf("testutil: truncate: %v", err)
	}
}

// BrokenDB returns a *gorm.DB whose connection pool is already closed, so every query
// fails. Use it to exercise database error branches.
func BrokenDB(t testing.TB) *gorm.DB {
	t.Helper()
	db, err := openGorm(DSN(t), false)
	if err != nil {
		t.Fatalf("testutil: open broken db: %v", err)
	}
	closeGorm(db)
	return db
}

// migrate creates the schema the application expects. Besides database.Models it creates the
// tables that production gets from the standalone scripts in backend/migrations
// (story_likes, recent_searches) and the pg_trgm extension used by user search.
func migrate(db *gorm.DB) error {
	if err := db.Exec("CREATE EXTENSION IF NOT EXISTS pg_trgm").Error; err != nil {
		return fmt.Errorf("enable pg_trgm: %w", err)
	}
	all := append(database.Models(), &models.StoryLike{}, &models.RecentSearch{})
	if err := db.AutoMigrate(all...); err != nil {
		return err
	}
	// Mirrors migrations/add_recent_searches.go: the model has no tag for this key, and
	// SaveRecentSearch's ON CONFLICT (user_id, searched_user_id) needs it.
	if err := db.Exec(`DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_recent_search_user_searched') THEN
		ALTER TABLE recent_searches
			ADD CONSTRAINT uq_recent_search_user_searched UNIQUE (user_id, searched_user_id);
	END IF;
END $$`).Error; err != nil {
		return fmt.Errorf("add recent_searches upsert constraint: %w", err)
	}

	var tables, sequences []string
	if err := db.Raw("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename").
		Scan(&tables).Error; err != nil {
		return err
	}
	if err := db.Raw("SELECT sequencename FROM pg_sequences WHERE schemaname = 'public' ORDER BY sequencename").
		Scan(&sequences).Error; err != nil {
		return err
	}

	quoted := make([]string, len(tables))
	var reset strings.Builder
	reset.WriteString("BEGIN; SET LOCAL session_replication_role = replica;")
	for i, name := range tables {
		quoted[i] = `"` + name + `"`
		reset.WriteString("DELETE FROM " + quoted[i] + ";")
	}
	if len(sequences) > 0 {
		calls := make([]string, len(sequences))
		for i, name := range sequences {
			calls[i] = `setval('"` + name + `"', 1, false)`
		}
		reset.WriteString("SELECT " + strings.Join(calls, ", ") + ";")
	}
	reset.WriteString("COMMIT;")
	resetSQL = reset.String()
	truncateSQL = "TRUNCATE TABLE " + strings.Join(quoted, ", ") + " RESTART IDENTITY CASCADE"
	return nil
}

func openGorm(dsn string, prepareStmt bool) (*gorm.DB, error) {
	return gorm.Open(postgres.Open(dsn), &gorm.Config{
		PrepareStmt: prepareStmt, // matches database.Init for the database under test
		Logger:      gormlogger.Default.LogMode(gormlogger.Silent),
	})
}

func closeGorm(db *gorm.DB) {
	if sqlDB, err := db.DB(); err == nil {
		_ = sqlDB.Close()
	}
}

// withDatabase points a server URL at another database and pins the session time zone to UTC
// (the production default) so date conversions match on every machine.
func withDatabase(serverURL, name string) (string, error) {
	u, err := url.Parse(serverURL)
	if err != nil {
		return "", fmt.Errorf("parse %s: %w", EnvDatabaseURL, err)
	}
	u.Path = "/" + name
	q := u.Query()
	if q.Get("sslmode") == "" {
		q.Set("sslmode", "disable")
	}
	q.Set("TimeZone", "UTC")
	u.RawQuery = q.Encode()
	return u.String(), nil
}

func redactURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return "<invalid url>"
	}
	return u.Redacted()
}

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}

type pgServer struct {
	url  string
	stop func()
}

func startServer() (*pgServer, error) {
	if raw := os.Getenv(EnvDatabaseURL); raw != "" {
		return &pgServer{url: raw, stop: func() {}}, nil
	}

	port, err := freePort()
	if err != nil {
		return nil, fmt.Errorf("find a free port: %w", err)
	}
	dir, err := os.MkdirTemp("", "gt-pg-")
	if err != nil {
		return nil, err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	cacheDir := filepath.Join(home, ".embedded-postgres-go")

	logs := &syncBuffer{}
	pg := embeddedpostgres.NewDatabase(embeddedpostgres.DefaultConfig().
		Version(embeddedVersion).
		Port(uint32(port)).
		Username("postgres").
		Password("postgres").
		Database("postgres").
		CachePath(cacheDir).
		RuntimePath(filepath.Join(dir, "runtime")).
		DataPath(filepath.Join(dir, "data")).
		Locale("C").
		Encoding("UTF8").
		StartParameters(map[string]string{"timezone": "UTC", "fsync": "off", "max_connections": "200"}).
		StartTimeout(3 * time.Minute).
		Logger(logs))

	unlock := lockFirstDownload(cacheDir)
	err = pg.Start()
	unlock()
	if err != nil {
		_ = os.RemoveAll(dir)
		return nil, fmt.Errorf("start embedded postgres (set %s to use an existing server): %w\n%s",
			EnvDatabaseURL, err, logs.String())
	}

	return &pgServer{
		url: fmt.Sprintf("postgres://postgres:postgres@localhost:%d/postgres?sslmode=disable", port),
		stop: func() {
			_ = pg.Stop()
			_ = os.RemoveAll(dir)
		},
	}, nil
}

// lockFirstDownload serialises the first start across concurrently running test binaries,
// so only one of them downloads the PostgreSQL archive into the shared cache.
func lockFirstDownload(cacheDir string) func() {
	pattern := filepath.Join(cacheDir, "embedded-postgres-binaries-*-"+string(embeddedVersion)+".txz")
	if matches, _ := filepath.Glob(pattern); len(matches) > 0 {
		return func() {}
	}
	if err := os.MkdirAll(cacheDir, 0o755); err != nil {
		return func() {}
	}
	lock := filepath.Join(cacheDir, ".growth-tracker-download.lock")
	deadline := time.Now().Add(5 * time.Minute)
	for {
		f, err := os.OpenFile(lock, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err == nil {
			_ = f.Close()
			return func() { _ = os.Remove(lock) }
		}
		if !errors.Is(err, os.ErrExist) || time.Now().After(deadline) {
			return func() {}
		}
		if info, statErr := os.Stat(lock); statErr == nil && time.Since(info.ModTime()) > 10*time.Minute {
			_ = os.Remove(lock) // left behind by a crashed run
		}
		time.Sleep(250 * time.Millisecond)
	}
}

func freePort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

// syncBuffer collects embedded PostgreSQL output for error messages.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}
