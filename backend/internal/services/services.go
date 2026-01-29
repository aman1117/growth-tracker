// Package services contains business logic for the application.
package services

import (
	"context"
	"errors"
	"time"

	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/logger"
	"github.com/aman1117/backend/internal/repository"
	"github.com/aman1117/backend/pkg/models"
	"golang.org/x/crypto/bcrypt"
)

// AuthService handles authentication-related business logic
type AuthService struct {
	userRepo *repository.UserRepository
}

// NewAuthService creates a new AuthService
func NewAuthService(userRepo *repository.UserRepository) *AuthService {
	return &AuthService{userRepo: userRepo}
}

// Register creates a new user account
func (s *AuthService) Register(email, username, password string) error {
	// Hash the password
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return err
	}

	return s.userRepo.Create(email, username, string(hash))
}

// Authenticate validates user credentials and returns the user if valid
func (s *AuthService) Authenticate(identifier, password string) (*models.User, error) {
	user, err := s.userRepo.FindByIdentifier(identifier)
	if err != nil {
		return nil, err
	}

	if user == nil {
		return nil, errors.New("user not found")
	}

	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(password)); err != nil {
		return nil, errors.New("invalid password")
	}

	return user, nil
}

// GetUserByID retrieves a user by their ID
func (s *AuthService) GetUserByID(userID uint) (*models.User, error) {
	return s.userRepo.FindByID(userID)
}

// GetUserByEmail retrieves a user by their email
func (s *AuthService) GetUserByEmail(email string) (*models.User, error) {
	return s.userRepo.FindByEmail(email)
}

// GetUserByUsername retrieves a user by their username
func (s *AuthService) GetUserByUsername(username string) (*models.User, error) {
	return s.userRepo.FindByUsername(username)
}

// UpdateUsername updates a user's username
func (s *AuthService) UpdateUsername(userID uint, newUsername string) error {
	return s.userRepo.UpdateUsername(userID, newUsername)
}

// ChangePassword validates the current password and updates to a new one
func (s *AuthService) ChangePassword(userID uint, currentPassword, newPassword string) error {
	user, err := s.userRepo.FindByID(userID)
	if err != nil || user == nil {
		return errors.New("user not found")
	}

	// Verify current password
	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(currentPassword)); err != nil {
		return errors.New("current password is incorrect")
	}

	// Hash new password
	hash, err := bcrypt.GenerateFromPassword([]byte(newPassword), bcrypt.DefaultCost)
	if err != nil {
		return err
	}

	return s.userRepo.UpdatePassword(userID, string(hash))
}

// ResetPassword sets a new password without validating the old one
func (s *AuthService) ResetPassword(userID uint, newPassword string) error {
	hash, err := bcrypt.GenerateFromPassword([]byte(newPassword), bcrypt.DefaultCost)
	if err != nil {
		return err
	}

	return s.userRepo.UpdatePassword(userID, string(hash))
}

// ==================== Profile Service ====================

// ProfileService handles profile-related business logic
type ProfileService struct {
	userRepo   *repository.UserRepository
	followRepo *repository.FollowRepository
}

// NewProfileService creates a new ProfileService
func NewProfileService(userRepo *repository.UserRepository, followRepo *repository.FollowRepository) *ProfileService {
	return &ProfileService{
		userRepo:   userRepo,
		followRepo: followRepo,
	}
}

// GetProfile retrieves a user's full profile
func (s *ProfileService) GetProfile(userID uint) (*models.User, error) {
	return s.userRepo.FindByID(userID)
}

// UpdatePrivacy updates a user's privacy setting
func (s *ProfileService) UpdatePrivacy(userID uint, isPrivate bool) error {
	return s.userRepo.UpdatePrivacy(userID, isPrivate)
}

// GetPrivacy gets a user's privacy setting
func (s *ProfileService) GetPrivacy(userID uint) (bool, error) {
	return s.userRepo.GetPrivacy(userID)
}

// UpdateBio updates a user's bio
func (s *ProfileService) UpdateBio(userID uint, bio string) error {
	return s.userRepo.UpdateBio(userID, bio)
}

// GetBio gets a user's bio
func (s *ProfileService) GetBio(userID uint) (*string, error) {
	return s.userRepo.GetBio(userID)
}

// UpdateProfilePic updates a user's profile picture URL
func (s *ProfileService) UpdateProfilePic(userID uint, url *string) error {
	return s.userRepo.UpdateProfilePic(userID, url)
}

