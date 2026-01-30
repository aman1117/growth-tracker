// Package repository provides data access layer for the application.
package repository

import (
	"errors"
	"strings"
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

// UpdateEmailVerified updates a user's email verification status
func (r *UserRepository) UpdateEmailVerified(userID uint, verified bool) error {
	result := r.db.Model(&models.User{}).Where("id = ?", userID).Update("email_verified", verified)
	return result.Error
}

// SearchByUsername searches for users by username (case-insensitive, includes all users)
func (r *UserRepository) SearchByUsername(query string) ([]models.User, error) {
	var users []models.User
	result := r.db.Where("username ILIKE ?", "%"+query+"%").Find(&users)
	return users, result.Error
}

// AutocompleteResult represents a user with their autocomplete score and follower count
type AutocompleteResult struct {
	ID             uint    `json:"id"`
	Username       string  `json:"username"`
	ProfilePic     *string `json:"profile_pic"`
	IsVerified     bool    `json:"is_verified"`
	IsPrivate      bool    `json:"is_private"`
	FollowersCount int64   `json:"followers_count"`
	Score          float64 `json:"score"`
}

// AutocompleteUsers performs ranked autocomplete search on usernames
// Ranking: exact match > prefix match > trigram similarity, then by followers_count DESC, username ASC
// Uses pg_trgm extension for fuzzy matching
func (r *UserRepository) AutocompleteUsers(query string, limit int) ([]AutocompleteResult, error) {
	if limit <= 0 {
		limit = 12
	}
	if limit > 20 {
		limit = 20
	}

	// Escape LIKE special characters (%, _, \) to prevent wildcard injection
	escapedQuery := strings.NewReplacer(
		`\`, `\\`,
		`%`, `\%`,
		`_`, `\_`,
	).Replace(query)

	var results []AutocompleteResult

	// Query explanation:
	// - CASE 1: Exact match (score 100)
	// - CASE 2: Prefix match (score 50 + similarity bonus)
	// - CASE 3: Trigram similarity > 0.15 (score = similarity * 30)
	// - ORDER BY: score DESC, followers_count DESC, username ASC
	// - LEFT JOIN follow_counters to get follower count (default 0 if not found)
	// Note: $1 is the original query (for exact match and similarity), $3 is escaped (for LIKE)
	err := r.db.Raw(`
		SELECT 
			u.id,
			u.username,
			u.profile_pic,
			u.is_verified,
			u.is_private,
			COALESCE(fc.followers_count, 0) as followers_count,
			CASE 
				WHEN lower(u.username) = lower($1) THEN 100.0
				WHEN lower(u.username) LIKE lower($3) || '%' ESCAPE '\' THEN 50.0 + (similarity(u.username, $1) * 30.0)
				WHEN similarity(u.username, $1) > 0.15 THEN similarity(u.username, $1) * 30.0
				ELSE 0.0
			END as score
		FROM users u
		LEFT JOIN follow_counters fc ON fc.user_id = u.id
		WHERE 
			lower(u.username) = lower($1)
			OR lower(u.username) LIKE lower($3) || '%' ESCAPE '\'
			OR similarity(u.username, $1) > 0.15
		ORDER BY 
			score DESC,
			followers_count DESC,
			u.username ASC
		LIMIT $2
	`, query, limit, escapedQuery).Scan(&results).Error

	if err != nil {
		return nil, err
	}

	return results, nil
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

// FindLatestActiveByUser finds the most recent streak where user actually logged activity (current > 0)
func (r *StreakRepository) FindLatestActiveByUser(userID uint) (*models.Streak, error) {
	var streak models.Streak
	result := r.db.Where("user_id = ? AND current > 0", userID).Order("activity_date DESC").Limit(1).Find(&streak)
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
		Select("DISTINCT user_id").
		Where("current = 0 AND DATE(activity_date) = ?", date).
		Pluck("user_id", &userIDs)
	return userIDs, result.Error
}

// ==================== Cron Job Log Repository ====================

// CronJobLogRepository handles cron job log data operations
type CronJobLogRepository struct {
	db *gorm.DB
}

// NewCronJobLogRepository creates a new CronJobLogRepository
func NewCronJobLogRepository(db *gorm.DB) *CronJobLogRepository {
	return &CronJobLogRepository{db: db}
}

// Create creates a new cron job log entry
func (r *CronJobLogRepository) Create(log *models.CronJobLog) error {
	return r.db.Create(log).Error
}

// Update updates an existing cron job log entry
func (r *CronJobLogRepository) Update(log *models.CronJobLog) error {
	return r.db.Save(log).Error
}

// FindByJobNameAndDate finds a cron job log by job name and date
func (r *CronJobLogRepository) FindByJobNameAndDate(jobName string, jobDate time.Time) (*models.CronJobLog, error) {
	var log models.CronJobLog
	result := r.db.Where("job_name = ? AND job_date = ? AND status = ?", jobName, jobDate, models.CronJobStatusCompleted).First(&log)
	if result.Error != nil {
		if errors.Is(result.Error, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, result.Error
	}
	return &log, nil
}

// FindRecentByJobName finds recent cron job logs by job name
func (r *CronJobLogRepository) FindRecentByJobName(jobName string, limit int) ([]models.CronJobLog, error) {
	var logs []models.CronJobLog
	result := r.db.Where("job_name = ?", jobName).Order("started_at DESC").Limit(limit).Find(&logs)
	return logs, result.Error
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
