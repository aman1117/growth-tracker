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
	authHandler           *handlers.AuthHandler
	profileHandler        *handlers.ProfileHandler
	activityHandler       *handlers.ActivityHandler
	streakHandler         *handlers.StreakHandler
	analyticsHandler      *handlers.AnalyticsHandler
	tileConfigHandler     *handlers.TileConfigHandler
	passwordResetHandler  *handlers.PasswordResetHandler
	blobHandler           *handlers.BlobHandler
	likeHandler           *handlers.LikeHandler
	badgeHandler          *handlers.BadgeHandler
	notificationHandler   *handlers.NotificationHandler
	notificationWSHandler *handlers.NotificationWSHandler
	pushHandler           *handlers.PushHandler
	followHandler         *handlers.FollowHandler
	tokenSvc              *handlers.TokenService
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
	badgeHandler *handlers.BadgeHandler,
	notificationHandler *handlers.NotificationHandler,
	notificationWSHandler *handlers.NotificationWSHandler,
	pushHandler *handlers.PushHandler,
	followHandler *handlers.FollowHandler,
	tokenSvc *handlers.TokenService,
) *Router {
	return &Router{
		authHandler:           authHandler,
		profileHandler:        profileHandler,
		activityHandler:       activityHandler,
		streakHandler:         streakHandler,
		analyticsHandler:      analyticsHandler,
		tileConfigHandler:     tileConfigHandler,
		passwordResetHandler:  passwordResetHandler,
		blobHandler:           blobHandler,
		likeHandler:           likeHandler,
		badgeHandler:          badgeHandler,
		notificationHandler:   notificationHandler,
		notificationWSHandler: notificationWSHandler,
		pushHandler:           pushHandler,
		followHandler:         followHandler,
		tokenSvc:              tokenSvc,
	}
}

