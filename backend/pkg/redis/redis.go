// Package redis provides Redis client and helper functions.
package redis

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"time"

	"github.com/aman1117/backend/internal/constants"
	goredis "github.com/redis/go-redis/v9"
)

var client *goredis.Client

// Init initializes the Redis client
func Init(redisURL string) error {
	if redisURL == "" {
		return fmt.Errorf("REDIS_URL is not set")
	}

	opt, err := goredis.ParseURL(redisURL)
	if err != nil {
		return fmt.Errorf("failed to parse REDIS_URL: %w", err)
	}

	client = goredis.NewClient(opt)

	// Test connection
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := client.Ping(ctx).Err(); err != nil {
		return fmt.Errorf("failed to connect to Redis: %w", err)
	}

	return nil
}

// Get returns the Redis client
func Get() *goredis.Client {
	return client
}

// IsAvailable returns whether Redis is configured and available
func IsAvailable() bool {
	return client != nil
}

// Close closes the Redis connection
func Close() error {
	if client == nil {
		return nil
	}
	return client.Close()
}

// ==================== Password Reset Token Functions ====================

// GenerateResetToken generates a cryptographically secure random token
// Returns the raw token (to send to user) and its hash (to store in Redis)
func GenerateResetToken() (rawToken string, tokenHash string, err error) {
	bytes := make([]byte, constants.ResetTokenByteLen)
	if _, err := rand.Read(bytes); err != nil {
		return "", "", fmt.Errorf("failed to generate random bytes: %w", err)
	}

	rawToken = hex.EncodeToString(bytes)
	tokenHash = HashToken(rawToken)

	return rawToken, tokenHash, nil
}

// HashToken computes SHA-256 hash of a token
func HashToken(rawToken string) string {
	hash := sha256.Sum256([]byte(rawToken))
	return hex.EncodeToString(hash[:])
}

// StoreResetToken stores a password reset token in Redis
func StoreResetToken(ctx context.Context, tokenHash string, userID uint) error {
	if client == nil {
		return fmt.Errorf("redis client not initialized")
	}

	key := constants.ResetTokenPrefix + tokenHash
	value := fmt.Sprintf("%d", userID)

	return client.Set(ctx, key, value, constants.ResetTokenTTL).Err()
}

// ValidateResetToken checks if a reset token exists in Redis
// Does NOT delete the token (for validate-only endpoint)
func ValidateResetToken(ctx context.Context, rawToken string) (uint, error) {
	if client == nil {
		return 0, fmt.Errorf("redis client not initialized")
	}

	tokenHash := HashToken(rawToken)
	key := constants.ResetTokenPrefix + tokenHash

	value, err := client.Get(ctx, key).Result()
	if err == goredis.Nil {
		return 0, nil
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
func ConsumeResetToken(ctx context.Context, rawToken string) (uint, error) {
	if client == nil {
		return 0, fmt.Errorf("redis client not initialized")
	}

	tokenHash := HashToken(rawToken)
	key := constants.ResetTokenPrefix + tokenHash

	value, err := client.Get(ctx, key).Result()
	if err == goredis.Nil {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("failed to get reset token: %w", err)
	}

	var userID uint
	if _, err := fmt.Sscanf(value, "%d", &userID); err != nil {
		return 0, fmt.Errorf("failed to parse user ID: %w", err)
	}

	// Delete the token (single-use)
	if err := client.Del(ctx, key).Err(); err != nil {
		return 0, fmt.Errorf("failed to delete reset token: %w", err)
	}

	return userID, nil
}

// DeleteResetToken explicitly deletes a reset token
func DeleteResetToken(ctx context.Context, rawToken string) error {
	if client == nil {
		return fmt.Errorf("redis client not initialized")
	}

	tokenHash := HashToken(rawToken)
	key := constants.ResetTokenPrefix + tokenHash

	return client.Del(ctx, key).Err()
}

// ==================== Likes Cache Functions ====================

// LikesCacheKey generates the Redis key for likes cache
func LikesCacheKey(userID uint, date string) string {
	return fmt.Sprintf("%s%d:%s", constants.LikesCachePrefix, userID, date)
}

// GetLikesCache retrieves cached likes data from Redis
func GetLikesCache(ctx context.Context, userID uint, date string) (string, error) {
	if client == nil {
		return "", fmt.Errorf("redis client not initialized")
	}

	key := LikesCacheKey(userID, date)
	value, err := client.Get(ctx, key).Result()
	if err == goredis.Nil {
		// Cache miss - this is normal, not an error
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("failed to get likes cache for key %s: %w", key, err)
	}

	return value, nil
}

// SetLikesCache stores likes data in Redis cache
func SetLikesCache(ctx context.Context, userID uint, date string, data string) error {
	if client == nil {
		return fmt.Errorf("redis client not initialized")
	}

	key := LikesCacheKey(userID, date)
	if err := client.Set(ctx, key, data, constants.LikesCacheTTL).Err(); err != nil {
		return fmt.Errorf("failed to set likes cache for key %s: %w", key, err)
	}

	return nil
}

// InvalidateLikesCache removes likes data from Redis cache
func InvalidateLikesCache(ctx context.Context, userID uint, date string) error {
	if client == nil {
		return fmt.Errorf("redis client not initialized")
	}

	key := LikesCacheKey(userID, date)
	if err := client.Del(ctx, key).Err(); err != nil {
		return fmt.Errorf("failed to invalidate likes cache for key %s: %w", key, err)
	}

	return nil
}
