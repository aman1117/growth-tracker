// Package main is the entry point for the Growth Tracker backend application.
package main

import (
	"context"
	"time"

	"github.com/aman1117/backend/internal/config"
	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/container"
	"github.com/aman1117/backend/internal/database"
	"github.com/aman1117/backend/internal/logger"
	"github.com/aman1117/backend/internal/middleware"
	"github.com/aman1117/backend/pkg/redis"
	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
	"github.com/robfig/cron/v3"
	"go.uber.org/zap"
)

func main() {
	// Load configuration
	cfg, err := config.Load()
	if err != nil {
		panic("Failed to load configuration: " + err.Error())
	}

	// Initialize logger
	logger.Init(cfg)
	defer logger.Sync()

	log := logger.Sugar

	// Initialize database
	db, err := database.Init(&cfg.Database)
	if err != nil {
		log.Fatalf("Database connection failed: %v", err)
	}
	log.Info("Database connection established")

	// Run migrations
	if err := database.AutoMigrate(); err != nil {
		log.Fatalf("Database migration failed: %v", err)
	}
	log.Info("Database migrations completed")

	// Initialize Redis (optional)
	if cfg.Redis.URL != "" {
		if err := redis.Init(cfg.Redis.URL); err != nil {
			log.Warnf("Redis initialization failed: %v", err)
			log.Warn("Password reset functionality will be disabled")
		} else {
			log.Info("Redis connection established")
		}
	}

	// Create dependency injection container
	c, err := container.New(cfg, db)
	if err != nil {
		log.Fatalf("Failed to create container: %v", err)
	}

	// Log optional service status
	if c.BlobHandler != nil {
		log.Info("Azure Blob Storage initialized")
	} else {
		log.Warn("Profile picture upload is disabled")
	}

	if c.EmailService != nil {
		log.Info("Email service initialized")
	} else {
		log.Warn("Email notifications are disabled")
	}

	// Setup cron jobs
	setupCronJobs(c, log)

	// Create Fiber app
	app := fiber.New(fiber.Config{
		ReadTimeout:  cfg.Server.ReadTimeout,
		WriteTimeout: cfg.Server.WriteTimeout,
	})

	// Setup middleware
	app.Use(middleware.RequestLogger)
	app.Use(cors.New(cors.Config{
		AllowOrigins:     "*",
		AllowMethods:     "*",
		AllowHeaders:     "*",
		ExposeHeaders:    "*",
		AllowCredentials: false,
	}))

	// Setup routes
	c.Router.Setup(app)

	// Start server
	addr := "0.0.0.0:" + cfg.Server.Port
	log.Infof("Server starting on http://localhost:%s", cfg.Server.Port)
	if err := app.Listen(addr); err != nil {
		log.Fatalf("Failed to start server: %v", err)
	}
}

func setupCronJobs(c *container.Container, log *zap.SugaredLogger) {
	loc, err := time.LoadLocation(constants.TimezoneIST)
	if err != nil {
		log.Fatalf("Failed to load timezone: %v", err)
	}

	cronScheduler := cron.New(
		cron.WithLocation(loc),
		cron.WithSeconds(),
	)

	// Midnight cron job for streak processing
	_, err = cronScheduler.AddFunc("0 0 0 * * *", func() {
		if err := c.CronService.RunDailyJob(context.Background()); err != nil {
			log.Errorf("Daily job failed: %v", err)
		} else {
			log.Info("Daily job completed successfully")
		}
	})
	if err != nil {
		log.Fatalf("Failed to add daily cron job: %v", err)
	}

	// 9 AM IST cron job for email reminders
	_, err = cronScheduler.AddFunc("0 0 9 * * *", func() {
		if err := c.CronService.SendStreakReminderEmails(); err != nil {
			log.Errorf("Email reminder job failed: %v", err)
		} else {
			log.Info("Email reminder job completed successfully")
		}
	})
	if err != nil {
		log.Fatalf("Failed to add email cron job: %v", err)
	}

	cronScheduler.Start()
	log.Info("Cron jobs scheduled")
}
