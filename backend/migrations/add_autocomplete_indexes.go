// Migration script to enable pg_trgm extension and create autocomplete indexes.
// Run with: go run migrations/add_autocomplete_indexes.go
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
// 1. Enables the pg_trgm extension for fuzzy/trigram matching
// 2. Creates a GIN index on username for trigram similarity search
// 3. Creates a B-tree index on lower(username) for fast prefix search
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

	// Step 1: Enable pg_trgm extension (idempotent)
	log.Println("Step 1: Enabling pg_trgm extension...")
	if err := db.Exec("CREATE EXTENSION IF NOT EXISTS pg_trgm").Error; err != nil {
		log.Fatalf("Failed to enable pg_trgm extension: %v", err)
	}
	log.Println("✓ pg_trgm extension enabled")

	// Step 2: Create GIN trigram index on username for fuzzy matching (idempotent)
	log.Println("Step 2: Creating trigram index on users.username...")
	if err := db.Exec(`
		CREATE INDEX IF NOT EXISTS idx_users_username_trgm 
		ON users USING GIN (username gin_trgm_ops)
	`).Error; err != nil {
		log.Fatalf("Failed to create trigram index: %v", err)
	}
	log.Println("✓ Trigram index created: idx_users_username_trgm")

	// Step 3: Create B-tree index on lower(username) for fast prefix search (idempotent)
	log.Println("Step 3: Creating prefix search index on lower(users.username)...")
	if err := db.Exec(`
		CREATE INDEX IF NOT EXISTS idx_users_username_lower_pattern 
		ON users (lower(username) text_pattern_ops)
	`).Error; err != nil {
		log.Fatalf("Failed to create prefix index: %v", err)
	}
	log.Println("✓ Prefix index created: idx_users_username_lower_pattern")

	// Verify indexes were created
	log.Println("\nVerifying indexes...")
	var indexes []struct {
		IndexName string
		IndexDef  string
	}
	if err := db.Raw(`
		SELECT indexname as index_name, indexdef as index_def 
		FROM pg_indexes 
		WHERE tablename = 'users' 
		AND indexname IN ('idx_users_username_trgm', 'idx_users_username_lower_pattern')
	`).Scan(&indexes).Error; err != nil {
		log.Printf("Warning: Could not verify indexes: %v", err)
	} else {
		for _, idx := range indexes {
			log.Printf("  ✓ %s", idx.IndexName)
		}
	}

	log.Println("\n✓ Migration completed successfully!")
	log.Println("\nYou can now use:")
	log.Println("  - Prefix search: WHERE lower(username) LIKE lower($1) || '%'")
	log.Println("  - Fuzzy search:  WHERE similarity(username, $1) > 0.3")
	log.Println("  - Order by:      ORDER BY similarity(username, $1) DESC")
}
