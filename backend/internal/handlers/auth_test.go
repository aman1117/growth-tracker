package handlers

import (
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/aman1117/backend/internal/config"
	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/dto"
	"github.com/aman1117/backend/internal/testutil"
	"github.com/aman1117/backend/pkg/models"
	"github.com/aman1117/backend/pkg/redis"
	"github.com/gofiber/fiber/v2"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/crypto/bcrypt"
)

func registerBody(email, username, password string) map[string]string {
	return map[string]string{"email": email, "username": username, "password": password}
}

func TestAuthHandler_Register_RejectsInvalidInput(t *testing.T) {
	env := newEnv(t)
	existing := env.user(t, withUsername("taken_name"))

	tests := []struct {
		name string
		body any
		opts []testutil.RequestOption
		code string
		msg  string
	}{
		{name: "malformed json", body: `{"email":`, code: constants.ErrCodeInvalidRequest, msg: "Invalid request body"},
		{name: "unsupported content type", body: []byte("email=a@b.c"),
			opts: []testutil.RequestOption{testutil.WithHeader("Content-Type", "text/plain")},
			code: constants.ErrCodeInvalidRequest, msg: "Invalid request body"},
		{name: "missing email", body: registerBody("", "newbie", "Password1"), code: constants.ErrCodeMissingFields, msg: "All fields are required"},
		{name: "missing username", body: registerBody("n@example.com", "", "Password1"), code: constants.ErrCodeMissingFields, msg: "All fields are required"},
		{name: "missing password", body: registerBody("n@example.com", "newbie", ""), code: constants.ErrCodeMissingFields, msg: "All fields are required"},
		{name: "blank password", body: registerBody("n@example.com", "newbie", "         "), code: constants.ErrCodeMissingFields, msg: "Password is required"},
		{name: "short password", body: registerBody("n@example.com", "newbie", "Short1"), code: constants.ErrCodePasswordTooShort},
		{name: "short username", body: registerBody("n@example.com", "ab", "Password1"), code: constants.ErrCodeInvalidUsernameLen},
		{name: "long username", body: registerBody("n@example.com", "abcdefghijklmnopqrstu", "Password1"), code: constants.ErrCodeInvalidUsernameLen},
		{name: "username with spaces", body: registerBody("n@example.com", "bad name", "Password1"), code: constants.ErrCodeInvalidUsernameFmt},
		{name: "unicode username", body: registerBody("n@example.com", "jürgen", "Password1"), code: constants.ErrCodeInvalidUsernameFmt},
		{name: "duplicate email", body: registerBody(existing.Email, "fresh_name", "Password1"), code: constants.ErrCodeUserExists,
			msg: "Could not create user (maybe email/username already used)"},
		{name: "duplicate username", body: registerBody("other@example.com", "TAKEN_NAME", "Password1"), code: constants.ErrCodeUserExists},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			res := env.do(t, nil, http.MethodPost, "/api/register", tc.body, tc.opts...)
			e := assertError(t, res, http.StatusBadRequest, tc.code)
			if tc.msg != "" {
				assert.Equal(t, tc.msg, e.Error)
			}
		})
	}

	assert.EqualValues(t, 1, count(t, env.db, &models.User{}, ""), "no user may be created by a rejected request")
}

func TestAuthHandler_Register_CreatesNormalisedUser(t *testing.T) {
	env := newEnv(t)

	res := env.do(t, nil, http.MethodPost, "/api/register", registerBody("  new@example.com ", "  New_User.1 ", "Secret123"))
	assertSuccessMessage(t, res, http.StatusCreated, constants.MsgUserCreated)

	var user models.User
	require.NoError(t, env.db.Where("username = ?", "new_user.1").First(&user).Error)
	assert.Equal(t, "new@example.com", user.Email)
	assert.False(t, user.EmailVerified)
	assert.False(t, user.IsPrivate)
	assert.NoError(t, bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte("Secret123")))
	assert.EqualValues(t, 1, count(t, env.db, &models.FollowCounter{}, "user_id = ?", user.ID))
}

