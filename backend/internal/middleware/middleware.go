// Package middleware provides HTTP middleware for the application.
package middleware

import (
	"fmt"
	"strings"
	"time"

	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/handlers"
	"github.com/aman1117/backend/internal/logger"
	"github.com/aman1117/backend/internal/response"
	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/limiter"
	"github.com/google/uuid"
	"go.uber.org/zap"
)

// ==================== Rate Limiters ====================

// RateLimitConfig holds configuration for a rate limiter
type RateLimitConfig struct {
	Max        int
	Expiration time.Duration
	Message    string
	KeyFunc    func(*fiber.Ctx) string
}

// NewRateLimiter creates a new rate limiter middleware with the given config
func NewRateLimiter(cfg RateLimitConfig) fiber.Handler {
	return limiter.New(limiter.Config{
		Max:        cfg.Max,
		Expiration: cfg.Expiration,
		KeyGenerator: func(c *fiber.Ctx) string {
			if cfg.KeyFunc != nil {
				return cfg.KeyFunc(c)
			}
			// Default: rate limit by IP
			return c.IP()
		},
		LimitReached: func(c *fiber.Ctx) error {
			logger.Sugar.Warnw("Rate limit exceeded",
				"ip", c.IP(),
				"path", c.Path(),
				"method", c.Method(),
			)
			return response.Error(c, fiber.StatusTooManyRequests, cfg.Message, constants.ErrCodeRateLimitExceeded)
		},
		SkipFailedRequests:     false,
		SkipSuccessfulRequests: false,
	})
}

// AuthRateLimiter returns a rate limiter for authentication endpoints
// Strict: 5 requests per minute per IP
func AuthRateLimiter() fiber.Handler {
	return NewRateLimiter(RateLimitConfig{
		Max:        constants.RateLimitAuthMaxRequests,
		Expiration: constants.RateLimitAuthWindow,
		Message:    constants.MsgRateLimitAuth,
	})
}

// PasswordResetRateLimiter returns a rate limiter for password reset endpoints
// Very strict: 3 requests per hour per IP
func PasswordResetRateLimiter() fiber.Handler {
	return NewRateLimiter(RateLimitConfig{
		Max:        constants.RateLimitPasswordMaxRequests,
		Expiration: constants.RateLimitPasswordWindow,
		Message:    constants.MsgRateLimitPassword,
	})
}

// APIRateLimiter returns a rate limiter for general API endpoints
// Moderate: 100 requests per minute per user (or IP if not authenticated)
func APIRateLimiter() fiber.Handler {
	return NewRateLimiter(RateLimitConfig{
		Max:        constants.RateLimitAPIMaxRequests,
		Expiration: constants.RateLimitAPIWindow,
		Message:    constants.MsgRateLimitAPI,
		KeyFunc: func(c *fiber.Ctx) string {
			// Rate limit by user ID if authenticated, otherwise by IP
			if userID, ok := c.Locals("user_id").(uint); ok && userID > 0 {
				return fmt.Sprintf("user:%d", userID)
			}
			return c.IP()
		},
	})
}

// UploadRateLimiter returns a rate limiter for file upload endpoints
// Strict: 10 uploads per minute per user
func UploadRateLimiter() fiber.Handler {
	return NewRateLimiter(RateLimitConfig{
		Max:        constants.RateLimitUploadMaxRequests,
		Expiration: constants.RateLimitUploadWindow,
		Message:    constants.MsgRateLimitUpload,
		KeyFunc: func(c *fiber.Ctx) string {
			if userID, ok := c.Locals("user_id").(uint); ok && userID > 0 {
				return fmt.Sprintf("upload:%d", userID)
			}
			return c.IP()
		},
	})
}

// FollowRateLimiter returns a rate limiter for follow/unfollow endpoints
// Moderate: 60 follow actions per minute per user
func FollowRateLimiter() fiber.Handler {
	return NewRateLimiter(RateLimitConfig{
		Max:        constants.RateLimitFollowMaxRequests,
		Expiration: constants.RateLimitFollowWindow,
		Message:    "Too many follow actions. Please slow down.",
		KeyFunc: func(c *fiber.Ctx) string {
			if userID, ok := c.Locals("user_id").(uint); ok && userID > 0 {
				return fmt.Sprintf("follow:%d", userID)
			}
			return c.IP()
		},
	})
}

// AutocompleteRateLimiter returns a lenient rate limiter for autocomplete endpoints
// Lenient: 60 requests per minute per user (supports rapid typing)
func AutocompleteRateLimiter() fiber.Handler {
	return NewRateLimiter(RateLimitConfig{
		Max:        constants.RateLimitAutocompleteMaxRequests,
		Expiration: constants.RateLimitAutocompleteWindow,
		Message:    constants.MsgRateLimitAutocomplete,
		KeyFunc: func(c *fiber.Ctx) string {
			if userID, ok := c.Locals("user_id").(uint); ok && userID > 0 {
				return fmt.Sprintf("autocomplete:%d", userID)
			}
			return c.IP()
		},
	})
}

// ==================== Request Logging ====================

// RequestLogger logs all incoming HTTP requests with timing and trace_id
func RequestLogger(c *fiber.Ctx) error {
	start := time.Now()

	// Generate trace_id for this request
	traceID := uuid.New().String()[:constants.TraceIDLength]
	c.Locals("trace_id", traceID)

	// Process request
	err := c.Next()

	// Calculate duration
	duration := time.Since(start)

	// Get status code
	status := c.Response().StatusCode()

	// Get user_id if available
	userID, _ := c.Locals("user_id").(uint)

	// Base fields for all requests
	fields := []zap.Field{
		zap.String("trace_id", traceID),
		zap.String("method", c.Method()),
		zap.String("path", c.Path()),
		zap.Int("status", status),
		zap.Duration("duration", duration),
	}

	if userID > 0 {
		fields = append(fields, zap.Uint("user_id", userID))
	}

	// Determine log level based on status
	if status >= 500 {
		fields = append(fields,
			zap.String("ip", c.IP()),
			zap.String("user_agent", c.Get("User-Agent")),
		)
		logger.Log.Error("HTTP Request", fields...)
	} else if status >= 400 {
		fields = append(fields, zap.String("ip", c.IP()))
		logger.Log.Warn("HTTP Request", fields...)
	} else {
		logger.Log.Info("HTTP Request", fields...)
	}

	return err
}

// Auth validates JWT tokens and sets user context
func Auth(tokenSvc *handlers.TokenService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		authHeader := c.Get("Authorization")
		if authHeader == "" {
			return response.Unauthorized(c, "Missing Authorization Header", constants.ErrCodeMissingAuthHeader)
		}

		if !strings.HasPrefix(authHeader, constants.BearerPrefix) {
			return response.Unauthorized(c, "Invalid Authorization Header", constants.ErrCodeInvalidAuthHeader)
		}

		tokenStr := strings.TrimSpace(authHeader[len(constants.BearerPrefix):])

		claims, err := tokenSvc.Parse(tokenStr)
		if err != nil {
			return response.Unauthorized(c, "Invalid token", constants.ErrCodeInvalidToken)
		}

		c.Locals("user_id", claims.UserID)
		c.Locals("username", claims.Username)

		return c.Next()
	}
}