// Setup configures all routes on the Fiber app
func (r *Router) Setup(app *fiber.App) {
	// Health check (no rate limit) - keep at root
	app.Get("/", func(c *fiber.Ctx) error {
		return c.SendString("API is running...")
	})

	// Swagger documentation (no rate limit) - keep at root
	app.Get("/swagger/*", swagger.HandlerDefault)

	// Middleware
	authMiddleware := middleware.Auth(r.tokenSvc)
	authRateLimiter := middleware.AuthRateLimiter()
	passwordRateLimiter := middleware.PasswordResetRateLimiter()
	apiRateLimiter := middleware.APIRateLimiter()
	uploadRateLimiter := middleware.UploadRateLimiter()

	// API group - all routes under /api prefix
	api := app.Group("/api")

	// ==================== Public Routes ====================

	// Authentication (strict rate limiting: 5 req/min)
	api.Post("/register", authRateLimiter, r.authHandler.Register)
	api.Post("/login", authRateLimiter, r.authHandler.Login)

	// Password Reset (very strict rate limiting: 3 req/hour)
	auth := api.Group("/auth")
	auth.Post("/forgot-password", passwordRateLimiter, r.passwordResetHandler.ForgotPassword)
	auth.Post("/reset-password", passwordRateLimiter, r.passwordResetHandler.ResetPassword)
	auth.Get("/reset-password/validate", passwordRateLimiter, r.passwordResetHandler.ValidateResetToken)

	// ==================== Protected Routes ====================
	// All protected routes have: auth middleware + API rate limiter (100 req/min)

	// User Search
	api.Post("/users", authMiddleware, apiRateLimiter, r.profileHandler.SearchUsers)

	// Activities
	api.Post("/create-activity", authMiddleware, apiRateLimiter, r.activityHandler.CreateActivity)
	api.Post("/get-activities", authMiddleware, apiRateLimiter, r.activityHandler.GetActivities)

	// Streaks
	api.Post("/get-streak", authMiddleware, apiRateLimiter, r.streakHandler.GetStreak)

	// Analytics
	api.Post("/get-week-analytics", authMiddleware, apiRateLimiter, r.analyticsHandler.GetWeekAnalytics)

	// Tile Configuration
	api.Get("/tile-config", authMiddleware, apiRateLimiter, r.tileConfigHandler.GetConfig)
	api.Post("/tile-config", authMiddleware, apiRateLimiter, r.tileConfigHandler.SaveConfig)
	api.Post("/tile-config/user", authMiddleware, apiRateLimiter, r.tileConfigHandler.GetConfigByUsername)

	// Likes
	api.Post("/like-day", authMiddleware, apiRateLimiter, r.likeHandler.LikeDay)
	api.Post("/unlike-day", authMiddleware, apiRateLimiter, r.likeHandler.UnlikeDay)
	api.Post("/get-likes", authMiddleware, apiRateLimiter, r.likeHandler.GetLikes)

	// Badges
	api.Get("/badges", authMiddleware, apiRateLimiter, r.badgeHandler.GetBadges)
	api.Post("/badges/user", authMiddleware, apiRateLimiter, r.badgeHandler.GetBadgesByUsername)

	// Profile Management
	api.Post("/update-username", authMiddleware, apiRateLimiter, r.authHandler.UpdateUsername)
	api.Post("/update-privacy", authMiddleware, apiRateLimiter, r.profileHandler.UpdatePrivacy)
	api.Get("/get-privacy", authMiddleware, apiRateLimiter, r.profileHandler.GetPrivacy)
	api.Post("/update-bio", authMiddleware, apiRateLimiter, r.profileHandler.UpdateBio)
	api.Get("/get-bio", authMiddleware, apiRateLimiter, r.profileHandler.GetBio)
	api.Post("/change-password", authMiddleware, authRateLimiter, r.authHandler.ChangePassword) // Strict rate limit for password change

	// Profile Picture (with upload-specific rate limiting)
	profile := api.Group("/profile", authMiddleware)
	profile.Get("", apiRateLimiter, r.profileHandler.GetProfile)
	if r.blobHandler != nil {
		profile.Post("/upload-picture", uploadRateLimiter, r.blobHandler.UploadProfilePicture)
		profile.Delete("/picture", apiRateLimiter, r.blobHandler.DeleteProfilePicture)
	}

	// ==================== Notifications ====================
	notifications := api.Group("/notifications", authMiddleware, apiRateLimiter)
	notifications.Get("", r.notificationHandler.GetNotifications)
	notifications.Get("/unread-count", r.notificationHandler.GetUnreadCount)
	notifications.Patch("/:id/read", r.notificationHandler.MarkAsRead)
	notifications.Patch("/read-all", r.notificationHandler.MarkAllAsRead)
	notifications.Delete("/:id", r.notificationHandler.DeleteNotification)

	// ==================== Push Notifications ====================
	push := api.Group("/push")
	// Public endpoint - VAPID public key (no auth required)
	push.Get("/vapid-public-key", r.pushHandler.GetVapidPublicKey)
	// Protected endpoints
	push.Post("/subscriptions", authMiddleware, apiRateLimiter, r.pushHandler.RegisterSubscription)
	push.Delete("/subscriptions", authMiddleware, apiRateLimiter, r.pushHandler.UnregisterSubscription)
	push.Get("/preferences", authMiddleware, apiRateLimiter, r.pushHandler.GetPreferences)
	push.Put("/preferences", authMiddleware, apiRateLimiter, r.pushHandler.UpdatePreferences)
	// Admin/maintenance endpoint - cleanup stale data
	push.Post("/cleanup", authMiddleware, r.pushHandler.RunCleanup)

	// ==================== Follow System ====================
	followRateLimiter := middleware.FollowRateLimiter()

	// Follow/Unfollow actions
	api.Post("/users/:targetId/follow", authMiddleware, followRateLimiter, r.followHandler.FollowUser)
	api.Delete("/users/:targetId/follow", authMiddleware, followRateLimiter, r.followHandler.UnfollowUser)

	// Follow request management
	api.Post("/follow-requests/:targetId/cancel", authMiddleware, apiRateLimiter, r.followHandler.CancelFollowRequest)
	api.Get("/me/follow-requests/incoming", authMiddleware, apiRateLimiter, r.followHandler.GetIncomingRequests)
	api.Post("/me/follow-requests/:requesterId/accept", authMiddleware, apiRateLimiter, r.followHandler.AcceptFollowRequest)
	api.Post("/me/follow-requests/:requesterId/decline", authMiddleware, apiRateLimiter, r.followHandler.DeclineFollowRequest)

	// Follower management
	api.Delete("/me/followers/:followerId", authMiddleware, apiRateLimiter, r.followHandler.RemoveFollower)

	// Follow lists
	api.Get("/users/:userId/followers", authMiddleware, apiRateLimiter, r.followHandler.GetFollowers)
	api.Get("/users/:userId/following", authMiddleware, apiRateLimiter, r.followHandler.GetFollowing)
	api.Get("/users/:userId/mutuals", authMiddleware, apiRateLimiter, r.followHandler.GetMutuals)
	api.Get("/users/:userId/follow-counts", authMiddleware, apiRateLimiter, r.followHandler.GetFollowCounts)
	api.Post("/me/follow-counts/reconcile", authMiddleware, apiRateLimiter, r.followHandler.ReconcileMyCounters)
	api.Get("/users/:userId/profile", authMiddleware, apiRateLimiter, r.profileHandler.GetUserProfile)

	// Relationship lookup (batch) - no rate limit, read-only and needed frequently for UI
	api.Post("/relationships/lookup", authMiddleware, r.followHandler.LookupRelationships)

	// ==================== WebSocket ====================
	// WebSocket route for real-time notifications
	// Token is passed as query parameter: /api/ws/notifications?token=<jwt>
	api.Use("/ws/notifications", r.notificationWSHandler.UpgradeMiddleware())
	api.Get("/ws/notifications", r.notificationWSHandler.HandleConnection())
}
