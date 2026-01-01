/*
#Plan: Redis Helper for Password Reset Tokens

Flow Overview:
1. User requests password reset via /auth/forgot-password
2. Server generates cryptographically secure 32-byte token
3. Token is hashed with SHA-256 before storage (never store raw)
4. Hash stored in Redis with key "reset:<hash>" and value "<userId>"
5. TTL set to 15 minutes
6. Raw token sent to user via email link
7. User clicks link, frontend calls /auth/reset-password with raw token
8. Server hashes the raw token, looks up Redis key
9. If found: update password, delete key (single-use)
10. If not found: return invalid/expired error

Security:
- Raw tokens never stored or logged
- SHA-256 hash ensures even if Redis is compromised, tokens can't be used
- TTL ensures tokens expire automatically
- Single-use: deleted after successful reset
*/

package utils

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

var redisClient *redis.Client

const (
	ResetTokenPrefix = "reset:"
	ResetTokenTTL    = 15 * time.Minute
	TokenByteLength  = 32
)

// InitRedis initializes the Redis client
func InitRedis() error {
	redisURL := GetFromEnv("REDIS_URL")
	if redisURL == "" {
		return fmt.Errorf("REDIS_URL is not set")
	}

	opt, err := redis.ParseURL(redisURL)
	if err != nil {
		return fmt.Errorf("failed to parse REDIS_URL: %w", err)
	}

	redisClient = redis.NewClient(opt)

	// Test connection
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := redisClient.Ping(ctx).Err(); err != nil {
		return fmt.Errorf("failed to connect to Redis: %w", err)
	}

	return nil
}

// GetRedis returns the Redis client
func GetRedis() *redis.Client {
	return redisClient
}

// GenerateResetToken generates a cryptographically secure random token
// Returns the raw token (to send to user) and its hash (to store in Redis)
func GenerateResetToken() (rawToken string, tokenHash string, err error) {
	// Generate 32 random bytes
	bytes := make([]byte, TokenByteLength)
	if _, err := rand.Read(bytes); err != nil {
		return "", "", fmt.Errorf("failed to generate random bytes: %w", err)
	}

	// Encode as hex (URL-safe, 64 characters)
	rawToken = hex.EncodeToString(bytes)

	// Hash with SHA-256
	tokenHash = HashToken(rawToken)

	return rawToken, tokenHash, nil
}

// HashToken computes SHA-256 hash of a token
func HashToken(rawToken string) string {
	hash := sha256.Sum256([]byte(rawToken))
	return hex.EncodeToString(hash[:])
}

// StoreResetToken stores a password reset token in Redis
// Key: "reset:<tokenHash>", Value: "<userId>", TTL: 15 minutes
func StoreResetToken(ctx context.Context, tokenHash string, userID uint) error {
	if redisClient == nil {
		return fmt.Errorf("redis client not initialized")
	}

	key := ResetTokenPrefix + tokenHash
	value := fmt.Sprintf("%d", userID)

	err := redisClient.Set(ctx, key, value, ResetTokenTTL).Err()
	if err != nil {
		return fmt.Errorf("failed to store reset token: %w", err)
	}

	return nil
}

// ValidateResetToken checks if a reset token exists in Redis
// Returns the userID if valid, 0 if invalid/expired
// Does NOT delete the token (for validate-only endpoint)
func ValidateResetToken(ctx context.Context, rawToken string) (uint, error) {
	if redisClient == nil {
		return 0, fmt.Errorf("redis client not initialized")
	}

	tokenHash := HashToken(rawToken)
	key := ResetTokenPrefix + tokenHash

	value, err := redisClient.Get(ctx, key).Result()
	if err == redis.Nil {
		return 0, nil // Token doesn't exist or expired
	}
	if err != nil {
		return 0, fmt.Errorf("failed to get reset token: %w", err)
	}

	var userID uint
	if _, err := fmt.Sscanf(value, "%d", &userID); err != nil {
		return 0, fmt.Errorf("failed to parse user ID: %w", err)
	}

	return userID, nil
}

// ConsumeResetToken validates and deletes a reset token (single-use)
// Returns the userID if valid, 0 if invalid/expired
func ConsumeResetToken(ctx context.Context, rawToken string) (uint, error) {
	if redisClient == nil {
		return 0, fmt.Errorf("redis client not initialized")
	}

	tokenHash := HashToken(rawToken)
	key := ResetTokenPrefix + tokenHash

	// Use a transaction to get and delete atomically
	var userID uint

	// First get the value
	value, err := redisClient.Get(ctx, key).Result()
	if err == redis.Nil {
		return 0, nil // Token doesn't exist or expired
	}
	if err != nil {
		return 0, fmt.Errorf("failed to get reset token: %w", err)
	}

	if _, err := fmt.Sscanf(value, "%d", &userID); err != nil {
		return 0, fmt.Errorf("failed to parse user ID: %w", err)
	}

	// Delete the token (make it single-use)
	if err := redisClient.Del(ctx, key).Err(); err != nil {
		return 0, fmt.Errorf("failed to delete reset token: %w", err)
	}

	return userID, nil
}

// DeleteResetToken explicitly deletes a reset token
func DeleteResetToken(ctx context.Context, rawToken string) error {
	if redisClient == nil {
		return fmt.Errorf("redis client not initialized")
	}

	tokenHash := HashToken(rawToken)
	key := ResetTokenPrefix + tokenHash

	return redisClient.Del(ctx, key).Err()
}
