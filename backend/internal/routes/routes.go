// Package routes defines all HTTP routes for the application.
package routes

import (
	_ "github.com/aman1117/backend/docs" // swagger docs

	"github.com/aman1117/backend/internal/handlers"
	"github.com/aman1117/backend/internal/middleware"
	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/swagger"
)

// Router holds all route handlers
type Router struct {
	authHandler          *handlers.AuthHandler
	profileHandler       *handlers.ProfileHandler
	activityHandler      *handlers.ActivityHandler
	streakHandler        *handlers.StreakHandler
	analyticsHandler     *handlers.AnalyticsHandler
	tileConfigHandler    *handlers.TileConfigHandler
	passwordResetHandler *handlers.PasswordResetHandler
	blobHandler          *handlers.BlobHandler
	likeHandler          *handlers.LikeHandler
	tokenSvc             *handlers.TokenService
}

// NewRouter creates a new Router with all handlers
func NewRouter(
	authHandler *handlers.AuthHandler,
	profileHandler *handlers.ProfileHandler,
	activityHandler *handlers.ActivityHandler,
	streakHandler *handlers.StreakHandler,
	analyticsHandler *handlers.AnalyticsHandler,
	tileConfigHandler *handlers.TileConfigHandler,
	passwordResetHandler *handlers.PasswordResetHandler,
	blobHandler *handlers.BlobHandler,
	likeHandler *handlers.LikeHandler,
	tokenSvc *handlers.TokenService,
) *Router {
	return &Router{
		authHandler:          authHandler,
		profileHandler:       profileHandler,
		activityHandler:      activityHandler,
		streakHandler:        streakHandler,
		analyticsHandler:     analyticsHandler,
		tileConfigHandler:    tileConfigHandler,
		passwordResetHandler: passwordResetHandler,
		blobHandler:          blobHandler,
		likeHandler:          likeHandler,
		tokenSvc:             tokenSvc,
	}
}

// Setup configures all routes on the Fiber app
func (r *Router) Setup(app *fiber.App) {
	// Health check (no rate limit)
	app.Get("/", func(c *fiber.Ctx) error {
		return c.SendString("API is running...")
	})

	// Swagger documentation (no rate limit)
	app.Get("/swagger/*", swagger.HandlerDefault)

	// Middleware
	authMiddleware := middleware.Auth(r.tokenSvc)
	authRateLimiter := middleware.AuthRateLimiter()
	passwordRateLimiter := middleware.PasswordResetRateLimiter()
	apiRateLimiter := middleware.APIRateLimiter()
	uploadRateLimiter := middleware.UploadRateLimiter()

	// ==================== Public Routes ====================

	// Authentication (strict rate limiting: 5 req/min)
	app.Post("/register", authRateLimiter, r.authHandler.Register)
	app.Post("/login", authRateLimiter, r.authHandler.Login)

	// Password Reset (very strict rate limiting: 3 req/hour)
	auth := app.Group("/auth")
	auth.Post("/forgot-password", passwordRateLimiter, r.passwordResetHandler.ForgotPassword)
	auth.Post("/reset-password", passwordRateLimiter, r.passwordResetHandler.ResetPassword)
	auth.Get("/reset-password/validate", passwordRateLimiter, r.passwordResetHandler.ValidateResetToken)

	// ==================== Protected Routes ====================
	// All protected routes have: auth middleware + API rate limiter (100 req/min)

	// User Search
	app.Post("/users", authMiddleware, apiRateLimiter, r.profileHandler.SearchUsers)

	// Activities
	app.Post("/create-activity", authMiddleware, apiRateLimiter, r.activityHandler.CreateActivity)
	app.Post("/get-activities", authMiddleware, apiRateLimiter, r.activityHandler.GetActivities)

	// Streaks
	app.Post("/get-streak", authMiddleware, apiRateLimiter, r.streakHandler.GetStreak)

	// Analytics
	app.Post("/get-week-analytics", authMiddleware, apiRateLimiter, r.analyticsHandler.GetWeekAnalytics)

	// Tile Configuration
	app.Get("/tile-config", authMiddleware, apiRateLimiter, r.tileConfigHandler.GetConfig)
	app.Post("/tile-config", authMiddleware, apiRateLimiter, r.tileConfigHandler.SaveConfig)
	app.Post("/tile-config/user", authMiddleware, apiRateLimiter, r.tileConfigHandler.GetConfigByUsername)

	// Likes
	app.Post("/like-day", authMiddleware, apiRateLimiter, r.likeHandler.LikeDay)
	app.Post("/unlike-day", authMiddleware, apiRateLimiter, r.likeHandler.UnlikeDay)
	app.Post("/get-likes", authMiddleware, apiRateLimiter, r.likeHandler.GetLikes)

	// Profile Management
	app.Post("/update-username", authMiddleware, apiRateLimiter, r.authHandler.UpdateUsername)
	app.Post("/update-privacy", authMiddleware, apiRateLimiter, r.profileHandler.UpdatePrivacy)
	app.Get("/get-privacy", authMiddleware, apiRateLimiter, r.profileHandler.GetPrivacy)
	app.Post("/update-bio", authMiddleware, apiRateLimiter, r.profileHandler.UpdateBio)
	app.Get("/get-bio", authMiddleware, apiRateLimiter, r.profileHandler.GetBio)
	app.Post("/change-password", authMiddleware, authRateLimiter, r.authHandler.ChangePassword) // Strict rate limit for password change

	// Profile Picture (with upload-specific rate limiting)
	profile := app.Group("/profile", authMiddleware)
	profile.Get("", apiRateLimiter, r.profileHandler.GetProfile)
	if r.blobHandler != nil {
		profile.Post("/upload-picture", uploadRateLimiter, r.blobHandler.UploadProfilePicture)
		profile.Delete("/picture", apiRateLimiter, r.blobHandler.DeleteProfilePicture)
	}
}
