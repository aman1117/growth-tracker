// Package config provides centralized configuration management for the application.
// It loads configuration from environment variables with sensible defaults and validation.
package config

import (
	"fmt"
	"os"
	"strconv"
	"time"

	"github.com/joho/godotenv"
)

// Config holds all application configuration
type Config struct {
	// Server configuration
	Server ServerConfig

	// Database configuration
	Database DatabaseConfig

	// Redis configuration
	Redis RedisConfig

	// JWT configuration
	JWT JWTConfig

	// Azure Blob Storage configuration
	AzureStorage AzureStorageConfig

	// Email configuration
	Email EmailConfig

	// Axiom logging configuration
	Axiom AxiomConfig

	// Environment (development, production)
	Env string
}

// ServerConfig holds server-related configuration
type ServerConfig struct {
	Port         string
	FrontendURL  string
	ReadTimeout  time.Duration
	WriteTimeout time.Duration
}

// DatabaseConfig holds database connection configuration
type DatabaseConfig struct {
	// Option 1: Full DSN string (takes precedence if set)
	URL string

	// Option 2: Individual components (used if URL is not set)
	Host            string
	Port            string
	Name            string
	Username        string
	Password        string
	SSLMode         string
	MaxIdleConns    int
	MaxOpenConns    int
	ConnMaxLifetime time.Duration
	ConnMaxIdleTime time.Duration
}

// RedisConfig holds Redis connection configuration
type RedisConfig struct {
	URL string
}

// JWTConfig holds JWT-related configuration
type JWTConfig struct {
	SecretKey       string
	AccessTokenTTL  time.Duration
	RefreshTokenTTL time.Duration
}

// AzureStorageConfig holds Azure Blob Storage configuration
type AzureStorageConfig struct {
	AccountName      string
	ConnectionString string
	ContainerName    string
}

// EmailConfig holds email service configuration
type EmailConfig struct {
	ResendAPIKey string
	FromAddress  string
	FromName     string
}

// AxiomConfig holds Axiom logging configuration
type AxiomConfig struct {
	Dataset  string
	APIToken string
}

// Global application config instance
var AppConfig *Config

// Load initializes the application configuration from environment variables
func Load() (*Config, error) {
	// Load .env file if present (ignore error if not found)
	_ = godotenv.Load()

	config := &Config{
		Env: getEnvWithDefault("ENV", "development"),

		Server: ServerConfig{
			Port:         getEnvWithDefault("PORT", "8000"),
			FrontendURL:  getEnvWithDefault("FRONTEND_BASE_URL", "http://localhost:5173"),
			ReadTimeout:  getDurationFromEnv("SERVER_READ_TIMEOUT", 30*time.Second),
			WriteTimeout: getDurationFromEnv("SERVER_WRITE_TIMEOUT", 30*time.Second),
		},

		Database: DatabaseConfig{
			URL:             os.Getenv("DATABASE_URL"), // Full DSN takes precedence
			Host:            os.Getenv("DB_HOST"),
			Port:            getEnvWithDefault("DB_PORT", "5432"),
			Name:            os.Getenv("DB_NAME"),
			Username:        os.Getenv("DB_USERNAME"),
			Password:        os.Getenv("DB_PASSWORD"),
			SSLMode:         getEnvWithDefault("DB_SSLMODE", "require"),
			MaxIdleConns:    getIntFromEnv("DB_MAX_IDLE_CONNS", 10),
			MaxOpenConns:    getIntFromEnv("DB_MAX_OPEN_CONNS", 100),
			ConnMaxLifetime: getDurationFromEnv("DB_CONN_MAX_LIFETIME", time.Hour),
			ConnMaxIdleTime: getDurationFromEnv("DB_CONN_MAX_IDLE_TIME", 10*time.Minute),
		},

		Redis: RedisConfig{
			URL: os.Getenv("REDIS_URL"), // Optional
		},

		JWT: JWTConfig{
			SecretKey:       getEnvRequired("JWT_SECRET_KEY"),
			AccessTokenTTL:  getDurationMinutesFromEnv("TTL_ACCESS_TOKEN", 24*60), // 24 hours default
			RefreshTokenTTL: getDurationMinutesFromEnv("TTL_REFRESH_TOKEN", 7*24*60),
		},

		AzureStorage: AzureStorageConfig{
			AccountName:      os.Getenv("AZURE_STORAGE_ACCOUNT_NAME"),
			ConnectionString: os.Getenv("AZURE_STORAGE_CONNECTION_STRING"),
			ContainerName:    getEnvWithDefault("AZURE_STORAGE_CONTAINER", "profile-pictures"),
		},

		Email: EmailConfig{
			ResendAPIKey: os.Getenv("RESEND_API_KEY"),
			FromAddress:  getEnvWithDefault("EMAIL_FROM_ADDRESS", "noreply@example.com"),
			FromName:     getEnvWithDefault("EMAIL_FROM_NAME", "Growth Tracker"),
		},

		Axiom: AxiomConfig{
			Dataset:  os.Getenv("AXIOM_DATASET"),
			APIToken: os.Getenv("AXIOM_API_TOKEN"),
		},
	}

	AppConfig = config
	return config, nil
}

// DSN returns the PostgreSQL connection string
func (c *DatabaseConfig) DSN() string {
	// If full URL is provided, use it
	if c.URL != "" {
		return c.URL
	}

	// Otherwise, build from components
	return fmt.Sprintf(
		"postgresql://%s:%s@%s:%s/%s?sslmode=%s",
		c.Username, c.Password, c.Host, c.Port, c.Name, c.SSLMode,
	)
}

// IsProduction returns true if running in production environment
func (c *Config) IsProduction() bool {
	return c.Env == "production"
}

// IsDevelopment returns true if running in development environment
func (c *Config) IsDevelopment() bool {
	return c.Env == "development"
}

// Helper functions for environment variable parsing

func getEnvRequired(key string) string {
	value := os.Getenv(key)
	if value == "" {
		// In development, we might want to be more lenient
		// Log a warning but don't panic
		fmt.Printf("Warning: Required environment variable %s is not set\n", key)
	}
	return value
}

func getEnvWithDefault(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

func getIntFromEnv(key string, defaultValue int) int {
	if value := os.Getenv(key); value != "" {
		if intVal, err := strconv.Atoi(value); err == nil {
			return intVal
		}
	}
	return defaultValue
}

func getDurationFromEnv(key string, defaultValue time.Duration) time.Duration {
	if value := os.Getenv(key); value != "" {
		if duration, err := time.ParseDuration(value); err == nil {
			return duration
		}
	}
	return defaultValue
}

func getDurationMinutesFromEnv(key string, defaultMinutes int) time.Duration {
	if value := os.Getenv(key); value != "" {
		if minutes, err := strconv.Atoi(value); err == nil {
			return time.Duration(minutes) * time.Minute
		}
	}
	return time.Duration(defaultMinutes) * time.Minute
}
