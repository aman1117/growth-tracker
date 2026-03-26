package repository

import (
	"time"

	"github.com/aman1117/backend/internal/logger"
	"github.com/aman1117/backend/pkg/models"
	"gorm.io/gorm"
)

// CommentDedupeRepository handles comment deduplication data operations
type CommentDedupeRepository struct {
	db *gorm.DB
}

// NewCommentDedupeRepository creates a new CommentDedupeRepository
func NewCommentDedupeRepository(db *gorm.DB) *CommentDedupeRepository {
	return &CommentDedupeRepository{db: db}
}

// CheckIdempotencyKey looks up a dedupe record by idempotency key within the time window
func (r *CommentDedupeRepository) CheckIdempotencyKey(key string, window time.Duration) (*models.CommentDedupe, error) {
	var dedupe models.CommentDedupe
	cutoff := time.Now().Add(-window)
	err := r.db.Where("idempotency_key = ? AND created_at > ?", key, cutoff).
		First(&dedupe).Error
	if err != nil {
		if err == gorm.ErrRecordNotFound {
			return nil, nil
		}
		return nil, err
	}
	return &dedupe, nil
}

// CheckBodyHash looks up a dedupe record by user + day + body hash within the time window
func (r *CommentDedupeRepository) CheckBodyHash(userID, dayOwnerID uint, dayDate time.Time, bodyHash string, window time.Duration) (*models.CommentDedupe, error) {
	var dedupe models.CommentDedupe
	dateStr := dayDate.Format("2006-01-02")
	cutoff := time.Now().Add(-window)
	err := r.db.Where(
		"user_id = ? AND day_owner_id = ? AND day_date = DATE(?) AND body_hash = ? AND created_at > ?",
		userID, dayOwnerID, dateStr, bodyHash, cutoff,
	).First(&dedupe).Error
	if err != nil {
		if err == gorm.ErrRecordNotFound {
			return nil, nil
		}
		return nil, err
	}
	return &dedupe, nil
}

// Create inserts a new dedupe record
func (r *CommentDedupeRepository) Create(dedupe *models.CommentDedupe) error {
	if err := r.db.Create(dedupe).Error; err != nil {
		logger.Sugar.Errorw("CommentDedupeRepository.Create failed",
			"user_id", dedupe.UserID,
			"comment_id", dedupe.CommentID,
			"error", err,
		)
		return err
	}
	return nil
}

// CleanupExpired removes dedupe records older than the given window
func (r *CommentDedupeRepository) CleanupExpired(window time.Duration) (int64, error) {
	cutoff := time.Now().Add(-window)
	result := r.db.Where("created_at < ?", cutoff).Delete(&models.CommentDedupe{})
	if result.Error != nil {
		logger.Sugar.Errorw("CommentDedupeRepository.CleanupExpired failed",
			"error", result.Error,
		)
		return 0, result.Error
	}
	return result.RowsAffected, nil
}
