// Package repository provides data access layer for notifications.
package repository

import (
	"time"

	"github.com/aman1117/backend/pkg/models"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// NotificationRepository handles notification data operations
type NotificationRepository struct {
	db *gorm.DB
}

// NewNotificationRepository creates a new NotificationRepository
func NewNotificationRepository(db *gorm.DB) *NotificationRepository {
	return &NotificationRepository{db: db}
}

// Create creates a new notification
func (r *NotificationRepository) Create(notif *models.Notification) error {
	return r.db.Create(notif).Error
}

// CreateBatch creates multiple notifications in a single transaction
func (r *NotificationRepository) CreateBatch(notifs []*models.Notification) error {
	if len(notifs) == 0 {
		return nil
	}
	return r.db.CreateInBatches(notifs, 100).Error
}

// GetByID retrieves a notification by ID
func (r *NotificationRepository) GetByID(id uint) (*models.Notification, error) {
	var notif models.Notification
	if err := r.db.First(&notif, id).Error; err != nil {
		if err == gorm.ErrRecordNotFound {
			return nil, nil
		}
		return nil, err
	}
	return &notif, nil
}

// GetByUserID retrieves notifications for a user with pagination
// Returns notifications ordered by created_at DESC (newest first)
func (r *NotificationRepository) GetByUserID(userID uint, limit, offset int) ([]models.Notification, error) {
	var notifs []models.Notification
	err := r.db.Where("user_id = ?", userID).
		Order("created_at DESC").
		Limit(limit).
		Offset(offset).
		Find(&notifs).Error
	return notifs, err
}

// GetUnreadByUserID retrieves unread notifications for a user
func (r *NotificationRepository) GetUnreadByUserID(userID uint, limit int) ([]models.Notification, error) {
	var notifs []models.Notification
	err := r.db.Where("user_id = ? AND read_at IS NULL", userID).
		Order("created_at DESC").
		Limit(limit).
		Find(&notifs).Error
	return notifs, err
}

// GetUnreadCount returns the count of unread notifications for a user
func (r *NotificationRepository) GetUnreadCount(userID uint) (int64, error) {
	var count int64
	err := r.db.Model(&models.Notification{}).
		Where("user_id = ? AND read_at IS NULL", userID).
		Count(&count).Error
	return count, err
}

// MarkAsRead marks a single notification as read
func (r *NotificationRepository) MarkAsRead(id, userID uint) error {
	now := time.Now()
	result := r.db.Model(&models.Notification{}).
		Where("id = ? AND user_id = ? AND read_at IS NULL", id, userID).
		Update("read_at", now)
	return result.Error
}

// MarkAllAsRead marks all notifications as read for a user
func (r *NotificationRepository) MarkAllAsRead(userID uint) error {
	now := time.Now()
	result := r.db.Model(&models.Notification{}).
		Where("user_id = ? AND read_at IS NULL", userID).
		Update("read_at", now)
	return result.Error
}

// Delete removes a notification by ID (must belong to user)
func (r *NotificationRepository) Delete(id, userID uint) error {
	result := r.db.Where("id = ? AND user_id = ?", id, userID).Delete(&models.Notification{})
	return result.Error
}

// DeleteOlderThan deletes notifications older than the specified time
// readOlderThan: delete read notifications older than this
// unreadOlderThan: delete unread notifications older than this
func (r *NotificationRepository) DeleteOlderThan(readOlderThan, unreadOlderThan time.Time) (int64, error) {
	// Delete read notifications older than readOlderThan
	readResult := r.db.Where("read_at IS NOT NULL AND created_at < ?", readOlderThan).
		Delete(&models.Notification{})
	if readResult.Error != nil {
		return 0, readResult.Error
	}

	// Delete unread notifications older than unreadOlderThan
	unreadResult := r.db.Where("read_at IS NULL AND created_at < ?", unreadOlderThan).
		Delete(&models.Notification{})
	if unreadResult.Error != nil {
		return readResult.RowsAffected, unreadResult.Error
	}

	return readResult.RowsAffected + unreadResult.RowsAffected, nil
}

// CountByUserID returns total notification count for a user
func (r *NotificationRepository) CountByUserID(userID uint) (int64, error) {
	var count int64
	err := r.db.Model(&models.Notification{}).
		Where("user_id = ?", userID).
		Count(&count).Error
	return count, err
}

// ExistsByTypeAndMetadata checks if a notification with given type and metadata exists
// Useful for deduplication (e.g., don't send duplicate like notifications)
func (r *NotificationRepository) ExistsByTypeAndMetadata(
	userID uint,
	notifType models.NotificationType,
	metadataKey string,
	metadataValue interface{},
	withinDuration time.Duration,
) (bool, error) {
	var count int64
	sinceTime := time.Now().Add(-withinDuration)

	err := r.db.Model(&models.Notification{}).
		Where("user_id = ? AND type = ? AND created_at > ?", userID, notifType, sinceTime).
		Where("metadata->>? = ?", metadataKey, metadataValue).
		Count(&count).Error

	return count > 0, err
}

// CreateDedupeRecord attempts to insert a dedupe record using ON CONFLICT DO NOTHING.
// Returns (true, nil) if a new record was created, (false, nil) if already exists,
// or (false, error) on database error.
func (r *NotificationRepository) CreateDedupeRecord(dedupe *models.NotificationDedupe) (bool, error) {
	result := r.db.Clauses(clause.OnConflict{DoNothing: true}).Create(dedupe)
	if result.Error != nil {
		return false, result.Error
	}
	// RowsAffected == 0 means the record already existed (conflict)
	return result.RowsAffected > 0, nil
}

// GetDB returns the underlying database connection for transaction support
func (r *NotificationRepository) GetDB() *gorm.DB {
	return r.db
}
