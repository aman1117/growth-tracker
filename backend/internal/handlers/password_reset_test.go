package handlers

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/testutil"
	"github.com/aman1117/backend/pkg/redis"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

var genericForgotResponse = map[string]any{"success": true, "message": constants.MsgPasswordResetSent}

func resetKeys(mr *miniredis.Miniredis) []string {
	var keys []string
	for _, k := range mr.Keys() {
		if strings.HasPrefix(k, constants.ResetTokenPrefix) {
			keys = append(keys, k)
		}
	}
	return keys
}

// storeResetToken issues a reset token for userID the way ForgotPassword does.
func storeResetToken(t *testing.T, userID uint) string {
	t.Helper()
	raw, hash, err := redis.GenerateResetToken()
	require.NoError(t, err)
	require.NoError(t, redis.StoreResetToken(context.Background(), hash, userID))
	return raw
}

func resetBody(token, password, confirm string) map[string]string {
	return map[string]string{"token": token, "new_password": password, "confirm_password": confirm}
}

func TestPasswordResetHandler_ForgotPassword_SameResponseForEveryEmail(t *testing.T) {
	env := newEnv(t)
	mr := testutil.StartRedis(t)
	smtp := newFakeSMTP(t, false)
	user := env.user(t)
	h := &handlerSet{
		auth:          env.h.auth,
		passwordReset: NewPasswordResetHandler(env.authSvc, newEmailService(t, smtp, env.cfg)),
	}

	for name, body := range map[string]any{
		"malformed json": `{"email":`,
		"empty email":    map[string]string{"email": ""},
		"unknown email":  map[string]string{"email": "nobody@example.com"},
	} {
		t.Run(name, func(t *testing.T) {
			res := call(t, h, nil, http.MethodPost, "/api/auth/forgot-password", body)
			require.Equal(t, http.StatusOK, res.Status)
			assert.Equal(t, genericForgotResponse, res.JSON(t))
			assert.Empty(t, resetKeys(mr))
			smtp.assertNoMail(t)
		})
	}

	t.Run("known email gets a single-use reset link", func(t *testing.T) {
		res := call(t, h, nil, http.MethodPost, "/api/auth/forgot-password", map[string]string{"email": user.Email})
		require.Equal(t, http.StatusOK, res.Status)
		assert.Equal(t, genericForgotResponse, res.JSON(t))

		mail := smtp.waitMail(t)
		assert.Contains(t, mail, "To: "+user.Email)
		assert.Contains(t, mail, "Subject: Reset Your Password - Growth Tracker")
		token := tokenFromMail(t, mail)
		key := constants.ResetTokenPrefix + redis.HashToken(token)
		assert.Equal(t, []string{key}, resetKeys(mr), "only the token hash is stored")
		stored, err := mr.Get(key)
		require.NoError(t, err)
		assert.Equal(t, fmt.Sprint(user.ID), stored)
		assert.Equal(t, constants.ResetTokenTTL, mr.TTL(key))

		res = call(t, h, nil, http.MethodGet, "/api/auth/reset-password/validate?token="+token, nil)
		assert.Equal(t, map[string]any{"success": true, "valid": true}, res.JSON(t))

		res = call(t, h, nil, http.MethodPost, "/api/auth/reset-password", resetBody(token, "Fresh1234", "Fresh1234"))
		assertSuccessMessage(t, res, http.StatusOK, constants.MsgPasswordReset)
		res = call(t, h, nil, http.MethodPost, "/api/login", map[string]string{"identifier": user.Email, "password": "Fresh1234"})
		assert.Equal(t, http.StatusOK, res.Status, "the new password works")
	})
}

func TestPasswordResetHandler_ForgotPassword_HidesDeliveryFailures(t *testing.T) {
	env := newEnv(t)
	user := env.user(t)
	body := map[string]string{"email": user.Email}

	t.Run("redis unavailable", func(t *testing.T) {
		smtp := newFakeSMTP(t, false)
		h := &handlerSet{passwordReset: NewPasswordResetHandler(env.authSvc, newEmailService(t, smtp, env.cfg))}

		res := call(t, h, nil, http.MethodPost, "/api/auth/forgot-password", body)

		require.Equal(t, http.StatusOK, res.Status)
		assert.Equal(t, genericForgotResponse, res.JSON(t))
		smtp.assertNoMail(t)
	})

	t.Run("email service not configured", func(t *testing.T) {
		mr := testutil.StartRedis(t)

		res := env.do(t, nil, http.MethodPost, "/api/auth/forgot-password", body)

		require.Equal(t, http.StatusOK, res.Status)
		assert.Equal(t, genericForgotResponse, res.JSON(t))
		assert.Len(t, resetKeys(mr), 1, "the token is still issued")
	})

	t.Run("smtp rejects the message", func(t *testing.T) {
		mr := testutil.StartRedis(t)
		smtp := newFakeSMTP(t, true)
		h := &handlerSet{passwordReset: NewPasswordResetHandler(env.authSvc, newEmailService(t, smtp, env.cfg))}

		res := call(t, h, nil, http.MethodPost, "/api/auth/forgot-password", body)

		require.Equal(t, http.StatusOK, res.Status)
		assert.Equal(t, genericForgotResponse, res.JSON(t))
		assert.Len(t, resetKeys(mr), 1)
	})

	t.Run("database failure", func(t *testing.T) {
		mr := testutil.StartRedis(t)

		res := call(t, brokenStack(t).handlers(), nil, http.MethodPost, "/api/auth/forgot-password", body)

		require.Equal(t, http.StatusOK, res.Status)
		assert.Equal(t, genericForgotResponse, res.JSON(t))
		assert.Empty(t, resetKeys(mr))
	})
}

