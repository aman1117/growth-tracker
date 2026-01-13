// Package repository provides data access layer for the application.
package repository

import (
	"errors"
	"time"

	"github.com/aman1117/backend/pkg/models"
	"gorm.io/gorm"
)

// UserRepository handles user data operations
type UserRepository struct {
	db *gorm.DB
}

// NewUserRepository creates a new UserRepository
func NewUserRepository(db *gorm.DB) *UserRepository {
	return &UserRepository{db: db}
}

// Create creates a new user with the given email, username, and password hash
// Also initializes the follow_counters row for the user
func (r *UserRepository) Create(email, username, passwordHash string) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		// Insert user
		if err := tx.Exec(
			"INSERT INTO users (email, username, password_hash) VALUES ($1, $2, $3)",
			email, username, passwordHash,
		).Error; err != nil {
			return err
		}

		// Get the newly created user's ID
		var userID uint
		if err := tx.Raw("SELECT id FROM users WHERE email = $1", email).Scan(&userID).Error; err != nil {
			return err
		}

		// Initialize follow_counters row
		if err := tx.Exec(
			`INSERT INTO follow_counters (user_id, followers_count, following_count, pending_requests_count, updated_at)
			 VALUES ($1, 0, 0, 0, NOW())
			 ON CONFLICT (user_id) DO NOTHING`,
			userID,
		).Error; err != nil {
			return err
		}

		return nil
	})
}

// FindByID finds a user by their ID
func (r *UserRepository) FindByID(id uint) (*models.User, error) {
	var user models.User
	if err := r.db.Where("id = ?", id).First(&user).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &user, nil
}

