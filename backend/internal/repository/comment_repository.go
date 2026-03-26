package repository

import (
	"time"

	"github.com/aman1117/backend/internal/logger"
	"github.com/aman1117/backend/pkg/models"
	"gorm.io/gorm"
)

// CommentWithAuthor represents a comment with joined author information
type CommentWithAuthor struct {
	models.Comment
	AuthorUsername string  `json:"author_username"`
	AuthorAvatar   *string `json:"author_avatar"`
	AuthorVerified bool    `json:"author_verified"`
}

// CommentRepository handles comment data operations
type CommentRepository struct {
	db *gorm.DB
}

// NewCommentRepository creates a new CommentRepository
func NewCommentRepository(db *gorm.DB) *CommentRepository {
	return &CommentRepository{db: db}
}

// Create inserts a new comment
func (r *CommentRepository) Create(comment *models.Comment) error {
	if err := r.db.Create(comment).Error; err != nil {
		logger.Sugar.Errorw("CommentRepository.Create failed",
			"author_id", comment.AuthorID,
			"day_owner_id", comment.DayOwnerID,
			"error", err,
		)
		return err
	}
	return nil
}

// GetByID retrieves a single comment by ID
func (r *CommentRepository) GetByID(id uint) (*models.Comment, error) {
	var comment models.Comment
	err := r.db.First(&comment, id).Error
	if err != nil {
		return nil, err
	}
	return &comment, nil
}

// GetByIDWithAuthor retrieves a single comment with author info
func (r *CommentRepository) GetByIDWithAuthor(id uint) (*CommentWithAuthor, error) {
	var result CommentWithAuthor
	err := r.db.Table("comments").
		Select("comments.*, users.username as author_username, users.profile_pic as author_avatar, users.is_verified as author_verified").
		Joins("LEFT JOIN users ON users.id = comments.author_id").
		Where("comments.id = ?", id).
		Scan(&result).Error
	if err != nil {
		return nil, err
	}
	if result.ID == 0 {
		return nil, gorm.ErrRecordNotFound
	}
	return &result, nil
}

// GetTopLevelByDay retrieves top-level comments for a day with author info.
// sort can be "newest" (created_at DESC) — ranking is applied in service layer for "top".
func (r *CommentRepository) GetTopLevelByDay(dayOwnerID uint, dayDate time.Time, cursor *uint, limit int) ([]CommentWithAuthor, error) {
	dateStr := dayDate.Format("2006-01-02")

	query := r.db.Table("comments").
		Select("comments.*, users.username as author_username, users.profile_pic as author_avatar, users.is_verified as author_verified").
		Joins("LEFT JOIN users ON users.id = comments.author_id").
		Where("comments.day_owner_id = ? AND comments.day_date = DATE(?) AND comments.parent_comment_id IS NULL",
			dayOwnerID, dateStr)

	if cursor != nil && *cursor > 0 {
		query = query.Where("comments.id < ?", *cursor)
	}

	// Fetch extra for ranking in service layer; order by newest first as default
	query = query.Order("comments.created_at DESC, comments.id DESC").Limit(limit + 1)

	var results []CommentWithAuthor
	if err := query.Find(&results).Error; err != nil {
		logger.Sugar.Errorw("CommentRepository.GetTopLevelByDay failed",
			"day_owner_id", dayOwnerID,
			"day_date", dateStr,
			"error", err,
		)
		return nil, err
	}

	return results, nil
}

// GetRepliesByRoot retrieves replies for a root comment, oldest first
func (r *CommentRepository) GetRepliesByRoot(rootCommentID uint, cursor *uint, limit int) ([]CommentWithAuthor, error) {
	query := r.db.Table("comments").
		Select("comments.*, users.username as author_username, users.profile_pic as author_avatar, users.is_verified as author_verified").
		Joins("LEFT JOIN users ON users.id = comments.author_id").
		Where("comments.root_comment_id = ?", rootCommentID)

	if cursor != nil && *cursor > 0 {
		query = query.Where("comments.id > ?", *cursor)
	}

	query = query.Order("comments.created_at ASC, comments.id ASC").Limit(limit + 1)

	var results []CommentWithAuthor
	if err := query.Find(&results).Error; err != nil {
		logger.Sugar.Errorw("CommentRepository.GetRepliesByRoot failed",
			"root_comment_id", rootCommentID,
			"error", err,
		)
		return nil, err
	}

	return results, nil
}

// SoftDelete marks a comment as deleted
func (r *CommentRepository) SoftDelete(commentID uint) error {
	now := time.Now()
	result := r.db.Model(&models.Comment{}).
		Where("id = ? AND is_deleted = false", commentID).
		Updates(map[string]interface{}{
			"is_deleted": true,
			"deleted_at": now,
			"body":       "[Deleted]",
		})
	if result.Error != nil {
		logger.Sugar.Errorw("CommentRepository.SoftDelete failed",
			"comment_id", commentID,
			"error", result.Error,
		)
		return result.Error
	}
	return nil
}

// IncrementAncestorReplyCounts atomically increments reply_count on every
// ancestor of the given comment (parent, grandparent, … up to root).
// Uses a recursive CTE to walk the parent_comment_id chain.
func (r *CommentRepository) IncrementAncestorReplyCounts(commentID uint) error {
	return r.db.Exec(`
		WITH RECURSIVE ancestors AS (
			SELECT parent_comment_id AS id
			FROM comments
			WHERE id = ? AND parent_comment_id IS NOT NULL
			UNION ALL
			SELECT c.parent_comment_id
			FROM comments c
			INNER JOIN ancestors a ON c.id = a.id
			WHERE c.parent_comment_id IS NOT NULL
		)
		UPDATE comments
		SET reply_count = reply_count + 1
		WHERE id IN (SELECT id FROM ancestors)
	`, commentID).Error
}

// DecrementAncestorReplyCounts atomically decrements reply_count on every
// ancestor of the given comment (floor at 0).
func (r *CommentRepository) DecrementAncestorReplyCounts(commentID uint) error {
	return r.db.Exec(`
		WITH RECURSIVE ancestors AS (
			SELECT parent_comment_id AS id
			FROM comments
			WHERE id = ? AND parent_comment_id IS NOT NULL
			UNION ALL
			SELECT c.parent_comment_id
			FROM comments c
			INNER JOIN ancestors a ON c.id = a.id
			WHERE c.parent_comment_id IS NOT NULL
		)
		UPDATE comments
		SET reply_count = GREATEST(reply_count - 1, 0)
		WHERE id IN (SELECT id FROM ancestors)
	`, commentID).Error
}

// GetCommentCountForDay returns the count of non-deleted comments for a day
func (r *CommentRepository) GetCommentCountForDay(dayOwnerID uint, dayDate time.Time) (int64, error) {
	dateStr := dayDate.Format("2006-01-02")
	var count int64
	err := r.db.Model(&models.Comment{}).
		Where("day_owner_id = ? AND day_date = DATE(?) AND is_deleted = false",
			dayOwnerID, dateStr).
		Count(&count).Error
	return count, err
}

// GetReplyToUsername retrieves the username for a reply_to_user_id
func (r *CommentRepository) GetReplyToUsername(userID uint) (string, error) {
	var user models.User
	err := r.db.Select("username").First(&user, userID).Error
	if err != nil {
		return "", err
	}
	return user.Username, nil
}
