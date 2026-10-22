package validator_test

import (
	"math"
	"strings"
	"testing"
	"time"

	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/validator"
	"github.com/aman1117/backend/pkg/models"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const invalidChallenge = constants.ErrCodeInvalidChallenge

func TestNormalizeChallengeTitle(t *testing.T) {
	const lengthMsg = "title must be between 1 and 60 characters"
	tests := []struct {
		name     string
		title    string
		want     string
		wantCode string
	}{
		{name: "plain", title: "Study 2h+ a day", want: "Study 2h+ a day"},
		{name: "trimmed", title: "  \t Study \n", want: "Study"},
		{name: "one character", title: "a", want: "a"},
		{name: "60 characters", title: strings.Repeat("a", 60), want: strings.Repeat("a", 60)},
		{name: "60 characters after trimming", title: "  " + strings.Repeat("a", 60) + "  ", want: strings.Repeat("a", 60)},
		{name: "60 emoji (240 bytes)", title: strings.Repeat("🏆", 60), want: strings.Repeat("🏆", 60)},
		{name: "60 accented letters", title: strings.Repeat("é", 60), want: strings.Repeat("é", 60)},
		{name: "empty", title: "", wantCode: invalidChallenge},
		{name: "only spaces", title: "   \t\n ", wantCode: invalidChallenge},
		{name: "61 characters", title: strings.Repeat("a", 61), wantCode: invalidChallenge},
		{name: "61 emoji", title: strings.Repeat("🏆", 61), wantCode: invalidChallenge},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := validator.NormalizeChallengeTitle(tt.title)
			assertValidation(t, err, tt.wantCode, lengthMsg)
			assert.Equal(t, tt.want, got)
		})
	}
}

func TestValidateChallengeActivity(t *testing.T) {
	for _, name := range models.ActivityNames {
		assertValidation(t, validator.ValidateChallengeActivity(string(name)), "", "")
	}
	for _, name := range []string{"", "swimming", "Study", " study", "custom:3f2b8c4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f"} {
		assertValidation(t, validator.ValidateChallengeActivity(name), invalidChallenge,
			"activity must be one of the predefined activities")
	}
}

func TestValidateChallengeGoal(t *testing.T) {
	const (
		atLeastMsg = "target_hours must be a multiple of 0.25 between 0.25 and 24"
		atMostMsg  = "target_hours must be a multiple of 0.25 between 0 and 23.75"
	)
	hours := func(h float64) *float64 { return &h }
	tests := []struct {
		name     string
		goal     string
		target   *float64
		wantCode string
		wantMsg  string
	}{
		{name: "at_least smallest", goal: models.ChallengeGoalAtLeast, target: hours(0.25)},
		{name: "at_least quarter steps", goal: models.ChallengeGoalAtLeast, target: hours(2.75)},
		{name: "at_least whole day", goal: models.ChallengeGoalAtLeast, target: hours(24)},
		{name: "at_least zero", goal: models.ChallengeGoalAtLeast, target: hours(0), wantCode: invalidChallenge, wantMsg: atLeastMsg},
		{name: "at_least negative", goal: models.ChallengeGoalAtLeast, target: hours(-1), wantCode: invalidChallenge, wantMsg: atLeastMsg},
		{name: "at_least above a day", goal: models.ChallengeGoalAtLeast, target: hours(24.25), wantCode: invalidChallenge, wantMsg: atLeastMsg},
		{name: "at_least not a quarter", goal: models.ChallengeGoalAtLeast, target: hours(2.1), wantCode: invalidChallenge, wantMsg: atLeastMsg},
		{name: "at_least tenth", goal: models.ChallengeGoalAtLeast, target: hours(0.1), wantCode: invalidChallenge, wantMsg: atLeastMsg},
		{name: "at_most zero", goal: models.ChallengeGoalAtMost, target: hours(0)},
		{name: "at_most quarter", goal: models.ChallengeGoalAtMost, target: hours(0.25)},
		{name: "at_most largest", goal: models.ChallengeGoalAtMost, target: hours(23.75)},
		{name: "at_most whole day", goal: models.ChallengeGoalAtMost, target: hours(24), wantCode: invalidChallenge, wantMsg: atMostMsg},
		{name: "at_most negative quarter", goal: models.ChallengeGoalAtMost, target: hours(-0.25), wantCode: invalidChallenge, wantMsg: atMostMsg},
		{name: "at_most not a quarter", goal: models.ChallengeGoalAtMost, target: hours(1.3), wantCode: invalidChallenge, wantMsg: atMostMsg},
		{name: "not a number", goal: models.ChallengeGoalAtMost, target: hours(math.NaN()), wantCode: invalidChallenge, wantMsg: atMostMsg},
		{name: "infinite", goal: models.ChallengeGoalAtLeast, target: hours(math.Inf(1)), wantCode: invalidChallenge, wantMsg: atLeastMsg},
		{name: "missing target", goal: models.ChallengeGoalAtLeast, wantCode: invalidChallenge, wantMsg: "target_hours is required"},
		{name: "unknown goal", goal: "exactly", target: hours(2), wantCode: invalidChallenge, wantMsg: "goal_type must be at_least or at_most"},
		{name: "goal is case-sensitive", goal: "AT_LEAST", target: hours(2), wantCode: invalidChallenge, wantMsg: "goal_type must be at_least or at_most"},
		{name: "missing goal", goal: "", wantCode: invalidChallenge, wantMsg: "goal_type must be at_least or at_most"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assertValidation(t, validator.ValidateChallengeGoal(tt.goal, tt.target), tt.wantCode, tt.wantMsg)
		})
	}
}

