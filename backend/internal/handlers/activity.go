package handlers

import (
	"time"

	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/dto"
	"github.com/aman1117/backend/internal/logger"
	"github.com/aman1117/backend/internal/response"
	"github.com/aman1117/backend/internal/services"
	"github.com/aman1117/backend/pkg/models"
	"github.com/gofiber/fiber/v2"
)

// ActivityHandler handles activity-related requests
type ActivityHandler struct {
	activitySvc *services.ActivityService
	authSvc     *services.AuthService
	profileSvc  *services.ProfileService
}

// NewActivityHandler creates a new ActivityHandler
func NewActivityHandler(activitySvc *services.ActivityService, authSvc *services.AuthService, profileSvc *services.ProfileService) *ActivityHandler {
	return &ActivityHandler{
		activitySvc: activitySvc,
		authSvc:     authSvc,
		profileSvc:  profileSvc,
	}
}

// CreateActivity handles activity creation/update
// @Summary Create or update an activity
// @Description Log hours for a specific activity on a date
// @Tags Activities
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param request body dto.CreateActivityRequest true "Activity details"
// @Success 200 {object} dto.SuccessResponse "Activity updated successfully"
// @Failure 400 {object} dto.ErrorResponse "Validation error"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Router /create-activity [post]
func (h *ActivityHandler) CreateActivity(c *fiber.Ctx) error {
	var req dto.CreateActivityRequest
	if err := c.BodyParser(&req); err != nil {
		return response.InvalidRequest(c)
	}

	if req.Username == "" || req.Activity == "" || req.Hours < 0 {
		return response.BadRequest(c, "Invalid request body", constants.ErrCodeMissingFields)
	}

	userID := getUserID(c)
	username := getUsername(c)

	// Check authorization
	if req.Username != username {
		return response.BadRequest(c, "You are not authorized to create activity for this username", constants.ErrCodeNotAuthorized)
	}

	// Validate activity name
	if !models.ActivityName(req.Activity).IsValid() {
		return response.BadRequest(c, "Invalid activity name", constants.ErrCodeInvalidActivity)
	}

	// Parse date
	date, err := time.Parse(constants.DateFormat, req.Date)
	if err != nil {
		return response.BadRequest(c, "Invalid date format, use YYYY-MM-DD", constants.ErrCodeInvalidDate)
	}
	date = date.Truncate(24 * time.Hour)

	log := logger.LogWithContext(getTraceID(c), userID)

	if err := h.activitySvc.CreateOrUpdateActivity(userID, req.Activity, req.Hours, date, req.Note); err != nil {
		if err.Error() == "total hours cannot be more than 24" {
			return response.BadRequest(c, "Total hours cannot be more than 24", constants.ErrCodeHoursExceeded)
		}
		log.Errorw("Failed to create/update activity", "error", err)
		return response.BadRequest(c, "Failed to update activity", constants.ErrCodeUpdateFailed)
	}

	log.Debugw("Activity updated", "activity", req.Activity, "hours", req.Hours, "date", req.Date)
	return response.Success(c, constants.MsgActivityUpdated)
}

// GetActivities handles activity retrieval
// @Summary Get activities for a user
// @Description Retrieve activities for a user within a date range
// @Tags Activities
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param request body dto.GetActivitiesRequest true "Date range and username"
// @Success 200 {object} dto.DataResponse{data=[]dto.ActivityDTO} "List of activities"
// @Failure 400 {object} dto.ErrorResponse "Validation error or user not found"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Failure 403 {object} dto.ErrorResponse "Private account"
// @Router /get-activities [post]
func (h *ActivityHandler) GetActivities(c *fiber.Ctx) error {
	var req dto.GetActivitiesRequest
	if err := c.BodyParser(&req); err != nil {
		return response.InvalidRequest(c)
	}

	// Parse dates
	startDate, err := time.Parse(constants.DateFormat, req.StartDate)
	if err != nil {
		return response.BadRequest(c, "Invalid start_date format, use YYYY-MM-DD", constants.ErrCodeInvalidDate)
	}

	endDate, err := time.Parse(constants.DateFormat, req.EndDate)
	if err != nil {
		return response.BadRequest(c, "Invalid end_date format, use YYYY-MM-DD", constants.ErrCodeInvalidDate)
	}

	if startDate.After(endDate) {
		return response.BadRequest(c, "Start date must be before end date", constants.ErrCodeInvalidDateRange)
	}

	currentUserID := getUserID(c)
	traceID := getTraceID(c)

	// Find target user
	user, err := h.authSvc.GetUserByUsername(req.Username)
	if err != nil || user == nil {
		logger.LogWithContext(traceID, currentUserID).Warnw("Activity fetch failed - user not found", "target_username", req.Username)
		return response.UserNotFound(c)
	}

	// Check privacy
	if !h.profileSvc.CanViewProfile(user, currentUserID) {
		logger.LogWithContext(traceID, currentUserID).Debugw("Activity access denied - private account", "target_username", req.Username)
		return response.PrivateAccount(c)
	}

	// Fetch activities
	activities, err := h.activitySvc.GetActivities(user.ID, startDate, endDate)
	if err != nil {
		logger.Sugar.Errorw("Activity fetch failed", "user_id", user.ID, "username", req.Username, "error", err)
		return response.BadRequest(c, "Failed to find activities", constants.ErrCodeFetchFailed)
	}

	// Only include notes if user is viewing their own activities
	isOwnProfile := user.ID == currentUserID
	return response.Data(c, toActivityDTOs(activities, isOwnProfile))
}