// SearchUsers searches for users by username (includes private users)
func (s *ProfileService) SearchUsers(query string) ([]models.User, error) {
	return s.userRepo.SearchByUsername(query)
}

// CanViewProfile checks if the current user can view another user's profile
func (s *ProfileService) CanViewProfile(targetUser *models.User, currentUserID uint) bool {
	if targetUser == nil {
		return false
	}
	// User can always view their own profile
	if targetUser.ID == currentUserID {
		return true
	}
	// Public profiles are viewable by everyone
	if !targetUser.IsPrivate {
		return true
	}
	// For private profiles, check if current user is following them
	if currentUserID > 0 && s.followRepo != nil {
		isFollowing, err := s.followRepo.IsFollowing(currentUserID, targetUser.ID)
		if err == nil && isFollowing {
			return true
		}
	}
	return false
}

// ==================== Activity Service ====================

// ActivityService handles activity-related business logic
type ActivityService struct {
	activityRepo *repository.ActivityRepository
	streakSvc    *StreakService
	userRepo     *repository.UserRepository
	followRepo   *repository.FollowRepository
	notifSvc     *NotificationService
}

// NewActivityService creates a new ActivityService
func NewActivityService(
	activityRepo *repository.ActivityRepository,
	streakSvc *StreakService,
	userRepo *repository.UserRepository,
	followRepo *repository.FollowRepository,
	notifSvc *NotificationService,
) *ActivityService {
	return &ActivityService{
		activityRepo: activityRepo,
		streakSvc:    streakSvc,
		userRepo:     userRepo,
		followRepo:   followRepo,
		notifSvc:     notifSvc,
	}
}

// CreateOrUpdateActivity creates or updates an activity for a user
func (s *ActivityService) CreateOrUpdateActivity(userID uint, name models.ActivityName, hours float32, date time.Time, note *string) error {
	// Get all activities for this day
	dayActivities, err := s.activityRepo.FindByUserAndDate(userID, date)
	if err != nil {
		return err
	}

	// Calculate total hours and find existing activity
	var totalHours float32
	var existing *models.Activity

	for i := range dayActivities {
		a := &dayActivities[i]
		totalHours += a.DurationHours
		if a.Name == name {
			existing = a
		}
	}

	// Store previous total for completion detection
	previousTotal := totalHours

	// Calculate new total
	var newTotal float32
	if existing != nil {
		newTotal = totalHours - existing.DurationHours + hours
	} else {
		newTotal = totalHours + hours
	}

	if newTotal > 24 {
		return errors.New("total hours cannot be more than 24")
	}

	// Update or create activity
	if existing != nil {
		existing.DurationHours = hours
		existing.Note = note
		if err := s.activityRepo.Update(existing); err != nil {
			return err
		}
	} else {
		activity := &models.Activity{
			UserID:        userID,
			Name:          name,
			DurationHours: hours,
			ActivityDate:  date,
			Note:          note,
		}
		if err := s.activityRepo.Create(activity); err != nil {
			return err
		}
	}

	logger.Sugar.Debugw("Activity hours calculation",
		"user_id", userID,
		"previous_total", previousTotal,
		"new_total", newTotal,
		"threshold_check", previousTotal < 24 && newTotal >= 24,
	)

	// Check if user just completed 24 hours (crossed the threshold)
	// Only triggers if: previousTotal < 24 AND newTotal >= 24
	if previousTotal < 24 && newTotal >= 24 {
		s.notifyFollowersOfDayCompletion(userID, date)
	}

	// Update streak
	return s.streakSvc.AddStreak(userID, date, false)
}

