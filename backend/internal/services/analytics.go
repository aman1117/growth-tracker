package services

import (
	"sort"
	"time"

	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/dto"
	"github.com/aman1117/backend/internal/repository"
	"github.com/aman1117/backend/pkg/models"
)

// AnalyticsService handles analytics-related business logic
type AnalyticsService struct {
	activityRepo *repository.ActivityRepository
	streakRepo   *repository.StreakRepository
	userRepo     *repository.UserRepository
}

// NewAnalyticsService creates a new AnalyticsService
func NewAnalyticsService(
	activityRepo *repository.ActivityRepository,
	streakRepo *repository.StreakRepository,
	userRepo *repository.UserRepository,
) *AnalyticsService {
	return &AnalyticsService{
		activityRepo: activityRepo,
		streakRepo:   streakRepo,
		userRepo:     userRepo,
	}
}

// GetWeekAnalytics retrieves weekly analytics for a user
func (s *AnalyticsService) GetWeekAnalytics(userID uint, weekStart time.Time) (*dto.WeekAnalyticsResponse, error) {
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

	// Fetch this week's activities
	thisWeekActivities, err := s.activityRepo.FindByUserAndDateRange(userID, weekStart, weekEnd)
	if err != nil {
		return nil, err
	}

	// Fetch previous week's activities
	prevWeekActivities, err := s.activityRepo.FindByUserAndDateRange(userID, prevWeekStart, prevWeekEnd)
	if err != nil {
		return nil, err
	}

	// Fetch current week's activities (for comparison with past weeks)
	var totalCurrentWeek float32
	if !isCurrentWeek {
		currentWeekActivities, err := s.activityRepo.FindByUserAndDateRange(userID, currentWeekStart, currentWeekEnd)
		if err != nil {
			return nil, err
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
	dailyBreakdown := make([]dto.DayAnalytics, 7)

	// Group activities by date
	activityByDate := make(map[string][]models.Activity)
	for _, a := range thisWeekActivities {
		dateStr := a.ActivityDate.Format(constants.DateFormat)
		activityByDate[dateStr] = append(activityByDate[dateStr], a)
	}

	for i := 0; i < 7; i++ {
		currentDay := weekStart.AddDate(0, 0, i)
		dateStr := currentDay.Format(constants.DateFormat)
		dayActivities := activityByDate[dateStr]

		// Sort by hours descending
		sort.Slice(dayActivities, func(a, b int) bool {
			return dayActivities[a].DurationHours > dayActivities[b].DurationHours
		})

		var totalHours float32
		activities := make([]dto.DayActivityBreakdown, 0)

		for _, a := range dayActivities {
			if a.DurationHours > 0 {
				totalHours += a.DurationHours
				activities = append(activities, dto.DayActivityBreakdown{
					Name:  a.Name,
					Hours: a.DurationHours,
				})
			}
		}

		dailyBreakdown[i] = dto.DayAnalytics{
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

	activitySummary := make([]dto.ActivitySummary, 0, len(activityTotals))
	for name, hours := range activityTotals {
		if hours > 0 {
			activitySummary = append(activitySummary, dto.ActivitySummary{
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
	streakInfo := s.getStreakInfo(userID)

	return &dto.WeekAnalyticsResponse{
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
	}, nil
}

func (s *AnalyticsService) getStreakInfo(userID uint) dto.StreakInfo {
	var streakInfo dto.StreakInfo

	// Get latest streak
	latestStreak, err := s.streakRepo.FindLatestByUser(userID)
	if err == nil && latestStreak != nil {
		streakInfo.Current = latestStreak.Current
		streakInfo.Longest = latestStreak.Longest
	}

	// Find longest streak period
	allStreaks, err := s.streakRepo.FindAllByUser(userID)
	if err == nil {
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
			streakInfo.LongestStart = longestStartDate.Format(constants.DateFormat)
			streakInfo.LongestEnd = longestEndDate.Format(constants.DateFormat)
		}
	}

	return streakInfo
}
