// Package repository provides data access layer for push notifications.
package repository

import (
	"errors"
	"time"

	"github.com/aman1117/backend/pkg/models"
	"gorm.io/gorm"
)

var (
	// ErrEndpointConflict is returned when an endpoint exists for a different user
	ErrEndpointConflict = errors.New("endpoint already registered to another user")
)

// PushRepository handles push subscription and preference data operations
type PushRepository struct {
	db *gorm.DB
}

// NewPushRepository creates a new PushRepository
func NewPushRepository(db *gorm.DB) *PushRepository {
	return &PushRepository{db: db}
}

// ============================================================================
// Push Subscription Operations
// ============================================================================

// UpsertSubscription creates or updates a push subscription
// Returns ErrEndpointConflict if the endpoint is already registered to a different user
func (r *PushRepository) UpsertSubscription(sub *models.PushSubscription) error {
	// Check if endpoint exists for a different user
	var existing models.PushSubscription
	err := r.db.Where("endpoint = ?", sub.Endpoint).First(&existing).Error
	if err == nil {
		// Endpoint exists
		if existing.UserID != sub.UserID {
			return ErrEndpointConflict
		}
		// Same user - update existing subscription
		sub.ID = existing.ID
		sub.CreatedAt = existing.CreatedAt
		return r.db.Save(sub).Error
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return err
	}
	// New subscription
	return r.db.Create(sub).Error
}

// GetSubscriptionByEndpoint retrieves a subscription by endpoint
func (r *PushRepository) GetSubscriptionByEndpoint(endpoint string) (*models.PushSubscription, error) {
	var sub models.PushSubscription
	err := r.db.Where("endpoint = ?", endpoint).First(&sub).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &sub, err
}

// GetActiveSubscriptionsByUserID retrieves all active subscriptions for a user
func (r *PushRepository) GetActiveSubscriptionsByUserID(userID uint) ([]models.PushSubscription, error) {
	var subs []models.PushSubscription
	err := r.db.Where("user_id = ? AND status = ?", userID, models.PushSubscriptionStatusActive).
		Find(&subs).Error
	return subs, err
}

// DeleteSubscription marks a subscription as expired (soft delete)
func (r *PushRepository) DeleteSubscription(endpoint string, userID uint) error {
	return r.db.Model(&models.PushSubscription{}).
		Where("endpoint = ? AND user_id = ?", endpoint, userID).
		Update("status", models.PushSubscriptionStatusExpired).Error
}

// DeleteSubscriptionsByUserID deletes all subscriptions for a user (for account deletion)
func (r *PushRepository) DeleteSubscriptionsByUserID(userID uint) error {
	return r.db.Where("user_id = ?", userID).Delete(&models.PushSubscription{}).Error
}

// MarkSubscriptionGone marks a subscription as gone (dead endpoint)
func (r *PushRepository) MarkSubscriptionGone(id uint) error {
	now := time.Now()
	return r.db.Model(&models.PushSubscription{}).
		Where("id = ?", id).
		Updates(map[string]interface{}{
			"status":          models.PushSubscriptionStatusGone,
			"last_failure_at": now,
		}).Error
}

// UpdateSubscriptionSuccess updates subscription after successful push
func (r *PushRepository) UpdateSubscriptionSuccess(id uint) error {
	now := time.Now()
	return r.db.Model(&models.PushSubscription{}).
		Where("id = ?", id).
		Updates(map[string]interface{}{
			"last_success_at": now,
			"failure_count":   0,
		}).Error
}

// IncrementSubscriptionFailure increments failure count and optionally marks as expired
func (r *PushRepository) IncrementSubscriptionFailure(id uint, maxFailures int) error {
	now := time.Now()
	result := r.db.Model(&models.PushSubscription{}).
		Where("id = ?", id).
		Updates(map[string]interface{}{
			"failure_count":   gorm.Expr("failure_count + 1"),
			"last_failure_at": now,
		})
	if result.Error != nil {
		return result.Error
	}

	// Mark as expired if max failures reached
	if maxFailures > 0 {
		return r.db.Model(&models.PushSubscription{}).
			Where("id = ? AND failure_count >= ?", id, maxFailures).
			Update("status", models.PushSubscriptionStatusExpired).Error
	}
	return nil
}

