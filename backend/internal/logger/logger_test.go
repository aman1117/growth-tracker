package logger

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aman1117/backend/internal/config"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
	"go.uber.org/zap/zaptest/observer"
)

const testToken = "test-axiom-token"

// restoreGlobals puts the package-level loggers and Axiom writer back when the test ends.
func restoreGlobals(t *testing.T) {
	t.Helper()
	prevLog, prevSugar, prevAxiom := Log, Sugar, axiom
	t.Cleanup(func() { Log, Sugar, axiom = prevLog, prevSugar, prevAxiom })
}

// observe installs an in-memory logger as Log and Sugar for the duration of the test.
func observe(t *testing.T) *observer.ObservedLogs {
	t.Helper()
	restoreGlobals(t)
	core, logs := observer.New(zapcore.DebugLevel)
	Log = zap.New(core)
	Sugar = Log.Sugar()
	return logs
}

// captureStdout returns everything written to os.Stdout while fn runs. Loggers created by Init
// inside fn keep the temporary pipe, so callers must not use them after fn returns.
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

func lines(s string) []string {
	var out []string
	scanner := bufio.NewScanner(strings.NewReader(s))
	for scanner.Scan() {
		if line := strings.TrimSpace(scanner.Text()); line != "" {
			out = append(out, line)
		}
	}
	return out
}

// ingestRequest is one batch received by the fake Axiom endpoint.
type ingestRequest struct {
	method        string
	path          string
	authorization string
	contentType   string
	entries       []map[string]any
}

// fakeAxiom starts an ingest endpoint that records every batch it receives.
func fakeAxiom(t *testing.T, status int) (*httptest.Server, <-chan ingestRequest) {
	t.Helper()
	received := make(chan ingestRequest, 16)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		req := ingestRequest{
			method:        r.Method,
			path:          r.URL.Path,
			authorization: r.Header.Get("Authorization"),
			contentType:   r.Header.Get("Content-Type"),
		}
		if err := json.NewDecoder(r.Body).Decode(&req.entries); err != nil {
			t.Errorf("fake axiom: decode batch: %v", err)
		}
		received <- req
		w.WriteHeader(status)
	}))
	t.Cleanup(srv.Close)
	return srv, received
}

func waitForBatch(t *testing.T, received <-chan ingestRequest) ingestRequest {
	t.Helper()
	select {
	case req := <-received:
		return req
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting for a batch")
		return ingestRequest{}
	}
}

func assertNoBatch(t *testing.T, received <-chan ingestRequest) {
	t.Helper()
	select {
	case req := <-received:
		t.Fatalf("unexpected batch with %d entries", len(req.entries))
	default:
	}
}

// newTestWriter returns a writer without the background flush loop, so tests drive flush directly.
func newTestWriter(url string, client *http.Client) *axiomWriter {
	return &axiomWriter{
		url:      url,
		apiToken: testToken,
		buffer:   make([]map[string]interface{}, 0, 100),
		client:   client,
		stopChan: make(chan struct{}),
		env:      "test",
	}
}

func writeLine(t *testing.T, w io.Writer, line string) {
	t.Helper()
	n, err := w.Write([]byte(line))
	require.NoError(t, err)
	require.Equal(t, len(line), n)
}

func assertAxiomMetadata(t *testing.T, entry map[string]any, env string) {
	t.Helper()
	assert.Equal(t, "growth-tracker", entry["app"])
	assert.Equal(t, env, entry["env"])
	stamp, ok := entry["_time"].(string)
	require.True(t, ok, "_time must be a string, got %T", entry["_time"])
	_, err := time.Parse(time.RFC3339Nano, stamp)
	assert.NoError(t, err)
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestInit_DevelopmentLogsColoredConsoleLines(t *testing.T) {
	for _, env := range []string{"development", "staging"} {
		t.Run(env, func(t *testing.T) {
			restoreGlobals(t)
			axiom = nil

			out := captureStdout(t, func() {
				Init(&config.Config{Env: env, Axiom: config.AxiomConfig{Dataset: "ignored", APIToken: testToken}})
				Log.Debug("debug is enabled")
				Sugar.Infow("user signed in", "user_id", 7)
			})

			assert.Nil(t, axiom, "Axiom is only used in production")
			got := lines(out)
			require.Len(t, got, 2)
			assert.Contains(t, got[0], "DEBUG")
			assert.Contains(t, got[0], "debug is enabled")
			assert.Contains(t, got[1], "INFO")
			assert.Contains(t, got[1], "user signed in")
			assert.Contains(t, got[1], `"user_id": 7`)
			assert.Contains(t, got[1], "\x1b[", "levels are colored")
			assert.False(t, json.Valid([]byte(got[1])), "console lines are not JSON")
		})
	}
}

func TestInit_ProductionLogsJSON(t *testing.T) {
	tests := []struct {
		name  string
		axiom config.AxiomConfig
	}{
		{name: "without Axiom"},
		{name: "Axiom dataset without token", axiom: config.AxiomConfig{Dataset: "growth-logs"}},
		{name: "Axiom token without dataset", axiom: config.AxiomConfig{APIToken: testToken}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			restoreGlobals(t)
			axiom = nil

			out := captureStdout(t, func() {
				Init(&config.Config{Env: "production", Axiom: tt.axiom})
				Log.Debug("debug is enabled")
				Sugar.Warnw("slow request", "duration_ms", 1500)
			})

			assert.Nil(t, axiom, "Axiom needs both a dataset and a token")
			got := lines(out)
			require.Len(t, got, 2)

			var debugEntry, warnEntry map[string]any
			require.NoError(t, json.Unmarshal([]byte(got[0]), &debugEntry))
			require.NoError(t, json.Unmarshal([]byte(got[1]), &warnEntry))
			assert.Equal(t, "debug", debugEntry["level"])
			assert.Equal(t, "warn", warnEntry["level"])
			assert.Equal(t, "slow request", warnEntry["message"])
			assert.EqualValues(t, 1500, warnEntry["duration_ms"])
			stamp, ok := warnEntry["timestamp"].(string)
			require.True(t, ok)
			_, err := time.Parse("2006-01-02T15:04:05.000Z0700", stamp)
			assert.NoError(t, err, "timestamps are ISO-8601")
		})
	}
}

