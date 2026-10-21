package validator_test

import (
	"fmt"
	"strings"
	"testing"

	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/validator"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// assertValidation checks a validator result: wantCode == "" means the input is valid.
func assertValidation(t *testing.T, err *validator.ValidationError, wantCode, wantMessage string) {
	t.Helper()
	if wantCode == "" {
		assert.Nil(t, err)
		return
	}
	require.NotNil(t, err)
	assert.Equal(t, wantCode, err.ErrorCode)
	assert.Equal(t, wantMessage, err.Message)
}

func TestValidationError(t *testing.T) {
	err := validator.NewValidationError("Username is required", constants.ErrCodeMissingFields)

	assert.Equal(t, "Username is required", err.Message)
	assert.Equal(t, constants.ErrCodeMissingFields, err.ErrorCode)

	var asError error = err
	assert.EqualError(t, asError, "Username is required")
}

func TestValidateUsername(t *testing.T) {
	const (
		lengthMsg = "Username must be between 3 and 20 characters"
		formatMsg = "Username can only contain lowercase letters, numbers, _ and ."
	)
	tests := []struct {
		name     string
		username string
		wantCode string
		wantMsg  string
	}{
		{name: "empty", username: "", wantCode: constants.ErrCodeMissingFields, wantMsg: "Username is required"},
		{name: "only whitespace", username: "   ", wantCode: constants.ErrCodeMissingFields, wantMsg: "Username is required"},
		{name: "too short", username: "ab", wantCode: constants.ErrCodeInvalidUsernameLen, wantMsg: lengthMsg},
		{name: "too short after trimming", username: "  ab  ", wantCode: constants.ErrCodeInvalidUsernameLen, wantMsg: lengthMsg},
		{name: "minimum length", username: "abc"},
		{name: "maximum length", username: strings.Repeat("a", 20)},
		{name: "too long", username: strings.Repeat("a", 21), wantCode: constants.ErrCodeInvalidUsernameLen, wantMsg: lengthMsg},
		{name: "digits, underscore and dot", username: "john_doe.42"},
		{name: "uppercase is normalised", username: "JohnDoe"},
		{name: "surrounding whitespace is trimmed", username: "  john  "},
		{name: "hyphen", username: "john-doe", wantCode: constants.ErrCodeInvalidUsernameFmt, wantMsg: formatMsg},
		{name: "inner space", username: "john doe", wantCode: constants.ErrCodeInvalidUsernameFmt, wantMsg: formatMsg},
		{name: "at sign", username: "@john", wantCode: constants.ErrCodeInvalidUsernameFmt, wantMsg: formatMsg},
		{name: "non-ASCII letters", username: "jöhn", wantCode: constants.ErrCodeInvalidUsernameFmt, wantMsg: formatMsg},
		{name: "emoji", username: "fire🔥", wantCode: constants.ErrCodeInvalidUsernameFmt, wantMsg: formatMsg},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assertValidation(t, validator.ValidateUsername(tt.username), tt.wantCode, tt.wantMsg)
		})
	}
}

// Usernames are ASCII-only, so non-ASCII input is always rejected; the reason must still be
// accurate, which needs the length in characters.
func TestValidateUsername_CountsCharactersNotBytes(t *testing.T) {
	tests := []struct {
		name     string
		username string
		wantCode string
		wantMsg  string
	}{
		{
			name:     "fifteen Cyrillic letters have a valid length but invalid characters",
			username: "абвгдежзийклмно",
			wantCode: constants.ErrCodeInvalidUsernameFmt,
			wantMsg:  "Username can only contain lowercase letters, numbers, _ and .",
		},
		{
			name:     "two accented letters are too short",
			username: "éé",
			wantCode: constants.ErrCodeInvalidUsernameLen,
			wantMsg:  "Username must be between 3 and 20 characters",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assertValidation(t, validator.ValidateUsername(tt.username), tt.wantCode, tt.wantMsg)
		})
	}
}

