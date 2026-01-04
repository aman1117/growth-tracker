// Package services provides business logic for badges.
package services

import (
	"time"

	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/dto"
	"github.com/aman1117/backend/internal/repository"
	"github.com/aman1117/backend/pkg/models"
)

// BadgeService handles badge-related business logic
type BadgeService struct {
	badgeRepo *repository.BadgeRepository
	userRepo  *repository.UserRepository
}

// NewBadgeService creates a new BadgeService
func NewBadgeService(badgeRepo *repository.BadgeRepository, userRepo *repository.UserRepository) *BadgeService {
	return &BadgeService{
		badgeRepo: badgeRepo,
		userRepo:  userRepo,
	}
}

// CheckAndAwardBadges checks if user qualifies for new badges and awards them
// Returns newly awarded badges
func (s *BadgeService) CheckAndAwardBadges(userID uint, longestStreak int) ([]dto.BadgeDTO, error) {
	// Get all badge keys the user qualifies for
	eligibleKeys := constants.GetEligibleBadgeKeys(longestStreak)
	if len(eligibleKeys) == 0 {
		return nil, nil
	}

	// Get already earned badge keys
	earnedKeys, err := s.badgeRepo.GetEarnedBadgeKeys(userID)
	if err != nil {
		return nil, err
	}

	// Create a set of earned keys for O(1) lookup
	earnedSet := make(map[string]bool)
	for _, key := range earnedKeys {
		earnedSet[key] = true
	}

	// Find new badges to award
	var newBadges []models.UserBadge
	now := time.Now()
	for _, key := range eligibleKeys {
		if !earnedSet[key] {
			newBadges = append(newBadges, models.UserBadge{
				UserID:   userID,
				BadgeKey: key,
				EarnedAt: now,
			})
		}
	}

	if len(newBadges) == 0 {
		return nil, nil
	}

	// Save new badges
	if err := s.badgeRepo.CreateBatch(newBadges); err != nil {
		return nil, err
	}

	// Convert to DTOs
	var newBadgeDTOs []dto.BadgeDTO
	for _, badge := range newBadges {
		badgeDef := constants.GetBadgeByKey(badge.BadgeKey)
		if badgeDef != nil {
			newBadgeDTOs = append(newBadgeDTOs, dto.BadgeDTO{
				Key:       badgeDef.Key,
				Name:      badgeDef.Name,
				Icon:      badgeDef.Icon,
				Color:     badgeDef.Color,
				Threshold: badgeDef.Threshold,
				EarnedAt:  badge.EarnedAt.Format(constants.DateFormat),
			})
		}
	}

	return newBadgeDTOs, nil
}

// GetUserBadges returns all badges for a user with their definitions
func (s *BadgeService) GetUserBadges(userID uint) ([]dto.BadgeDTO, error) {
	earnedBadges, err := s.badgeRepo.FindByUserID(userID)
	if err != nil {
		return nil, err
	}

	// Create a map of earned badges
	earnedMap := make(map[string]time.Time)
	for _, badge := range earnedBadges {
		earnedMap[badge.BadgeKey] = badge.EarnedAt
	}

	// Build response with all badges, marking which are earned
	var badges []dto.BadgeDTO
	for _, badgeDef := range constants.GetAllBadges() {
		badge := dto.BadgeDTO{
			Key:       badgeDef.Key,
			Name:      badgeDef.Name,
			Icon:      badgeDef.Icon,
			Color:     badgeDef.Color,
			Threshold: badgeDef.Threshold,
			Earned:    false,
		}
		if earnedAt, ok := earnedMap[badgeDef.Key]; ok {
			badge.Earned = true
			badge.EarnedAt = earnedAt.Format(constants.DateFormat)
		}
		badges = append(badges, badge)
	}

	return badges, nil
}

// GetBadgesByUsername returns all badges for a user by username (always public)
func (s *BadgeService) GetBadgesByUsername(username string) ([]dto.BadgeDTO, error) {
	user, err := s.userRepo.FindByUsername(username)
	if err != nil {
		return nil, err
	}
	if user == nil {
		return nil, nil
	}

	return s.GetUserBadges(user.ID)
}

// AwardBadgeWithDate awards a specific badge with a custom earned date (for migration)
func (s *BadgeService) AwardBadgeWithDate(userID uint, badgeKey string, earnedAt time.Time) error {
	// Check if already exists
	exists, err := s.badgeRepo.ExistsByUserAndKey(userID, badgeKey)
	if err != nil {
		return err
	}
	if exists {
		return nil // Already earned, skip
	}

	badge := &models.UserBadge{
		UserID:   userID,
		BadgeKey: badgeKey,
		EarnedAt: earnedAt,
	}
	return s.badgeRepo.Create(badge)
}
