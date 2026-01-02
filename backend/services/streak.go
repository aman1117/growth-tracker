package services

import (
	"time"

	"github.com/aman1117/backend/models"
	"github.com/aman1117/backend/utils"
	"github.com/gofiber/fiber/v2"
	"gorm.io/gorm"
)

type GetStreakRequest struct {
	Username string `json:"username"`
	Date     string `json:"date"`
}

type StreakDTO struct {
	ID      uint   `json:"id"`
	Current int    `json:"current"`
	Longest int    `json:"longest"`
	Date    string `json:"date"`
}

func AddStreak(userID uint, date time.Time, isCron bool) error {
	now := time.Now().In(date.Location())
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, date.Location())

	if date.Before(today) {
		return nil
	}
	db := utils.GetDB()
	streak := models.Streak{}
	result := db.
		Where("user_id = ?", userID).
		Order("activity_date DESC").
		Limit(1).
		Find(&streak)

	if result.Error != nil {
		return result.Error
	}
	if isCron {
		longest := 0
		if result.RowsAffected > 0 {
			longest = streak.Longest
		}
		streak := models.Streak{
			UserID:       userID,
			Current:      0,
			Longest:      longest,
			ActivityDate: date,
		}
		if err := db.Create(&streak).Error; err != nil {
			return err
		}
		return nil
	}

	previousStreak := models.Streak{}
	_ = db.
		Where("user_id = ?", userID).
		Order("activity_date DESC").
		Offset(1).
		Limit(1).
		Find(&previousStreak)
	current := previousStreak.Current
	if previousStreak.ID != 0 {
		// find streak of current date and update it
		streakTouUpdate := models.Streak{}
		result = db.Where("user_id = ? AND activity_date = ?", userID, date).First(&streakTouUpdate)
		if result.Error != nil {
			return result.Error
		}
		if streakTouUpdate.Current != 0 {
			return nil
		}
		streakTouUpdate.Current = current + 1
		streakTouUpdate.Longest = max(streak.Longest, streakTouUpdate.Current)
		if err := db.Save(&streakTouUpdate).Error; err != nil {
			return err
		}
		return nil
	} else {
		streakTouUpdate := models.Streak{}
		result = db.Where("user_id = ? AND activity_date = ?", userID, date).First(&streakTouUpdate)
		if result.Error != nil {
			if result.Error != gorm.ErrRecordNotFound {
				return result.Error
			}
		}
		if streakTouUpdate.ID != 0 {
			return nil
		}
		streak := models.Streak{
			UserID:       userID,
			Current:      current + 1,
			Longest:      1,
			ActivityDate: date,
		}
		if err := db.Create(&streak).Error; err != nil {
			return err
		}
	}
	return nil
}

func GetStreakHandler(c *fiber.Ctx) error {
	var body GetStreakRequest
	if err := c.BodyParser(&body); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success":    false,
			"error":      "Invalid request body",
			"error_code": "INVALID_REQUEST",
		})
	}

	const layout = "2006-01-02"
	date, err := time.Parse(layout, body.Date)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success":    false,
			"error":      "Invalid date format, use YYYY-MM-DD",
			"error_code": "INVALID_DATE",
		})
	}
	date = date.Truncate(24 * time.Hour)
	db := utils.GetDB()
	streak := models.Streak{}
	user := models.User{}

	// Get current user ID from context first
	currentUserID, _ := c.Locals("user_id").(uint)

	result := db.Where("username = ?", body.Username).First(&user)
	if result.Error != nil {
		utils.LogWithUserID(currentUserID).Warnw("Streak fetch failed - user not found", "target_username", body.Username)
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success":    false,
			"error":      "Failed to find user",
			"error_code": "USER_NOT_FOUND",
		})
	}

	// Check if user is private and not the current user
	if user.IsPrivate && user.ID != currentUserID {
		utils.LogWithUserID(currentUserID).Debugw("Streak access denied - private account", "target_username", body.Username)
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{
			"success":    false,
			"error":      "This account is private",
			"error_code": "ACCOUNT_PRIVATE",
		})
	}

	result = db.Where("user_id = ? AND activity_date = ?", user.ID, date).Last(&streak)
	if result.Error != nil {
		utils.LogWithUserID(user.ID).Debugw("Streak not found", "username", body.Username, "date", body.Date)
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success":    false,
			"error":      "Failed to find streak",
			"error_code": "STREAK_NOT_FOUND",
		})
	}
	return c.Status(fiber.StatusOK).JSON(fiber.Map{
		"success": true,
		"data":    ToStreakDTOs(streak),
	})
}

func ToStreakDTOs(in models.Streak) StreakDTO {
	return StreakDTO{
		ID:      in.ID,
		Current: in.Current,
		Longest: in.Longest,
		Date:    in.ActivityDate.Format("2006-01-02"),
	}
}
