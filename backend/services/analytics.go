package services

import (
	"sort"
	"time"

	"github.com/aman1117/backend/models"
	"github.com/aman1117/backend/utils"
	"github.com/gofiber/fiber/v2"
)

type GetWeekAnalyticsRequest struct {
	Username  string `json:"username"`
	WeekStart string `json:"week_start"` // YYYY-MM-DD (Monday of the week)
}

type DayActivityBreakdown struct {
	Name  models.ActivityName `json:"name"`
	Hours float32             `json:"hours"`
}

type DayAnalytics struct {
	Date       string                 `json:"date"`
	DayName    string                 `json:"day_name"`
	TotalHours float32                `json:"total_hours"`
	Activities []DayActivityBreakdown `json:"activities"`
}

type ActivitySummary struct {
	Name       models.ActivityName `json:"name"`
	TotalHours float32             `json:"total_hours"`
}

type StreakInfo struct {
	Current      int    `json:"current"`
	Longest      int    `json:"longest"`
	LongestStart string `json:"longest_start,omitempty"`
	LongestEnd   string `json:"longest_end,omitempty"`
}

type WeekAnalyticsResponse struct {
	Success               bool              `json:"success"`
	TotalHoursThisWeek    float32           `json:"total_hours_this_week"`
	TotalHoursPrevWeek    float32           `json:"total_hours_prev_week"`
	TotalHoursCurrentWeek float32           `json:"total_hours_current_week"`
	PercentageChange      float32           `json:"percentage_change"`
	PercentageVsCurrent   float32           `json:"percentage_vs_current"`
	IsCurrentWeek         bool              `json:"is_current_week"`
	Streak                StreakInfo        `json:"streak"`
	DailyBreakdown        []DayAnalytics    `json:"daily_breakdown"`
	ActivitySummary       []ActivitySummary `json:"activity_summary"`
}

