// Migration script to seed badges for existing users based on their longest streak.
// Run with: go run migrations/seed_badges.go
//
// Required environment variables:
// - DB_HOST: Database host
// - DB_PORT: Database port (default: 5432)
// - DB_NAME: Database name
// - DB_USER: Database user
// - DB_PASSWORD: Database password
// - DB_SSL_MODE: SSL mode (default: require)
package main

import (
	"fmt"
	"log"
	"os"
	"time"

	"github.com/aman1117/backend/internal/constants"
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
	// Get database credentials from environment variables
	dbHost := getEnv("DB_HOST", "")
	dbPort := getEnv("DB_PORT", "5432")
	dbName := getEnv("DB_NAME", "")
	dbUser := getEnv("DB_USER", "")
	dbPassword := getEnv("DB_PASSWORD", "")
	dbSSLMode := getEnv("DB_SSL_MODE", "require")

	// Validate required environment variables
	if dbHost == "" || dbName == "" || dbUser == "" || dbPassword == "" {
		log.Fatal("Missing required environment variables: DB_HOST, DB_NAME, DB_USER, DB_PASSWORD")
	}

	// Build connection string
	dsn := fmt.Sprintf("host=%s port=%s dbname=%s user=%s password=%s sslmode=%s",
		dbHost, dbPort, dbName, dbUser, dbPassword, dbSSLMode)

	// Connect to database
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Info),
	})
	if err != nil {
		log.Fatalf("Failed to connect to database: %v", err)
	}

	// Auto-migrate UserBadge table
	if err := db.AutoMigrate(&models.UserBadge{}); err != nil {
		log.Fatalf("Failed to migrate UserBadge table: %v", err)
	}
	log.Println("✓ UserBadge table migrated")

	// Get all users with their max longest streak
	type UserStreak struct {
		UserID        uint
		MaxLongest    int
		FirstStreakAt time.Time
	}

	var userStreaks []UserStreak
	err = db.Raw(`
		SELECT 
			user_id,
			MAX(longest) as max_longest,
			MIN(activity_date) as first_streak_at
		FROM streaks
		WHERE longest > 0
		GROUP BY user_id
	`).Scan(&userStreaks).Error

	if err != nil {
		log.Fatalf("Failed to get user streaks: %v", err)
	}

	log.Printf("Found %d users with streaks to process", len(userStreaks))

	// Process each user
	var totalBadgesCreated int
	for _, us := range userStreaks {
		badgesCreated, err := seedBadgesForUser(db, us.UserID, us.MaxLongest)
		if err != nil {
			log.Printf("Error seeding badges for user %d: %v", us.UserID, err)
			continue
		}
		totalBadgesCreated += badgesCreated
		if badgesCreated > 0 {
			log.Printf("✓ User %d: awarded %d badge(s) for longest streak of %d days", us.UserID, badgesCreated, us.MaxLongest)
		}
	}

	log.Printf("\n=== Migration Complete ===")
	log.Printf("Total badges created: %d", totalBadgesCreated)
}

func seedBadgesForUser(db *gorm.DB, userID uint, maxLongest int) (int, error) {
	// Get eligible badge keys
	eligibleKeys := constants.GetEligibleBadgeKeys(maxLongest)
	if len(eligibleKeys) == 0 {
		return 0, nil
	}

	// Get already earned badge keys
	var earnedKeys []string
	err := db.Model(&models.UserBadge{}).
		Where("user_id = ?", userID).
		Pluck("badge_key", &earnedKeys).Error
	if err != nil {
		return 0, err
	}

	// Create set for O(1) lookup
	earnedSet := make(map[string]bool)
	for _, key := range earnedKeys {
		earnedSet[key] = true
	}

	// Find the earliest date the user achieved each badge threshold
	badgeDates := make(map[string]time.Time)
	for _, badge := range constants.Badges {
		if badge.Threshold > maxLongest {
			continue
		}

		// Find the first date when user reached this threshold
		var firstAchievement struct {
			ActivityDate time.Time
		}
		err := db.Raw(`
			SELECT activity_date
			FROM streaks
			WHERE user_id = ? AND longest >= ?
			ORDER BY activity_date ASC
			LIMIT 1
		`, userID, badge.Threshold).Scan(&firstAchievement).Error

		if err == nil && !firstAchievement.ActivityDate.IsZero() {
			badgeDates[badge.Key] = firstAchievement.ActivityDate
		}
	}

	// Create badges for unearnved ones
	var newBadges []models.UserBadge
	for _, key := range eligibleKeys {
		if earnedSet[key] {
			continue // Already earned
		}

		earnedAt := time.Now()
		if date, ok := badgeDates[key]; ok {
			earnedAt = date
		}

		newBadges = append(newBadges, models.UserBadge{
			UserID:   userID,
			BadgeKey: key,
			EarnedAt: earnedAt,
		})
	}

	if len(newBadges) == 0 {
		return 0, nil
	}

	// Batch insert
	if err := db.Create(&newBadges).Error; err != nil {
		return 0, err
	}

	return len(newBadges), nil
}
