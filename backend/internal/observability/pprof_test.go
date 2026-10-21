package observability_test

import (
	"bytes"
	"fmt"
	"log"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/aman1117/backend/internal/config"
	"github.com/aman1117/backend/internal/logger"
	"github.com/aman1117/backend/internal/observability"
	"github.com/gofiber/fiber/v2"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
	"go.uber.org/zap/zaptest/observer"
)

const pprofToken = "pprof-test-token-0123456789"

// observeLogs routes the application logger to memory for the duration of the test.
func observeLogs(t *testing.T) *observer.ObservedLogs {
	t.Helper()
	prevLog, prevSugar := logger.Log, logger.Sugar
	t.Cleanup(func() { logger.Log, logger.Sugar = prevLog, prevSugar })
	core, logs := observer.New(zapcore.DebugLevel)
	logger.Log = zap.New(core)
	logger.Sugar = logger.Log.Sugar()
	return logs
}

// newApp registers pprof on a fresh app (and so a fresh rate limiter) next to a regular route.
func newApp(t *testing.T, cfg config.PprofConfig) (*fiber.App, *observer.ObservedLogs) {
	t.Helper()
	logs := observeLogs(t)
	app := fiber.New()
	observability.RegisterPprof(app, cfg)
	app.Get("/healthz", func(c *fiber.Ctx) error { return c.SendString("ok") })
	return app, logs
}

type response struct {
	status int
	body   string
}

func get(t *testing.T, app *fiber.App, target string, headers map[string]string) response {
	t.Helper()
	req := httptest.NewRequest(fiber.MethodGet, target, nil)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := app.Test(req, -1)
	require.NoError(t, err)
	defer res.Body.Close()
	var body bytes.Buffer
	_, err = body.ReadFrom(res.Body)
	require.NoError(t, err)
	return response{status: res.StatusCode, body: body.String()}
}

func messages(logs *observer.ObservedLogs) []string {
	var out []string
	for _, entry := range logs.All() {
		out = append(out, entry.Message)
	}
	return out
}

func TestRegisterPprof_DisabledRegistersNothing(t *testing.T) {
	logs := observeLogs(t)
	app := fiber.New()

	observability.RegisterPprof(app, config.PprofConfig{Enabled: false, Prefix: "/debug/pprof", Token: pprofToken})

	assert.Empty(t, app.GetRoutes(), "no middleware or routes are registered")
	assert.Equal(t, fiber.StatusNotFound, get(t, app, "/debug/pprof/", nil).status)
	assert.Equal(t, []string{"pprof disabled (PPROF_ENABLED=false)"}, messages(logs))
}

func TestRegisterPprof_ServesProfilesUnderThePrefix(t *testing.T) {
	tests := []struct {
		name      string
		prefix    string
		servedAt  string
		notServed string
	}{
		{name: "default prefix", prefix: "/debug/pprof", servedAt: "/debug/pprof", notServed: "/custom/debug/pprof/"},
		{name: "empty prefix uses the default", prefix: "", servedAt: "/debug/pprof", notServed: "/custom/debug/pprof/"},
		{name: "default prefix with a trailing slash", prefix: "/debug/pprof/", servedAt: "/debug/pprof", notServed: "/custom/debug/pprof/"},
		{name: "custom prefix", prefix: "/internal", servedAt: "/internal/debug/pprof", notServed: "/debug/pprof/"},
		{name: "custom prefix is normalised", prefix: "ops/", servedAt: "/ops/debug/pprof", notServed: "/debug/pprof/"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			app, logs := newApp(t, config.PprofConfig{Enabled: true, Prefix: tt.prefix})

			index := get(t, app, tt.servedAt+"/", nil)
			assert.Equal(t, fiber.StatusOK, index.status)
			assert.Contains(t, index.body, "Types of profiles available")

			cmdline := get(t, app, tt.servedAt+"/cmdline", nil)
			assert.Equal(t, fiber.StatusOK, cmdline.status)
			assert.NotEmpty(t, cmdline.body)

			assert.Equal(t, fiber.StatusNotFound, get(t, app, tt.notServed, nil).status)
			assert.Equal(t, []string{
				"pprof enabled at " + tt.servedAt + " (no auth - recommend setting PPROF_TOKEN)",
			}, messages(logs))
		})
	}
}

