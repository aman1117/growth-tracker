// Package validator provides validation functions for user input.
package validator

import (
	"regexp"
	"strings"
	"unicode"

	"github.com/aman1117/backend/internal/constants"
)

// UsernamePattern defines the valid username format
var UsernamePattern = regexp.MustCompile(`^[a-z0-9_.]+$`)

// ValidationError represents a validation error with an error code
type ValidationError struct {
	Message   string
	ErrorCode string
}

func (e *ValidationError) Error() string {
	return e.Message
}

// NewValidationError creates a new validation error
func NewValidationError(message, code string) *ValidationError {
	return &ValidationError{
		Message:   message,
		ErrorCode: code,
	}
}

// ValidateUsername validates a username for format and length
func ValidateUsername(username string) *ValidationError {
	username = strings.ToLower(strings.TrimSpace(username))

	if username == "" {
		return NewValidationError("Username is required", constants.ErrCodeMissingFields)
	}

	if len(username) < constants.UsernameMinLength || len(username) > constants.UsernameMaxLength {
		return NewValidationError(
			"Username must be between 3 and 20 characters",
			constants.ErrCodeInvalidUsernameLen,
		)
	}

	if !UsernamePattern.MatchString(username) {
		return NewValidationError(
			"Username can only contain lowercase letters, numbers, _ and .",
			constants.ErrCodeInvalidUsernameFmt,
		)
	}

	return nil
}

// ValidatePassword validates a password for minimum length
func ValidatePassword(password string) *ValidationError {
	password = strings.TrimSpace(password)

	if password == "" {
		return NewValidationError("Password is required", constants.ErrCodeMissingFields)
	}

	if len(password) < constants.PasswordMinLength {
		return NewValidationError(
			"Password must be at least 8 characters long",
			constants.ErrCodePasswordTooShort,
		)
	}

	return nil
}

// ValidatePasswordStrength validates password strength (letter + number requirement)
func ValidatePasswordStrength(password string) *ValidationError {
	if err := ValidatePassword(password); err != nil {
		return err
	}

	var hasLetter, hasNumber bool
	for _, char := range password {
		if unicode.IsLetter(char) {
			hasLetter = true
		}
		if unicode.IsDigit(char) {
			hasNumber = true
		}
	}

	if !hasLetter {
		return NewValidationError(
			"Password must contain at least one letter",
			constants.ErrCodeWeakPassword,
		)
	}

	if !hasNumber {
		return NewValidationError(
			"Password must contain at least one number",
			constants.ErrCodeWeakPassword,
		)
	}

	return nil
}

// ValidateEmail validates an email address (basic validation)
func ValidateEmail(email string) *ValidationError {
	email = strings.TrimSpace(email)

	if email == "" {
		return NewValidationError("Email is required", constants.ErrCodeMissingFields)
	}

	// Basic email validation
	if !strings.Contains(email, "@") || !strings.Contains(email, ".") {
		return NewValidationError("Invalid email format", constants.ErrCodeInvalidRequest)
	}

	return nil
}

// ValidateBio validates a user bio for length
func ValidateBio(bio string) *ValidationError {
	bio = strings.TrimSpace(bio)

	if len(bio) > constants.BioMaxLength {
		return NewValidationError(
			"Bio must be 150 characters or less",
			constants.ErrCodeBioTooLong,
		)
	}

	return nil
}

// ValidateNote validates an activity note for length
func ValidateNote(note *string) *ValidationError {
	if note == nil {
		return nil
	}

	trimmed := strings.TrimSpace(*note)
	if len(trimmed) > constants.NoteMaxLength {
		return NewValidationError(
			"Note must be 500 characters or less",
			constants.ErrCodeInvalidRequest,
		)
	}

	return nil
}

// ValidateActivityHours validates activity hours
func ValidateActivityHours(hours float32) *ValidationError {
	if hours < 0 || hours > constants.MaxDailyHours {
		return NewValidationError(
			"Duration hours must be between 0 and 24",
			constants.ErrCodeInvalidRequest,
		)
	}

	return nil
}

// ValidateDateRange validates that start date is before or equal to end date
func ValidateDateRange(startDate, endDate string) *ValidationError {
	// Dates should already be in YYYY-MM-DD format for string comparison
	if startDate > endDate {
		return NewValidationError(
			"Start date must be before end date",
			constants.ErrCodeInvalidDateRange,
		)
	}

	return nil
}

// SanitizeUsername normalizes a username (lowercase, trimmed)
func SanitizeUsername(username string) string {
	return strings.ToLower(strings.TrimSpace(username))
}

// SanitizeEmail normalizes an email (trimmed)
func SanitizeEmail(email string) string {
	return strings.TrimSpace(email)
}

// SanitizeBio normalizes a bio (trimmed)
func SanitizeBio(bio string) string {
	return strings.TrimSpace(bio)
}
