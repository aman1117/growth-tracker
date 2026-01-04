// Package database provides database connection and management.
package database

import (
	"fmt"
	"sync"
	"time"

	"github.com/aman1117/backend/internal/config"
	"github.com/aman1117/backend/pkg/models"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

var (
	db   *gorm.DB
	once sync.Once
)

// Init initializes the database connection with the provided configuration
func Init(cfg *config.DatabaseConfig) (*gorm.DB, error) {
	var initErr error

	once.Do(func() {
		logLevel := logger.Info
		if config.AppConfig != nil && config.AppConfig.IsProduction() {
			logLevel = logger.Warn
		}

		db, initErr = gorm.Open(postgres.Open(cfg.DSN()), &gorm.Config{
			PrepareStmt: true,
			Logger:      logger.Default.LogMode(logLevel),
		})
		if initErr != nil {
			return
		}

		sqlDB, err := db.DB()
		if err != nil {
			initErr = fmt.Errorf("failed to get underlying sql.DB: %w", err)
			return
		}

		// Configure connection pool
		sqlDB.SetMaxIdleConns(cfg.MaxIdleConns)
		sqlDB.SetMaxOpenConns(cfg.MaxOpenConns)
		sqlDB.SetConnMaxLifetime(cfg.ConnMaxLifetime)
		sqlDB.SetConnMaxIdleTime(cfg.ConnMaxIdleTime)
	})

	return db, initErr
}

// Get returns the database instance
func Get() *gorm.DB {
	return db
}

// AutoMigrate runs database migrations for all models
func AutoMigrate() error {
	if db == nil {
		return fmt.Errorf("database not initialized")
	}

	return db.AutoMigrate(
		&models.User{},
		&models.Activity{},
		&models.Streak{},
		&models.TileConfig{},
		&models.Like{},
	)
}

// Close closes the database connection
func Close() error {
	if db == nil {
		return nil
	}

	sqlDB, err := db.DB()
	if err != nil {
		return err
	}

	return sqlDB.Close()
}

// WithTimeout returns a new DB instance with a timeout context
func WithTimeout(timeout time.Duration) *gorm.DB {
	// This is a placeholder - in a real implementation,
	// you'd use context.WithTimeout
	return db
}

// Transaction executes a function within a database transaction
func Transaction(fn func(tx *gorm.DB) error) error {
	return db.Transaction(fn)
}