func TestRegisterPprof_TokenProtection(t *testing.T) {
	sameLengthWrong := strings.Repeat("x", len(pprofToken))
	tests := []struct {
		name       string
		target     string
		headers    map[string]string
		wantStatus int
	}{
		{name: "no token", target: "/debug/pprof/", wantStatus: fiber.StatusUnauthorized},
		{name: "bearer token", target: "/debug/pprof/", headers: map[string]string{"Authorization": "Bearer " + pprofToken}, wantStatus: fiber.StatusOK},
		{name: "bearer scheme is case-insensitive", target: "/debug/pprof/", headers: map[string]string{"Authorization": "bearer " + pprofToken}, wantStatus: fiber.StatusOK},
		{name: "wrong bearer token", target: "/debug/pprof/", headers: map[string]string{"Authorization": "Bearer " + sameLengthWrong}, wantStatus: fiber.StatusUnauthorized},
		{name: "bearer token with a different length", target: "/debug/pprof/", headers: map[string]string{"Authorization": "Bearer short"}, wantStatus: fiber.StatusUnauthorized},
		{name: "other scheme", target: "/debug/pprof/", headers: map[string]string{"Authorization": "Basic " + pprofToken}, wantStatus: fiber.StatusUnauthorized},
		{name: "token without a scheme", target: "/debug/pprof/", headers: map[string]string{"Authorization": pprofToken}, wantStatus: fiber.StatusUnauthorized},
		{name: "X-PPROF-Token header", target: "/debug/pprof/", headers: map[string]string{"X-PPROF-Token": pprofToken}, wantStatus: fiber.StatusOK},
		{name: "wrong X-PPROF-Token header", target: "/debug/pprof/", headers: map[string]string{"X-PPROF-Token": sameLengthWrong}, wantStatus: fiber.StatusUnauthorized},
		{name: "X-PPROF-Token is checked after a wrong bearer token", target: "/debug/pprof/", headers: map[string]string{"Authorization": "Bearer " + sameLengthWrong, "X-PPROF-Token": pprofToken}, wantStatus: fiber.StatusOK},
		{name: "query parameter is not accepted", target: "/debug/pprof/?token=" + pprofToken, wantStatus: fiber.StatusUnauthorized},
		{name: "every pprof path is protected", target: "/debug/pprof/cmdline", wantStatus: fiber.StatusUnauthorized},
		{name: "other routes stay public", target: "/healthz", wantStatus: fiber.StatusOK},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			app, _ := newApp(t, config.PprofConfig{Enabled: true, Prefix: "/debug/pprof", Token: pprofToken})

			res := get(t, app, tt.target, tt.headers)

			assert.Equal(t, tt.wantStatus, res.status)
			if tt.wantStatus == fiber.StatusUnauthorized {
				assert.JSONEq(t, `{"error": "unauthorized: valid pprof token required"}`, res.body)
			}
		})
	}
}

func TestRegisterPprof_TokenIsNeverLogged(t *testing.T) {
	_, logs := newApp(t, config.PprofConfig{Enabled: true, Prefix: "/internal", Token: pprofToken})

	assert.Equal(t, []string{"pprof enabled at /internal/debug/pprof (token-protected)"}, messages(logs))
	for _, entry := range logs.All() {
		assert.NotContains(t, entry.Message, pprofToken)
		for _, value := range entry.ContextMap() {
			assert.NotContains(t, fmt.Sprint(value), pprofToken)
		}
	}
}

func TestRegisterPprof_RateLimitsProfileEndpoints(t *testing.T) {
	app, _ := newApp(t, config.PprofConfig{Enabled: true, Prefix: "/debug/pprof"})

	for i := 1; i <= 5; i++ {
		require.Equal(t, fiber.StatusOK, get(t, app, "/debug/pprof/cmdline", nil).status, "request %d", i)
	}
	limited := get(t, app, "/debug/pprof/", nil)
	assert.Equal(t, fiber.StatusTooManyRequests, limited.status)
	assert.JSONEq(t, `{"error": "rate limit exceeded for pprof endpoints"}`, limited.body)

	for i := 1; i <= 10; i++ {
		assert.Equal(t, fiber.StatusOK, get(t, app, "/healthz", nil).status, "other routes are not rate limited")
	}
}

func TestRegisterPprof_FallsBackToTheStandardLogger(t *testing.T) {
	observeLogs(t)
	logger.Sugar = nil
	var buf bytes.Buffer
	prevOutput, prevFlags := log.Writer(), log.Flags()
	log.SetOutput(&buf)
	log.SetFlags(0)
	t.Cleanup(func() {
		log.SetOutput(prevOutput)
		log.SetFlags(prevFlags)
	})

	observability.RegisterPprof(fiber.New(), config.PprofConfig{Enabled: false})

	assert.Equal(t, "pprof disabled (PPROF_ENABLED=false)\n", buf.String())
}