func TestInit_ProductionWithAxiomShipsLogs(t *testing.T) {
	restoreGlobals(t)
	axiom = nil
	srv, received := fakeAxiom(t, http.StatusOK)

	out := captureStdout(t, func() {
		Init(&config.Config{Env: "production", Axiom: config.AxiomConfig{Dataset: "growth-logs", APIToken: testToken}})

		require.NotNil(t, axiom)
		assert.Equal(t, "https://api.axiom.co/v1/datasets/growth-logs/ingest", axiom.url)
		assert.Equal(t, testToken, axiom.apiToken)
		assert.Equal(t, "production", axiom.env)
		assert.Equal(t, 5*time.Second, axiom.client.Timeout)

		// Point the writer at the fake endpoint before anything is logged.
		axiom.url = srv.URL + "/v1/datasets/growth-logs/ingest"
		axiom.client = srv.Client()

		Sugar.Infow("user signed in", "user_id", 42)
		Sync() // stops the writer, which flushes what is buffered
	})

	assert.Contains(t, out, "user signed in", "logs still go to stdout")
	batch := waitForBatch(t, received)
	assert.Equal(t, "/v1/datasets/growth-logs/ingest", batch.path)
	assert.Equal(t, "Bearer "+testToken, batch.authorization)
	require.Len(t, batch.entries, 1)
	entry := batch.entries[0]
	assert.Equal(t, "user signed in", entry["message"])
	assert.Equal(t, "info", entry["level"])
	assert.EqualValues(t, 42, entry["user_id"])
	assertAxiomMetadata(t, entry, "production")
}

func TestAxiomWriter_Write(t *testing.T) {
	tests := []struct {
		name string
		line string
		want map[string]any // expected fields besides _time, app and env
	}{
		{
			name: "JSON line keeps its fields",
			line: `{"level":"error","message":"payment failed","attempt":2}` + "\n",
			want: map[string]any{"level": "error", "message": "payment failed", "attempt": float64(2)},
		},
		{
			name: "plain text becomes the message",
			line: "plain text line",
			want: map[string]any{"message": "plain text line"},
		},
		{
			name: "JSON that is not an object is sent as text",
			line: `["a","b"]`,
			want: map[string]any{"message": `["a","b"]`},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			aw := newTestWriter("http://unused.invalid", nil)

			writeLine(t, aw, tt.line)

			require.Len(t, aw.buffer, 1)
			entry := aw.buffer[0]
			assertAxiomMetadata(t, entry, "test")
			for _, key := range []string{"_time", "app", "env"} {
				delete(entry, key)
			}
			assert.Equal(t, tt.want, map[string]any(entry))
		})
	}
}

func TestAxiomWriter_FlushSendsOneBatch(t *testing.T) {
	srv, received := fakeAxiom(t, http.StatusOK)
	aw := newTestWriter(srv.URL+"/v1/datasets/ds/ingest", srv.Client())

	aw.flush()
	assertNoBatch(t, received)

	writeLine(t, aw, `{"message":"first"}`)
	writeLine(t, aw, "second")
	writeLine(t, aw, `{"message":"third"}`)
	aw.flush()

	batch := waitForBatch(t, received)
	assert.Equal(t, http.MethodPost, batch.method)
	assert.Equal(t, "/v1/datasets/ds/ingest", batch.path)
	assert.Equal(t, "Bearer "+testToken, batch.authorization)
	assert.Equal(t, "application/json", batch.contentType)
	require.Len(t, batch.entries, 3)
	for i, message := range []string{"first", "second", "third"} {
		assert.Equal(t, message, batch.entries[i]["message"])
	}
	assert.Empty(t, aw.buffer, "the buffer is reset after a flush")

	aw.flush()
	assertNoBatch(t, received)
}