// CleanupStaleSubscriptions marks old inactive subscriptions as expired
func (r *PushRepository) CleanupStaleSubscriptions(staleDays int) (int64, error) {
	cutoff := time.Now().AddDate(0, 0, -staleDays)
	result := r.db.Model(&models.PushSubscription{}).
		Where("status = ? AND (last_success_at IS NULL OR last_success_at < ?)",
			models.PushSubscriptionStatusActive, cutoff).
		Update("status", models.PushSubscriptionStatusExpired)
	return result.RowsAffected, result.Error
}

// CleanupGoneSubscriptions deletes old gone subscriptions
func (r *PushRepository) CleanupGoneSubscriptions(daysOld int) (int64, error) {
	cutoff := time.Now().AddDate(0, 0, -daysOld)
	result := r.db.Where("status = ? AND updated_at < ?",
		models.PushSubscriptionStatusGone, cutoff).
		Delete(&models.PushSubscription{})
	return result.RowsAffected, result.Error
}

// ============================================================================
// Push Preference Operations
// ============================================================================

// GetOrCreatePreference retrieves preferences for a user, creating defaults if not exists
func (r *PushRepository) GetOrCreatePreference(userID uint) (*models.PushPreference, error) {
	var pref models.PushPreference
	err := r.db.Where("user_id = ?", userID).First(&pref).Error
	if err == nil {
		return &pref, nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, err
	}

	// Create default preferences
	pref = *models.DefaultPushPreference(userID)
	if err := r.db.Create(&pref).Error; err != nil {
		// Handle race condition - another request may have created it
		if r.db.Where("user_id = ?", userID).First(&pref).Error == nil {
			return &pref, nil
		}
		return nil, err
	}
	return &pref, nil
}

// UpdatePreference updates push preferences for a user
func (r *PushRepository) UpdatePreference(pref *models.PushPreference) error {
	return r.db.Save(pref).Error
}

// DeletePreferenceByUserID deletes preferences for a user (for account deletion)
func (r *PushRepository) DeletePreferenceByUserID(userID uint) error {
	return r.db.Where("user_id = ?", userID).Delete(&models.PushPreference{}).Error
}

// ============================================================================
// Push Delivery Log Operations
// ============================================================================

// CreateDeliveryLog creates a new delivery log entry
func (r *PushRepository) CreateDeliveryLog(log *models.PushDeliveryLog) error {
	return r.db.Create(log).Error
}

// CheckIdempotency checks if a message has already been delivered to a subscription
func (r *PushRepository) CheckIdempotency(messageID string, subscriptionID uint) (bool, error) {
	var count int64
	err := r.db.Model(&models.PushDeliveryLog{}).
		Where("message_id = ? AND subscription_id = ?", messageID, subscriptionID).
		Count(&count).Error
	return count > 0, err
}

// CheckDedupeWindow checks if a similar notification was sent recently
func (r *PushRepository) CheckDedupeWindow(userID uint, dedupeKey string, windowSeconds int) (bool, error) {
	if dedupeKey == "" {
		return false, nil
	}
	cutoff := time.Now().Add(-time.Duration(windowSeconds) * time.Second)
	var count int64
	err := r.db.Model(&models.PushDeliveryLog{}).
		Where("user_id = ? AND dedupe_key = ? AND created_at > ? AND status_code >= 200 AND status_code < 300",
			userID, dedupeKey, cutoff).
		Count(&count).Error
	return count > 0, err
}

// CleanupOldDeliveryLogs deletes old delivery logs
func (r *PushRepository) CleanupOldDeliveryLogs(daysOld int) (int64, error) {
	cutoff := time.Now().AddDate(0, 0, -daysOld)
	result := r.db.Where("created_at < ?", cutoff).Delete(&models.PushDeliveryLog{})
	return result.RowsAffected, result.Error
}
