package services

import (
	"time"

	"github.com/aman1117/backend/models"
	"github.com/aman1117/backend/utils"
	"github.com/gofiber/fiber/v2"
)

type ActivityRequest struct {
	Username string              `json:"username"`
	Activity models.ActivityName `json:"activity"`
	Hours    float32             `json:"hours"`
	Date     string              `json:"date"`
}

type ActivityDTO struct {
	ID            uint                `json:"id"`
	Name          models.ActivityName `json:"name"`
	DurationHours float32             `json:"hours"`
	Date          string              `json:"date"`
}

type GetActivityRequest struct {
	Username  string `json:"username"`
	StartDate string `json:"start_date"`
	EndDate   string `json:"end_date"`
}

type GetUsersRequest struct {
	Username string `json:"username"`
}
type UserDTO struct {
	Username string `json:"username"`
	Email    string `json:"email"`
	ID       uint   `json:"id"`
}

func CreateActivityHandler(c *fiber.Ctx) error {
	var body ActivityRequest
	if err := c.BodyParser(&body); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success": false,
			"error":   "Invalid request body",
		})
	}

	if body.Username == "" || body.Activity == "" || body.Hours < 0 {
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

	const layout = "2006-01-02"
	date, err := time.Parse(layout, body.Date)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success": false,
			"error":   "Invalid date format, use YYYY-MM-DD",
		})
	}
	date = date.Truncate(24 * time.Hour)

	db := utils.GetDB()
	userID := c.Locals("user_id").(uint)

	var dayActivities []models.Activity
	result := db.
		Where("user_id = ? AND activity_date = ?", userID, date).
		Find(&dayActivities)
	if result.Error != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success": false,
			"error":   "Failed to find activities",
		})
	}

	var (
		totalHours      float32
		existing        *models.Activity
		activityNameVal = models.ActivityName(body.Activity)
	)

	for i := range dayActivities {
		a := &dayActivities[i]
		totalHours += a.DurationHours

		if a.Name == activityNameVal {
			existing = a
		}
	}

	var newTotal float32
	if existing != nil {
		newTotal = totalHours - existing.DurationHours + body.Hours
	} else {
		newTotal = totalHours + body.Hours
	}

	if newTotal > 24 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success": false,
			"error":   "Total hours cannot be more than 24",
		})
	}

	if existing != nil {
		existing.DurationHours = body.Hours
		if err := db.Save(existing).Error; err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
				"success": false,
				"error":   "Failed to update activity",
			})
		}
	} else {
		activity := models.Activity{
			UserID:        userID,
			Name:          activityNameVal,
			DurationHours: body.Hours,
			ActivityDate:  date,
		}
		if err := db.Create(&activity).Error; err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
				"success": false,
				"error":   "Failed to create activity",
			})
		}
	}

	return c.Status(fiber.StatusOK).JSON(fiber.Map{
		"success": true,
		"message": "Activity updated successfully",
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

	const layout = "2006-01-02"

	// Parse start_date (YYYY-MM-DD)
	startDate, err := time.Parse(layout, body.StartDate)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success": false,
			"error":   "Invalid start_date format, use YYYY-MM-DD",
		})
	}

	// Parse end_date (YYYY-MM-DD)
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

	// Find user by username
	var user models.User
	if err := db.Where("username = ?", body.Username).First(&user).Error; err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success": false,
			"error":   "Failed to find user",
		})
	}

	// Fetch activities using activity_date (DATE column)
	var activities []models.Activity
	if err := db.Where(
		"user_id = ? AND activity_date BETWEEN ? AND ?",
		user.ID,
		startDate,
		endDate,
	).Find(&activities).Error; err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success": false,
			"error":   "Failed to find activities",
		})
	}

	return c.Status(fiber.StatusOK).JSON(fiber.Map{
		"success": true,
		"data":    ToActivityDTOs(activities), // only name + duration etc.
	})
}

func ToActivityDTOs(in []models.Activity) []ActivityDTO {
	out := make([]ActivityDTO, 0, len(in))
	for _, a := range in {
		out = append(out, ActivityDTO{
			ID:            a.ID,
			Name:          models.ActivityName(a.Name),
			DurationHours: a.DurationHours,
			Date:          a.ActivityDate.Format("2006-01-02"),
		})
	}
	return out
}

func GetUsersHandler(c *fiber.Ctx) error {

	var body GetUsersRequest
	if err := c.BodyParser(&body); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success": false,
			"error":   "Invalid request body",
		})
	}

	db := utils.GetDB()
	users := []models.User{}
	// find user by username with ILIKE
	result := db.Where("username ILIKE ?", "%"+body.Username+"%").Find(&users)
	if result.Error != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success": false,
			"error":   "Failed to find users",
		})
	}
	return c.Status(fiber.StatusOK).JSON(fiber.Map{
		"success": true,
		"data":    SanitizeUsers(users),
	})
}

func SanitizeUsers(in []models.User) []UserDTO {
	out := make([]UserDTO, 0, len(in))
	for _, a := range in {
		out = append(out, UserDTO{
			ID:       a.ID,
			Username: a.Username,
			Email:    a.Email,
		})
	}
	return out
}
