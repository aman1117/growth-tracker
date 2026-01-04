// Package repository provides data access layer for badges.
package repository

import (
	"github.com/aman1117/backend/pkg/models"
	"gorm.io/gorm"
)

// BadgeRepository handles badge data operations
type BadgeRepository struct {
	db *gorm.DB
}

// NewBadgeRepository creates a new BadgeRepository
func NewBadgeRepository(db *gorm.DB) *BadgeRepository {
	return &BadgeRepository{db: db}
}

// Create creates a new user badge
func (r *BadgeRepository) Create(badge *models.UserBadge) error {
	return r.db.Create(badge).Error
}

// CreateBatch creates multiple badges in a single transaction
func (r *BadgeRepository) CreateBatch(badges []models.UserBadge) error {
	if len(badges) == 0 {
		return nil
	}
	return r.db.Create(&badges).Error
}

// FindByUserID finds all badges for a user
func (r *BadgeRepository) FindByUserID(userID uint) ([]models.UserBadge, error) {
	var badges []models.UserBadge
	err := r.db.Where("user_id = ?", userID).Order("earned_at ASC").Find(&badges).Error
	return badges, err
}

// FindByUserIDs finds all badges for multiple users
func (r *BadgeRepository) FindByUserIDs(userIDs []uint) ([]models.UserBadge, error) {
	var badges []models.UserBadge
	err := r.db.Where("user_id IN ?", userIDs).Order("earned_at ASC").Find(&badges).Error
	return badges, err
}

// ExistsByUserAndKey checks if a user has already earned a specific badge
func (r *BadgeRepository) ExistsByUserAndKey(userID uint, badgeKey string) (bool, error) {
	var count int64
	err := r.db.Model(&models.UserBadge{}).
		Where("user_id = ? AND badge_key = ?", userID, badgeKey).
		Count(&count).Error
	return count > 0, err
}

// GetEarnedBadgeKeys returns all badge keys earned by a user
func (r *BadgeRepository) GetEarnedBadgeKeys(userID uint) ([]string, error) {
	var keys []string
	err := r.db.Model(&models.UserBadge{}).
		Where("user_id = ?", userID).
		Pluck("badge_key", &keys).Error
	return keys, err
}

// DeleteByUserID deletes all badges for a user (useful for testing/reset)
func (r *BadgeRepository) DeleteByUserID(userID uint) error {
	return r.db.Where("user_id = ?", userID).Delete(&models.UserBadge{}).Error
}
