// Database seeder for local development
// Run with: go run ./cmd/seed/main.go
// Or via docker-compose: docker-compose --profile seed up seed
package main

import (
	"fmt"
	"log"
	"math/rand"
	"os"
	"strings"
	"time"

	"github.com/aman1117/backend/internal/constants"
	appmodels "github.com/aman1117/backend/models"
	pkgmodels "github.com/aman1117/backend/pkg/models"
	"golang.org/x/crypto/bcrypt"
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
	log.Println("🌱 Starting database seeder...")

	// Verify we're NOT in production
	env := getEnv("ENV", "development")
	if env == "production" {
		log.Fatal("❌ REFUSING TO SEED: ENV is set to 'production'. This seeder is for local development only!")
	}

	// Get database credentials from environment
	dbHost := getEnv("DB_HOST", "localhost")
	dbPort := getEnv("DB_PORT", "5432")
	dbName := getEnv("DB_NAME", "growth_tracker_dev")
	dbUser := getEnv("DB_USERNAME", "localdev")
	dbPassword := getEnv("DB_PASSWORD", "localdevpassword")
	dbSSLMode := getEnv("DB_SSLMODE", "disable")

	// Safety check: refuse to run on known production hosts
	productionIndicators := []string{"neon.tech", "azure", "aws", "prod", "production", "rds.amazonaws"}
	for _, indicator := range productionIndicators {
		if strings.Contains(strings.ToLower(dbHost), indicator) {
			log.Fatalf("❌ REFUSING TO SEED: DB_HOST '%s' appears to be a production database!", dbHost)
		}
	}

	// Additional safety: check DB name
	if strings.Contains(strings.ToLower(dbName), "prod") {
		log.Fatalf("❌ REFUSING TO SEED: DB_NAME '%s' appears to be a production database!", dbName)
	}

	log.Printf("📊 Connecting to database: %s@%s:%s/%s (sslmode=%s)", dbUser, dbHost, dbPort, dbName, dbSSLMode)

	// Build connection string
	dsn := fmt.Sprintf("host=%s port=%s dbname=%s user=%s password=%s sslmode=%s",
		dbHost, dbPort, dbName, dbUser, dbPassword, dbSSLMode)

	// Connect to database
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Info),
	})
	if err != nil {
		log.Fatalf("❌ Failed to connect to database: %v", err)
	}

	log.Println("✅ Database connected")

	// Run migrations
	if err := runMigrations(db); err != nil {
		log.Fatalf("❌ Migration failed: %v", err)
	}

	// Check if already seeded
	var userCount int64
	db.Model(&appmodels.User{}).Count(&userCount)
	if userCount > 0 {
		log.Printf("ℹ️  Database already has %d users. Skipping seed.", userCount)
		log.Println("✅ Seeder complete (no changes)")
		return
	}

	// Seed test users
	users, err := seedUsers(db)
	if err != nil {
		log.Fatalf("❌ Failed to seed users: %v", err)
	}

	// Seed activities and streaks
	if err := seedActivities(db, users); err != nil {
		log.Fatalf("❌ Failed to seed activities: %v", err)
	}

	// Seed badges based on streaks
	if err := seedBadges(db, users); err != nil {
		log.Fatalf("❌ Failed to seed badges: %v", err)
	}

	log.Println("\n🎉 Database seeding complete!")
	log.Println("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
	log.Println("Test Users (password: password123):")
	for _, u := range users {
		log.Printf("  • %s (%s)", u.Email, u.Username)
	}
	log.Println("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
}

func runMigrations(db *gorm.DB) error {
	log.Println("📦 Running migrations...")
	return db.AutoMigrate(
		&appmodels.User{},
		&appmodels.Activity{},
		&appmodels.Streak{},
		&pkgmodels.UserBadge{},
	)
}

func seedUsers(db *gorm.DB) ([]appmodels.User, error) {
	log.Println("👤 Seeding test users...")

	// Hash password
	hashedPassword, err := bcrypt.GenerateFromPassword([]byte("password123"), bcrypt.DefaultCost)
	if err != nil {
		return nil, err
	}

	users := []appmodels.User{
		{
			Email:        "alice@local.dev",
			Username:     "alice",
			PasswordHash: string(hashedPassword),
			IsPrivate:    false,
		},
		{
			Email:        "bob@local.dev",
			Username:     "bob",
			PasswordHash: string(hashedPassword),
			IsPrivate:    false,
		},
		{
			Email:        "charlie@local.dev",
			Username:     "charlie",
			PasswordHash: string(hashedPassword),
			IsPrivate:    true,
		},
	}

	if err := db.Create(&users).Error; err != nil {
		return nil, err
	}

	log.Printf("✅ Created %d test users", len(users))
	return users, nil
}

func seedActivities(db *gorm.DB, users []appmodels.User) error {
	log.Println("📝 Seeding activities and streaks...")

	activityTypes := appmodels.ActivityNames
	today := time.Now().Truncate(24 * time.Hour)

	for _, user := range users {
		// Generate activities with some gaps based on user
		var currentStreak, longestStreak int

		// User-specific streak patterns:
		// alice: 15-day streak (current)
		// bob: 45-day streak (longest), broke 5 days ago
		// charlie: 7-day streak (current)
		var daysToSeed int
		var skipDays map[int]bool

		switch user.Username {
		case "alice":
			daysToSeed = 15
			skipDays = map[int]bool{}
		case "bob":
			daysToSeed = 50
			skipDays = map[int]bool{1: true, 2: true, 3: true, 4: true, 5: true} // Broke streak 5 days ago
		case "charlie":
			daysToSeed = 7
			skipDays = map[int]bool{}
		default:
			daysToSeed = 10
			skipDays = map[int]bool{}
		}

		var lastActivityDate time.Time

		for dayOffset := daysToSeed; dayOffset >= 0; dayOffset-- {
			if skipDays[dayOffset] {
				// Gap in activities - reset current streak
				currentStreak = 0
				continue
			}

			activityDate := today.AddDate(0, 0, -dayOffset)

			// Create 2-4 activities per day
			numActivities := rand.Intn(3) + 2
			for i := 0; i < numActivities; i++ {
				activityType := activityTypes[rand.Intn(len(activityTypes))]
				duration := float32(rand.Intn(4)+1) + float32(rand.Intn(4))*0.25 // 1.0 to 5.0 hours

				activity := appmodels.Activity{
					UserID:        user.ID,
					Name:          activityType,
					DurationHours: duration,
					ActivityDate:  activityDate,
				}

				if err := db.Create(&activity).Error; err != nil {
					return err
				}
			}

			// Update streak
			if lastActivityDate.IsZero() || activityDate.Sub(lastActivityDate) <= 24*time.Hour {
				currentStreak++
			} else {
				currentStreak = 1
			}

			if currentStreak > longestStreak {
				longestStreak = currentStreak
			}

			// Create streak record
			streak := appmodels.Streak{
				UserID:       user.ID,
				Current:      currentStreak,
				Longest:      longestStreak,
				ActivityDate: activityDate,
			}

			if err := db.Create(&streak).Error; err != nil {
				return err
			}

			lastActivityDate = activityDate
		}

		log.Printf("✅ User %s: %d days of activities (current streak: %d, longest: %d)",
			user.Username, daysToSeed-len(skipDays), currentStreak, longestStreak)
	}

	return nil
}

func seedBadges(db *gorm.DB, users []appmodels.User) error {
	log.Println("🏅 Seeding badges based on streaks...")

	for _, user := range users {
		// Get user's longest streak
		var maxStreak struct {
			Longest int
		}
		db.Model(&appmodels.Streak{}).
			Where("user_id = ?", user.ID).
			Select("MAX(longest) as longest").
			Scan(&maxStreak)

		// Get eligible badges
		eligibleKeys := constants.GetEligibleBadgeKeys(maxStreak.Longest)

		for _, key := range eligibleKeys {
			badge := pkgmodels.UserBadge{
				UserID:   user.ID,
				BadgeKey: key,
				EarnedAt: time.Now(),
			}

			if err := db.Create(&badge).Error; err != nil {
				log.Printf("⚠️  Could not create badge %s for user %s: %v", key, user.Username, err)
				continue
			}
		}

		log.Printf("✅ User %s: awarded %d badge(s) for longest streak of %d days",
			user.Username, len(eligibleKeys), maxStreak.Longest)
	}

	return nil
}
