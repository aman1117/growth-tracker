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
	Note     *string             `json:"note,omitempty"`
}

type ActivityDTO struct {
	ID            uint                `json:"id"`
	Name          models.ActivityName `json:"name"`
	DurationHours float32             `json:"hours"`
	Date          string              `json:"date"`
	Note          *string             `json:"note"`
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
	Username   string  `json:"username"`
	Email      string  `json:"email"`
	ID         uint    `json:"id"`
	ProfilePic *string `json:"profile_pic"`
	Bio        *string `json:"bio,omitempty"` // Only included for public profiles
	IsPrivate  bool    `json:"is_private"`
	IsVerified bool    `json:"is_verified"`
}

func CreateActivityHandler(c *fiber.Ctx) error {
	var body ActivityRequest
	if err := c.BodyParser(&body); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success":    false,
			"error":      "Invalid request body",
			"error_code": "INVALID_REQUEST",
		})
	}

	if body.Username == "" || body.Activity == "" || body.Hours < 0 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success":    false,
			"error":      "Invalid request body",
			"error_code": "MISSING_FIELDS",
		})
	}

	if body.Username != c.Locals("username").(string) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success":    false,
			"error":      "you are not authorized to create activity for this username",
			"error_code": "NOT_AUTHORIZED",
		})
	}

	if !models.ActivityName(body.Activity).IsValid() {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success":    false,
			"error":      "Invalid activity name",
			"error_code": "INVALID_ACTIVITY",
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
	userID := c.Locals("user_id").(uint)

	var dayActivities []models.Activity
	result := db.
		Where("user_id = ? AND activity_date = ?", userID, date).
		Find(&dayActivities)
	if result.Error != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success":    false,
			"error":      "Failed to find activities",
			"error_code": "FETCH_FAILED",
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
			"success":    false,
			"error":      "Total hours cannot be more than 24",
			"error_code": "HOURS_EXCEEDED",
		})
	}

	traceID, _ := c.Locals("trace_id").(string)
	log := utils.LogWithContext(traceID, userID)

	if existing != nil {
		existing.DurationHours = body.Hours
		existing.Note = body.Note
		if err := db.Save(existing).Error; err != nil {
			log.Errorw("Failed to update activity", "error", err)
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
				"success":    false,
				"error":      "Failed to update activity",
				"error_code": "UPDATE_FAILED",
			})
		}

		err := AddStreak(userID, date, false)
		if err != nil {
			log.Errorw("Failed to add streak", "error", err)
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
				"success":    false,
				"error":      err.Error(),
				"error_code": "STREAK_ERROR",
			})
		}
		log.Debugw("Activity updated", "activity", body.Activity, "hours", body.Hours, "date", body.Date)
	} else {
		activity := models.Activity{
			UserID:        userID,
			Name:          activityNameVal,
			DurationHours: body.Hours,
			ActivityDate:  date,
			Note:          body.Note,
		}
		if err := db.Create(&activity).Error; err != nil {
			log.Errorw("Failed to create activity", "error", err)
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
				"success":    false,
				"error":      "Failed to create activity",
				"error_code": "CREATE_FAILED",
			})
		}

		err := AddStreak(userID, date, false)
		if err != nil {
			log.Errorw("Failed to add streak", "error", err)
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
				"success":    false,
				"error":      err.Error(),
				"error_code": "STREAK_ERROR",
			})
		}
		log.Debugw("Activity created", "activity", body.Activity, "hours", body.Hours, "date", body.Date)
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
			"success":    false,
			"error":      "Invalid request body",
			"error_code": "INVALID_REQUEST",
		})
	}

	const layout = "2006-01-02"

	// Parse start_date (YYYY-MM-DD)
	startDate, err := time.Parse(layout, body.StartDate)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success":    false,
			"error":      "Invalid start_date format, use YYYY-MM-DD",
			"error_code": "INVALID_DATE",
		})
	}

	// Parse end_date (YYYY-MM-DD)
	endDate, err := time.Parse(layout, body.EndDate)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success":    false,
			"error":      "Invalid end_date format, use YYYY-MM-DD",
			"error_code": "INVALID_DATE",
		})
	}

	if startDate.After(endDate) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success":    false,
			"error":      "Start date must be before end date",
			"error_code": "INVALID_DATE_RANGE",
		})
	}

	db := utils.GetDB()

	// Get current user ID from context
	currentUserID, _ := c.Locals("user_id").(uint)
	traceID, _ := c.Locals("trace_id").(string)

	// Find user by username
	var user models.User
	if err := db.Where("username = ?", body.Username).First(&user).Error; err != nil {
		utils.LogWithContext(traceID, currentUserID).Warnw("Activity fetch failed - user not found", "target_username", body.Username)
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success":    false,
			"error":      "Failed to find user",
			"error_code": "USER_NOT_FOUND",
		})
	}

	// Check if user is private and not the current user
	if user.IsPrivate && user.ID != currentUserID {
		utils.LogWithContext(traceID, currentUserID).Debugw("Activity access denied - private account", "target_username", body.Username)
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{
			"success":    false,
			"error":      "This account is private",
			"error_code": "ACCOUNT_PRIVATE",
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
		utils.Sugar.Errorw("Activity fetch failed", "user_id", user.ID, "username", body.Username, "error", err)
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success":    false,
			"error":      "Failed to find activities",
			"error_code": "FETCH_FAILED",
		})
	}

	// Only include notes if user is viewing their own activities
	isOwnProfile := user.ID == currentUserID
	return c.Status(fiber.StatusOK).JSON(fiber.Map{
		"success": true,
		"data":    ToActivityDTOs(activities, isOwnProfile),
	})
}

