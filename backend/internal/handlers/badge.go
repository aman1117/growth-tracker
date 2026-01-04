package handlers

import (
	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/dto"
	"github.com/aman1117/backend/internal/logger"
	"github.com/aman1117/backend/internal/response"
	"github.com/aman1117/backend/internal/services"
	"github.com/gofiber/fiber/v2"
)

// BadgeHandler handles badge-related requests
type BadgeHandler struct {
	badgeSvc *services.BadgeService
	authSvc  *services.AuthService
}

// NewBadgeHandler creates a new BadgeHandler
func NewBadgeHandler(badgeSvc *services.BadgeService, authSvc *services.AuthService) *BadgeHandler {
	return &BadgeHandler{
		badgeSvc: badgeSvc,
		authSvc:  authSvc,
	}
}

// GetBadges handles getting current user's badges
// @Summary Get user badges
// @Description Retrieve all badges for the current user
// @Tags Badges
// @Accept json
// @Produce json
// @Security BearerAuth
// @Success 200 {object} dto.BadgesResponse "User badges"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Router /badges [get]
func (h *BadgeHandler) GetBadges(c *fiber.Ctx) error {
	userID := getUserID(c)
	traceID := getTraceID(c)

	badges, err := h.badgeSvc.GetUserBadges(userID)
	if err != nil {
		logger.LogWithContext(traceID, userID).Errorw("Failed to get badges", "error", err)
		return response.InternalError(c, "Failed to get badges", constants.ErrCodeServerError)
	}

	return response.JSON(c, dto.BadgesResponse{
		Success: true,
		Badges:  badges,
	})
}

// GetBadgesByUsername handles getting another user's badges (always public)
// @Summary Get user badges by username
// @Description Retrieve all badges for a user by username (badges are always public)
// @Tags Badges
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param request body dto.GetBadgesByUsernameRequest true "Username"
// @Success 200 {object} dto.BadgesResponse "User badges"
// @Failure 400 {object} dto.ErrorResponse "User not found"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Router /badges/user [post]
func (h *BadgeHandler) GetBadgesByUsername(c *fiber.Ctx) error {
	var req dto.GetBadgesByUsernameRequest
	if err := c.BodyParser(&req); err != nil {
		return response.InvalidRequest(c)
	}

	userID := getUserID(c)
	traceID := getTraceID(c)

	// Find target user
	targetUser, err := h.authSvc.GetUserByUsername(req.Username)
	if err != nil || targetUser == nil {
		logger.LogWithContext(traceID, userID).Warnw("Badge fetch failed - user not found", "target_username", req.Username)
		return response.UserNotFound(c)
	}

	// Get badges (always public, no privacy check)
	badges, err := h.badgeSvc.GetUserBadges(targetUser.ID)
	if err != nil {
		logger.LogWithContext(traceID, userID).Errorw("Failed to get badges", "error", err, "target_username", req.Username)
		return response.InternalError(c, "Failed to get badges", constants.ErrCodeServerError)
	}

	return response.JSON(c, dto.BadgesResponse{
		Success: true,
		Badges:  badges,
	})
}