func TestAxiomWriter_FlushDropsBatchesThatCannotBeSent(t *testing.T) {
	tests := []struct {
		name          string
		setup         func(aw *axiomWriter)
		wantAttempted bool
	}{
		{
			name:          "network error",
			setup:         func(aw *axiomWriter) {},
			wantAttempted: true,
		},
		{
			name:  "invalid endpoint URL",
			setup: func(aw *axiomWriter) { aw.url = "http://[::1" },
		},
		{
			name: "entry that cannot be encoded",
			setup: func(aw *axiomWriter) {
				aw.buffer = append(aw.buffer, map[string]interface{}{"callback": func() {}})
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var mu sync.Mutex
			var attempts []string
			client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				body, _ := io.ReadAll(r.Body)
				mu.Lock()
				attempts = append(attempts, string(body))
				mu.Unlock()
				return nil, errors.New("network is unreachable")
			})}
			aw := newTestWriter("http://axiom.invalid/ingest", client)
			writeLine(t, aw, `{"message":"lost"}`)
			tt.setup(aw)

			assert.NotPanics(t, aw.flush)

			assert.Empty(t, aw.buffer, "failed batches are dropped, not retried")
			mu.Lock()
			defer mu.Unlock()
			if tt.wantAttempted {
				require.Len(t, attempts, 1)
				assert.Contains(t, attempts[0], `"message":"lost"`)
			} else {
				assert.Empty(t, attempts)
			}
		})
	}
}

func TestAxiomWriter_RejectedBatchDoesNotBlockLaterBatches(t *testing.T) {
	srv, received := fakeAxiom(t, http.StatusInternalServerError)
	aw := newTestWriter(srv.URL, srv.Client())

	writeLine(t, aw, `{"message":"first"}`)
	aw.flush()
	assert.Len(t, waitForBatch(t, received).entries, 1)

	writeLine(t, aw, `{"message":"second"}`)
	aw.flush()
	batch := waitForBatch(t, received)
	require.Len(t, batch.entries, 1)
	assert.Equal(t, "second", batch.entries[0]["message"])
}

func TestAxiomWriter_FlushLoop(t *testing.T) {
	t.Run("flushes periodically", func(t *testing.T) {
		srv, received := fakeAxiom(t, http.StatusOK)
		aw := newAxiomWriter("ds", testToken, "test")
		t.Cleanup(aw.stop)
		aw.url = srv.URL + "/ingest"
		aw.client = srv.Client()

		writeLine(t, aw, `{"message":"tick"}`)

		batch := waitForBatch(t, received) // the loop flushes every 2 seconds
		require.Len(t, batch.entries, 1)
		assert.Equal(t, "tick", batch.entries[0]["message"])
	})

	t.Run("flushes what is left when stopped", func(t *testing.T) {
		srv, received := fakeAxiom(t, http.StatusOK)
		aw := newAxiomWriter("ds", testToken, "test")
		aw.url = srv.URL + "/ingest"
		aw.client = srv.Client()

		writeLine(t, aw, `{"message":"one"}`)
		writeLine(t, aw, `{"message":"two"}`)
		aw.stop()

		var messages []any
		for len(messages) < 2 {
			for _, entry := range waitForBatch(t, received).entries {
				messages = append(messages, entry["message"])
			}
		}
		assert.Equal(t, []any{"one", "two"}, messages)
	})
}

func TestSync(t *testing.T) {
	t.Run("without loggers", func(t *testing.T) {
		restoreGlobals(t)
		Log, Sugar, axiom = nil, nil, nil

		assert.NotPanics(t, Sync)
	})

	t.Run("with a logger and no Axiom", func(t *testing.T) {
		observe(t)
		axiom = nil

		assert.NotPanics(t, Sync)
	})

	t.Run("stops the Axiom writer", func(t *testing.T) {
		observe(t)
		srv, received := fakeAxiom(t, http.StatusOK)
		axiom = newAxiomWriter("ds", testToken, "production")
		axiom.url = srv.URL + "/ingest"
		axiom.client = srv.Client()
		writeLine(t, axiom, "pending entry")

		Sync()

		batch := waitForBatch(t, received)
		require.Len(t, batch.entries, 1)
		assert.Equal(t, "pending entry", batch.entries[0]["message"])
		select {
		case <-axiom.stopChan:
		default:
			t.Fatal("Sync must stop the writer")
		}
	})
}

