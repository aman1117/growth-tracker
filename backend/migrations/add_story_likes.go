//go:build ignore
// +build ignore

// Migration script to create story_likes table.
// Run with: go run migrations/add_story_likes.go
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
// 1. Creates the story_likes table for tracking who liked each photo
// 2. Creates indexes for efficient querying
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

	// Step 1: Create story_likes table
	log.Println("Step 1: Creating story_likes table...")
	if err := db.Exec(`
		CREATE TABLE IF NOT EXISTS story_likes (
			id SERIAL PRIMARY KEY,
			liker_id INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
			photo_id INTEGER NOT NULL REFERENCES activity_photos(id) ON UPDATE CASCADE ON DELETE CASCADE,
			liked_at TIMESTAMP NOT NULL DEFAULT NOW()
		)
	`).Error; err != nil {
		log.Fatalf("Failed to create story_likes table: %v", err)
	}
	log.Println("✓ story_likes table created")

	// Step 2: Create unique constraint on (liker_id, photo_id)
	log.Println("Step 2: Creating unique constraint on story_likes...")
	if err := db.Exec(`
		CREATE UNIQUE INDEX IF NOT EXISTS idx_story_like_unique 
		ON story_likes(liker_id, photo_id)
	`).Error; err != nil {
		log.Fatalf("Failed to create unique index: %v", err)
	}
	log.Println("✓ Unique constraint created")

	// Step 3: Create index on liker_id for querying likes by user
	log.Println("Step 3: Creating index on liker_id...")
	if err := db.Exec(`
		CREATE INDEX IF NOT EXISTS idx_story_like_liker 
		ON story_likes(liker_id)
	`).Error; err != nil {
		log.Fatalf("Failed to create liker index: %v", err)
	}
	log.Println("✓ Liker index created")

	// Step 4: Create index on photo_id for querying likes by photo
	log.Println("Step 4: Creating index on photo_id...")
	if err := db.Exec(`
		CREATE INDEX IF NOT EXISTS idx_story_like_photo 
		ON story_likes(photo_id)
	`).Error; err != nil {
		log.Fatalf("Failed to create photo index: %v", err)
	}
	log.Println("✓ Photo index created")

	log.Println("Migration completed successfully!")
	log.Println("")
	log.Println("Summary:")
	log.Println("- Created story_likes table with foreign keys to users and activity_photos")
	log.Println("- Created unique index idx_story_like_unique (liker_id, photo_id)")
	log.Println("- Created index idx_story_like_liker (liker_id)")
	log.Println("- Created index idx_story_like_photo (photo_id)")
}
