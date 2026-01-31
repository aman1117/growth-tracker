//go:build ignore
// +build ignore

// Migration script to create activity_photos and story_views tables.
// Run with: go run migrations/add_activity_photos.go
//
// Required environment variables:
// - DB_HOST: Database host
// - DB_PORT: Database port (default: 5432)
// - DB_NAME: Database name
// - DB_USER: Database user
// - DB_PASSWORD: Database password
// - DB_SSL_MODE: SSL mode (default: require)
//
// This migration:
// 1. Creates the activity_photos table for storing activity story photos
// 2. Creates the story_views table for tracking who viewed each photo
// 3. Creates indexes for efficient querying
package main

import (
	"fmt"
	"log"
	"os"

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

	log.Println("Connected to database, starting migration...")

	// Step 1: Create activity_photos table
	log.Println("Step 1: Creating activity_photos table...")
	if err := db.Exec(`
		CREATE TABLE IF NOT EXISTS activity_photos (
			id SERIAL PRIMARY KEY,
			user_id INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
			activity_name VARCHAR(50) NOT NULL,
			photo_date DATE NOT NULL,
			photo_url VARCHAR(500) NOT NULL,
			thumbnail_url VARCHAR(500) NOT NULL,
			activity_icon VARCHAR(50),
			activity_color VARCHAR(20),
			activity_label VARCHAR(50),
			created_at TIMESTAMP NOT NULL DEFAULT NOW()
		)
	`).Error; err != nil {
		log.Fatalf("Failed to create activity_photos table: %v", err)
	}
	log.Println("✓ activity_photos table created")

	// Step 1b: Add custom tile metadata columns if they don't exist (for existing tables)
	log.Println("Step 1b: Adding custom tile metadata columns (if missing)...")
	db.Exec(`ALTER TABLE activity_photos ADD COLUMN IF NOT EXISTS activity_icon VARCHAR(50)`)
	db.Exec(`ALTER TABLE activity_photos ADD COLUMN IF NOT EXISTS activity_color VARCHAR(20)`)
	db.Exec(`ALTER TABLE activity_photos ADD COLUMN IF NOT EXISTS activity_label VARCHAR(50)`)
	log.Println("✓ Custom tile metadata columns ensured")

	// Step 2: Create unique constraint on (user_id, activity_name, photo_date)
	log.Println("Step 2: Creating unique constraint on activity_photos...")
	if err := db.Exec(`
		CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_photo_unique 
		ON activity_photos(user_id, activity_name, photo_date)
	`).Error; err != nil {
		log.Fatalf("Failed to create unique index: %v", err)
	}
	log.Println("✓ Unique constraint created: idx_activity_photo_unique")

	// Step 3: Create index on (user_id, photo_date) for efficient querying
	log.Println("Step 3: Creating index on (user_id, photo_date)...")
	if err := db.Exec(`
		CREATE INDEX IF NOT EXISTS idx_activity_photo_user_date 
		ON activity_photos(user_id, photo_date)
	`).Error; err != nil {
		log.Fatalf("Failed to create user_date index: %v", err)
	}
	log.Println("✓ Index created: idx_activity_photo_user_date")

	// Step 4: Create index on photo_date DESC for recent photos query
	log.Println("Step 4: Creating index on photo_date DESC...")
	if err := db.Exec(`
		CREATE INDEX IF NOT EXISTS idx_activity_photo_date 
		ON activity_photos(photo_date DESC)
	`).Error; err != nil {
		log.Fatalf("Failed to create date index: %v", err)
	}
	log.Println("✓ Index created: idx_activity_photo_date")

	// Step 5: Create story_views table
	log.Println("Step 5: Creating story_views table...")
	if err := db.Exec(`
		CREATE TABLE IF NOT EXISTS story_views (
			id SERIAL PRIMARY KEY,
			viewer_id INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
			photo_id INTEGER NOT NULL REFERENCES activity_photos(id) ON UPDATE CASCADE ON DELETE CASCADE,
			viewed_at TIMESTAMP NOT NULL DEFAULT NOW()
		)
	`).Error; err != nil {
		log.Fatalf("Failed to create story_views table: %v", err)
	}
	log.Println("✓ story_views table created")

	// Step 6: Create unique constraint on (viewer_id, photo_id)
	log.Println("Step 6: Creating unique constraint on story_views...")
	if err := db.Exec(`
		CREATE UNIQUE INDEX IF NOT EXISTS idx_story_view_unique 
		ON story_views(viewer_id, photo_id)
	`).Error; err != nil {
		log.Fatalf("Failed to create unique index: %v", err)
	}
	log.Println("✓ Unique constraint created: idx_story_view_unique")

	// Step 7: Create index on viewer_id for user's viewed photos
	log.Println("Step 7: Creating index on viewer_id...")
	if err := db.Exec(`
		CREATE INDEX IF NOT EXISTS idx_story_view_viewer 
		ON story_views(viewer_id)
	`).Error; err != nil {
		log.Fatalf("Failed to create viewer index: %v", err)
	}
	log.Println("✓ Index created: idx_story_view_viewer")

	// Step 8: Create index on photo_id for photo's viewers
	log.Println("Step 8: Creating index on photo_id...")
	if err := db.Exec(`
		CREATE INDEX IF NOT EXISTS idx_story_view_photo 
		ON story_views(photo_id)
	`).Error; err != nil {
		log.Fatalf("Failed to create photo index: %v", err)
	}
	log.Println("✓ Index created: idx_story_view_photo")

	// Verify tables and indexes were created
	log.Println("\nVerifying tables...")
	var tables []struct {
		TableName string
	}
	if err := db.Raw(`
		SELECT tablename as table_name 
		FROM pg_tables 
		WHERE schemaname = 'public' 
		AND tablename IN ('activity_photos', 'story_views')
	`).Scan(&tables).Error; err != nil {
		log.Printf("Warning: Could not verify tables: %v", err)
	} else {
		log.Printf("✓ Found %d tables:", len(tables))
		for _, t := range tables {
			log.Printf("  - %s", t.TableName)
		}
	}

	log.Println("\n✅ Migration completed successfully!")
	log.Println("\nTables created:")
	log.Println("  - activity_photos: Stores activity story photos (one per activity per day per user)")
	log.Println("  - story_views: Tracks who viewed each photo")
}
