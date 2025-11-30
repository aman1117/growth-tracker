package services

import (
	"fmt"
	"time"

	"github.com/aman1117/backend/models"
	"github.com/aman1117/backend/utils"
	"github.com/gofiber/fiber/v2"
)

type ActivityRequest struct {
	Username string              `json:"username"`
	Activity models.ActivityName `json:"activity"`
	Hours    float32             `json:"hours"`
}

type ActivityDTO struct {
	ID            uint                `json:"id"`
	Name          models.ActivityName `json:"name"`
	DurationHours float32             `json:"hours"`
}

type GetActivityRequest struct {
	Username  string `json:"username"`
	StartDate string `json:"start_date"`
	EndDate   string `json:"end_date"`
}

func UpdateActivityHandler(c *fiber.Ctx) error {
	return c.Status(fiber.StatusOK).JSON(fiber.Map{
		"success": true,
		"message": "Activity updated successfully.",
	})
}

func CreateActivityHandler(c *fiber.Ctx) error {
	var body ActivityRequest
	if err := c.BodyParser(&body); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success": false,
			"error":   "Invalid request body",
		})
	}

	if body.Username == "" || body.Activity == "" || body.Hours <= 0 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success": false,
			"error":   "Invalid request body",
		})
	}

	if body.Username != c.Locals("username").(string) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success": false,
			"error":   "you are not authorized to create activity for this username",
		})
	}

	if !models.ActivityName(body.Activity).IsValid() {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success": false,
			"error":   "Invalid activity name",
		})
	}

	db := utils.GetDB()
	// find all the records for this person for current day.
	todayActivities := []models.Activity{}
	fmt.Println("BBBBB")
	result := db.Where("user_id = ? AND date(created_at) = date('now')", c.Locals("user_id").(uint)).Find(&todayActivities)
	if result.Error != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success": false,
			"error":   "Failed to find activities",
		})
	}
	// if already present, update the duration_hours with the same activityName or create a new record
	if len(todayActivities) > 0 {
		for _, activity := range todayActivities {
			if activity.Name == models.ActivityName(body.Activity) {
				activity.DurationHours = body.Hours
				result = db.Save(&activity)
				if result.Error != nil {
					return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
						"success": false,
						"error":   "Failed to update activity",
					})
				}
				break
			}
		}
	}
	if len(todayActivities) == 0 {
		fmt.Println("I am here")
		activity := models.Activity{
			UserID:        c.Locals("user_id").(uint),
			Name:          models.ActivityName(body.Activity),
			DurationHours: body.Hours,
		}
		result = db.Create(&activity)
	}
	if result.Error != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success": false,
			"error":   "Failed to create activity",
		})
	}

	return c.Status(fiber.StatusOK).JSON(fiber.Map{
		"success": true,
		"message": "Activity created successfully",
	})
}

func GetActivityHandler(c *fiber.Ctx) error {
	var body GetActivityRequest
	if err := c.BodyParser(&body); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success": false,
			"error":   "Invalid request body",
		})
	}

	if body.Username != c.Locals("username").(string) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success": false,
			"error":   "you are not authorized to get activity for this username",
		})
	}

	const layout = "2006-01-02"

	startDate, err := time.Parse(layout, body.StartDate)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success": false,
			"error":   "Invalid start_date format, use YYYY-MM-DD",
		})
	}

	endDate, err := time.Parse(layout, body.EndDate)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success": false,
			"error":   "Invalid end_date format, use YYYY-MM-DD",
		})
	}

	if startDate.After(endDate) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success": false,
			"error":   "Start date must be before end date",
		})
	}

	db := utils.GetDB()
	// find all the records for this person for current day.
	activities := []models.Activity{}
	result := db.Where("user_id = ? AND date(created_at) BETWEEN ? AND ?", c.Locals("user_id").(uint), startDate, endDate).Find(&activities)
	if result.Error != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success": false,
			"error":   "Failed to find activities",
		})
	}

	return c.Status(fiber.StatusOK).JSON(fiber.Map{
		"success": true,
		// select only name and duration
		"data": ToActivityDTOs(activities),
	})
}

func ToActivityDTOs(in []models.Activity) []ActivityDTO {
	out := make([]ActivityDTO, 0, len(in))
	for _, a := range in {
		out = append(out, ActivityDTO{
			ID:            a.ID,
			Name:          models.ActivityName(a.Name),
			DurationHours: a.DurationHours,
		})
	}
	return out
}