// GetDailyTotals handles fetching daily hour totals for calendar heat map
// @Summary Get daily totals for heat map
// @Description Retrieve total hours per day for a user within a date range
// @Tags Activities
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param request body dto.GetDailyTotalsRequest true "Date range and username"
// @Success 200 {object} dto.DataResponse{data=map[string]float32} "Map of dates to total hours"
// @Failure 400 {object} dto.ErrorResponse "Validation error or user not found"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Failure 403 {object} dto.ErrorResponse "Private account"
// @Router /get-daily-totals [post]
func (h *ActivityHandler) GetDailyTotals(c *fiber.Ctx) error {
	var req dto.GetDailyTotalsRequest
	if err := c.BodyParser(&req); err != nil {
		return response.InvalidRequest(c)
	}

	// Parse dates
	startDate, err := time.Parse(constants.DateFormat, req.StartDate)
	if err != nil {
		return response.BadRequest(c, "Invalid start_date format, use YYYY-MM-DD", constants.ErrCodeInvalidDate)
	}

	endDate, err := time.Parse(constants.DateFormat, req.EndDate)
	if err != nil {
		return response.BadRequest(c, "Invalid end_date format, use YYYY-MM-DD", constants.ErrCodeInvalidDate)
	}

	if startDate.After(endDate) {
		return response.BadRequest(c, "Start date must be before end date", constants.ErrCodeInvalidDateRange)
	}

	// Limit date range to prevent abuse (max 93 days = ~3 months)
	if endDate.Sub(startDate).Hours() > 93*24 {
		return response.BadRequest(c, "Date range cannot exceed 93 days", constants.ErrCodeInvalidDateRange)
	}

	currentUserID := getUserID(c)
	traceID := getTraceID(c)

	// Find target user
	user, err := h.authSvc.GetUserByUsername(req.Username)
	if err != nil || user == nil {
		logger.LogWithContext(traceID, currentUserID).Warnw("Daily totals fetch failed - user not found", "target_username", req.Username)
		return response.UserNotFound(c)
	}

	// Check privacy
	if !h.profileSvc.CanViewProfile(user, currentUserID) {
		logger.LogWithContext(traceID, currentUserID).Debugw("Daily totals access denied - private account", "target_username", req.Username)
		return response.PrivateAccount(c)
	}

	// Fetch daily totals
	totals, err := h.activitySvc.GetDailyTotals(user.ID, startDate, endDate)
	if err != nil {
		logger.Sugar.Errorw("Daily totals fetch failed", "user_id", user.ID, "username", req.Username, "error", err)
		return response.BadRequest(c, "Failed to fetch daily totals", constants.ErrCodeFetchFailed)
	}

	logger.LogWithContext(traceID, currentUserID).Debugw("Daily totals fetched",
		"target_username", req.Username,
		"start_date", req.StartDate,
		"end_date", req.EndDate,
		"days_with_data", len(totals),
	)

	return response.Data(c, totals)
}

// toActivityDTOs converts activities to DTOs
func toActivityDTOs(activities []models.Activity, includeNotes bool) []dto.ActivityDTO {
	result := make([]dto.ActivityDTO, 0, len(activities))
	for _, a := range activities {
		d := dto.ActivityDTO{
			ID:            a.ID,
			Name:          a.Name,
			DurationHours: a.DurationHours,
			Date:          a.ActivityDate.Format(constants.DateFormat),
		}
		if includeNotes {
			d.Note = a.Note
		}
		result = append(result, d)
	}
	return result
}
