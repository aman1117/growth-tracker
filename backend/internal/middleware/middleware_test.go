package middleware_test

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/aman1117/backend/internal/config"
	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/handlers"
	"github.com/aman1117/backend/internal/logger"
	"github.com/aman1117/backend/internal/middleware"
	"github.com/aman1117/backend/internal/response"
	"github.com/aman1117/backend/internal/testutil"
	"github.com/aman1117/backend/pkg/models"
	"github.com/gofiber/fiber/v2"
	"github.com/golang-jwt/jwt/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
	"go.uber.org/zap/zaptest/observer"
)

const (
	// headerTestUser authenticates a request as the given user ID in the test apps.
	headerTestUser = "X-Test-User-ID"
	ipA            = "203.0.113.10"
	ipB            = "198.51.100.7"
	userAgent      = "growth-tests/1.0"
)

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

// ==================== Rate limiters ====================

// newLimitedApp mounts limiter on GET /limited. The app trusts X-Forwarded-For as the client
// IP, and a stand-in for middleware.Auth sets the user_id local from X-Test-User-ID.
func newLimitedApp(limiter fiber.Handler) *fiber.App {
	app := fiber.New(fiber.Config{ProxyHeader: fiber.HeaderXForwardedFor})
	app.Use(func(c *fiber.Ctx) error {
		if raw := c.Get(headerTestUser); raw != "" {
			id, err := strconv.ParseUint(raw, 10, 32)
			if err != nil {
				return err
			}
			c.Locals("user_id", uint(id))
		}
		return c.Next()
	})
	app.Get("/limited", limiter, func(c *fiber.Ctx) error { return c.SendString("ok") })
	return app
}

// client is the sender of a request: an IP address and, if userID > 0, a signed-in user.
type client struct {
	ip     string
	userID uint
}

func (cl client) get(t *testing.T, app *fiber.App) testutil.Response {
	t.Helper()
	opts := []testutil.RequestOption{testutil.WithHeader(fiber.HeaderXForwardedFor, cl.ip)}
	if cl.userID > 0 {
		opts = append(opts, testutil.WithHeader(headerTestUser, strconv.FormatUint(uint64(cl.userID), 10)))
	}
	return testutil.Do(t, app, fiber.MethodGet, "/limited", nil, opts...)
}

// useQuota sends max requests, every one of which must be allowed.
func (cl client) useQuota(t *testing.T, app *fiber.App, max int) {
	t.Helper()
	for i := 1; i <= max; i++ {
		res := cl.get(t, app)
		require.Equal(t, fiber.StatusOK, res.Status, "request %d of %d", i, max)
		require.Equal(t, strconv.Itoa(max), res.Header.Get("X-RateLimit-Limit"))
		require.Equal(t, strconv.Itoa(max-i), res.Header.Get("X-RateLimit-Remaining"))
	}
}

// assertLimited checks the 429 envelope and that Retry-After matches the limiter window.
func assertLimited(t *testing.T, res testutil.Response, message string, window time.Duration) {
	t.Helper()
	assert.Equal(t, fiber.StatusTooManyRequests, res.Status)
	assert.Equal(t, map[string]any{
		"success":    false,
		"error":      message,
		"error_code": constants.ErrCodeRateLimitExceeded,
	}, res.JSON(t))

	retryAfter, err := strconv.Atoi(res.Header.Get(fiber.HeaderRetryAfter))
	require.NoError(t, err, "Retry-After must be a number of seconds")
	assert.LessOrEqual(t, retryAfter, int(window.Seconds()))
	assert.Greater(t, retryAfter, int(window.Seconds())-10, "Retry-After should cover the rest of the window")
}