func TestValidateChallengeDuration(t *testing.T) {
	const msg = "duration_days must be between 3 and 60"
	days := func(d int) *int { return &d }
	tests := []struct {
		name     string
		days     *int
		wantCode string
	}{
		{name: "shortest", days: days(3)},
		{name: "three weeks", days: days(21)},
		{name: "longest", days: days(60)},
		{name: "too short", days: days(2), wantCode: invalidChallenge},
		{name: "zero", days: days(0), wantCode: invalidChallenge},
		{name: "negative", days: days(-5), wantCode: invalidChallenge},
		{name: "too long", days: days(61), wantCode: invalidChallenge},
		{name: "missing", wantCode: invalidChallenge},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assertValidation(t, validator.ValidateChallengeDuration(tt.days), tt.wantCode, msg)
		})
	}
}

func TestParseChallengeStartDate(t *testing.T) {
	const (
		formatMsg = "start_date must be a date in YYYY-MM-DD format"
		rangeMsg  = "start_date must be between today and 30 days from today"
	)
	today := time.Date(2026, 10, 23, 0, 0, 0, 0, time.UTC)
	tests := []struct {
		name     string
		raw      string
		want     time.Time
		wantCode string
		wantMsg  string
	}{
		{name: "today", raw: "2026-10-23", want: today},
		{name: "tomorrow", raw: "2026-10-24", want: today.AddDate(0, 0, 1)},
		{name: "30 days ahead", raw: "2026-11-22", want: today.AddDate(0, 0, 30)},
		{name: "surrounding spaces", raw: " 2026-10-25 ", want: today.AddDate(0, 0, 2)},
		{name: "yesterday", raw: "2026-10-22", wantCode: invalidChallenge, wantMsg: rangeMsg},
		{name: "31 days ahead", raw: "2026-11-23", wantCode: invalidChallenge, wantMsg: rangeMsg},
		{name: "empty", raw: "", wantCode: invalidChallenge, wantMsg: formatMsg},
		{name: "not a date", raw: "soon", wantCode: invalidChallenge, wantMsg: formatMsg},
		{name: "day first", raw: "23-10-2026", wantCode: invalidChallenge, wantMsg: formatMsg},
		{name: "with a time", raw: "2026-10-23T00:00:00Z", wantCode: invalidChallenge, wantMsg: formatMsg},
		{name: "impossible date", raw: "2026-02-30", wantCode: invalidChallenge, wantMsg: formatMsg},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := validator.ParseChallengeStartDate(tt.raw, today)
			assertValidation(t, err, tt.wantCode, tt.wantMsg)
			assert.True(t, tt.want.Equal(got), "got %v, want %v", got, tt.want)
			if tt.wantCode == "" {
				assert.Equal(t, time.UTC, got.Location(), "dates are midnight UTC like DATE columns")
			}
		})
	}
}

func TestValidateInviteUserIDs(t *testing.T) {
	const msg = "user_ids must contain between 1 and 20 users"
	ids := func(n int) []uint {
		out := make([]uint, n)
		for i := range out {
			out[i] = uint(i + 1)
		}
		return out
	}
	assertValidation(t, validator.ValidateInviteUserIDs(ids(1)), "", "")
	assertValidation(t, validator.ValidateInviteUserIDs(ids(20)), "", "")
	assertValidation(t, validator.ValidateInviteUserIDs(nil), invalidChallenge, msg)
	assertValidation(t, validator.ValidateInviteUserIDs([]uint{}), invalidChallenge, msg)
	assertValidation(t, validator.ValidateInviteUserIDs(ids(21)), invalidChallenge, msg)
}

func TestNormalizeInviteCode(t *testing.T) {
	tests := []struct {
		raw    string
		want   string
		wantOK bool
	}{
		{raw: "K7Q2M9XA", want: "K7Q2M9XA", wantOK: true},
		{raw: "k7q2m9xa", want: "K7Q2M9XA", wantOK: true},
		{raw: "  k7Q2m9Xa\t", want: "K7Q2M9XA", wantOK: true},
		{raw: "ABCDEFGH", want: "ABCDEFGH", wantOK: true},
		{raw: "23456789", want: "23456789", wantOK: true},
		{raw: ""},
		{raw: "K7Q2M9X"},
		{raw: "K7Q2M9XAB"},
		{raw: "K7Q2M9X0"}, // 0, 1, I and O are not in the alphabet
		{raw: "K7Q2M9X1"},
		{raw: "K7Q2M9XI"},
		{raw: "K7Q2M9XO"},
		{raw: "K7Q2 9XA"},
		{raw: "K7Q2M9X%"},
		{raw: "K7Q2M9X_"},
		{raw: "K7Q2M9Xé"},
	}
	for _, tt := range tests {
		got, ok := validator.NormalizeInviteCode(tt.raw)
		assert.Equal(t, tt.wantOK, ok, "NormalizeInviteCode(%q)", tt.raw)
		assert.Equal(t, tt.want, got, "NormalizeInviteCode(%q)", tt.raw)
	}
}

func TestChallengeValidationErrorsUseTheChallengeCode(t *testing.T) {
	_, err := validator.NormalizeChallengeTitle("")
	require.NotNil(t, err)
	assert.Equal(t, constants.ErrCodeInvalidChallenge, err.ErrorCode)
	assert.EqualError(t, err, err.Message)
}
