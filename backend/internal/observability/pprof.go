// Package observability provides runtime profiling and monitoring utilities.
package observability

import (
	"log"
	"strings"
	"time"

	"github.com/aman1117/backend/internal/config"
	"github.com/aman1117/backend/internal/logger"
	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/limiter"
	"github.com/gofiber/fiber/v2/middleware/pprof"
)

// #Plan: RegisterPprof
// 1. If pprof is disabled, log and return early (routes not registered, will 404).
// 2. Register path-scoped middleware for rate limiting and token auth.
// 3. Register pprof middleware with the configured prefix.
// 4. Log startup status (enabled at prefix, never log token).

// RegisterPprof conditionally registers pprof endpoints on the Fiber app.
// If cfg.Enabled is false, no routes are registered and requests will 404.
// If cfg.Token is set, requests must include the token in Authorization or X-PPROF-Token header.
func RegisterPprof(app *fiber.App, cfg config.PprofConfig) {
	// Step 1: Check if pprof is enabled
	if !cfg.Enabled {
		logInfo("pprof disabled (PPROF_ENABLED=false)")
		return
	}

	// Normalize prefix for middleware path matching
	// Note: Fiber pprof middleware always serves at /debug/pprof/, the Prefix config
	// is prepended to that path. So Prefix="" means /debug/pprof/, Prefix="/api" means /api/debug/pprof/
	prefix := cfg.Prefix
	if prefix == "" {
		prefix = "/debug/pprof"
	}
	if !strings.HasPrefix(prefix, "/") {
		prefix = "/" + prefix
	}
	prefix = strings.TrimSuffix(prefix, "/")

	// Determine the actual pprof path based on config
	// If prefix is "/debug/pprof" (default), use empty prefix for pprof middleware (serves at /debug/pprof/)
	// Otherwise, treat prefix as a custom path prefix
	var pprofPrefix string
	var actualPath string
	if prefix == "/debug/pprof" {
		pprofPrefix = ""
		actualPath = "/debug/pprof"
	} else {
		// Custom prefix - pprof will serve at {prefix}/debug/pprof/
		pprofPrefix = prefix
		actualPath = prefix + "/debug/pprof"
	}

	// Step 2: Add path-scoped rate limiter to protect against abuse
	// Profile endpoints can be CPU/memory intensive, limit to 5 req per 30 seconds per IP
	rateLimiter := limiter.New(limiter.Config{
		Max:        5,
		Expiration: 30 * time.Second,
		KeyGenerator: func(c *fiber.Ctx) string {
			return c.IP()
		},
		LimitReached: func(c *fiber.Ctx) error {
			return c.Status(fiber.StatusTooManyRequests).JSON(fiber.Map{
				"error": "rate limit exceeded for pprof endpoints",
			})
		},
		SkipFailedRequests: true,
		Next: func(c *fiber.Ctx) bool {
			// Only apply rate limiter to pprof paths
			return !strings.HasPrefix(c.Path(), actualPath)
		},
	})
	app.Use(rateLimiter)

	// Step 3: Add token authentication if configured (path-scoped)
	if cfg.Token != "" {
		app.Use(pprofAuthMiddleware(cfg.Token, actualPath))
	}

	// Step 4: Register pprof middleware
	// The pprof middleware registers handlers for /debug/pprof/, /debug/pprof/profile, etc.
	app.Use(pprof.New(pprof.Config{
		Prefix: pprofPrefix,
	}))

	// Step 5: Log startup status
	if cfg.Token != "" {
		logInfo("pprof enabled at " + actualPath + " (token-protected)")
	} else {
		logInfo("pprof enabled at " + actualPath + " (no auth - recommend setting PPROF_TOKEN)")
	}
}

// logInfo logs a message using the application logger if available, otherwise uses standard log.
func logInfo(msg string) {
	if logger.Sugar != nil {
		logger.Sugar.Info(msg)
	} else {
		log.Println(msg)
	}
}

// pprofAuthMiddleware returns a Fiber handler that validates pprof token authentication.
// Only applies to paths starting with the given prefix.
// Accepts token via:
//   - Authorization: Bearer <token>
//   - X-PPROF-Token: <token>
func pprofAuthMiddleware(expectedToken string, prefix string) fiber.Handler {
	return func(c *fiber.Ctx) error {
		// Only apply auth to pprof paths
		if !strings.HasPrefix(c.Path(), prefix) {
			return c.Next()
		}

		// Check Authorization header (Bearer token)
		authHeader := c.Get("Authorization")
		if authHeader != "" {
			// Expect format: "Bearer <token>"
			parts := strings.SplitN(authHeader, " ", 2)
			if len(parts) == 2 && strings.EqualFold(parts[0], "Bearer") {
				if parts[1] == expectedToken {
					return c.Next()
				}
			}
		}

		// Check X-PPROF-Token header
		pprofToken := c.Get("X-PPROF-Token")
		if pprofToken == expectedToken {
			return c.Next()
		}

		// No valid token provided
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
			"error": "unauthorized: valid pprof token required",
		})
	}
}