func TestRateLimiters(t *testing.T) {
	tests := []struct {
		name    string
		limiter func() fiber.Handler
		max     int
		window  time.Duration
		message string
		perUser bool // keyed by the signed-in user, falling back to the IP
	}{
		{name: "AuthRateLimiter", limiter: middleware.AuthRateLimiter, max: constants.RateLimitAuthMaxRequests, window: constants.RateLimitAuthWindow, message: constants.MsgRateLimitAuth},
		{name: "PasswordResetRateLimiter", limiter: middleware.PasswordResetRateLimiter, max: constants.RateLimitPasswordMaxRequests, window: constants.RateLimitPasswordWindow, message: constants.MsgRateLimitPassword},
		{name: "APIRateLimiter", limiter: middleware.APIRateLimiter, max: constants.RateLimitAPIMaxRequests, window: constants.RateLimitAPIWindow, message: constants.MsgRateLimitAPI, perUser: true},
		{name: "UploadRateLimiter", limiter: middleware.UploadRateLimiter, max: constants.RateLimitUploadMaxRequests, window: constants.RateLimitUploadWindow, message: constants.MsgRateLimitUpload, perUser: true},
		{name: "FollowRateLimiter", limiter: middleware.FollowRateLimiter, max: constants.RateLimitFollowMaxRequests, window: constants.RateLimitFollowWindow, message: "Too many follow actions. Please slow down.", perUser: true},
		{name: "AutocompleteRateLimiter", limiter: middleware.AutocompleteRateLimiter, max: constants.RateLimitAutocompleteMaxRequests, window: constants.RateLimitAutocompleteWindow, message: constants.MsgRateLimitAutocomplete, perUser: true},
		{name: "CommentRateLimiter", limiter: middleware.CommentRateLimiter, max: constants.RateLimitCommentMaxRequests, window: constants.RateLimitCommentWindow, message: constants.MsgRateLimitComment, perUser: true},
		{name: "CommentLikeRateLimiter", limiter: middleware.CommentLikeRateLimiter, max: constants.RateLimitCommentLikeMaxRequests, window: constants.RateLimitCommentLikeWindow, message: constants.MsgRateLimitCommentLike, perUser: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if !tt.perUser {
				t.Run("limits each IP whoever is signed in", func(t *testing.T) {
					app := newLimitedApp(tt.limiter())
					alice := client{ip: ipA, userID: 1}

					alice.useQuota(t, app, tt.max)

					assertLimited(t, alice.get(t, app), tt.message, tt.window)
					assertLimited(t, client{ip: ipA, userID: 2}.get(t, app), tt.message, tt.window)
					assertLimited(t, client{ip: ipA}.get(t, app), tt.message, tt.window)
					assert.Equal(t, fiber.StatusOK, client{ip: ipB, userID: 1}.get(t, app).Status, "another IP has its own quota")
				})
				return
			}

			t.Run("limits each signed-in user separately", func(t *testing.T) {
				app := newLimitedApp(tt.limiter())
				alice := client{ip: ipA, userID: 1}

				alice.useQuota(t, app, tt.max)

				assertLimited(t, alice.get(t, app), tt.message, tt.window)
				assertLimited(t, client{ip: ipB, userID: 1}.get(t, app), tt.message, tt.window)
				assert.Equal(t, fiber.StatusOK, client{ip: ipA, userID: 2}.get(t, app).Status, "other users on the same IP are not affected")
				assert.Equal(t, fiber.StatusOK, client{ip: ipA}.get(t, app).Status, "anonymous requests from the same IP are not affected")
			})

			t.Run("limits anonymous requests by IP", func(t *testing.T) {
				app := newLimitedApp(tt.limiter())
				anonymous := client{ip: ipA}

				anonymous.useQuota(t, app, tt.max)

				assertLimited(t, anonymous.get(t, app), tt.message, tt.window)
				assert.Equal(t, fiber.StatusOK, client{ip: ipB}.get(t, app).Status, "another IP has its own quota")
				assert.Equal(t, fiber.StatusOK, client{ip: ipA, userID: 1}.get(t, app).Status, "signed-in users have their own quota")
			})
		})
	}
}