func TestValidatePassword(t *testing.T) {
	const tooShort = "Password must be at least 8 characters long"
	tests := []struct {
		name     string
		password string
		wantCode string
		wantMsg  string
	}{
		{name: "empty", password: "", wantCode: constants.ErrCodeMissingFields, wantMsg: "Password is required"},
		{name: "only whitespace", password: "        ", wantCode: constants.ErrCodeMissingFields, wantMsg: "Password is required"},
		{name: "seven characters", password: "abc1234", wantCode: constants.ErrCodePasswordTooShort, wantMsg: tooShort},
		{name: "short once trimmed", password: "  abc1234  ", wantCode: constants.ErrCodePasswordTooShort, wantMsg: tooShort},
		{name: "eight characters", password: "abcd1234"},
		{name: "no complexity requirement", password: "aaaaaaaa"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assertValidation(t, validator.ValidatePassword(tt.password), tt.wantCode, tt.wantMsg)
		})
	}
}

func TestValidatePasswordStrength(t *testing.T) {
	tests := []struct {
		name     string
		password string
		wantCode string
		wantMsg  string
	}{
		{name: "empty", password: "", wantCode: constants.ErrCodeMissingFields, wantMsg: "Password is required"},
		{name: "too short", password: "ab12", wantCode: constants.ErrCodePasswordTooShort, wantMsg: "Password must be at least 8 characters long"},
		{name: "digits only", password: "12345678", wantCode: constants.ErrCodeWeakPassword, wantMsg: "Password must contain at least one letter"},
		{name: "symbols only", password: "!@#$%^&*", wantCode: constants.ErrCodeWeakPassword, wantMsg: "Password must contain at least one letter"},
		{name: "letters only", password: "password", wantCode: constants.ErrCodeWeakPassword, wantMsg: "Password must contain at least one number"},
		{name: "letters and digits", password: "passw0rd"},
		{name: "mixed with symbols", password: "Password123!"},
		{name: "non-ASCII letters count as letters", password: "пароль123"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assertValidation(t, validator.ValidatePasswordStrength(tt.password), tt.wantCode, tt.wantMsg)
		})
	}
}

// The minimum is 8 characters: multi-byte characters must not make a shorter password pass.
func TestValidatePassword_CountsCharactersNotBytes(t *testing.T) {
	const tooShort = "Password must be at least 8 characters long"
	tests := []struct {
		name     string
		password string
		wantCode string
	}{
		{name: "seven Cyrillic characters", password: "пароль1", wantCode: constants.ErrCodePasswordTooShort},
		{name: "four CJK characters", password: "密码密码", wantCode: constants.ErrCodePasswordTooShort},
		{name: "eight Cyrillic characters", password: "пароль12"},
		{name: "eight emoji", password: strings.Repeat("🔑", 8)},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assertValidation(t, validator.ValidatePassword(tt.password), tt.wantCode, tooShort)
		})
	}

	t.Run("strength check applies the same minimum", func(t *testing.T) {
		assertValidation(t, validator.ValidatePasswordStrength("пароль1"), constants.ErrCodePasswordTooShort, tooShort)
		assertValidation(t, validator.ValidatePasswordStrength("пароль12"), "", "")
	})
}

func TestValidateEmail(t *testing.T) {
	tests := []struct {
		name     string
		email    string
		wantCode string
		wantMsg  string
	}{
		{name: "empty", email: "", wantCode: constants.ErrCodeMissingFields, wantMsg: "Email is required"},
		{name: "only whitespace", email: "  ", wantCode: constants.ErrCodeMissingFields, wantMsg: "Email is required"},
		{name: "missing at sign", email: "user.example.com", wantCode: constants.ErrCodeInvalidRequest, wantMsg: "Invalid email format"},
		{name: "missing dot", email: "user@localhost", wantCode: constants.ErrCodeInvalidRequest, wantMsg: "Invalid email format"},
		{name: "valid", email: "user@example.com"},
		{name: "valid with surrounding whitespace", email: "  user@example.com  "},
		{name: "valid with plus tag", email: "user+tag@mail.example.co"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assertValidation(t, validator.ValidateEmail(tt.email), tt.wantCode, tt.wantMsg)
		})
	}
}