// notifyFollowersOfDayCompletion sends notifications to all followers when a user completes 24 hours.
// This runs asynchronously to not block the activity update.
func (s *ActivityService) notifyFollowersOfDayCompletion(userID uint, date time.Time) {
	// Skip if notification service not configured
	if s.notifSvc == nil || s.followRepo == nil || s.userRepo == nil {
		logger.Sugar.Warnw("Skipping day completion notification - missing dependencies",
			"user_id", userID,
			"notifSvc_nil", s.notifSvc == nil,
			"followRepo_nil", s.followRepo == nil,
			"userRepo_nil", s.userRepo == nil,
		)
		return
	}

	logger.Sugar.Infow("Triggering day completion notification",
		"user_id", userID,
		"date", date.Format(constants.DateFormat),
	)

	// Run in goroutine to not block the main request
	go func() {
		defer func() {
			if r := recover(); r != nil {
				logger.Sugar.Errorw("Panic in day completion notification goroutine",
					"user_id", userID,
					"panic", r,
				)
			}
		}()

		ctx := context.Background()

		// Get user details for notification content
		user, err := s.userRepo.FindByID(userID)
		if err != nil {
			logger.Sugar.Warnw("Failed to get user for day completion notification",
				"user_id", userID,
				"error", err,
			)
			return
		}

		// Get all followers
		followerIDs, err := s.followRepo.GetAllFollowerIDs(userID)
		if err != nil {
			logger.Sugar.Warnw("Failed to get followers for day completion notification",
				"user_id", userID,
				"error", err,
			)
			return
		}

		if len(followerIDs) == 0 {
			logger.Sugar.Debugw("No followers to notify for day completion",
				"user_id", userID,
			)
			return
		}

		logger.Sugar.Infow("Sending day completion notifications to followers",
			"user_id", userID,
			"username", user.Username,
			"follower_count", len(followerIDs),
		)

		// Format date for notification
		loc, _ := time.LoadLocation(constants.TimezoneIST)
		dateStr := date.In(loc).Format(constants.DateFormat)

		// Get avatar URL (may be nil)
		avatar := ""
		if user.ProfilePic != nil {
			avatar = *user.ProfilePic
		}

		// Send notifications to all followers
		if err := s.notifSvc.NotifyDayCompleted(
			ctx,
			userID,
			user.Username,
			avatar,
			dateStr,
			followerIDs,
		); err != nil {
			logger.Sugar.Warnw("Failed to send day completion notifications",
				"user_id", userID,
				"date", dateStr,
				"error", err,
			)
		}
	}()
}

// GetActivities retrieves activities for a user within a date range
func (s *ActivityService) GetActivities(userID uint, startDate, endDate time.Time) ([]models.Activity, error) {
	return s.activityRepo.FindByUserAndDateRange(userID, startDate, endDate)
}

// ==================== Streak Service ====================

// StreakService handles streak-related business logic
type StreakService struct {
	streakRepo *repository.StreakRepository
}

// NewStreakService creates a new StreakService
func NewStreakService(streakRepo *repository.StreakRepository) *StreakService {
	return &StreakService{streakRepo: streakRepo}
}

// AddStreak updates or creates a streak record
func (s *StreakService) AddStreak(userID uint, date time.Time, isCron bool) error {
	now := time.Now().In(date.Location())
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, date.Location())

	// Only process today's date for regular updates
	if date.Before(today) && !isCron {
		return nil
	}

	// Get the latest streak
	streak, err := s.streakRepo.FindLatestByUser(userID)
	if err != nil {
		return err
	}

	if isCron {
		// Check if a streak record already exists for this date (idempotency check)
		existingStreak, err := s.streakRepo.FindByUserAndDate(userID, date)
		if err != nil {
			return err
		}
		if existingStreak != nil {
			// Record already exists, skip to prevent duplicates
			return nil
		}

		// Cron job creates a new day's streak record with current = 0 (broken)
		longest := 0
		if streak != nil {
			longest = streak.Longest
		}
		newStreak := &models.Streak{
			UserID:       userID,
			Current:      0,
			Longest:      longest,
			ActivityDate: date,
		}
		return s.streakRepo.Create(newStreak)
	}

	// Get previous streak for calculating continuation
	previousStreak, _ := s.streakRepo.FindPreviousByUser(userID)
	current := 0
	if previousStreak != nil {
		current = previousStreak.Current
	}

	if previousStreak != nil && previousStreak.ID != 0 {
		// Find streak for current date and update it
		streakToUpdate, err := s.streakRepo.FindByUserAndDate(userID, date)
		if err != nil {
			return err
		}
		if streakToUpdate == nil {
			return nil
		}
		if streakToUpdate.Current != 0 {
			return nil // Already updated
		}
		streakToUpdate.Current = current + 1
		if streak != nil && streak.Longest > streakToUpdate.Current {
			streakToUpdate.Longest = streak.Longest
		} else {
			streakToUpdate.Longest = streakToUpdate.Current
		}
		return s.streakRepo.Update(streakToUpdate)
	}

	// No previous streak - check if there's a streak for today
	streakToUpdate, _ := s.streakRepo.FindByUserAndDate(userID, date)
	if streakToUpdate != nil && streakToUpdate.ID != 0 {
		return nil // Already exists
	}

	// Create new streak
	newStreak := &models.Streak{
		UserID:       userID,
		Current:      current + 1,
		Longest:      1,
		ActivityDate: date,
	}
	return s.streakRepo.Create(newStreak)
}