func TestNewRateLimiter_UsesKeyFuncAndMessageAndLogsRejections(t *testing.T) {
	logs := observeLogs(t)
	app := fiber.New(fiber.Config{ProxyHeader: fiber.HeaderXForwardedFor})
	app.Post("/keys", middleware.NewRateLimiter(middleware.RateLimitConfig{
		Max:        2,
		Expiration: time.Minute,
		Message:    "Slow down, key holder.",
		KeyFunc:    func(c *fiber.Ctx) string { return c.Get("X-API-Key") },
	}), func(c *fiber.Ctx) error { return c.SendStatus(fiber.StatusNoContent) })
	send := func(key, ip string) testutil.Response {
		return testutil.Do(t, app, fiber.MethodPost, "/keys", nil,
			testutil.WithHeader("X-API-Key", key), testutil.WithHeader(fiber.HeaderXForwardedFor, ip))
	}

	assert.Equal(t, fiber.StatusNoContent, send("key-a", ipA).Status)
	assert.Equal(t, fiber.StatusNoContent, send("key-a", ipB).Status)
	assertLimited(t, send("key-a", ipA), "Slow down, key holder.", time.Minute)
	assert.Equal(t, fiber.StatusNoContent, send("key-b", ipA).Status)

	rejected := logs.FilterMessage("Rate limit exceeded").All()
	require.Len(t, rejected, 1)
	assert.Equal(t, zapcore.WarnLevel, rejected[0].Level)
	assert.Equal(t, map[string]any{"ip": ipA, "path": "/keys", "method": fiber.MethodPost}, rejected[0].ContextMap())
}

func TestNewRateLimiter_DefaultsToTheClientIP(t *testing.T) {
	app := newLimitedApp(middleware.NewRateLimiter(middleware.RateLimitConfig{
		Max:        1,
		Expiration: 30 * time.Second,
		Message:    "Too many requests.",
	}))

	assert.Equal(t, fiber.StatusOK, client{ip: ipA}.get(t, app).Status)
	assertLimited(t, client{ip: ipA, userID: 1}.get(t, app), "Too many requests.", 30*time.Second)
	assert.Equal(t, fiber.StatusOK, client{ip: ipB, userID: 1}.get(t, app).Status)
}

// ==================== Request logging ====================

var traceIDPattern = regexp.MustCompile(`^[0-9a-f]{8}$`)

func newLoggedApp() *fiber.App {
	app := fiber.New(fiber.Config{ProxyHeader: fiber.HeaderXForwardedFor})
	app.Use(middleware.RequestLogger)
	sendTraceID := func(c *fiber.Ctx) error {
		traceID, _ := c.Locals("trace_id").(string)
		return c.SendString(traceID)
	}
	app.Get("/ok", sendTraceID)
	app.Get("/me", testutil.AsUser(42, "alice"), sendTraceID)
	app.Get("/bad", func(c *fiber.Ctx) error { return response.InvalidRequest(c) })
	app.Get("/private", testutil.AsUser(42, "alice"), response.PrivateAccount)
	app.Get("/boom", response.ServerError)
	app.Get("/teapot", func(c *fiber.Ctx) error { return fiber.ErrTeapot })
	app.Get("/fails", func(c *fiber.Ctx) error { return errors.New("database exploded") })
	return app
}