func ToActivityDTOs(in []models.Activity, includeNotes bool) []ActivityDTO {
	out := make([]ActivityDTO, 0, len(in))
	for _, a := range in {
		dto := ActivityDTO{
			ID:            a.ID,
			Name:          models.ActivityName(a.Name),
			DurationHours: a.DurationHours,
			Date:          a.ActivityDate.Format("2006-01-02"),
		}
		// Only include notes for own profile
		if includeNotes {
			dto.Note = a.Note
		}
		out = append(out, dto)
	}
	return out
}

func GetUsersHandler(c *fiber.Ctx) error {
	traceID, _ := c.Locals("trace_id").(string)
	currentUserID, _ := c.Locals("user_id").(uint)

	var body GetUsersRequest
	if err := c.BodyParser(&body); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success":    false,
			"error":      "Invalid request body",
			"error_code": "INVALID_REQUEST",
		})
	}

	db := utils.GetDB()
	users := []models.User{}
	// find user by username with ILIKE, exclude private users from search results
	result := db.Where("username ILIKE ? AND is_private = ?", "%"+body.Username+"%", false).Find(&users)
	if result.Error != nil {
		utils.LogWithContext(traceID, currentUserID).Errorw("User search failed", "query", body.Username, "error", result.Error)
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success":    false,
			"error":      "Failed to find users",
			"error_code": "FETCH_FAILED",
		})
	}
	utils.LogWithContext(traceID, currentUserID).Debugw("User search completed", "query", body.Username, "found", len(users))
	return c.Status(fiber.StatusOK).JSON(fiber.Map{
		"success": true,
		"data":    SanitizeUsers(users),
	})
}

func SanitizeUsers(in []models.User) []UserDTO {
	out := make([]UserDTO, 0, len(in))
	for _, a := range in {
		dto := UserDTO{
			ID:         a.ID,
			Username:   a.Username,
			Email:      a.Email,
			ProfilePic: a.ProfilePic,
			IsPrivate:  a.IsPrivate,
			IsVerified: a.IsVerified,
		}
		// Only include bio for public profiles
		if !a.IsPrivate {
			dto.Bio = a.Bio
		}
		out = append(out, dto)
	}
	return out
}