func TestAuthHandler_Register_SendsVerificationEmail(t *testing.T) {
	env := newEnv(t)
	mr := testutil.StartRedis(t)
	smtp := newFakeSMTP(t, false)
	logs := observeLogs(t)
	h := &handlerSet{
		auth:         NewAuthHandler(env.authSvc, env.tokenSvc, env.profileSvc, newEmailService(t, smtp, env.cfg)),
		verification: env.h.verification,
	}

	res := call(t, h, nil, http.MethodPost, "/api/register", registerBody("fresh@example.com", "fresh_user", "Secret123"))
	assertSuccessMessage(t, res, http.StatusCreated, constants.MsgUserCreated)

	mail := smtp.waitMail(t)
	assert.Contains(t, mail, "To: fresh@example.com")
	assert.Contains(t, mail, "Subject: Verify Your Email - Growth Tracker")
	assert.Contains(t, mail, env.cfg.Server.FrontendURL+"/verify-email?token=")
	token := tokenFromMail(t, mail)
	waitLog(t, logs, "Verification email sent for new user")

	var user models.User
	require.NoError(t, env.db.Where("email = ?", "fresh@example.com").First(&user).Error)
	stored, err := mr.Get(constants.VerifyTokenPrefix + redis.HashToken(token))
	require.NoError(t, err, "only the token hash is stored")
	assert.Equal(t, fmt.Sprint(user.ID), stored)
	assert.InDelta(t, constants.VerifyTokenTTL.Seconds(), mr.TTL(constants.VerifyTokenPrefix+redis.HashToken(token)).Seconds(), 1)

	// The emailed link verifies the account.
	res = call(t, h, nil, http.MethodPost, "/api/auth/verify-email", map[string]string{"token": token})
	require.Equal(t, http.StatusOK, res.Status, "body: %s", res.Body)
	require.NoError(t, env.db.First(&user, user.ID).Error)
	assert.True(t, user.EmailVerified)
}

func TestAuthHandler_Register_VerificationEmailFailuresDoNotFailRegistration(t *testing.T) {
	env := newEnv(t)

	t.Run("redis unavailable", func(t *testing.T) {
		smtp := newFakeSMTP(t, false)
		logs := observeLogs(t)
		h := &handlerSet{auth: NewAuthHandler(env.authSvc, env.tokenSvc, env.profileSvc, newEmailService(t, smtp, env.cfg))}

		res := call(t, h, nil, http.MethodPost, "/api/register", registerBody("noredis@example.com", "no_redis", "Secret123"))

		assertSuccessMessage(t, res, http.StatusCreated, constants.MsgUserCreated)
		waitLog(t, logs, "Failed to store verify token during registration")
		smtp.assertNoMail(t)
	})

	t.Run("smtp rejects the message", func(t *testing.T) {
		testutil.StartRedis(t)
		smtp := newFakeSMTP(t, true)
		logs := observeLogs(t)
		h := &handlerSet{auth: NewAuthHandler(env.authSvc, env.tokenSvc, env.profileSvc, newEmailService(t, smtp, env.cfg))}

		res := call(t, h, nil, http.MethodPost, "/api/register", registerBody("rejected@example.com", "rejected", "Secret123"))

		assertSuccessMessage(t, res, http.StatusCreated, constants.MsgUserCreated)
		waitLog(t, logs, "Failed to send verification email during registration")
	})

	assert.EqualValues(t, 2, count(t, env.db, &models.User{}, ""))
}