func TestRequestLogger_LogsEveryRequestAtALevelMatchingItsStatus(t *testing.T) {
	tests := []struct {
		path          string
		wantStatus    int
		wantLevel     zapcore.Level
		wantUserID    uint
		wantIP        bool
		wantUserAgent bool
	}{
		{path: "/ok", wantStatus: fiber.StatusOK, wantLevel: zapcore.InfoLevel},
		{path: "/me", wantStatus: fiber.StatusOK, wantLevel: zapcore.InfoLevel, wantUserID: 42},
		{path: "/bad", wantStatus: fiber.StatusBadRequest, wantLevel: zapcore.WarnLevel, wantIP: true},
		{path: "/private", wantStatus: fiber.StatusForbidden, wantLevel: zapcore.WarnLevel, wantUserID: 42, wantIP: true},
		{path: "/boom", wantStatus: fiber.StatusInternalServerError, wantLevel: zapcore.ErrorLevel, wantIP: true, wantUserAgent: true},
	}
	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			logs := observeLogs(t)

			res := testutil.Do(t, newLoggedApp(), fiber.MethodGet, tt.path, nil,
				testutil.WithHeader(fiber.HeaderXForwardedFor, ipA), testutil.WithHeader(fiber.HeaderUserAgent, userAgent))

			require.Equal(t, tt.wantStatus, res.Status)
			entries := logs.FilterMessage("HTTP Request").All()
			require.Len(t, entries, 1)
			assert.Equal(t, tt.wantLevel, entries[0].Level)

			fields := entries[0].ContextMap()
			traceID, _ := fields["trace_id"].(string)
			assert.Regexp(t, traceIDPattern, traceID)
			if tt.wantStatus == fiber.StatusOK {
				assert.Equal(t, string(res.Body), traceID, "handlers see the logged trace_id")
			}
			assert.Equal(t, fiber.MethodGet, fields["method"])
			assert.Equal(t, tt.path, fields["path"])
			assert.EqualValues(t, tt.wantStatus, fields["status"])
			duration, ok := fields["duration"].(time.Duration)
			assert.True(t, ok, "duration must be logged as a duration")
			assert.GreaterOrEqual(t, duration, time.Duration(0))

			want := map[string]any{"user_id": nil, "ip": nil, "user_agent": nil}
			if tt.wantUserID > 0 {
				want["user_id"] = uint64(tt.wantUserID)
			}
			if tt.wantIP {
				want["ip"] = ipA
			}
			if tt.wantUserAgent {
				want["user_agent"] = userAgent
			}
			for key, value := range want {
				assert.Equal(t, value, fields[key], key)
			}
		})
	}
}

func TestRequestLogger_AssignsAFreshTraceIDPerRequest(t *testing.T) {
	observeLogs(t)
	app := newLoggedApp()

	first := string(testutil.Do(t, app, fiber.MethodGet, "/ok", nil).Body)
	second := string(testutil.Do(t, app, fiber.MethodGet, "/ok", nil).Body)

	assert.Regexp(t, traceIDPattern, first)
	assert.Regexp(t, traceIDPattern, second)
	assert.NotEqual(t, first, second)
}

// Handlers may return an error instead of writing a response; the log must show the status
// the error handler finally sent, not the 200 the response held before it ran.
func TestRequestLogger_LogsTheFinalStatusOfReturnedErrors(t *testing.T) {
	tests := []struct {
		path          string
		wantStatus    int
		wantBody      string
		wantLevel     zapcore.Level
		wantUserAgent bool
	}{
		{path: "/teapot", wantStatus: fiber.StatusTeapot, wantBody: "I'm a teapot", wantLevel: zapcore.WarnLevel},
		{path: "/missing", wantStatus: fiber.StatusNotFound, wantBody: "Cannot GET /missing", wantLevel: zapcore.WarnLevel},
		{path: "/fails", wantStatus: fiber.StatusInternalServerError, wantBody: "database exploded", wantLevel: zapcore.ErrorLevel, wantUserAgent: true},
	}
	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			logs := observeLogs(t)

			res := testutil.Do(t, newLoggedApp(), fiber.MethodGet, tt.path, nil,
				testutil.WithHeader(fiber.HeaderXForwardedFor, ipA), testutil.WithHeader(fiber.HeaderUserAgent, userAgent))

			assert.Equal(t, tt.wantStatus, res.Status, "the client still gets the error handler's response")
			assert.Equal(t, tt.wantBody, string(res.Body))
			entries := logs.FilterMessage("HTTP Request").All()
			require.Len(t, entries, 1)
			assert.Equal(t, tt.wantLevel, entries[0].Level)
			fields := entries[0].ContextMap()
			assert.EqualValues(t, tt.wantStatus, fields["status"])
			assert.Equal(t, ipA, fields["ip"])
			if tt.wantUserAgent {
				assert.Equal(t, userAgent, fields["user_agent"])
			}
		})
	}
}

