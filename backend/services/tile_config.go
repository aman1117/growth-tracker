package services

import (
	"github.com/aman1117/backend/models"
	"github.com/aman1117/backend/utils"
	"github.com/gofiber/fiber/v2"
)

// GetTileConfig fetches the tile configuration for a user
func GetTileConfig(userID uint) (*models.TileConfig, error) {
	db := utils.GetDB()
	var config models.TileConfig
	result := db.Where("user_id = ?", userID).First(&config)
	if result.Error != nil {
		return nil, result.Error
	}
	return &config, nil
}

// GetTileConfigByUsername fetches the tile configuration for a user by username
func GetTileConfigByUsername(username string) (*models.TileConfig, error) {
	db := utils.GetDB()

	// First get the user ID from username
	var user models.User
	if err := db.Where("username = ?", username).First(&user).Error; err != nil {
		return nil, err
	}

	var config models.TileConfig
	result := db.Where("user_id = ?", user.ID).First(&config)
	if result.Error != nil {
		return nil, result.Error
	}
	return &config, nil
}

// SaveTileConfig saves or updates tile configuration for a user
func SaveTileConfig(userID uint, config models.JSONB) error {
	db := utils.GetDB()

	var existing models.TileConfig
	result := db.Where("user_id = ?", userID).First(&existing)

	if result.Error != nil {
		// Create new record
		newConfig := models.TileConfig{
			UserID: userID,
			Config: config,
		}
		return db.Create(&newConfig).Error
	}

	// Update existing record
	existing.Config = config
	return db.Save(&existing).Error
}

// GetTileConfigHandler - GET /tile-config
func GetTileConfigHandler(c *fiber.Ctx) error {
	userID, ok := c.Locals("user_id").(uint)
	if !ok {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
			"success":    false,
			"error":      "Unauthorized",
			"error_code": "UNAUTHORIZED",
		})
	}

	config, err := GetTileConfig(userID)
	if err != nil {
		// No config found - return null config (not an error)
		return c.JSON(fiber.Map{
			"success": true,
			"data":    nil,
		})
	}

	return c.JSON(fiber.Map{
		"success": true,
		"data":    config.Config,
	})
}

// GetTileConfigByUsernameRequest represents the request body
type GetTileConfigByUsernameRequest struct {
	Username string `json:"username"`
}

// GetTileConfigByUsernameHandler - POST /tile-config/user
func GetTileConfigByUsernameHandler(c *fiber.Ctx) error {
	var req GetTileConfigByUsernameRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success":    false,
			"error":      "Invalid request body",
			"error_code": "INVALID_REQUEST",
		})
	}

	if req.Username == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success":    false,
			"error":      "Username is required",
			"error_code": "MISSING_FIELDS",
		})
	}

	db := utils.GetDB()

	// Get current user ID from context
	currentUserID, _ := c.Locals("user_id").(uint)

	// First check if the user exists and is private
	var user models.User
	if err := db.Where("username = ?", req.Username).First(&user).Error; err != nil {
		utils.LogWithUserID(currentUserID).Warnw("Tile config fetch failed - user not found", "target_username", req.Username)
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{
			"success":    false,
			"error":      "User not found",
			"error_code": "USER_NOT_FOUND",
		})
	}

	// Check if user is private and not the current user
	if user.IsPrivate && user.ID != currentUserID {
		utils.LogWithUserID(currentUserID).Debugw("Tile config access denied - private account", "target_username", req.Username)
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{
			"success":    false,
			"error":      "This account is private",
			"error_code": "ACCOUNT_PRIVATE",
		})
	}

	config, err := GetTileConfigByUsername(req.Username)
	if err != nil {
		// No config found - return null config (not an error)
		return c.JSON(fiber.Map{
			"success": true,
			"data":    nil,
		})
	}

	return c.JSON(fiber.Map{
		"success": true,
		"data":    config.Config,
	})
}

// SaveTileConfigRequest represents the request body for saving tile config
type SaveTileConfigRequest struct {
	Config models.JSONB `json:"config"`
}

// SaveTileConfigHandler - POST /tile-config
func SaveTileConfigHandler(c *fiber.Ctx) error {
	userID, ok := c.Locals("user_id").(uint)
	if !ok {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
			"success":    false,
			"error":      "Unauthorized",
			"error_code": "UNAUTHORIZED",
		})
	}

	var req SaveTileConfigRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success":    false,
			"error":      "Invalid request body",
			"error_code": "INVALID_REQUEST",
		})
	}

	if err := SaveTileConfig(userID, req.Config); err != nil {
		utils.LogWithUserID(userID).Errorw("Tile config save failed", "error", err)
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"success":    false,
			"error":      "Failed to save tile configuration",
			"error_code": "SAVE_FAILED",
		})
	}

	utils.LogWithUserID(userID).Debug("Tile config saved")
	return c.JSON(fiber.Map{
		"success": true,
		"message": "Tile configuration saved successfully",
	})
}
