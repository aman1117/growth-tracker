package repository

import (
	"strings"

	"github.com/aman1117/backend/internal/logger"
	"github.com/aman1117/backend/pkg/models"
	"gorm.io/gorm"
)

// CommentLikeRepository handles comment like data operations
type CommentLikeRepository struct {
	db *gorm.DB
}

// NewCommentLikeRepository creates a new CommentLikeRepository
func NewCommentLikeRepository(db *gorm.DB) *CommentLikeRepository {
	return &CommentLikeRepository{db: db}
}

// Create creates a comment like. Returns (true, nil) if created, (false, nil) if already liked.
func (r *CommentLikeRepository) Create(commentID, userID uint) (bool, error) {
	like := models.CommentLike{
		CommentID: commentID,
		UserID:    userID,
	}
	err := r.db.Create(&like).Error
	if err != nil {
		if strings.Contains(err.Error(), "23505") || strings.Contains(err.Error(), "duplicate") {
			return false, nil
		}
		logger.Sugar.Errorw("CommentLikeRepository.Create failed",
			"comment_id", commentID,
			"user_id", userID,
			"error", err,
		)
		return false, err
	}
	return true, nil
}

// Delete removes a comment like. Returns (true, nil) if deleted, (false, nil) if not found.
func (r *CommentLikeRepository) Delete(commentID, userID uint) (bool, error) {
	result := r.db.Where("comment_id = ? AND user_id = ?", commentID, userID).
		Delete(&models.CommentLike{})
	if result.Error != nil {
		return false, result.Error
	}
	return result.RowsAffected > 0, nil
}

// HasLiked checks if a user has liked a comment
func (r *CommentLikeRepository) HasLiked(commentID, userID uint) (bool, error) {
	var count int64
	err := r.db.Model(&models.CommentLike{}).
		Where("comment_id = ? AND user_id = ?", commentID, userID).
		Count(&count).Error
	return count > 0, err
}

// IncrementLikeCount atomically increments the like_count on a comment
func (r *CommentLikeRepository) IncrementLikeCount(commentID uint) error {
	return r.db.Model(&models.Comment{}).
		Where("id = ?", commentID).
		UpdateColumn("like_count", gorm.Expr("like_count + 1")).Error
}

// DecrementLikeCount atomically decrements like_count (floor at 0)
func (r *CommentLikeRepository) DecrementLikeCount(commentID uint) error {
	return r.db.Model(&models.Comment{}).
		Where("id = ? AND like_count > 0", commentID).
		UpdateColumn("like_count", gorm.Expr("like_count - 1")).Error
}

// BatchHasLiked checks which comments in a list have been liked by a user.
// Returns a map of commentID → true for liked comments.
func (r *CommentLikeRepository) BatchHasLiked(commentIDs []uint, userID uint) (map[uint]bool, error) {
	result := make(map[uint]bool)
	if len(commentIDs) == 0 {
		return result, nil
	}

	var likes []models.CommentLike
	err := r.db.Where("comment_id IN ? AND user_id = ?", commentIDs, userID).
		Find(&likes).Error
	if err != nil {
		return nil, err
	}

	for _, like := range likes {
		result[like.CommentID] = true
	}
	return result, nil
}