func TestPasswordResetHandler_ResetPassword_Validation(t *testing.T) {
	env := newEnv(t)

	tests := []struct {
		name   string
		body   any
		status int
		code   string
		msg    string
	}{
		{"malformed json", `{"token":`, http.StatusBadRequest, constants.ErrCodeInvalidRequest, "Invalid request body"},
		{"missing token", resetBody("", "Fresh1234", "Fresh1234"), http.StatusBadRequest, constants.ErrCodeMissingToken, "Reset token is required"},
		{"passwords differ", resetBody("tok", "Fresh1234", "Fresh12345"), http.StatusBadRequest, constants.ErrCodePasswordMismatch, "Passwords do not match"},
		{"too short", resetBody("tok", "Ab1", "Ab1"), http.StatusBadRequest, constants.ErrCodePasswordTooShort, "Password must be at least 8 characters long"},
		{"no number", resetBody("tok", "OnlyLetters", "OnlyLetters"), http.StatusBadRequest, constants.ErrCodeWeakPassword, "Password must contain at least one number"},
		{"no letter", resetBody("tok", "12345678", "12345678"), http.StatusBadRequest, constants.ErrCodeWeakPassword, "Password must contain at least one letter"},
		{"redis unavailable", resetBody("tok", "Fresh1234", "Fresh1234"), http.StatusInternalServerError, constants.ErrCodeServerError, "An error occurred. Please try again."},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			res := env.do(t, nil, http.MethodPost, "/api/auth/reset-password", tc.body)
			assertErrorMessage(t, res, tc.status, tc.code, tc.msg)
		})
	}
}

func TestPasswordResetHandler_ResetPassword_Tokens(t *testing.T) {
	env := newEnv(t)
	mr := testutil.StartRedis(t)
	user := env.user(t)

	t.Run("unknown token", func(t *testing.T) {
		res := env.do(t, nil, http.MethodPost, "/api/auth/reset-password", resetBody("deadbeef", "Fresh1234", "Fresh1234"))
		assertErrorMessage(t, res, http.StatusBadRequest, constants.ErrCodeInvalidResetToken, "Invalid or expired reset token")
	})

	t.Run("token works exactly once", func(t *testing.T) {
		token := storeResetToken(t, user.ID)

		res := env.do(t, nil, http.MethodPost, "/api/auth/reset-password", resetBody(token, "Fresh1234", "Fresh1234"))
		assertSuccessMessage(t, res, http.StatusOK, constants.MsgPasswordReset)
		assert.Empty(t, resetKeys(mr))

		res = env.do(t, nil, http.MethodPost, "/api/login", map[string]string{"identifier": user.Username, "password": "Fresh1234"})
		assert.Equal(t, http.StatusOK, res.Status)

		res = env.do(t, nil, http.MethodPost, "/api/auth/reset-password", resetBody(token, "Other1234", "Other1234"))
		assertError(t, res, http.StatusBadRequest, constants.ErrCodeInvalidResetToken)
	})

	t.Run("expired token", func(t *testing.T) {
		token := storeResetToken(t, user.ID)
		mr.FastForward(constants.ResetTokenTTL + time.Second)

		res := env.do(t, nil, http.MethodPost, "/api/auth/reset-password", resetBody(token, "Fresh1234", "Fresh1234"))
		assertError(t, res, http.StatusBadRequest, constants.ErrCodeInvalidResetToken)
	})

	t.Run("redis error", func(t *testing.T) {
		token := storeResetToken(t, user.ID)
		mr.SetError("ERR boom")
		defer mr.SetError("")

		res := env.do(t, nil, http.MethodPost, "/api/auth/reset-password", resetBody(token, "Fresh1234", "Fresh1234"))
		assertError(t, res, http.StatusInternalServerError, constants.ErrCodeServerError)
	})
}

func TestPasswordResetHandler_ResetPassword_UpdateFailure(t *testing.T) {
	mr := testutil.StartRedis(t)
	token := storeResetToken(t, 1)

	res := call(t, brokenStack(t).handlers(), nil, http.MethodPost, "/api/auth/reset-password", resetBody(token, "Fresh1234", "Fresh1234"))

	assertErrorMessage(t, res, http.StatusInternalServerError, constants.ErrCodeUpdateFailed, "Failed to update password")
	assert.Empty(t, resetKeys(mr), "the token is consumed before the update")
}

func TestPasswordResetHandler_ValidateResetToken(t *testing.T) {
	env := newEnv(t)
	invalid := map[string]any{"success": true, "valid": false}

	t.Run("missing token", func(t *testing.T) {
		res := env.do(t, nil, http.MethodGet, "/api/auth/reset-password/validate", nil)
		require.Equal(t, http.StatusOK, res.Status)
		assert.Equal(t, invalid, res.JSON(t))
	})

	t.Run("redis unavailable", func(t *testing.T) {
		res := env.do(t, nil, http.MethodGet, "/api/auth/reset-password/validate?token=abc", nil)
		require.Equal(t, http.StatusOK, res.Status)
		assert.Equal(t, invalid, res.JSON(t))
	})

	t.Run("checks without consuming", func(t *testing.T) {
		mr := testutil.StartRedis(t)
		token := storeResetToken(t, 3)

		res := env.do(t, nil, http.MethodGet, "/api/auth/reset-password/validate?token=unknown", nil)
		assert.Equal(t, invalid, res.JSON(t))

		for i := 0; i < 2; i++ {
			res = env.do(t, nil, http.MethodGet, "/api/auth/reset-password/validate?token="+token, nil)
			assert.Equal(t, map[string]any{"success": true, "valid": true}, res.JSON(t))
		}
		assert.Len(t, resetKeys(mr), 1)
	})
}
