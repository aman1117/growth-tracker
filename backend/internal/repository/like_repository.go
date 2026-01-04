package repository

import (
	"errors"
	"strings"
	"time"

	"github.com/aman1117/backend/internal/logger"
	"github.com/aman1117/backend/pkg/models"
	"gorm.io/gorm"
)

// LikeRepository handles like data operations
type LikeRepository struct {
	db *gorm.DB
}

// NewLikeRepository creates a new LikeRepository
func NewLikeRepository(db *gorm.DB) *LikeRepository {
	return &LikeRepository{db: db}
}

// LikeWithUser represents a like with liker's user info for API responses
type LikeWithUser struct {
	ID         uint
	LikerID    uint
	Username   string
	ProfilePic *string
	CreatedAt  time.Time
}

// Create creates a new like (handles duplicate gracefully)
func (r *LikeRepository) Create(likerID, likedUserID uint, likedDate time.Time) error {
	log := logger.Sugar

	dateStr := likedDate.Format("2006-01-02")
	log.Infow("LikeRepository.Create called",
		"liker_id", likerID,
		"liked_user_id", likedUserID,
		"liked_date", dateStr,
	)

	like := models.Like{
		LikerID:     likerID,
		LikedUserID: likedUserID,
		LikedDate:   likedDate,
	}
	err := r.db.Create(&like).Error
	if err != nil {
		// Check if it's a duplicate key error
		if strings.Contains(err.Error(), "23505") || strings.Contains(err.Error(), "duplicate") {
			log.Warnw("Like already exists (duplicate key)",
				"liker_id", likerID,
				"liked_user_id", likedUserID,
				"liked_date", dateStr,
			)
			return nil // Already liked, not an error
		}
		log.Errorw("LikeRepository.Create failed",
			"liker_id", likerID,
			"liked_user_id", likedUserID,
			"liked_date", dateStr,
			"error", err,
		)
		return err
	}

	log.Infow("LikeRepository.Create success",
		"liker_id", likerID,
		"liked_user_id", likedUserID,
		"liked_date", dateStr,
		"like_id", like.ID,
	)
	return nil
}

// Delete removes a like
func (r *LikeRepository) Delete(likerID, likedUserID uint, likedDate time.Time) error {
	log := logger.Sugar
	dateStr := likedDate.Format("2006-01-02")

	log.Infow("LikeRepository.Delete called",
		"liker_id", likerID,
		"liked_user_id", likedUserID,
		"liked_date", dateStr,
	)

	result := r.db.Where(
		"liker_id = ? AND liked_user_id = ? AND liked_date = DATE(?)",
		likerID, likedUserID, dateStr,
	).Delete(&models.Like{})

	if result.Error != nil {
		log.Errorw("LikeRepository.Delete failed",
			"liker_id", likerID,
			"liked_user_id", likedUserID,
			"liked_date", dateStr,
			"error", result.Error,
		)
		return result.Error
	}
	if result.RowsAffected == 0 {
		log.Warnw("LikeRepository.Delete no rows affected (like not found)",
			"liker_id", likerID,
			"liked_user_id", likedUserID,
			"liked_date", dateStr,
		)
		return errors.New("like not found")
	}

	log.Infow("LikeRepository.Delete success",
		"liker_id", likerID,
		"liked_user_id", likedUserID,
		"liked_date", dateStr,
		"rows_affected", result.RowsAffected,
	)
	return nil
}

// HasLiked checks if a user has liked another user's day
func (r *LikeRepository) HasLiked(likerID, likedUserID uint, likedDate time.Time) (bool, error) {
	log := logger.Sugar
	dateStr := likedDate.Format("2006-01-02")

	log.Infow("LikeRepository.HasLiked called",
		"liker_id", likerID,
		"liked_user_id", likedUserID,
		"liked_date", dateStr,
	)

	var count int64
	// Use DATE cast for reliable comparison
	err := r.db.Model(&models.Like{}).Where(
		"liker_id = ? AND liked_user_id = ? AND liked_date = DATE(?)",
		likerID, likedUserID, dateStr,
	).Count(&count).Error

	if err != nil {
		log.Errorw("LikeRepository.HasLiked query failed",
			"liker_id", likerID,
			"liked_user_id", likedUserID,
			"liked_date", dateStr,
			"error", err,
		)
		return false, err
	}

	hasLiked := count > 0
	log.Infow("LikeRepository.HasLiked result",
		"liker_id", likerID,
		"liked_user_id", likedUserID,
		"liked_date", dateStr,
		"count", count,
		"has_liked", hasLiked,
	)
	return hasLiked, nil
}

// GetLikesForDay retrieves all likes for a user's specific day with liker info
func (r *LikeRepository) GetLikesForDay(likedUserID uint, likedDate time.Time) ([]LikeWithUser, error) {
	log := logger.Sugar
	dateStr := likedDate.Format("2006-01-02")

	log.Infow("LikeRepository.GetLikesForDay called",
		"liked_user_id", likedUserID,
		"liked_date", dateStr,
	)

	var likes []LikeWithUser

	err := r.db.Table("likes").
		Select("likes.id, likes.liker_id, users.username, users.profile_pic, likes.created_at").
		Joins("JOIN users ON users.id = likes.liker_id").
		Where("likes.liked_user_id = ? AND likes.liked_date = DATE(?)", likedUserID, dateStr).
		Order("likes.created_at DESC").
		Scan(&likes).Error

	if err != nil {
		log.Errorw("LikeRepository.GetLikesForDay failed",
			"liked_user_id", likedUserID,
			"liked_date", dateStr,
			"error", err,
		)
		return nil, err
	}

	log.Infow("LikeRepository.GetLikesForDay result",
		"liked_user_id", likedUserID,
		"liked_date", dateStr,
		"likes_count", len(likes),
	)
	return likes, nil
}

// CountLikesForDay counts the number of likes for a user's specific day
func (r *LikeRepository) CountLikesForDay(likedUserID uint, likedDate time.Time) (int64, error) {
	var count int64
	err := r.db.Model(&models.Like{}).Where(
		"liked_user_id = ? AND liked_date = DATE(?)",
		likedUserID, likedDate.Format("2006-01-02"),
	).Count(&count).Error

	return count, err
}

// GetLikesByUser retrieves all likes given by a user (for potential future use)
func (r *LikeRepository) GetLikesByUser(likerID uint, limit int) ([]models.Like, error) {
	var likes []models.Like
	err := r.db.Where("liker_id = ?", likerID).
		Order("created_at DESC").
		Limit(limit).
		Find(&likes).Error

	if err != nil {
		return nil, err
	}
	return likes, nil
}