// A second Sync (for example an explicit flush followed by the deferred one) must be harmless.
func TestSync_CanBeCalledMoreThanOnce(t *testing.T) {
	observe(t)
	srv, received := fakeAxiom(t, http.StatusOK)
	axiom = newAxiomWriter("ds", testToken, "production")
	axiom.url = srv.URL + "/ingest"
	axiom.client = srv.Client()
	writeLine(t, axiom, "pending entry")

	require.NotPanics(t, Sync)
	require.NotPanics(t, Sync)

	batch := waitForBatch(t, received)
	require.Len(t, batch.entries, 1)
	assert.Equal(t, "pending entry", batch.entries[0]["message"])
}

func TestAxiomWriter_StopCanBeCalledMoreThanOnce(t *testing.T) {
	aw := newTestWriter("http://unused.invalid", nil)
	aw.stop()

	assert.NotPanics(t, aw.stop)

	select {
	case <-aw.stopChan:
	default:
		t.Fatal("the writer must stay stopped")
	}
}

func TestContextLoggers(t *testing.T) {
	tests := []struct {
		name   string
		logger func() *zap.SugaredLogger
		want   map[string]any
	}{
		{name: "LogWithUser with id and username", logger: func() *zap.SugaredLogger { return LogWithUser(7, "alice") }, want: map[string]any{"user_id": uint64(7), "username": "alice"}},
		{name: "LogWithUser with id only", logger: func() *zap.SugaredLogger { return LogWithUser(7, "") }, want: map[string]any{"user_id": uint64(7)}},
		{name: "LogWithUser with username only", logger: func() *zap.SugaredLogger { return LogWithUser(0, "alice") }, want: map[string]any{"username": "alice"}},
		{name: "LogWithUser anonymous", logger: func() *zap.SugaredLogger { return LogWithUser(0, "") }, want: map[string]any{}},
		{name: "LogWithUserID", logger: func() *zap.SugaredLogger { return LogWithUserID(7) }, want: map[string]any{"user_id": uint64(7)}},
		{name: "LogWithUserID anonymous", logger: func() *zap.SugaredLogger { return LogWithUserID(0) }, want: map[string]any{}},
		{name: "LogWithTrace", logger: func() *zap.SugaredLogger { return LogWithTrace("1a2b3c4d") }, want: map[string]any{"trace_id": "1a2b3c4d"}},
		{name: "LogWithTrace empty", logger: func() *zap.SugaredLogger { return LogWithTrace("") }, want: map[string]any{}},
		{name: "LogWithContext with trace and user", logger: func() *zap.SugaredLogger { return LogWithContext("1a2b3c4d", 7) }, want: map[string]any{"trace_id": "1a2b3c4d", "user_id": uint64(7)}},
		{name: "LogWithContext with trace only", logger: func() *zap.SugaredLogger { return LogWithContext("1a2b3c4d", 0) }, want: map[string]any{"trace_id": "1a2b3c4d"}},
		{name: "LogWithContext with user only", logger: func() *zap.SugaredLogger { return LogWithContext("", 7) }, want: map[string]any{"user_id": uint64(7)}},
		{name: "LogWithContext empty", logger: func() *zap.SugaredLogger { return LogWithContext("", 0) }, want: map[string]any{}},
		{name: "LogWithFullContext with everything", logger: func() *zap.SugaredLogger { return LogWithFullContext("1a2b3c4d", 7, "alice") }, want: map[string]any{"trace_id": "1a2b3c4d", "user_id": uint64(7), "username": "alice"}},
		{name: "LogWithFullContext with trace only", logger: func() *zap.SugaredLogger { return LogWithFullContext("1a2b3c4d", 0, "") }, want: map[string]any{"trace_id": "1a2b3c4d"}},
		{name: "LogWithFullContext with user only", logger: func() *zap.SugaredLogger { return LogWithFullContext("", 7, "alice") }, want: map[string]any{"user_id": uint64(7), "username": "alice"}},
		{name: "LogWithFullContext empty", logger: func() *zap.SugaredLogger { return LogWithFullContext("", 0, "") }, want: map[string]any{}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			logs := observe(t)

			tt.logger().Infow("something happened", "extra", true)

			entries := logs.TakeAll()
			require.Len(t, entries, 1)
			assert.Equal(t, "something happened", entries[0].Message)
			fields := entries[0].ContextMap()
			assert.Equal(t, true, fields["extra"])
			delete(fields, "extra")
			assert.Equal(t, tt.want, fields)
		})
	}
}

func TestContextLoggers_ReuseTheBaseLoggerWithoutContext(t *testing.T) {
	observe(t)

	assert.Same(t, Sugar, LogWithUserID(0))
	assert.Same(t, Sugar, LogWithTrace(""))
	assert.NotSame(t, Sugar, LogWithUserID(1))
}