func GetWeekAnalyticsHandler(c *fiber.Ctx) error {
	var body GetWeekAnalyticsRequest
	if err := c.BodyParser(&body); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success":    false,
			"error":      "Invalid request body",
			"error_code": "INVALID_REQUEST",
		})
	}

	const layout = "2006-01-02"
	weekStart, err := time.Parse(layout, body.WeekStart)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success":    false,
			"error":      "Invalid week_start format, use YYYY-MM-DD",
			"error_code": "INVALID_DATE",
		})
	}

	// Calculate week end (Sunday)
	weekEnd := weekStart.AddDate(0, 0, 6)

	// Previous week dates
	prevWeekStart := weekStart.AddDate(0, 0, -7)
	prevWeekEnd := weekStart.AddDate(0, 0, -1)

	// Current week dates (based on today)
	now := time.Now()
	currentWeekday := int(now.Weekday())
	// Adjust for Monday start
	if currentWeekday == 0 {
		currentWeekday = 7
	}
	currentWeekStart := now.AddDate(0, 0, -(currentWeekday - 1))
	currentWeekStart = time.Date(currentWeekStart.Year(), currentWeekStart.Month(), currentWeekStart.Day(), 0, 0, 0, 0, time.UTC)
	currentWeekEnd := currentWeekStart.AddDate(0, 0, 6)

	// Check if selected week is current week
	isCurrentWeek := weekStart.Equal(currentWeekStart)

	db := utils.GetDB()
	currentUserID, _ := c.Locals("user_id").(uint)
	traceID, _ := c.Locals("trace_id").(string)

	// Find user by username
	var user models.User
	if err := db.Where("username = ?", body.Username).First(&user).Error; err != nil {
		utils.LogWithContext(traceID, currentUserID).Warnw("Analytics fetch failed - user not found", "target_username", body.Username)
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success":    false,
			"error":      "Failed to find user",
			"error_code": "USER_NOT_FOUND",
		})
	}

	// Check if user is private and not the current user
	if user.IsPrivate && user.ID != currentUserID {
		utils.LogWithContext(traceID, currentUserID).Debugw("Analytics access denied - private account", "target_username", body.Username)
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{
			"success":    false,
			"error":      "This account is private",
			"error_code": "ACCOUNT_PRIVATE",
		})
	}

	// Fetch this week's activities
	var thisWeekActivities []models.Activity
	if err := db.Where(
		"user_id = ? AND activity_date BETWEEN ? AND ?",
		user.ID, weekStart, weekEnd,
	).Find(&thisWeekActivities).Error; err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"success":    false,
			"error":      "Failed to fetch activities",
			"error_code": "FETCH_FAILED",
		})
	}

	// Fetch previous week's activities
	var prevWeekActivities []models.Activity
	if err := db.Where(
		"user_id = ? AND activity_date BETWEEN ? AND ?",
		user.ID, prevWeekStart, prevWeekEnd,
	).Find(&prevWeekActivities).Error; err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"success":    false,
			"error":      "Failed to fetch previous week activities",
			"error_code": "FETCH_FAILED",
		})
	}

	// Fetch current week's activities (for comparison with past weeks)
	var currentWeekActivities []models.Activity
	var totalCurrentWeek float32
	if !isCurrentWeek {
		if err := db.Where(
			"user_id = ? AND activity_date BETWEEN ? AND ?",
			user.ID, currentWeekStart, currentWeekEnd,
		).Find(&currentWeekActivities).Error; err != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
				"success":    false,
				"error":      "Failed to fetch current week activities",
				"error_code": "FETCH_FAILED",
			})
		}
		for _, a := range currentWeekActivities {
			totalCurrentWeek += a.DurationHours
		}
	}

	// Calculate totals
	var totalThisWeek float32
	for _, a := range thisWeekActivities {
		totalThisWeek += a.DurationHours
	}

	var totalPrevWeek float32
	for _, a := range prevWeekActivities {
		totalPrevWeek += a.DurationHours
	}

	// Calculate percentage change (vs previous week)
	var percentageChange float32
	if totalPrevWeek > 0 {
		percentageChange = ((totalThisWeek - totalPrevWeek) / totalPrevWeek) * 100
	} else if totalThisWeek > 0 {
		percentageChange = 100
	}

	// Calculate percentage vs current week (for past weeks)
	var percentageVsCurrent float32
	if !isCurrentWeek {
		if totalCurrentWeek > 0 {
			percentageVsCurrent = ((totalThisWeek - totalCurrentWeek) / totalCurrentWeek) * 100
		} else if totalThisWeek > 0 {
			percentageVsCurrent = 100
		}
	}

	// Build daily breakdown
	dayNames := []string{"Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"}
	dailyBreakdown := make([]DayAnalytics, 7)

	// Group activities by date
	activityByDate := make(map[string][]models.Activity)
	for _, a := range thisWeekActivities {
		dateStr := a.ActivityDate.Format(layout)
		activityByDate[dateStr] = append(activityByDate[dateStr], a)
	}

	for i := 0; i < 7; i++ {
		currentDay := weekStart.AddDate(0, 0, i)
		dateStr := currentDay.Format(layout)
		dayActivities := activityByDate[dateStr]

		// Sort by hours descending
		sort.Slice(dayActivities, func(a, b int) bool {
			return dayActivities[a].DurationHours > dayActivities[b].DurationHours
		})

		var totalHours float32
		activities := make([]DayActivityBreakdown, 0)

		for _, a := range dayActivities {
			if a.DurationHours > 0 {
				totalHours += a.DurationHours
				activities = append(activities, DayActivityBreakdown{
					Name:  a.Name,
					Hours: a.DurationHours,
				})
			}
		}

		dailyBreakdown[i] = DayAnalytics{
			Date:       dateStr,
			DayName:    dayNames[i],
			TotalHours: totalHours,
			Activities: activities,
		}
	}

	// Build activity summary (aggregate across the week)
	activityTotals := make(map[models.ActivityName]float32)
	for _, a := range thisWeekActivities {
		activityTotals[a.Name] += a.DurationHours
	}

	activitySummary := make([]ActivitySummary, 0, len(activityTotals))
	for name, hours := range activityTotals {
		if hours > 0 {
			activitySummary = append(activitySummary, ActivitySummary{
				Name:       name,
				TotalHours: hours,
			})
		}
	}

	// Sort by hours descending
	sort.Slice(activitySummary, func(a, b int) bool {
		return activitySummary[a].TotalHours > activitySummary[b].TotalHours
	})

	// Get streak info
	var streakInfo StreakInfo
	var currentStreak models.Streak
	if err := db.Where("user_id = ?", user.ID).Order("activity_date DESC").First(&currentStreak).Error; err == nil {
		streakInfo.Current = currentStreak.Current
		streakInfo.Longest = currentStreak.Longest
	}

	// Find longest streak period
	var allStreaks []models.Streak
	if err := db.Where("user_id = ?", user.ID).Order("activity_date ASC").Find(&allStreaks).Error; err == nil {
		longestVal := 0
		var longestStartDate, longestEndDate time.Time

		for _, s := range allStreaks {
			if s.Current >= longestVal && s.Current > 0 {
				longestVal = s.Current
				longestEndDate = s.ActivityDate
				longestStartDate = s.ActivityDate.AddDate(0, 0, -(s.Current - 1))
			}
		}

		if longestVal > 0 {
			streakInfo.Longest = longestVal
			streakInfo.LongestStart = longestStartDate.Format(layout)
			streakInfo.LongestEnd = longestEndDate.Format(layout)
		}
	}

	return c.Status(fiber.StatusOK).JSON(WeekAnalyticsResponse{
		Success:               true,
		TotalHoursThisWeek:    totalThisWeek,
		TotalHoursPrevWeek:    totalPrevWeek,
		TotalHoursCurrentWeek: totalCurrentWeek,
		PercentageChange:      percentageChange,
		PercentageVsCurrent:   percentageVsCurrent,
		IsCurrentWeek:         isCurrentWeek,
		Streak:                streakInfo,
		DailyBreakdown:        dailyBreakdown,
		ActivitySummary:       activitySummary,
	})
}