// GetStreak retrieves streak data for a user on a specific date
func (s *StreakService) GetStreak(userID uint, date time.Time) (*models.Streak, error) {
	return s.streakRepo.FindByUserAndDate(userID, date)
}

// GetLatestStreak retrieves the latest streak for a user
func (s *StreakService) GetLatestStreak(userID uint) (*models.Streak, error) {
	return s.streakRepo.FindLatestByUser(userID)
}

// GetLatestActiveStreak retrieves the latest streak where user actually logged activity (current > 0)
func (s *StreakService) GetLatestActiveStreak(userID uint) (*models.Streak, error) {
	return s.streakRepo.FindLatestActiveByUser(userID)
}

// GetAllStreaks retrieves all streaks for a user
func (s *StreakService) GetAllStreaks(userID uint) ([]models.Streak, error) {
	return s.streakRepo.FindAllByUser(userID)
}

// ==================== Tile Config Service ====================

// TileConfigService handles tile configuration business logic
type TileConfigService struct {
	tileRepo *repository.TileConfigRepository
	userRepo *repository.UserRepository
}

// NewTileConfigService creates a new TileConfigService
func NewTileConfigService(tileRepo *repository.TileConfigRepository, userRepo *repository.UserRepository) *TileConfigService {
	return &TileConfigService{
		tileRepo: tileRepo,
		userRepo: userRepo,
	}
}

// GetConfig retrieves tile config for a user
func (s *TileConfigService) GetConfig(userID uint) (*models.TileConfig, error) {
	return s.tileRepo.FindByUserID(userID)
}

// GetConfigByUsername retrieves tile config by username
func (s *TileConfigService) GetConfigByUsername(username string) (*models.TileConfig, error) {
	user, err := s.userRepo.FindByUsername(username)
	if err != nil || user == nil {
		return nil, errors.New("user not found")
	}
	return s.tileRepo.FindByUserID(user.ID)
}

// TileConfigValidationError represents a validation error with a specific code
type TileConfigValidationError struct {
	Message string
	Code    string
}

func (e *TileConfigValidationError) Error() string {
	return e.Message
}

// ValidateConfig validates the tile configuration
func (s *TileConfigService) ValidateConfig(config models.JSONB) *TileConfigValidationError {
	// Parse config to structured data
	tc := &models.TileConfig{Config: config}
	configData, err := tc.GetConfigData()
	if err != nil {
		return &TileConfigValidationError{
			Message: "Invalid configuration format",
			Code:    "INVALID_TILE_CONFIG",
		}
	}

	// Validate custom tiles limit (max 5)
	if len(configData.CustomTiles) > 5 {
		return &TileConfigValidationError{
			Message: "Maximum of 5 custom tiles allowed",
			Code:    "TILE_LIMIT_EXCEEDED",
		}
	}

	// Validate each custom tile
	customTileIDs := make(map[string]bool)
	for _, ct := range configData.CustomTiles {
		if err := ct.Validate(); err != nil {
			return &TileConfigValidationError{
				Message: err.Error(),
				Code:    "INVALID_TILE_CONFIG",
			}
		}

		// Check for duplicate IDs
		if customTileIDs[ct.ID] {
			return &TileConfigValidationError{
				Message: "Duplicate custom tile ID found",
				Code:    "INVALID_TILE_CONFIG",
			}
		}
		customTileIDs[ct.ID] = true
	}

	// Validate color overrides
	for _, color := range configData.Colors {
		if !models.ValidateColor(color) {
			return &TileConfigValidationError{
				Message: "Invalid color format: " + color,
				Code:    "INVALID_COLOR",
			}
		}
	}

	return nil
}

// SaveConfig saves tile config for a user with validation
func (s *TileConfigService) SaveConfig(userID uint, config models.JSONB) error {
	// Validate config
	if validationErr := s.ValidateConfig(config); validationErr != nil {
		return validationErr
	}

	return s.tileRepo.Save(userID, config)
}
