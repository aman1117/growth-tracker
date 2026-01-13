// Script to send streak reminder notifications to all users
// Run with: docker-compose --profile send-reminders run --rm send-reminders
package main

import (
	"fmt"
	"log"
	"os"
	"strings"

	"github.com/aman1117/backend/internal/repository"
	"github.com/aman1117/backend/pkg/models"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func getEnv(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func main() {
	log.Println("🔔 Sending Streak Reminder Notifications to ALL users...")

	// Get database credentials from environment
	dbHost := getEnv("DB_HOST", "localhost")
	dbPort := getEnv("DB_PORT", "5432")
	dbName := getEnv("DB_NAME", "growth_tracker_dev")
	dbUser := getEnv("DB_USERNAME", "localdev")
	dbPassword := getEnv("DB_PASSWORD", "localdevpassword")
	dbSSLMode := getEnv("DB_SSLMODE", "disable")

	// Safety check
	productionIndicators := []string{"neon.tech", "azure", "aws", "prod", "production"}
	for _, indicator := range productionIndicators {
		if strings.Contains(strings.ToLower(dbHost), indicator) {
			log.Fatalf("❌ REFUSING: DB_HOST '%s' appears to be production!", dbHost)
		}
	}

	log.Printf("📊 Connecting to: %s@%s:%s/%s", dbUser, dbHost, dbPort, dbName)

	dsn := fmt.Sprintf("postgres://%s:%s@%s:%s/%s?sslmode=%s",
		dbUser, dbPassword, dbHost, dbPort, dbName, dbSSLMode)

	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Warn),
	})
	if err != nil {
		log.Fatalf("❌ Failed to connect: %v", err)
	}
	log.Println("✅ Connected to database")

	// Create repository
	userRepo := repository.NewUserRepository(db)

	// Get all users
	users, err := userRepo.GetAll()
	if err != nil {
		log.Fatalf("❌ Failed to get users: %v", err)
	}

	log.Printf("📋 Found %d users", len(users))

	// Send notifications to each user (direct DB insert)
	today := "2026-01-14"
	var success, failed int

	for _, user := range users {
		notif := &models.Notification{
			UserID: user.ID,
			Type:   models.NotifTypeStreakAtRisk,
			Title:  "Don't Lose Your Streak! 🔥",
			Body:   "You haven't logged today. Update now to keep your streak!",
			Metadata: map[string]interface{}{
				"activity_type": "daily",
				"streak_count":  0,
				"date":          today,
			},
		}

		if err := db.Create(notif).Error; err != nil {
			log.Printf("   ❌ Failed for %s (ID: %d): %v", user.Username, user.ID, err)
			failed++
		} else {
			log.Printf("   ✅ Sent to %s (ID: %d)", user.Username, user.ID)
			success++
		}
	}

	log.Println("")
	log.Printf("=== Complete: %d sent, %d failed ===", success, failed)
}
