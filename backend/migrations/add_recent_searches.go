//go:build ignore
// +build ignore

// Migration script to create recent_searches table.
// Run with: go run migrations/add_recent_searches.go
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
// 1. Creates the recent_searches table for tracking user's recent profile visits
// 2. Creates indexes for efficient querying by user and time
// 3. Creates unique constraint for upsert operations
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

	// Step 1: Create recent_searches table
	log.Println("Step 1: Creating recent_searches table...")
	if err := db.Exec(`
		CREATE TABLE IF NOT EXISTS recent_searches (
			id SERIAL PRIMARY KEY,
			user_id INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
			searched_user_id INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
			searched_at TIMESTAMP NOT NULL DEFAULT NOW()
		)
	`).Error; err != nil {
		log.Fatalf("Failed to create recent_searches table: %v", err)
	}
	log.Println("✓ recent_searches table created")

	// Step 2: Create unique constraint on (user_id, searched_user_id) for upsert
	log.Println("Step 2: Creating unique constraint on (user_id, searched_user_id)...")
	if err := db.Exec(`
		DO $$
		BEGIN
			IF NOT EXISTS (
				SELECT 1 FROM pg_constraint 
				WHERE conname = 'uq_recent_search_user_searched'
			) THEN
				ALTER TABLE recent_searches 
				ADD CONSTRAINT uq_recent_search_user_searched 
				UNIQUE (user_id, searched_user_id);
			END IF;
		END $$;
	`).Error; err != nil {
		log.Fatalf("Failed to create unique constraint: %v", err)
	}
	log.Println("✓ Unique constraint created")

	// Step 3: Create composite index for querying user's recent searches
	log.Println("Step 3: Creating composite index on (user_id, searched_at DESC)...")
	if err := db.Exec(`
		CREATE INDEX IF NOT EXISTS idx_recent_search_user_time 
		ON recent_searches (user_id, searched_at DESC)
	`).Error; err != nil {
		log.Fatalf("Failed to create composite index: %v", err)
	}
	log.Println("✓ Composite index created")

	log.Println("Migration completed successfully!")
}
