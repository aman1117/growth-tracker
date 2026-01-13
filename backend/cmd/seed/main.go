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
	"github.com/aman1117/backend/pkg/models"
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
	db.Model(&models.User{}).Count(&userCount)
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

	// Seed follow relationships
	if err := seedFollows(db, users); err != nil {
		log.Fatalf("❌ Failed to seed follows: %v", err)
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
		&models.User{},
		&models.Activity{},
		&models.Streak{},
		&models.UserBadge{},
		&models.FollowEdgeByFollower{},
		&models.FollowEdgeByFollowee{},
		&models.FollowCounter{},
	)
}

func seedUsers(db *gorm.DB) ([]models.User, error) {
	log.Println("👤 Seeding test users...")

	// Hash password
	hashedPassword, err := bcrypt.GenerateFromPassword([]byte("password123"), bcrypt.DefaultCost)
	if err != nil {
		return nil, err
	}

	// Helper to create string pointers
	strPtr := func(s string) *string { return &s }

	users := []models.User{
		{
			Email:        "alice@local.dev",
			Username:     "alice",
			PasswordHash: string(hashedPassword),
			Bio:          strPtr("📚 Student | 💪 Fitness enthusiast | Building better habits daily"),
			IsPrivate:    false,
			IsVerified:   true,
		},
		{
			Email:        "bob@local.dev",
			Username:     "bob",
			PasswordHash: string(hashedPassword),
			Bio:          strPtr("Software developer 🖥️ | Coffee addict ☕"),
			IsPrivate:    false,
			IsVerified:   false,
		},
		{
			Email:        "charlie@local.dev",
			Username:     "charlie",
			PasswordHash: string(hashedPassword),
			Bio:          strPtr("Private account 🔒"),
			IsPrivate:    true,
			IsVerified:   false,
		},
		{
			Email:        "diana@local.dev",
			Username:     "diana",
			PasswordHash: string(hashedPassword),
			Bio:          strPtr("🎨 Designer | 🧘 Yoga lover | Tracking my growth journey"),
			IsPrivate:    false,
			IsVerified:   true,
		},
		{
			Email:        "evan@local.dev",
			Username:     "evan",
			PasswordHash: string(hashedPassword),
			Bio:          strPtr("Entrepreneur 🚀 | Early bird 🌅 | 100 day streak goal"),
			IsPrivate:    false,
			IsVerified:   false,
		},
		{
			Email:        "fiona@local.dev",
			Username:     "fiona",
			PasswordHash: string(hashedPassword),
			Bio:          strPtr("Medical student 🏥 | Marathon runner 🏃‍♀️"),
			IsPrivate:    false,
			IsVerified:   false,
		},
		{
			Email:        "george@local.dev",
			Username:     "george",
			PasswordHash: string(hashedPassword),
			Bio:          strPtr("📖 Bookworm | 🎮 Gamer | Habit tracking newbie"),
			IsPrivate:    true,
			IsVerified:   false,
		},
		{
			Email:        "hannah@local.dev",
			Username:     "hannah",
			PasswordHash: string(hashedPassword),
			Bio:          strPtr("Music teacher 🎵 | Piano & Guitar | Daily practice tracker"),
			IsPrivate:    false,
			IsVerified:   false,
		},
		{
			Email:        "ivan@local.dev",
			Username:     "ivan",
			PasswordHash: string(hashedPassword),
			Bio:          strPtr("🏋️ Personal trainer | Helping others reach their goals"),
			IsPrivate:    false,
			IsVerified:   true,
		},
		{
			Email:        "julia@local.dev",
			Username:     "julia",
			PasswordHash: string(hashedPassword),
			Bio:          strPtr("Data scientist 📊 | ML enthusiast | Continuous learner"),
			IsPrivate:    false,
			IsVerified:   false,
		},
	}

	if err := db.Create(&users).Error; err != nil {
		return nil, err
	}

	log.Printf("✅ Created %d test users", len(users))
	return users, nil
}

