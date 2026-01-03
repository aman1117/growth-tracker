package main

import (
	"context"
	"time"

	"github.com/robfig/cron/v3"

	"github.com/aman1117/backend/models"
	"github.com/aman1117/backend/services"
	"github.com/aman1117/backend/utils"
	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
)

func main() {
	// Initialize environment variables FIRST (loads .env file)
	utils.InitDB()

	// Initialize Zap logger (after env is loaded)
	utils.InitLogger()
	defer utils.SyncLogger()

	log := utils.Sugar // Use sugared logger for convenience

	db := utils.GetDB()
	if err := db.Error; err != nil {
		log.Fatalf("DB connection failed: %v", err)
	}

	// Initialize Redis
	if err := utils.InitRedis(); err != nil {
		log.Warnf("Redis initialization failed: %v", err)
		log.Warn("Password reset functionality will be disabled")
	} else {
		log.Info("Redis connection successful")
	}

	// Initialize Azure Blob Storage
	if err := services.InitBlobStorage(); err != nil {
		log.Warnf("Azure Blob Storage initialization failed: %v", err)
		log.Warn("Profile picture upload will be disabled")
	}

	if err := db.AutoMigrate(&models.User{}, &models.Activity{}, &models.Streak{}, &models.TileConfig{}); err != nil {
		log.Fatalf("AutoMigrate failed: %v", err)
	}
	log.Info("DB migrations successful")

	loc, err := time.LoadLocation("Asia/Kolkata")
	if err != nil {
		log.Fatalf("failed to load IST timezone: %v", err)
	}

	c := cron.New(
		cron.WithLocation(loc),
		cron.WithSeconds(), // allows specifying seconds in the spec
	)
	// Midnight cron job for streak processing
	_, err = c.AddFunc("0 0 0 * * *", func() {
		if err := services.CronJob(context.Background()); err != nil {
			log.Errorf("Daily job failed: %v", err)
		} else {
			log.Info("Daily job completed successfully")
		}
	})
	if err != nil {
		log.Fatalf("Failed to add cron job: %v", err)
	}

	_, err = c.AddFunc("0 0 9 * * *", func() {
		if err := services.SendStreakReminderEmails(); err != nil {
			log.Errorf("Email reminder job failed: %v", err)
		} else {
			log.Info("Email reminder job completed successfully")
		}
	})
	if err != nil {
		log.Fatalf("Failed to add email cron job: %v", err)
	}

	c.Start()
	defer c.Stop()

	app := fiber.New()

	// Request logging middleware
	app.Use(services.RequestLoggerMiddleware)

	app.Use(cors.New(cors.Config{
		AllowOrigins:     "*",   // allow all origins
		AllowMethods:     "*",   // allow all HTTP methods
		AllowHeaders:     "*",   // allow all headers
		ExposeHeaders:    "*",   // optional: expose all headers
		AllowCredentials: false, // set true only if you really need cookies/auth headers
	}))

	app.Get("/", func(c *fiber.Ctx) error {
		log.Debug("Health check endpoint hit")
		return c.SendString("API is running...")
	})
	app.Post("/register", services.RegisterHandler)
	app.Post("/login", services.LoginHandler)
	app.Post("/users", services.AuthMiddleware, services.GetUsersHandler)

	app.Post("/create-activity", services.AuthMiddleware, services.CreateActivityHandler)
	app.Post("/get-activities", services.AuthMiddleware, services.GetActivityHandler)

	app.Post("/get-streak", services.AuthMiddleware, services.GetStreakHandler)

	app.Get("/tile-config", services.AuthMiddleware, services.GetTileConfigHandler)
	app.Post("/tile-config", services.AuthMiddleware, services.SaveTileConfigHandler)
	app.Post("/tile-config/user", services.AuthMiddleware, services.GetTileConfigByUsernameHandler)

	app.Post("/update-username", services.AuthMiddleware, services.UpdateUsernameHandler)
	app.Post("/update-privacy", services.AuthMiddleware, services.UpdatePrivacyHandler)
	app.Get("/get-privacy", services.AuthMiddleware, services.GetPrivacyHandler)
	app.Post("/update-bio", services.AuthMiddleware, services.UpdateBioHandler)
	app.Get("/get-bio", services.AuthMiddleware, services.GetBioHandler)
	app.Post("/change-password", services.AuthMiddleware, services.ChangePasswordHandler)

	app.Post("/auth/forgot-password", services.ForgotPasswordHandler)
	app.Post("/auth/reset-password", services.ResetPasswordHandler)
	app.Get("/auth/reset-password/validate", services.ValidateResetTokenHandler)

	// Profile picture endpoints
	app.Post("/profile/upload-picture", services.AuthMiddleware, services.UploadProfilePictureHandler)
	app.Delete("/profile/picture", services.AuthMiddleware, services.DeleteProfilePictureHandler)
	app.Get("/profile", services.AuthMiddleware, services.GetProfileHandler)

	port := utils.GetFromEnv("PORT")
	if port == "" {
		port = "8000"
	}
	addr := "0.0.0.0:" + port
	log.Infof("Server starting on http://localhost:%s", port)
	if err := app.Listen(addr); err != nil {
		log.Fatalf("Failed to start server: %v", err)
	}
}
