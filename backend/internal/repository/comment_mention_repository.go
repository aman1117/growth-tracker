package repository

import (
	"github.com/aman1117/backend/internal/logger"
	"github.com/aman1117/backend/pkg/models"
	"gorm.io/gorm"
)

// CommentMentionRepository handles comment mention data operations
type CommentMentionRepository struct {
	db *gorm.DB
}

// NewCommentMentionRepository creates a new CommentMentionRepository
func NewCommentMentionRepository(db *gorm.DB) *CommentMentionRepository {
	return &CommentMentionRepository{db: db}
}

// CreateBatch inserts multiple mentions for a comment
func (r *CommentMentionRepository) CreateBatch(mentions []models.CommentMention) error {
	if len(mentions) == 0 {
		return nil
	}
	if err := r.db.Create(&mentions).Error; err != nil {
		logger.Sugar.Errorw("CommentMentionRepository.CreateBatch failed",
			"count", len(mentions),
			"error", err,
		)
		return err
	}
	return nil
}

// GetByCommentID retrieves all mentions for a single comment
func (r *CommentMentionRepository) GetByCommentID(commentID uint) ([]models.CommentMention, error) {
	var mentions []models.CommentMention
	err := r.db.Where("comment_id = ?", commentID).Find(&mentions).Error
	return mentions, err
}

// DeleteByCommentID removes all mentions for a comment
func (r *CommentMentionRepository) DeleteByCommentID(commentID uint) error {
	result := r.db.Where("comment_id = ?", commentID).Delete(&models.CommentMention{})
	if result.Error != nil {
		logger.Sugar.Errorw("CommentMentionRepository.DeleteByCommentID failed",
			"comment_id", commentID,
			"error", result.Error,
		)
		return result.Error
	}
	return nil
}

// GetByCommentIDs retrieves mentions for multiple comments, grouped by comment ID
func (r *CommentMentionRepository) GetByCommentIDs(commentIDs []uint) (map[uint][]models.CommentMention, error) {
	result := make(map[uint][]models.CommentMention)
	if len(commentIDs) == 0 {
		return result, nil
	}

	var mentions []models.CommentMention
	err := r.db.Where("comment_id IN ?", commentIDs).Find(&mentions).Error
	if err != nil {
		return nil, err
	}

	for _, m := range mentions {
		result[m.CommentID] = append(result[m.CommentID], m)
	}
	return result, nil
}