func TestRequestLogger_RunsTheAppErrorHandlerOnce(t *testing.T) {
	logs := observeLogs(t)
	calls := 0
	app := fiber.New(fiber.Config{ErrorHandler: func(c *fiber.Ctx, err error) error {
		calls++
		return response.Error(c, fiber.StatusUnprocessableEntity, err.Error(), constants.ErrCodeInvalidInput)
	}})
	app.Use(middleware.RequestLogger)
	app.Get("/invalid", func(c *fiber.Ctx) error { return errors.New("bad input") })

	res := testutil.Do(t, app, fiber.MethodGet, "/invalid", nil)

	assert.Equal(t, 1, calls)
	assert.Equal(t, fiber.StatusUnprocessableEntity, res.Status)
	assert.Equal(t, map[string]any{"success": false, "error": "bad input", "error_code": constants.ErrCodeInvalidInput}, res.JSON(t))
	entries := logs.FilterMessage("HTTP Request").All()
	require.Len(t, entries, 1)
	assert.Equal(t, zapcore.WarnLevel, entries[0].Level)
	assert.EqualValues(t, fiber.StatusUnprocessableEntity, entries[0].ContextMap()["status"])
}

func TestRequestLogger_Logs500WhenTheErrorHandlerFails(t *testing.T) {
	logs := observeLogs(t)
	app := fiber.New(fiber.Config{ErrorHandler: func(c *fiber.Ctx, err error) error {
		return errors.New("error handler failed")
	}})
	app.Use(middleware.RequestLogger)
	app.Get("/teapot", func(c *fiber.Ctx) error { return fiber.ErrTeapot })

	res := testutil.Do(t, app, fiber.MethodGet, "/teapot", nil)

	assert.Equal(t, fiber.StatusInternalServerError, res.Status)
	entries := logs.FilterMessage("HTTP Request").All()
	require.Len(t, entries, 1)
	assert.Equal(t, zapcore.ErrorLevel, entries[0].Level)
	assert.EqualValues(t, fiber.StatusInternalServerError, entries[0].ContextMap()["status"])
}

// ==================== Authentication ====================

// newAuthApp protects GET /private with middleware.Auth. The handler echoes the locals it sees
// and counts its calls.
func newAuthApp(tokens *handlers.TokenService) (*fiber.App, *int) {
	calls := 0
	app := fiber.New()
	app.Get("/private", middleware.Auth(tokens), func(c *fiber.Ctx) error {
		calls++
		userID, isUint := c.Locals("user_id").(uint)
		username, _ := c.Locals("username").(string)
		return c.JSON(fiber.Map{"user_id": userID, "user_id_is_uint": isUint, "username": username})
	})
	return app, &calls
}

func generate(t *testing.T, tokens *handlers.TokenService, user *models.User) string {
	t.Helper()
	token, _, _, err := tokens.Generate(user)
	require.NoError(t, err)
	return token
}

func unsignedToken(t *testing.T, user *models.User) string {
	t.Helper()
	claims := &handlers.Claims{
		UserID:           user.ID,
		Username:         user.Username,
		RegisteredClaims: jwt.RegisteredClaims{ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour))},
	}
	token, err := jwt.NewWithClaims(jwt.SigningMethodNone, claims).SignedString(jwt.UnsafeAllowNoneSignatureType)
	require.NoError(t, err)
	return token
}

// withPayload swaps the claims of a signed token while keeping the original signature.
func withPayload(t *testing.T, token string, claims map[string]any) string {
	t.Helper()
	parts := strings.Split(token, ".")
	require.Len(t, parts, 3)
	payload, err := json.Marshal(claims)
	require.NoError(t, err)
	parts[1] = base64.RawURLEncoding.EncodeToString(payload)
	return strings.Join(parts, ".")
}

