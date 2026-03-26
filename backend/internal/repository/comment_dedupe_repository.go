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

// Upsert inserts a new dedupe record or updates the existing one on conflict.
// This handles the case where an expired record still occupies the unique constraint slot.
func (r *CommentDedupeRepository) Upsert(dedupe *models.CommentDedupe) error {
	result := r.db.Exec(
		`INSERT INTO comment_dedupes (user_id, day_owner_id, day_date, body_hash, idempotency_key, comment_id, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, NOW())
		 ON CONFLICT (user_id, day_owner_id, day_date, body_hash)
		 DO UPDATE SET comment_id = EXCLUDED.comment_id,
		               idempotency_key = EXCLUDED.idempotency_key,
		               created_at = NOW()`,
		dedupe.UserID, dedupe.DayOwnerID, dedupe.DayDate, dedupe.BodyHash, dedupe.IdempotencyKey, dedupe.CommentID,
	)
	if result.Error != nil {
		logger.Sugar.Errorw("CommentDedupeRepository.Upsert failed",
			"user_id", dedupe.UserID,
			"comment_id", dedupe.CommentID,
			"error", result.Error,
		)
		return result.Error
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
