// Package container provides dependency injection for the application.
package container

import (
	"github.com/aman1117/backend/internal/config"
	"github.com/aman1117/backend/internal/handlers"
	"github.com/aman1117/backend/internal/repository"
	"github.com/aman1117/backend/internal/routes"
	"github.com/aman1117/backend/internal/services"
	"gorm.io/gorm"
)

// Container holds all application dependencies
type Container struct {
	// Configuration
	Config *config.Config

	// Repositories
	UserRepo         *repository.UserRepository
	ActivityRepo     *repository.ActivityRepository
	StreakRepo       *repository.StreakRepository
	TileConfigRepo   *repository.TileConfigRepository
	LikeRepo         *repository.LikeRepository
	BadgeRepo        *repository.BadgeRepository
	NotificationRepo *repository.NotificationRepository

	// Services
	AuthService         *services.AuthService
	ProfileService      *services.ProfileService
	ActivityService     *services.ActivityService
	StreakService       *services.StreakService
	AnalyticsService    *services.AnalyticsService
	TileConfigService   *services.TileConfigService
	EmailService        *services.EmailService
	CronService         *services.CronService
	BlobService         *services.BlobService
	BadgeService        *services.BadgeService
	NotificationService *services.NotificationService

	// Handlers
	TokenService          *handlers.TokenService
	AuthHandler           *handlers.AuthHandler
	ProfileHandler        *handlers.ProfileHandler
	ActivityHandler       *handlers.ActivityHandler
	StreakHandler         *handlers.StreakHandler
	AnalyticsHandler      *handlers.AnalyticsHandler
	TileConfigHandler     *handlers.TileConfigHandler
	PasswordResetHandler  *handlers.PasswordResetHandler
	BlobHandler           *handlers.BlobHandler
	LikeHandler           *handlers.LikeHandler
	BadgeHandler          *handlers.BadgeHandler
	NotificationHandler   *handlers.NotificationHandler
	NotificationWSHandler *handlers.NotificationWSHandler

	// Router
	Router *routes.Router
}

// New creates a new dependency injection container
func New(cfg *config.Config, db *gorm.DB) (*Container, error) {
	c := &Container{Config: cfg}

	// Initialize repositories
	c.UserRepo = repository.NewUserRepository(db)
	c.ActivityRepo = repository.NewActivityRepository(db)
	c.StreakRepo = repository.NewStreakRepository(db)
	c.TileConfigRepo = repository.NewTileConfigRepository(db)
	c.LikeRepo = repository.NewLikeRepository(db)
	c.BadgeRepo = repository.NewBadgeRepository(db)
	c.NotificationRepo = repository.NewNotificationRepository(db)

	// Initialize services
	c.AuthService = services.NewAuthService(c.UserRepo)
	c.ProfileService = services.NewProfileService(c.UserRepo)
	c.StreakService = services.NewStreakService(c.StreakRepo)
	c.ActivityService = services.NewActivityService(c.ActivityRepo, c.StreakService)
	c.AnalyticsService = services.NewAnalyticsService(c.ActivityRepo, c.StreakRepo, c.UserRepo)
	c.TileConfigService = services.NewTileConfigService(c.TileConfigRepo, c.UserRepo)
	c.BlobService = services.NewBlobService(c.UserRepo, &cfg.AzureStorage)
	c.BadgeService = services.NewBadgeService(c.BadgeRepo, c.UserRepo)
	c.NotificationService = services.NewNotificationService(c.NotificationRepo)

	// Initialize email service (optional - uses SMTP fallback for local dev)
	emailSvc, err := services.NewEmailService(&cfg.Email, cfg.Server.FrontendURL)
	if err == nil {
		c.EmailService = emailSvc
	}

	// Initialize cron service
	c.CronService = services.NewCronService(c.UserRepo, c.StreakRepo, c.StreakService, c.EmailService, c.NotificationService)

	// Initialize token service
	c.TokenService = handlers.NewTokenService(&cfg.JWT)

	// Initialize handlers
	c.AuthHandler = handlers.NewAuthHandler(c.AuthService, c.TokenService, c.ProfileService)
	c.ProfileHandler = handlers.NewProfileHandler(c.ProfileService, c.AuthService)
	c.ActivityHandler = handlers.NewActivityHandler(c.ActivityService, c.AuthService, c.ProfileService)
	c.StreakHandler = handlers.NewStreakHandler(c.StreakService, c.AuthService, c.ProfileService, c.BadgeService)
	c.AnalyticsHandler = handlers.NewAnalyticsHandler(c.AnalyticsService, c.AuthService, c.ProfileService)
	c.TileConfigHandler = handlers.NewTileConfigHandler(c.TileConfigService, c.AuthService, c.ProfileService)
	c.PasswordResetHandler = handlers.NewPasswordResetHandler(c.AuthService, c.EmailService)
	c.LikeHandler = handlers.NewLikeHandler(c.LikeRepo, c.AuthService, c.ProfileService, c.NotificationService)
	c.BadgeHandler = handlers.NewBadgeHandler(c.BadgeService, c.AuthService)
	c.NotificationHandler = handlers.NewNotificationHandler(c.NotificationService)
	c.NotificationWSHandler = handlers.NewNotificationWSHandler(c.NotificationService, c.TokenService)

	// Initialize blob handler (optional)
	if cfg.AzureStorage.ConnectionString != "" {
		blobHandler, err := handlers.NewBlobHandler(c.BlobService, &cfg.AzureStorage)
		if err == nil {
			c.BlobHandler = blobHandler
		}
	}

	// Initialize router
	c.Router = routes.NewRouter(
		c.AuthHandler,
		c.ProfileHandler,
		c.ActivityHandler,
		c.StreakHandler,
		c.AnalyticsHandler,
		c.TileConfigHandler,
		c.PasswordResetHandler,
		c.BlobHandler,
		c.LikeHandler,
		c.BadgeHandler,
		c.NotificationHandler,
		c.NotificationWSHandler,
		c.TokenService,
	)

	return c, nil
}