func seedActivities(db *gorm.DB, users []models.User) error {
	log.Println("📝 Seeding activities and streaks...")

	activityTypes := models.ActivityNames
	today := time.Now().Truncate(24 * time.Hour)

	for _, user := range users {
		// Generate activities with some gaps based on user
		var currentStreak, longestStreak int

		// User-specific streak patterns:
		// alice: 15-day streak (current)
		// bob: 45-day streak (longest), broke 5 days ago
		// charlie: 7-day streak (current)
		// diana: 30-day streak (current) - verified user
		// evan: 20-day streak (current)
		// fiona: 60-day streak (longest), broke 2 days ago
		// george: 5-day streak (current) - private
		// hannah: 12-day streak (current)
		// ivan: 25-day streak (current) - verified
		// julia: 8-day streak (current)
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
		case "diana":
			daysToSeed = 30
			skipDays = map[int]bool{}
		case "evan":
			daysToSeed = 20
			skipDays = map[int]bool{}
		case "fiona":
			daysToSeed = 65
			skipDays = map[int]bool{1: true, 2: true} // Broke streak 2 days ago
		case "george":
			daysToSeed = 5
			skipDays = map[int]bool{}
		case "hannah":
			daysToSeed = 12
			skipDays = map[int]bool{}
		case "ivan":
			daysToSeed = 25
			skipDays = map[int]bool{}
		case "julia":
			daysToSeed = 8
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

				activity := models.Activity{
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
			streak := models.Streak{
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

func seedBadges(db *gorm.DB, users []models.User) error {
	log.Println("🏅 Seeding badges based on streaks...")

	for _, user := range users {
		// Get user's longest streak
		var maxStreak struct {
			Longest int
		}
		db.Model(&models.Streak{}).
			Where("user_id = ?", user.ID).
			Select("MAX(longest) as longest").
			Scan(&maxStreak)

		// Get eligible badges
		eligibleKeys := constants.GetEligibleBadgeKeys(maxStreak.Longest)

		for _, key := range eligibleKeys {
			badge := models.UserBadge{
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

func seedFollows(db *gorm.DB, users []models.User) error {
	log.Println("👥 Seeding follow relationships...")

	// Create a map for easy user lookup
	userMap := make(map[string]models.User)
	for _, u := range users {
		userMap[u.Username] = u
	}

	// Define follow relationships
	// Format: follower -> []followees
	followRelationships := map[string][]string{
		"alice":   {"bob", "diana", "evan", "fiona", "hannah", "ivan", "julia"},
		"bob":     {"alice", "charlie", "diana", "evan"},
		"charlie": {"alice", "bob"},
		"diana":   {"alice", "bob", "evan", "fiona", "ivan"},
		"evan":    {"alice", "diana", "fiona", "hannah"},
		"fiona":   {"alice", "bob", "diana", "evan", "hannah", "ivan", "julia"},
		"george":  {"alice", "diana"},
		"hannah":  {"alice", "bob", "diana", "evan", "fiona"},
		"ivan":    {"alice", "diana", "evan", "fiona"},
		"julia":   {"alice", "bob", "diana", "fiona", "ivan"},
	}

	// Pending requests to private accounts
	pendingRequests := map[string][]string{
		"alice": {"charlie", "george"},
		"bob":   {"george"},
		"diana": {"charlie", "george"},
		"evan":  {"charlie"},
	}

	now := time.Now()
	var totalFollows, totalPending int

	// Create active follows
	for followerName, followees := range followRelationships {
		follower := userMap[followerName]
		for i, followeeName := range followees {
			followee := userMap[followeeName]

			// Stagger created_at times for realistic ordering
			createdAt := now.Add(-time.Duration(rand.Intn(30*24))*time.Hour - time.Duration(i)*time.Minute)
			acceptedAt := createdAt.Add(time.Duration(rand.Intn(60)) * time.Minute)

			// Create both edges (dual-write pattern)
			edgeByFollower := models.FollowEdgeByFollower{
				FollowerID: follower.ID,
				FolloweeID: followee.ID,
				State:      models.FollowStateActive,
				CreatedAt:  createdAt,
				AcceptedAt: &acceptedAt,
			}
			if err := db.Create(&edgeByFollower).Error; err != nil {
				log.Printf("⚠️  Failed to create follow edge (follower): %v", err)
				continue
			}

			edgeByFollowee := models.FollowEdgeByFollowee{
				FolloweeID: followee.ID,
				FollowerID: follower.ID,
				State:      models.FollowStateActive,
				CreatedAt:  createdAt,
				AcceptedAt: &acceptedAt,
			}
			if err := db.Create(&edgeByFollowee).Error; err != nil {
				log.Printf("⚠️  Failed to create follow edge (followee): %v", err)
				continue
			}

			totalFollows++
		}
	}

	// Create pending requests
	for followerName, followees := range pendingRequests {
		follower := userMap[followerName]
		for i, followeeName := range followees {
			followee := userMap[followeeName]

			createdAt := now.Add(-time.Duration(rand.Intn(7*24))*time.Hour - time.Duration(i)*time.Minute)

			edgeByFollower := models.FollowEdgeByFollower{
				FollowerID: follower.ID,
				FolloweeID: followee.ID,
				State:      models.FollowStatePending,
				CreatedAt:  createdAt,
			}
			if err := db.Create(&edgeByFollower).Error; err != nil {
				log.Printf("⚠️  Failed to create pending request (follower): %v", err)
				continue
			}

			edgeByFollowee := models.FollowEdgeByFollowee{
				FolloweeID: followee.ID,
				FollowerID: follower.ID,
				State:      models.FollowStatePending,
				CreatedAt:  createdAt,
			}
			if err := db.Create(&edgeByFollowee).Error; err != nil {
				log.Printf("⚠️  Failed to create pending request (followee): %v", err)
				continue
			}

			totalPending++
		}
	}

	// Update follow counters
	log.Println("📊 Updating follow counters...")
	for _, user := range users {
		var followersCount, followingCount, pendingCount int64

		// Count followers (people who follow this user)
		db.Model(&models.FollowEdgeByFollowee{}).
			Where("followee_id = ? AND state = ?", user.ID, models.FollowStateActive).
			Count(&followersCount)

		// Count following (people this user follows)
		db.Model(&models.FollowEdgeByFollower{}).
			Where("follower_id = ? AND state = ?", user.ID, models.FollowStateActive).
			Count(&followingCount)

		// Count pending requests (for private accounts)
		db.Model(&models.FollowEdgeByFollowee{}).
			Where("followee_id = ? AND state = ?", user.ID, models.FollowStatePending).
			Count(&pendingCount)

		counter := models.FollowCounter{
			UserID:               user.ID,
			FollowersCount:       followersCount,
			FollowingCount:       followingCount,
			PendingRequestsCount: pendingCount,
		}
		if err := db.Save(&counter).Error; err != nil {
			log.Printf("⚠️  Failed to save counter for user %s: %v", user.Username, err)
		}
	}

	log.Printf("✅ Created %d active follows, %d pending requests", totalFollows, totalPending)

	// Print follow summary
	log.Println("\n📊 Follow Summary:")
	for _, user := range users {
		var counter models.FollowCounter
		db.Where("user_id = ?", user.ID).First(&counter)
		log.Printf("  • %s: %d followers, %d following, %d pending requests",
			user.Username, counter.FollowersCount, counter.FollowingCount, counter.PendingRequestsCount)
	}

	return nil
}