func TestValidateBio(t *testing.T) {
	const tooLong = "Bio must be 150 characters or less"
	tests := []struct {
		name     string
		bio      string
		wantCode string
	}{
		{name: "empty", bio: ""},
		{name: "maximum length", bio: strings.Repeat("a", 150)},
		{name: "too long", bio: strings.Repeat("a", 151), wantCode: constants.ErrCodeBioTooLong},
		{name: "surrounding whitespace does not count", bio: "  " + strings.Repeat("a", 150) + "\n"},
		// The limit is 150 characters, like the message and the varchar(150) column: multi-byte characters count once.
		{name: "150 accented letters", bio: strings.Repeat("é", 150)},
		{name: "150 emoji", bio: strings.Repeat("🚀", 150)},
		{name: "150 mixed characters", bio: "Coffee | Code " + strings.Repeat("ü", 136)},
		{name: "151 accented letters", bio: strings.Repeat("é", 151), wantCode: constants.ErrCodeBioTooLong},
		{name: "151 emoji", bio: strings.Repeat("🚀", 151), wantCode: constants.ErrCodeBioTooLong},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assertValidation(t, validator.ValidateBio(tt.bio), tt.wantCode, tooLong)
		})
	}
}

func TestValidateNote(t *testing.T) {
	const tooLong = "Note must be 500 characters or less"
	tests := []struct {
		name     string
		note     *string
		wantCode string
	}{
		{name: "no note", note: nil},
		{name: "empty note", note: ptr("")},
		{name: "maximum length", note: ptr(strings.Repeat("n", 500))},
		{name: "too long", note: ptr(strings.Repeat("n", 501)), wantCode: constants.ErrCodeInvalidRequest},
		{name: "surrounding whitespace does not count", note: ptr("\t" + strings.Repeat("n", 500) + "  ")},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assertValidation(t, validator.ValidateNote(tt.note), tt.wantCode, tooLong)
		})
	}
}

func TestValidateNote_CountsCharactersNotBytes(t *testing.T) {
	const tooLong = "Note must be 500 characters or less"
	tests := []struct {
		name     string
		note     string
		wantCode string
	}{
		{name: "500 accented letters", note: strings.Repeat("ñ", 500)},
		{name: "500 emoji", note: strings.Repeat("📝", 500)},
		{name: "501 accented letters", note: strings.Repeat("ñ", 501), wantCode: constants.ErrCodeInvalidRequest},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assertValidation(t, validator.ValidateNote(&tt.note), tt.wantCode, tooLong)
		})
	}
}

func TestValidateCommentBody(t *testing.T) {
	tests := []struct {
		name     string
		body     string
		wantCode string
		wantMsg  string
	}{
		{name: "empty", body: "", wantCode: constants.ErrCodeCommentEmpty, wantMsg: "Comment cannot be empty"},
		{name: "only whitespace", body: " \n\t ", wantCode: constants.ErrCodeCommentEmpty, wantMsg: "Comment cannot be empty"},
		{name: "single character", body: "k"},
		{name: "maximum length", body: strings.Repeat("c", 200)},
		{name: "maximum length plus whitespace", body: "  " + strings.Repeat("c", 200) + "  "},
		{name: "too long", body: strings.Repeat("c", 201), wantCode: constants.ErrCodeCommentTooLong, wantMsg: "Comment must be 200 characters or less"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assertValidation(t, validator.ValidateCommentBody(tt.body), tt.wantCode, tt.wantMsg)
		})
	}
}

// The limit is 200 characters, as the message says: accented letters and emoji count once.
func TestValidateCommentBody_CountsCharactersNotBytes(t *testing.T) {
	const tooLong = "Comment must be 200 characters or less"
	tests := []struct {
		name     string
		body     string
		wantCode string
	}{
		{name: "200 accented letters", body: strings.Repeat("é", 200)},
		{name: "200 emoji", body: strings.Repeat("🔥", 200)},
		{name: "200 mixed characters", body: "Great day! " + strings.Repeat("ü", 189)},
		{name: "201 accented letters", body: strings.Repeat("é", 201), wantCode: constants.ErrCodeCommentTooLong},
		{name: "201 emoji", body: strings.Repeat("🔥", 201), wantCode: constants.ErrCodeCommentTooLong},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assertValidation(t, validator.ValidateCommentBody(tt.body), tt.wantCode, tooLong)
		})
	}
}

