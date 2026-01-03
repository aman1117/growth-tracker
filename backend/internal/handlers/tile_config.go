package handlers

import (
	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/dto"
	"github.com/aman1117/backend/internal/logger"
	"github.com/aman1117/backend/internal/response"
	"github.com/aman1117/backend/internal/services"
	"github.com/gofiber/fiber/v2"
)

// TileConfigHandler handles tile configuration requests
type TileConfigHandler struct {
	tileConfigSvc *services.TileConfigService
	authSvc       *services.AuthService
	profileSvc    *services.ProfileService
}

// NewTileConfigHandler creates a new TileConfigHandler
func NewTileConfigHandler(tileConfigSvc *services.TileConfigService, authSvc *services.AuthService, profileSvc *services.ProfileService) *TileConfigHandler {
	return &TileConfigHandler{
		tileConfigSvc: tileConfigSvc,
		authSvc:       authSvc,
		profileSvc:    profileSvc,
	}
}

// GetConfig handles tile config retrieval for the current user
// @Summary Get tile configuration
// @Description Get dashboard tile configuration for authenticated user
// @Tags Tile Config
// @Produce json
// @Security BearerAuth
// @Success 200 {object} dto.TileConfigResponse "Tile configuration"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Router /tile-config [get]
func (h *TileConfigHandler) GetConfig(c *fiber.Ctx) error {
	userID := getUserID(c)

	config, err := h.tileConfigSvc.GetConfig(userID)
	if err != nil || config == nil {
		// No config found - return null config (not an error)
		return response.JSON(c, dto.TileConfigResponse{
			Success: true,
			Data:    nil,
		})
	}

	return response.JSON(c, dto.TileConfigResponse{
		Success: true,
		Data:    config.Config,
	})
}

// GetConfigByUsername handles tile config retrieval for another user
// @Summary Get tile config by username
// @Description Get dashboard tile configuration for another user
// @Tags Tile Config
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param request body dto.GetTileConfigByUsernameRequest true "Target username"
// @Success 200 {object} dto.TileConfigResponse "Tile configuration"
// @Failure 400 {object} dto.ErrorResponse "User not found"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Failure 403 {object} dto.ErrorResponse "Private account"
// @Router /tile-config/user [post]
func (h *TileConfigHandler) GetConfigByUsername(c *fiber.Ctx) error {
	var req dto.GetTileConfigByUsernameRequest
	if err := c.BodyParser(&req); err != nil {
		return response.InvalidRequest(c)
	}

	if req.Username == "" {
		return response.BadRequest(c, "Username is required", constants.ErrCodeMissingFields)
	}

	currentUserID := getUserID(c)
	traceID := getTraceID(c)

	// Find target user and check privacy
	user, err := h.authSvc.GetUserByUsername(req.Username)
	if err != nil || user == nil {
		logger.LogWithContext(traceID, currentUserID).Warnw("Tile config fetch failed - user not found", "target_username", req.Username)
		return response.NotFound(c, "User not found", constants.ErrCodeUserNotFound)
	}

	if !h.profileSvc.CanViewProfile(user, currentUserID) {
		logger.LogWithContext(traceID, currentUserID).Debugw("Tile config access denied - private account", "target_username", req.Username)
		return response.PrivateAccount(c)
	}

	config, err := h.tileConfigSvc.GetConfig(user.ID)
	if err != nil || config == nil {
		return response.JSON(c, dto.TileConfigResponse{
			Success: true,
			Data:    nil,
		})
	}

	return response.JSON(c, dto.TileConfigResponse{
		Success: true,
		Data:    config.Config,
	})
}

// SaveConfig handles tile config saving
// @Summary Save tile configuration
// @Description Save dashboard tile configuration
// @Tags Tile Config
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param request body dto.SaveTileConfigRequest true "Tile configuration"
// @Success 200 {object} dto.SuccessResponse "Config saved"
// @Failure 400 {object} dto.ErrorResponse "Invalid request"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Router /tile-config [post]
func (h *TileConfigHandler) SaveConfig(c *fiber.Ctx) error {
	userID := getUserID(c)
	traceID := getTraceID(c)

	var req dto.SaveTileConfigRequest
	if err := c.BodyParser(&req); err != nil {
		return response.InvalidRequest(c)
	}

	if err := h.tileConfigSvc.SaveConfig(userID, req.Config); err != nil {
		logger.LogWithContext(traceID, userID).Errorw("Tile config save failed", "error", err)
		return response.InternalError(c, "Failed to save tile configuration", constants.ErrCodeSaveFailed)
	}

	logger.LogWithContext(traceID, userID).Debug("Tile config saved")
	return response.Success(c, constants.MsgTileConfigSaved)
}
