package handlers

import (
	"time"

	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/dto"
	"github.com/aman1117/backend/internal/logger"
	"github.com/aman1117/backend/internal/response"
	"github.com/aman1117/backend/internal/services"
	"github.com/gofiber/fiber/v2"
)

// StreakHandler handles streak-related requests
type StreakHandler struct {
	streakSvc  *services.StreakService
	authSvc    *services.AuthService
	profileSvc *services.ProfileService
	badgeSvc   *services.BadgeService
}

// NewStreakHandler creates a new StreakHandler
func NewStreakHandler(streakSvc *services.StreakService, authSvc *services.AuthService, profileSvc *services.ProfileService, badgeSvc *services.BadgeService) *StreakHandler {
	return &StreakHandler{
		streakSvc:  streakSvc,
		authSvc:    authSvc,
		profileSvc: profileSvc,
		badgeSvc:   badgeSvc,
	}
}

// GetStreak handles streak retrieval
// @Summary Get streak data
// @Description Retrieve streak information for a user on a specific date
// @Tags Streaks
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param request body dto.GetStreakRequest true "Username and date"
// @Success 200 {object} dto.StreakResponse "Streak data"
// @Failure 400 {object} dto.ErrorResponse "Validation error or streak not found"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Failure 403 {object} dto.ErrorResponse "Private account"
// @Router /get-streak [post]
func (h *StreakHandler) GetStreak(c *fiber.Ctx) error {
	var req dto.GetStreakRequest
	if err := c.BodyParser(&req); err != nil {
		return response.InvalidRequest(c)
	}

	// Parse date
	date, err := time.Parse(constants.DateFormat, req.Date)
	if err != nil {
		return response.BadRequest(c, "Invalid date format, use YYYY-MM-DD", constants.ErrCodeInvalidDate)
	}
	date = date.Truncate(24 * time.Hour)

	currentUserID := getUserID(c)
	traceID := getTraceID(c)

	// Find target user
	user, err := h.authSvc.GetUserByUsername(req.Username)
	if err != nil || user == nil {
		logger.LogWithContext(traceID, currentUserID).Warnw("Streak fetch failed - user not found", "target_username", req.Username)
		return response.UserNotFound(c)
	}

	// Check privacy
	if !h.profileSvc.CanViewProfile(user, currentUserID) {
		logger.LogWithContext(traceID, currentUserID).Debugw("Streak access denied - private account", "target_username", req.Username)
		return response.PrivateAccount(c)
	}

	// Get streak
	streak, err := h.streakSvc.GetStreak(user.ID, date)
	if err != nil || streak == nil {
		logger.LogWithContext(traceID, user.ID).Debugw("Streak not found", "username", req.Username, "date", req.Date)
		return response.BadRequest(c, "Failed to find streak", constants.ErrCodeStreakNotFound)
	}

	// Check for new badges (only for own streak)
	var newBadges []dto.BadgeDTO
	if user.ID == currentUserID && h.badgeSvc != nil {
		newBadges, _ = h.badgeSvc.CheckAndAwardBadges(user.ID, streak.Longest)
	}

	return response.JSON(c, dto.StreakResponse{
		Success: true,
		Data: dto.StreakDTO{
			ID:        streak.ID,
			Current:   streak.Current,
			Longest:   streak.Longest,
			Date:      streak.ActivityDate.Format(constants.DateFormat),
			NewBadges: newBadges,
		},
	})
}