func TestAuthHandler_Login(t *testing.T) {
	env := newEnv(t)
	user := env.user(t)

	t.Run("rejects invalid requests", func(t *testing.T) {
		tests := []struct {
			name string
			body any
			code string
			msg  string
		}{
			{"malformed json", `{"identifier"`, constants.ErrCodeInvalidRequest, "Invalid request body"},
			{"missing identifier", map[string]string{"password": testutil.TestPassword}, constants.ErrCodeMissingFields, "All fields are required"},
			{"missing password", map[string]string{"identifier": user.Username}, constants.ErrCodeMissingFields, "All fields are required"},
			{"unknown user", map[string]string{"identifier": "nobody", "password": testutil.TestPassword}, constants.ErrCodeInvalidCredentials, "Invalid credentials"},
			{"wrong password", map[string]string{"identifier": user.Username, "password": "Wrong123!"}, constants.ErrCodeInvalidPassword, "Invalid password"},
		}
		for _, tc := range tests {
			t.Run(tc.name, func(t *testing.T) {
				res := env.do(t, nil, http.MethodPost, "/api/login", tc.body)
				assertErrorMessage(t, res, http.StatusBadRequest, tc.code, tc.msg)
			})
		}
	})

	for _, identifier := range []string{user.Username, user.Email} {
		t.Run("returns a bearer token for "+identifier, func(t *testing.T) {
			before := time.Now()
			res := env.do(t, nil, http.MethodPost, "/api/login", map[string]string{"identifier": identifier, "password": testutil.TestPassword})

			login := decodeAs[dto.LoginResponse](t, res, http.StatusOK)
			assert.True(t, login.Success)
			assert.Equal(t, "Bearer", login.TokenType)
			assert.Equal(t, int(env.cfg.JWT.AccessTokenTTL.Seconds()), login.ExpiresIn)
			expiresAt, err := time.Parse(time.RFC3339, login.ExpiresAt)
			require.NoError(t, err)
			assert.WithinDuration(t, before.Add(env.cfg.JWT.AccessTokenTTL), expiresAt, 5*time.Second)

			claims, err := env.tokenSvc.Parse(login.AccessToken)
			require.NoError(t, err)
			assert.Equal(t, user.ID, claims.UserID)
			assert.Equal(t, user.Username, claims.Username)
		})
	}
}

func TestAuthHandler_Login_TokenGenerationFailure(t *testing.T) {
	env := newEnv(t)
	user := env.user(t)
	h := &handlerSet{auth: NewAuthHandler(env.authSvc, NewTokenService(&config.JWTConfig{AccessTokenTTL: time.Hour}), env.profileSvc, nil)}

	res := call(t, h, nil, http.MethodPost, "/api/login", map[string]string{"identifier": user.Username, "password": testutil.TestPassword})

	assertErrorMessage(t, res, http.StatusBadRequest, constants.ErrCodeTokenGenFailed, "Failed to generate token")
}

func TestAuthHandler_Login_DatabaseFailureIsReportedAsInvalidPassword(t *testing.T) {
	broken := brokenStack(t)

	res := call(t, broken.handlers(), nil, http.MethodPost, "/api/login", map[string]string{"identifier": "someone", "password": "Secret123"})

	assertErrorMessage(t, res, http.StatusBadRequest, constants.ErrCodeInvalidPassword, "Invalid password")
}

func TestAuthHandler_UpdateUsername(t *testing.T) {
	env := newEnv(t)
	user := env.user(t)
	other := env.user(t, withUsername("already_taken"))

	tests := []struct {
		name string
		body any
		code string
		msg  string
	}{
		{"malformed json", `{"new_username":`, constants.ErrCodeInvalidRequest, "Invalid request body"},
		{"blank username", map[string]string{"new_username": "   "}, constants.ErrCodeMissingFields, "Username is required"},
		{"too long", map[string]string{"new_username": "abcdefghijklmnopqrstu"}, constants.ErrCodeInvalidUsernameLen, ""},
		{"invalid characters", map[string]string{"new_username": "no-dashes"}, constants.ErrCodeInvalidUsernameFmt, ""},
		{"taken", map[string]string{"new_username": other.Username}, constants.ErrCodeUsernameTaken, "Username already taken or update failed"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			res := env.do(t, user, http.MethodPost, "/api/update-username", tc.body)
			e := assertError(t, res, http.StatusBadRequest, tc.code)
			if tc.msg != "" {
				assert.Equal(t, tc.msg, e.Error)
			}
		})
	}

	t.Run("normalises and saves the new username", func(t *testing.T) {
		res := env.do(t, user, http.MethodPost, "/api/update-username", map[string]string{"new_username": "  Fresh.Name_1 "})

		got := decodeAs[dto.UsernameUpdateResponse](t, res, http.StatusOK)
		assert.Equal(t, dto.UsernameUpdateResponse{Success: true, Message: constants.MsgUsernameUpdated, NewUsername: "fresh.name_1"}, got)
		var stored models.User
		require.NoError(t, env.db.First(&stored, user.ID).Error)
		assert.Equal(t, "fresh.name_1", stored.Username)
	})
}

