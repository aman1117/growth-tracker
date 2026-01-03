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

// AnalyticsHandler handles analytics-related requests
type AnalyticsHandler struct {
	analyticsSvc *services.AnalyticsService
	authSvc      *services.AuthService
	profileSvc   *services.ProfileService
}

// NewAnalyticsHandler creates a new AnalyticsHandler
func NewAnalyticsHandler(analyticsSvc *services.AnalyticsService, authSvc *services.AuthService, profileSvc *services.ProfileService) *AnalyticsHandler {
	return &AnalyticsHandler{
		analyticsSvc: analyticsSvc,
		authSvc:      authSvc,
		profileSvc:   profileSvc,
	}
}

// GetWeekAnalytics handles weekly analytics retrieval
// @Summary Get weekly analytics
// @Description Retrieve weekly analytics including daily breakdown and activity summary
// @Tags Analytics
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param request body dto.GetWeekAnalyticsRequest true "Username and week start date"
// @Success 200 {object} dto.WeekAnalyticsResponse "Weekly analytics data"
// @Failure 400 {object} dto.ErrorResponse "Validation error or user not found"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Failure 403 {object} dto.ErrorResponse "Private account"
// @Router /get-week-analytics [post]
func (h *AnalyticsHandler) GetWeekAnalytics(c *fiber.Ctx) error {
	var req dto.GetWeekAnalyticsRequest
	if err := c.BodyParser(&req); err != nil {
		return response.InvalidRequest(c)
	}

	// Parse week start date
	weekStart, err := time.Parse(constants.DateFormat, req.WeekStart)
	if err != nil {
		return response.BadRequest(c, "Invalid week_start format, use YYYY-MM-DD", constants.ErrCodeInvalidDate)
	}

	currentUserID := getUserID(c)
	traceID := getTraceID(c)

	// Find target user
	user, err := h.authSvc.GetUserByUsername(req.Username)
	if err != nil || user == nil {
		logger.LogWithContext(traceID, currentUserID).Warnw("Analytics fetch failed - user not found", "target_username", req.Username)
		return response.UserNotFound(c)
	}

	// Check privacy
	if !h.profileSvc.CanViewProfile(user, currentUserID) {
		logger.LogWithContext(traceID, currentUserID).Debugw("Analytics access denied - private account", "target_username", req.Username)
		return response.PrivateAccount(c)
	}

	// Get analytics
	analytics, err := h.analyticsSvc.GetWeekAnalytics(user.ID, weekStart)
	if err != nil {
		logger.Sugar.Errorw("Analytics fetch failed", "user_id", user.ID, "error", err)
		return response.InternalError(c, "Failed to fetch analytics", constants.ErrCodeFetchFailed)
	}

	return response.JSON(c, analytics)
}
