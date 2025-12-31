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
			"success": false,
			"error":   "Unauthorized",
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

// SaveTileConfigRequest represents the request body for saving tile config
type SaveTileConfigRequest struct {
	Config models.JSONB `json:"config"`
}

// SaveTileConfigHandler - POST /tile-config
func SaveTileConfigHandler(c *fiber.Ctx) error {
	userID, ok := c.Locals("user_id").(uint)
	if !ok {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
			"success": false,
			"error":   "Unauthorized",
		})
	}

	var req SaveTileConfigRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success": false,
			"error":   "Invalid request body",
		})
	}

	if err := SaveTileConfig(userID, req.Config); err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"success": false,
			"error":   "Failed to save tile configuration",
		})
	}

	return c.JSON(fiber.Map{
		"success": true,
		"message": "Tile configuration saved successfully",
	})
}
