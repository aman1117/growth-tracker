// Test script to manually trigger streak reminder notifications
// Run with: go run ./cmd/test_reminder/main.go
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/repository"
	"github.com/aman1117/backend/internal/services"
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
	log.Println("🔔 Testing Streak Reminder Notifications...")

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

	// Use URL format for better compatibility
	dsn := fmt.Sprintf("postgres://%s:%s@%s:%s/%s?sslmode=%s",
		dbUser, dbPassword, dbHost, dbPort, dbName, dbSSLMode)

	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Info),
	})
	if err != nil {
		log.Fatalf("❌ Failed to connect: %v", err)
	}
	log.Println("✅ Connected to database")

	// Create repositories and services
	userRepo := repository.NewUserRepository(db)
	streakRepo := repository.NewStreakRepository(db)
	notifRepo := repository.NewNotificationRepository(db)
	notifSvc := services.NewNotificationService(notifRepo)

	// Get today's date in IST
	loc, _ := time.LoadLocation(constants.TimezoneIST)
	today := time.Now().In(loc).Format(constants.DateFormat)

	log.Printf("📅 Checking for users who haven't logged on: %s", today)

	// Find users who missed today
	userIDs, err := streakRepo.FindUsersMissedStreak(today)
	if err != nil {
		log.Fatalf("❌ Failed to query: %v", err)
	}

	if len(userIDs) == 0 {
		log.Println("✅ All users have logged today! No reminders needed.")
		log.Println("")
		log.Println("💡 To test, you can:")
		log.Println("   1. Create a user who hasn't logged today")
		log.Println("   2. Or manually call NotifyStreakReminder for your user ID")

		// Option: send a test notification to yourself
		var testUserID uint
		fmt.Print("\n🧪 Enter your user ID to send a test notification (or 0 to skip): ")
		fmt.Scan(&testUserID)

		if testUserID > 0 {
			user, err := userRepo.FindByID(testUserID)
			if err != nil || user == nil {
				log.Printf("❌ User %d not found", testUserID)
				os.Exit(1)
			}
			log.Printf("📤 Sending test notification to user: %s (ID: %d)", user.Username, testUserID)

			ctx := context.Background()
			if err := notifSvc.NotifyStreakReminder(ctx, testUserID, today); err != nil {
				log.Fatalf("❌ Failed: %v", err)
			}
			log.Println("✅ Test notification sent! Check the notification bell in the app.")
		}

		os.Exit(0)
	}

	log.Printf("📋 Found %d users who haven't logged today", len(userIDs))

	// Show the users
	for _, uid := range userIDs {
		user, _ := userRepo.FindByID(uid)
		if user != nil {
			log.Printf("   - %s (ID: %d)", user.Username, uid)
		}
	}

	// Ask for confirmation
	fmt.Print("\n🚀 Send notifications to these users? (y/n): ")
	var confirm string
	fmt.Scan(&confirm)

	if strings.ToLower(confirm) != "y" {
		log.Println("❌ Cancelled")
		os.Exit(0)
	}

	// Send notifications
	ctx := context.Background()
	var success, failed int
	for _, userID := range userIDs {
		if err := notifSvc.NotifyStreakReminder(ctx, userID, today); err != nil {
			log.Printf("   ❌ Failed for user %d: %v", userID, err)
			failed++
		} else {
			log.Printf("   ✅ Sent to user %d", userID)
			success++
		}
	}

	log.Println("")
	log.Printf("=== Complete: %d sent, %d failed ===", success, failed)
	log.Println("Check the notifications table or the frontend notification bell!")

	// Show recent notifications
	log.Println("")
	log.Println("📬 Recent streak_at_risk notifications:")
	var notifs []models.Notification
	db.Where("type = ?", "streak_at_risk").Order("created_at DESC").Limit(5).Find(&notifs)
	for _, n := range notifs {
		log.Printf("   [%s] User %d: %s", n.CreatedAt.Format("15:04:05"), n.UserID, n.Body)
	}
}