func TestAuth_RejectsMissingOrInvalidCredentials(t *testing.T) {
	cfg := testutil.Config()
	tokens := handlers.NewTokenService(&cfg.JWT)
	alice := &models.User{ID: 42, Username: "alice"}
	valid := generate(t, tokens, alice)

	otherSecret := generate(t, handlers.NewTokenService(&config.JWTConfig{SecretKey: "some-other-secret", AccessTokenTTL: time.Hour}), alice)
	expired := generate(t, handlers.NewTokenService(&config.JWTConfig{SecretKey: cfg.JWT.SecretKey, AccessTokenTTL: -time.Minute}), alice)
	tampered := withPayload(t, valid, map[string]any{
		"user_id": 1, "username": "admin", "exp": time.Now().Add(time.Hour).Unix(),
	})

	const (
		missingHeader = "Missing Authorization Header"
		invalidHeader = "Invalid Authorization Header"
		invalidToken  = "Invalid token"
	)
	tests := []struct {
		name     string
		header   string
		wantMsg  string
		wantCode string
	}{
		{name: "missing header", header: "", wantMsg: missingHeader, wantCode: constants.ErrCodeMissingAuthHeader},
		{name: "basic scheme", header: "Basic dXNlcjpwYXNz", wantMsg: invalidHeader, wantCode: constants.ErrCodeInvalidAuthHeader},
		{name: "token without a scheme", header: valid, wantMsg: invalidHeader, wantCode: constants.ErrCodeInvalidAuthHeader},
		{name: "scheme without a token", header: "Bearer", wantMsg: invalidHeader, wantCode: constants.ErrCodeInvalidAuthHeader},
		{name: "malformed token", header: "Bearer not-a-jwt", wantMsg: invalidToken, wantCode: constants.ErrCodeInvalidToken},
		{name: "signed with another secret", header: "Bearer " + otherSecret, wantMsg: invalidToken, wantCode: constants.ErrCodeInvalidToken},
		{name: "expired", header: "Bearer " + expired, wantMsg: invalidToken, wantCode: constants.ErrCodeInvalidToken},
		{name: "unsigned (alg none)", header: "Bearer " + unsignedToken(t, alice), wantMsg: invalidToken, wantCode: constants.ErrCodeInvalidToken},
		{name: "tampered claims", header: "Bearer " + tampered, wantMsg: invalidToken, wantCode: constants.ErrCodeInvalidToken},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			app, calls := newAuthApp(tokens)
			var opts []testutil.RequestOption
			if tt.header != "" {
				opts = append(opts, testutil.WithHeader(fiber.HeaderAuthorization, tt.header))
			}

			res := testutil.Do(t, app, fiber.MethodGet, "/private", nil, opts...)

			assert.Equal(t, fiber.StatusUnauthorized, res.Status)
			assert.Equal(t, map[string]any{"success": false, "error": tt.wantMsg, "error_code": tt.wantCode}, res.JSON(t))
			assert.Zero(t, *calls, "the protected handler must not run")
		})
	}
}

func TestAuth_ValidTokenSetsUserLocals(t *testing.T) {
	cfg := testutil.Config()
	tokens := handlers.NewTokenService(&cfg.JWT)
	token := generate(t, tokens, &models.User{ID: 42, Username: "alice"})

	tests := map[string]string{
		"bearer token":                    "Bearer " + token,
		"extra whitespace before a token": "Bearer   " + token,
	}
	for name, header := range tests {
		t.Run(name, func(t *testing.T) {
			app, calls := newAuthApp(tokens)

			res := testutil.Do(t, app, fiber.MethodGet, "/private", nil, testutil.WithHeader(fiber.HeaderAuthorization, header))

			require.Equal(t, fiber.StatusOK, res.Status)
			assert.Equal(t, map[string]any{"user_id": float64(42), "user_id_is_uint": true, "username": "alice"}, res.JSON(t))
			assert.Equal(t, 1, *calls)
		})
	}
}
