package handlers

import (
	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/dto"
	"github.com/aman1117/backend/internal/logger"
	"github.com/aman1117/backend/internal/response"
	"github.com/aman1117/backend/internal/services"
	"github.com/aman1117/backend/internal/validator"
	"github.com/aman1117/backend/pkg/models"
	"github.com/gofiber/fiber/v2"
)

// ProfileHandler handles profile-related requests
type ProfileHandler struct {
	profileSvc *services.ProfileService
	authSvc    *services.AuthService
}

// NewProfileHandler creates a new ProfileHandler
func NewProfileHandler(profileSvc *services.ProfileService, authSvc *services.AuthService) *ProfileHandler {
	return &ProfileHandler{
		profileSvc: profileSvc,
		authSvc:    authSvc,
	}
}

// UpdatePrivacy handles privacy setting updates
// @Summary Update privacy setting
// @Description Set account privacy (public or private)
// @Tags Profile
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param request body dto.UpdatePrivacyRequest true "Privacy setting"
// @Success 200 {object} dto.PrivacyResponse "Privacy updated"
// @Failure 400 {object} dto.ErrorResponse "Invalid request"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Router /update-privacy [post]
func (h *ProfileHandler) UpdatePrivacy(c *fiber.Ctx) error {
	userID := getUserID(c)

	var req dto.UpdatePrivacyRequest
	if err := c.BodyParser(&req); err != nil {
		return response.InvalidRequest(c)
	}

	log := logger.LogWithContext(getTraceID(c), userID)
	if err := h.profileSvc.UpdatePrivacy(userID, req.IsPrivate); err != nil {
		log.Errorw("Privacy update failed", "error", err)
		return response.InternalError(c, "Failed to update privacy setting", constants.ErrCodeUpdateFailed)
	}

	log.Infow("Privacy updated", "is_private", req.IsPrivate)
	return response.JSON(c, fiber.Map{
		"success":    true,
		"message":    constants.MsgPrivacyUpdated,
		"is_private": req.IsPrivate,
	})
}

// GetPrivacy handles privacy setting retrieval
// @Summary Get privacy setting
// @Description Get current account privacy setting
// @Tags Profile
// @Produce json
// @Security BearerAuth
// @Success 200 {object} dto.PrivacyResponse "Privacy setting"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Router /get-privacy [get]
func (h *ProfileHandler) GetPrivacy(c *fiber.Ctx) error {
	userID := getUserID(c)

	isPrivate, err := h.profileSvc.GetPrivacy(userID)
	if err != nil {
		logger.LogWithContext(getTraceID(c), userID).Errorw("Failed to get privacy setting", "error", err)
		return response.InternalError(c, "Failed to get privacy setting", constants.ErrCodeFetchFailed)
	}

	return response.JSON(c, dto.PrivacyResponse{
		Success:   true,
		IsPrivate: isPrivate,
	})
}

// UpdateBio handles bio updates
// @Summary Update bio
// @Description Update user bio (max 150 characters)
// @Tags Profile
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param request body dto.UpdateBioRequest true "Bio content"
// @Success 200 {object} dto.BioResponse "Bio updated"
// @Failure 400 {object} dto.ErrorResponse "Validation error"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Router /update-bio [post]
func (h *ProfileHandler) UpdateBio(c *fiber.Ctx) error {
	userID := getUserID(c)

	var req dto.UpdateBioRequest
	if err := c.BodyParser(&req); err != nil {
		return response.InvalidRequest(c)
	}

	bio := validator.SanitizeBio(req.Bio)

	if err := validator.ValidateBio(bio); err != nil {
		return response.BadRequest(c, err.Message, err.ErrorCode)
	}

	log := logger.LogWithContext(getTraceID(c), userID)
	if err := h.profileSvc.UpdateBio(userID, bio); err != nil {
		log.Errorw("Bio update failed", "error", err)
		return response.InternalError(c, "Failed to update bio", constants.ErrCodeUpdateFailed)
	}

	log.Infow("Bio updated", "bio_length", len(bio))
	return response.JSON(c, fiber.Map{
		"success": true,
		"message": constants.MsgBioUpdated,
		"bio":     bio,
	})
}

// GetBio handles bio retrieval
// @Summary Get bio
// @Description Get current user's bio
// @Tags Profile
// @Produce json
// @Security BearerAuth
// @Success 200 {object} dto.BioResponse "Bio content"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Router /get-bio [get]
func (h *ProfileHandler) GetBio(c *fiber.Ctx) error {
	userID := getUserID(c)

	bio, err := h.profileSvc.GetBio(userID)
	if err != nil {
		logger.LogWithContext(getTraceID(c), userID).Errorw("Failed to get bio", "error", err)
		return response.InternalError(c, "Failed to get bio", constants.ErrCodeFetchFailed)
	}

	return response.JSON(c, dto.BioResponse{
		Success: true,
		Bio:     bio,
	})
}

// GetProfile handles full profile retrieval
// @Summary Get user profile
// @Description Get full profile of authenticated user
// @Tags Profile
// @Produce json
// @Security BearerAuth
// @Success 200 {object} dto.ProfileResponse "User profile"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Failure 404 {object} dto.ErrorResponse "User not found"
// @Router /profile [get]
func (h *ProfileHandler) GetProfile(c *fiber.Ctx) error {
	userID := getUserID(c)

	user, err := h.profileSvc.GetProfile(userID)
	if err != nil || user == nil {
		return response.NotFound(c, "User not found", constants.ErrCodeUserNotFound)
	}

	return response.JSON(c, dto.ProfileResponse{
		Success:    true,
		Username:   user.Username,
		Email:      user.Email,
		ProfilePic: user.ProfilePic,
		Bio:        user.Bio,
		IsVerified: user.IsVerified,
	})
}

// SearchUsers handles user search requests
// @Summary Search users
// @Description Search for users by username (excludes private accounts)
// @Tags Users
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param request body dto.SearchUsersRequest true "Search query"
// @Success 200 {object} dto.DataResponse{data=[]dto.UserDTO} "List of users"
// @Failure 400 {object} dto.ErrorResponse "Invalid request"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Router /users [post]
func (h *ProfileHandler) SearchUsers(c *fiber.Ctx) error {
	currentUserID := getUserID(c)
	traceID := getTraceID(c)

	var req dto.SearchUsersRequest
	if err := c.BodyParser(&req); err != nil {
		return response.InvalidRequest(c)
	}

	users, err := h.profileSvc.SearchUsers(req.Username)
	if err != nil {
		logger.LogWithContext(traceID, currentUserID).Errorw("User search failed", "query", req.Username, "error", err)
		return response.BadRequest(c, "Failed to find users", constants.ErrCodeFetchFailed)
	}

	logger.LogWithContext(traceID, currentUserID).Debugw("User search completed", "query", req.Username, "found", len(users))
	return response.Data(c, sanitizeUsers(users))
}

// sanitizeUsers converts users to DTOs, hiding private information
func sanitizeUsers(users []models.User) []dto.UserDTO {
	result := make([]dto.UserDTO, 0, len(users))
	for _, u := range users {
		d := dto.UserDTO{
			ID:         u.ID,
			Username:   u.Username,
			Email:      u.Email,
			ProfilePic: u.ProfilePic,
			IsPrivate:  u.IsPrivate,
			IsVerified: u.IsVerified,
		}
		// Only include bio for public profiles
		if !u.IsPrivate {
			d.Bio = u.Bio
		}
		result = append(result, d)
	}
	return result
}