func mentions(n int) string {
	parts := make([]string, n)
	for i := range parts {
		parts[i] = fmt.Sprintf("@user%02d", i)
	}
	return strings.Join(parts, " ")
}

func TestParseMentions(t *testing.T) {
	tests := []struct {
		name string
		body string
		want []string
	}{
		{name: "no mentions", body: "Great progress today!", want: nil},
		{name: "empty body", body: "", want: nil},
		{name: "single mention", body: "nice one @john_doe!", want: []string{"john_doe"}},
		{name: "keeps first-seen order", body: "@zoe then @adam and @mia", want: []string{"zoe", "adam", "mia"}},
		{name: "deduplicates", body: "@john @john.doe @john", want: []string{"john", "john.doe"}},
		{name: "too short to be a username", body: "hi @ab", want: nil},
		{name: "bare at sign", body: "email me @ home", want: nil},
		{name: "uppercase is not a username", body: "@JOHN", want: nil},
		{name: "mentions next to punctuation", body: "(@alice),@bob;", want: []string{"alice", "bob"}},
		{name: "ten unique mentions is the maximum", body: mentions(10), want: strings.Fields(strings.ReplaceAll(mentions(10), "@", ""))},
		{name: "repeated mentions count once", body: mentions(10) + " " + mentions(10), want: strings.Fields(strings.ReplaceAll(mentions(10), "@", ""))},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := validator.ParseMentions(tt.body)
			assert.Nil(t, err)
			assert.Equal(t, tt.want, got)
		})
	}

	t.Run("more than ten unique mentions", func(t *testing.T) {
		got, err := validator.ParseMentions(mentions(11))
		assert.Nil(t, got)
		assertValidation(t, err, constants.ErrCodeTooManyMentions, "Too many mentions (max 10 per comment)")
	})
}

func TestValidateActivityHours(t *testing.T) {
	const invalid = "Duration hours must be between 0 and 24"
	tests := []struct {
		hours    float32
		wantCode string
	}{
		{hours: -0.25, wantCode: constants.ErrCodeInvalidRequest},
		{hours: 0},
		{hours: 0.5},
		{hours: 23.75},
		{hours: 24},
		{hours: 24.01, wantCode: constants.ErrCodeInvalidRequest},
		{hours: 100, wantCode: constants.ErrCodeInvalidRequest},
	}
	for _, tt := range tests {
		t.Run(fmt.Sprintf("%v hours", tt.hours), func(t *testing.T) {
			assertValidation(t, validator.ValidateActivityHours(tt.hours), tt.wantCode, invalid)
		})
	}
}

func TestValidateDateRange(t *testing.T) {
	tests := []struct {
		name       string
		start, end string
		wantCode   string
	}{
		{name: "ascending", start: "2026-01-01", end: "2026-01-31"},
		{name: "same day", start: "2026-03-09", end: "2026-03-09"},
		{name: "across years", start: "2025-12-31", end: "2026-01-01"},
		{name: "reversed", start: "2026-02-01", end: "2026-01-31", wantCode: constants.ErrCodeInvalidDateRange},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assertValidation(t, validator.ValidateDateRange(tt.start, tt.end), tt.wantCode, "Start date must be before end date")
		})
	}
}

func TestSanitizers(t *testing.T) {
	assert.Equal(t, "john_doe", validator.SanitizeUsername("  John_Doe \n"))
	assert.Equal(t, "", validator.SanitizeUsername("   "))

	assert.Equal(t, "John.Doe@Example.com", validator.SanitizeEmail("\tJohn.Doe@Example.com  "), "email case is preserved")

	assert.Equal(t, "Coffee | Code", validator.SanitizeBio("  Coffee | Code\n"))
	assert.Equal(t, "line one\nline two", validator.SanitizeBio("line one\nline two"), "inner whitespace is kept")
}

func TestPatterns(t *testing.T) {
	assert.True(t, validator.UsernamePattern.MatchString("a.b_c9"))
	assert.False(t, validator.UsernamePattern.MatchString("A"))
	assert.False(t, validator.UsernamePattern.MatchString(""))

	assert.Equal(t, []string{"@alice", "alice"}, validator.MentionPattern.FindStringSubmatch("hey @alice!"))
}

func ptr[T any](v T) *T { return &v }
