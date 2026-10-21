package services

import (
	"testing"
	"time"

	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/dto"
	"github.com/aman1117/backend/internal/repository"
	"github.com/aman1117/backend/internal/testutil"
	"github.com/aman1117/backend/pkg/models"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func newBadgeService(db *gorm.DB) *BadgeService {
	return NewBadgeService(repository.NewBadgeRepository(db), repository.NewUserRepository(db))
}

func badgeKeys(badges []dto.BadgeDTO) []string {
	keys := make([]string, 0, len(badges))
	for _, b := range badges {
		keys = append(keys, b.Key)
	}
	return keys
}

func TestBadgeService_CheckAndAwardBadges(t *testing.T) {
	db := testDB(t)
	svc := newBadgeService(db)
	user := newUser(t, db)
	today := time.Now().Format(constants.DateFormat)

	awarded, err := svc.CheckAndAwardBadges(user.ID, 0)
	require.NoError(t, err)
	assert.Nil(t, awarded, "no streak, no badge")

	awarded, err = svc.CheckAndAwardBadges(user.ID, 7)
	require.NoError(t, err)
	assert.Equal(t, []string{"first_step", "spark_starter"}, badgeKeys(awarded))
	assert.Equal(t, dto.BadgeDTO{Key: "first_step", Name: "First Step", Icon: "Footprints", Color: "#22c55e", Threshold: 1, EarnedAt: today}, awarded[0])

	awarded, err = svc.CheckAndAwardBadges(user.ID, 7)
	require.NoError(t, err)
	assert.Nil(t, awarded, "badges are only awarded once")

	awarded, err = svc.CheckAndAwardBadges(user.ID, 30)
	require.NoError(t, err)
	assert.Equal(t, []string{"flame_keeper", "iron_will"}, badgeKeys(awarded))
	assert.EqualValues(t, 4, countRows(t, db.Where("user_id = ?", user.ID), &models.UserBadge{}))

	_, err = newBadgeService(testutil.BrokenDB(t)).CheckAndAwardBadges(user.ID, 90)
	assert.Error(t, err)
	_, err = newBadgeService(faultyDB(t, failingOn("create", "user_badges"))).CheckAndAwardBadges(user.ID, 90)
	assert.ErrorIs(t, err, errInjected)
	assert.EqualValues(t, 4, countRows(t, db.Where("user_id = ?", user.ID), &models.UserBadge{}))
}

func TestBadgeService_GetBadges(t *testing.T) {
	db := testDB(t)
	svc := newBadgeService(db)
	user := newUser(t, db)
	earnedAt := testutil.Day(2025, time.March, 4)
	require.NoError(t, svc.AwardBadgeWithDate(user.ID, "spark_starter", earnedAt))

	badges, err := svc.GetUserBadges(user.ID)
	require.NoError(t, err)
	require.Len(t, badges, len(constants.GetAllBadges()))
	assert.Equal(t, []string{"first_step", "spark_starter", "flame_keeper", "iron_will", "diamond_mind", "titan", "legendary"}, badgeKeys(badges))
	for _, b := range badges {
		if b.Key == "spark_starter" {
			assert.Equal(t, dto.BadgeDTO{Key: "spark_starter", Name: "Spark Starter", Icon: "Zap", Color: "#3b82f6", Threshold: 7,
				Earned: true, EarnedAt: "2025-03-04"}, b)
			continue
		}
		assert.False(t, b.Earned, b.Key)
		assert.Empty(t, b.EarnedAt, b.Key)
	}

	byName, err := svc.GetBadgesByUsername(user.Username)
	require.NoError(t, err)
	assert.Equal(t, badges, byName)

	unknown, err := svc.GetBadgesByUsername("nobody")
	require.NoError(t, err)
	assert.Nil(t, unknown)

	_, err = newBadgeService(testutil.BrokenDB(t)).GetUserBadges(user.ID)
	assert.Error(t, err)
	_, err = newBadgeService(testutil.BrokenDB(t)).GetBadgesByUsername(user.Username)
	assert.Error(t, err)
}

func TestBadgeService_AwardBadgeWithDate(t *testing.T) {
	db := testDB(t)
	svc := newBadgeService(db)
	user := newUser(t, db)
	earnedAt := time.Date(2025, time.June, 1, 12, 0, 0, 0, time.UTC)

	require.NoError(t, svc.AwardBadgeWithDate(user.ID, "iron_will", earnedAt))
	require.NoError(t, svc.AwardBadgeWithDate(user.ID, "iron_will", earnedAt.AddDate(0, 1, 0)), "awarding again is a no-op")

	var stored []models.UserBadge
	require.NoError(t, db.Where("user_id = ?", user.ID).Find(&stored).Error)
	require.Len(t, stored, 1)
	assert.Equal(t, "iron_will", stored[0].BadgeKey)
	assert.True(t, earnedAt.Equal(stored[0].EarnedAt), "keeps the original date, got %v", stored[0].EarnedAt)

	assert.Error(t, newBadgeService(testutil.BrokenDB(t)).AwardBadgeWithDate(user.ID, "titan", earnedAt))
	assert.ErrorIs(t, newBadgeService(faultyDB(t, failingOn("create", "user_badges"))).AwardBadgeWithDate(user.ID, "titan", earnedAt), errInjected)
}
