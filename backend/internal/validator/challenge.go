package validator

import (
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/pkg/models"
)

// newChallengeError returns a challenge validation error; message names the invalid field.
func newChallengeError(message string) *ValidationError {
	return NewValidationError(message, constants.ErrCodeInvalidChallenge)
}

// NormalizeChallengeTitle trims a challenge title and checks its length in characters (runes,
// so emoji and accented letters count once).
func NormalizeChallengeTitle(title string) (string, *ValidationError) {
	trimmed := strings.TrimSpace(title)
	if length := utf8.RuneCountInString(trimmed); length < 1 || length > constants.ChallengeTitleMaxLength {
		return "", newChallengeError(fmt.Sprintf("title must be between 1 and %d characters", constants.ChallengeTitleMaxLength))
	}
	return trimmed, nil
}

// ValidateChallengeActivity accepts the predefined activities only: custom tiles belong to a
// single user, so other participants could never log them.
func ValidateChallengeActivity(activity string) *ValidationError {
	if !models.ActivityName(activity).IsPredefined() {
		return newChallengeError("activity must be one of the predefined activities")
	}
	return nil
}

// ValidateChallengeGoal checks goal_type and target_hours. The target is a multiple of 0.25
// hours: 0.25..24 for at_least and 0..23.75 for at_most (0 means "none at all").
func ValidateChallengeGoal(goalType string, targetHours *float64) *ValidationError {
	var low, high float64
	switch goalType {
	case models.ChallengeGoalAtLeast:
		low, high = constants.ChallengeHoursStep, constants.ChallengeAtLeastMaxHours
	case models.ChallengeGoalAtMost:
		low, high = 0, constants.ChallengeAtMostMaxHours
	default:
		return newChallengeError("goal_type must be at_least or at_most")
	}
	if targetHours == nil {
		return newChallengeError("target_hours is required")
	}
	target := *targetHours
	steps := target / constants.ChallengeHoursStep
	if math.IsNaN(target) || target < low || target > high || steps != math.Trunc(steps) {
		return newChallengeError(fmt.Sprintf("target_hours must be a multiple of %s between %s and %s",
			formatHours(constants.ChallengeHoursStep), formatHours(low), formatHours(high)))
	}
	return nil
}

// ValidateChallengeDuration checks duration_days.
func ValidateChallengeDuration(days *int) *ValidationError {
	if days == nil || *days < constants.ChallengeMinDurationDays || *days > constants.ChallengeMaxDurationDays {
		return newChallengeError(fmt.Sprintf("duration_days must be between %d and %d",
			constants.ChallengeMinDurationDays, constants.ChallengeMaxDurationDays))
	}
	return nil
}

// ParseChallengeStartDate parses start_date (YYYY-MM-DD) and checks that it is between today
// and 30 days from today. today and the result are dates at midnight UTC.
func ParseChallengeStartDate(raw string, today time.Time) (time.Time, *ValidationError) {
	start, err := time.Parse(constants.DateFormat, strings.TrimSpace(raw))
	if err != nil {
		return time.Time{}, newChallengeError("start_date must be a date in YYYY-MM-DD format")
	}
	if start.Before(today) || start.After(today.AddDate(0, 0, constants.ChallengeMaxStartOffsetDays)) {
		return time.Time{}, newChallengeError(fmt.Sprintf("start_date must be between today and %d days from today",
			constants.ChallengeMaxStartOffsetDays))
	}
	return start, nil
}

// ValidateInviteUserIDs checks the number of users invited in one request.
func ValidateInviteUserIDs(userIDs []uint) *ValidationError {
	if len(userIDs) < 1 || len(userIDs) > constants.ChallengeMaxInvitesPerRequest {
		return newChallengeError(fmt.Sprintf("user_ids must contain between 1 and %d users",
			constants.ChallengeMaxInvitesPerRequest))
	}
	return nil
}

// NormalizeInviteCode trims and upper-cases an invite code (codes are case-insensitive). ok is
// false when the result cannot be an invite code.
func NormalizeInviteCode(raw string) (code string, ok bool) {
	code = strings.ToUpper(strings.TrimSpace(raw))
	if len(code) != constants.ChallengeInviteCodeLength {
		return "", false
	}
	for _, r := range code {
		if !strings.ContainsRune(constants.ChallengeInviteCodeAlphabet, r) {
			return "", false
		}
	}
	return code, true
}

func formatHours(hours float64) string {
	return strconv.FormatFloat(hours, 'f', -1, 64)
}