// FindByIdentifier finds a user by email or username
func (r *UserRepository) FindByIdentifier(identifier string) (*models.User, error) {
	var user models.User
	result := r.db.Where("email = ? OR username = ?", identifier, identifier).First(&user)
	if result.Error != nil {
		if errors.Is(result.Error, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, result.Error
	}
	return &user, nil
}

// FindByUsername finds a user by username
func (r *UserRepository) FindByUsername(username string) (*models.User, error) {
	var user models.User
	if err := r.db.Where("username = ?", username).First(&user).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &user, nil
}

// FindByEmail finds a user by email
func (r *UserRepository) FindByEmail(email string) (*models.User, error) {
	var user models.User
	if err := r.db.Where("email = ?", email).First(&user).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &user, nil
}

// UpdateUsername updates a user's username
func (r *UserRepository) UpdateUsername(userID uint, newUsername string) error {
	result := r.db.Model(&models.User{}).Where("id = ?", userID).Update("username", newUsername)
	return result.Error
}

// UpdatePassword updates a user's password hash
func (r *UserRepository) UpdatePassword(userID uint, passwordHash string) error {
	result := r.db.Model(&models.User{}).Where("id = ?", userID).Update("password_hash", passwordHash)
	return result.Error
}

// UpdatePrivacy updates a user's privacy setting
func (r *UserRepository) UpdatePrivacy(userID uint, isPrivate bool) error {
	result := r.db.Model(&models.User{}).Where("id = ?", userID).Update("is_private", isPrivate)
	return result.Error
}

// GetPrivacy gets a user's privacy setting
func (r *UserRepository) GetPrivacy(userID uint) (bool, error) {
	var user models.User
	if err := r.db.Where("id = ?", userID).First(&user).Error; err != nil {
		return false, err
	}
	return user.IsPrivate, nil
}

// UpdateBio updates a user's bio
func (r *UserRepository) UpdateBio(userID uint, bio string) error {
	var bioPtr *string
	if bio != "" {
		bioPtr = &bio
	}
	result := r.db.Model(&models.User{}).Where("id = ?", userID).Update("bio", bioPtr)
	return result.Error
}

// GetBio gets a user's bio
func (r *UserRepository) GetBio(userID uint) (*string, error) {
	var user models.User
	if err := r.db.Where("id = ?", userID).First(&user).Error; err != nil {
		return nil, err
	}
	return user.Bio, nil
}

// UpdateProfilePic updates a user's profile picture URL
func (r *UserRepository) UpdateProfilePic(userID uint, url *string) error {
	result := r.db.Model(&models.User{}).Where("id = ?", userID).Update("profile_pic", url)
	return result.Error
}

// SearchByUsername searches for users by username (case-insensitive, includes all users)
func (r *UserRepository) SearchByUsername(query string) ([]models.User, error) {
	var users []models.User
	result := r.db.Where("username ILIKE ?", "%"+query+"%").Find(&users)
	return users, result.Error
}

// GetAll returns all users
func (r *UserRepository) GetAll() ([]models.User, error) {
	var users []models.User
	result := r.db.Find(&users)
	return users, result.Error
}

// ==================== Activity Repository ====================

// ActivityRepository handles activity data operations
type ActivityRepository struct {
	db *gorm.DB
}

// NewActivityRepository creates a new ActivityRepository
func NewActivityRepository(db *gorm.DB) *ActivityRepository {
	return &ActivityRepository{db: db}
}

// Create creates a new activity
func (r *ActivityRepository) Create(activity *models.Activity) error {
	return r.db.Create(activity).Error
}

// Update updates an existing activity
func (r *ActivityRepository) Update(activity *models.Activity) error {
	return r.db.Save(activity).Error
}

// FindByUserAndDate finds all activities for a user on a specific date
func (r *ActivityRepository) FindByUserAndDate(userID uint, date time.Time) ([]models.Activity, error) {
	var activities []models.Activity
	result := r.db.Where("user_id = ? AND activity_date = ?", userID, date).Find(&activities)
	return activities, result.Error
}

// FindByUserAndDateRange finds all activities for a user within a date range
func (r *ActivityRepository) FindByUserAndDateRange(userID uint, startDate, endDate time.Time) ([]models.Activity, error) {
	var activities []models.Activity
	result := r.db.Where(
		"user_id = ? AND activity_date BETWEEN ? AND ?",
		userID, startDate, endDate,
	).Find(&activities)
	return activities, result.Error
}

// ==================== Streak Repository ====================

// StreakRepository handles streak data operations
type StreakRepository struct {
	db *gorm.DB
}

// NewStreakRepository creates a new StreakRepository
func NewStreakRepository(db *gorm.DB) *StreakRepository {
	return &StreakRepository{db: db}
}

// Create creates a new streak record
func (r *StreakRepository) Create(streak *models.Streak) error {
	return r.db.Create(streak).Error
}

// Update updates an existing streak record
func (r *StreakRepository) Update(streak *models.Streak) error {
	return r.db.Save(streak).Error
}

// FindLatestByUser finds the most recent streak for a user
func (r *StreakRepository) FindLatestByUser(userID uint) (*models.Streak, error) {
	var streak models.Streak
	result := r.db.Where("user_id = ?", userID).Order("activity_date DESC").Limit(1).Find(&streak)
	if result.Error != nil {
		return nil, result.Error
	}
	if result.RowsAffected == 0 {
		return nil, nil
	}
	return &streak, nil
}

// FindPreviousByUser finds the second most recent streak for a user
func (r *StreakRepository) FindPreviousByUser(userID uint) (*models.Streak, error) {
	var streak models.Streak
	result := r.db.Where("user_id = ?", userID).Order("activity_date DESC").Offset(1).Limit(1).Find(&streak)
	if result.Error != nil {
		return nil, result.Error
	}
	if result.RowsAffected == 0 {
		return nil, nil
	}
	return &streak, nil
}

// FindByUserAndDate finds a streak for a user on a specific date
func (r *StreakRepository) FindByUserAndDate(userID uint, date time.Time) (*models.Streak, error) {
	var streak models.Streak
	result := r.db.Where("user_id = ? AND activity_date = ?", userID, date).Last(&streak)
	if result.Error != nil {
		if errors.Is(result.Error, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, result.Error
	}
	return &streak, nil
}

// FindAllByUser finds all streaks for a user ordered by date
func (r *StreakRepository) FindAllByUser(userID uint) ([]models.Streak, error) {
	var streaks []models.Streak
	result := r.db.Where("user_id = ?", userID).Order("activity_date ASC").Find(&streaks)
	return streaks, result.Error
}

// FindUsersMissedStreak finds users who had a zero streak on a specific date
func (r *StreakRepository) FindUsersMissedStreak(date string) ([]uint, error) {
	var userIDs []uint
	result := r.db.Table("streaks").
		Select("user_id").
		Where("current = 0 AND DATE(activity_date) = ?", date).
		Pluck("user_id", &userIDs)
	return userIDs, result.Error
}

// ==================== Tile Config Repository ====================

// TileConfigRepository handles tile configuration data operations
type TileConfigRepository struct {
	db *gorm.DB
}

// NewTileConfigRepository creates a new TileConfigRepository
func NewTileConfigRepository(db *gorm.DB) *TileConfigRepository {
	return &TileConfigRepository{db: db}
}

// FindByUserID finds tile config for a user
func (r *TileConfigRepository) FindByUserID(userID uint) (*models.TileConfig, error) {
	var config models.TileConfig
	result := r.db.Where("user_id = ?", userID).First(&config)
	if result.Error != nil {
		if errors.Is(result.Error, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, result.Error
	}
	return &config, nil
}

// Save creates or updates tile config for a user
func (r *TileConfigRepository) Save(userID uint, config models.JSONB) error {
	var existing models.TileConfig
	result := r.db.Where("user_id = ?", userID).First(&existing)

	if result.Error != nil {
		// Create new record
		newConfig := models.TileConfig{
			UserID: userID,
			Config: config,
		}
		return r.db.Create(&newConfig).Error
	}

	// Update existing record
	existing.Config = config
	return r.db.Save(&existing).Error
}