func TestAuthHandler_ChangePassword(t *testing.T) {
	env := newEnv(t)
	user := env.user(t)

	tests := []struct {
		name string
		body any
		code string
		msg  string
	}{
		{"malformed json", `{"current_password":`, constants.ErrCodeInvalidRequest, "Invalid request body"},
		{"missing current password", map[string]string{"new_password": "NewPass123"}, constants.ErrCodeMissingFields, "All fields are required"},
		{"missing new password", map[string]string{"current_password": testutil.TestPassword}, constants.ErrCodeMissingFields, "All fields are required"},
		{"short new password", map[string]string{"current_password": testutil.TestPassword, "new_password": "short"}, constants.ErrCodePasswordTooShort, ""},
		{"wrong current password", map[string]string{"current_password": "Nope12345", "new_password": "NewPass123"}, constants.ErrCodeInvalidPassword, "Current password is incorrect"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			res := env.do(t, user, http.MethodPost, "/api/change-password", tc.body)
			e := assertError(t, res, http.StatusBadRequest, tc.code)
			if tc.msg != "" {
				assert.Equal(t, tc.msg, e.Error)
			}
		})
	}

	t.Run("changes the password", func(t *testing.T) {
		res := env.do(t, user, http.MethodPost, "/api/change-password",
			map[string]string{"current_password": testutil.TestPassword, "new_password": "BrandNew123"})
		assertSuccessMessage(t, res, http.StatusOK, constants.MsgPasswordChanged)

		res = env.do(t, nil, http.MethodPost, "/api/login", map[string]string{"identifier": user.Username, "password": "BrandNew123"})
		assert.Equal(t, http.StatusOK, res.Status)
		res = env.do(t, nil, http.MethodPost, "/api/login", map[string]string{"identifier": user.Username, "password": testutil.TestPassword})
		assertError(t, res, http.StatusBadRequest, constants.ErrCodeInvalidPassword)
	})

	t.Run("unknown user", func(t *testing.T) {
		ghost := &models.User{ID: 9999, Username: "ghost"}
		res := env.do(t, ghost, http.MethodPost, "/api/change-password",
			map[string]string{"current_password": testutil.TestPassword, "new_password": "BrandNew123"})
		assertErrorMessage(t, res, http.StatusInternalServerError, constants.ErrCodeUpdateFailed, "Failed to update password")
	})
}

func TestAuthHandler_ChangePassword_UpdateFailure(t *testing.T) {
	env := newEnv(t)
	user := env.user(t)
	faulty := newStack(faultyDB(t, failOn("update", "users")), env.cfg, false)

	res := call(t, faulty.handlers(), user, http.MethodPost, "/api/change-password",
		map[string]string{"current_password": testutil.TestPassword, "new_password": "BrandNew123"})

	assertErrorMessage(t, res, http.StatusInternalServerError, constants.ErrCodeUpdateFailed, "Failed to update password")
	var stored models.User
	require.NoError(t, env.db.First(&stored, user.ID).Error)
	assert.NoError(t, bcrypt.CompareHashAndPassword([]byte(stored.PasswordHash), []byte(testutil.TestPassword)), "password must be unchanged")
}

func TestHandlerContextHelpers(t *testing.T) {
	type locals struct {
		ID    uint   `json:"id"`
		Alt   uint   `json:"alt"`
		Name  string `json:"name"`
		Trace string `json:"trace"`
	}
	app := fiber.New()
	app.Get("/ctx", func(c *fiber.Ctx) error {
		switch c.Query("set") {
		case "all":
			c.Locals("user_id", uint(7))
			c.Locals("username", "seven")
			c.Locals("trace_id", "abc12345")
		case "wrong-types":
			c.Locals("user_id", 7)
			c.Locals("username", 7)
			c.Locals("trace_id", 7)
		}
		return c.JSON(locals{ID: getUserID(c), Alt: getUserIDFromContext(c), Name: getUsername(c), Trace: getTraceID(c)})
	})

	tests := map[string]locals{
		"all":         {ID: 7, Alt: 7, Name: "seven", Trace: "abc12345"},
		"wrong-types": {},
		"none":        {},
	}
	for set, want := range tests {
		t.Run(set, func(t *testing.T) {
			res := testutil.Do(t, app, http.MethodGet, "/ctx?set="+set, nil)
			assert.Equal(t, want, decodeAs[locals](t, res, http.StatusOK))
		})
	}
}
