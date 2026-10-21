package handlers

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/alicebob/miniredis/v2"
	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/testutil"
	"github.com/aman1117/backend/pkg/models"
	"github.com/aman1117/backend/pkg/redis"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// storeVerifyToken issues an email verification token for userID.
func storeVerifyToken(t *testing.T, userID uint) string {
	t.Helper()
	raw, hash, err := redis.GenerateVerifyToken()
	require.NoError(t, err)
	require.NoError(t, redis.StoreVerifyToken(context.Background(), hash, userID))
	return raw
}

func verifyKeys(mr *miniredis.Miniredis) []string {
	var keys []string
	for _, k := range mr.Keys() {
		if strings.HasPrefix(k, constants.VerifyTokenPrefix) {
			keys = append(keys, k)
		}
	}
	return keys
}

func cooldownKey(userID uint) string {
	return fmt.Sprintf("%s%d", constants.VerifyResendPrefix, userID)
}

func TestVerificationHandler_VerifyEmail_RejectsInvalidRequests(t *testing.T) {
	env := newEnv(t)

	t.Run("malformed json", func(t *testing.T) {
		res := env.do(t, nil, http.MethodPost, "/api/auth/verify-email", `{"token":`)
		assertErrorMessage(t, res, http.StatusBadRequest, constants.ErrCodeInvalidRequest, "Invalid request body")
	})
	t.Run("missing token", func(t *testing.T) {
		res := env.do(t, nil, http.MethodPost, "/api/auth/verify-email", map[string]string{"token": ""})
		assertErrorMessage(t, res, http.StatusBadRequest, constants.ErrCodeMissingToken, "Verification token is required")
	})
	t.Run("redis unavailable", func(t *testing.T) {
		res := env.do(t, nil, http.MethodPost, "/api/auth/verify-email", map[string]string{"token": "abc"})
		assertErrorMessage(t, res, http.StatusInternalServerError, constants.ErrCodeServerError, "An error occurred. Please try again.")
	})
}

func TestVerificationHandler_VerifyEmail_Tokens(t *testing.T) {
	env := newEnv(t)
	mr := testutil.StartRedis(t)
	unverified := env.user(t)
	setUnverifiedEmail(t, env.db, unverified)
	alreadyVerified := env.user(t)

	t.Run("verifies the email once", func(t *testing.T) {
		token := storeVerifyToken(t, unverified.ID)

		res := env.do(t, nil, http.MethodPost, "/api/auth/verify-email", map[string]string{"token": token})
		require.Equal(t, http.StatusOK, res.Status)
		assert.Equal(t, map[string]any{"success": true, "message": constants.MsgEmailVerified}, res.JSON(t))

		var stored models.User
		require.NoError(t, env.db.First(&stored, unverified.ID).Error)
		assert.True(t, stored.EmailVerified)
		assert.Empty(t, verifyKeys(mr), "the token is single-use")

		res = env.do(t, nil, http.MethodPost, "/api/auth/verify-email", map[string]string{"token": token})
		assertErrorMessage(t, res, http.StatusBadRequest, constants.ErrCodeInvalidVerifyToken, "Invalid or expired verification link")
	})

	t.Run("already verified is idempotent", func(t *testing.T) {
		token := storeVerifyToken(t, alreadyVerified.ID)

		res := env.do(t, nil, http.MethodPost, "/api/auth/verify-email", map[string]string{"token": token})

		require.Equal(t, http.StatusOK, res.Status)
		assert.Equal(t, map[string]any{"success": true, "message": constants.MsgEmailVerified, "already_verified": true}, res.JSON(t))
	})

	t.Run("expired token", func(t *testing.T) {
		token := storeVerifyToken(t, unverified.ID)
		mr.FastForward(constants.VerifyTokenTTL)

		res := env.do(t, nil, http.MethodPost, "/api/auth/verify-email", map[string]string{"token": token})
		assertError(t, res, http.StatusBadRequest, constants.ErrCodeInvalidVerifyToken)
	})

	t.Run("deleted user", func(t *testing.T) {
		token := storeVerifyToken(t, 9999)

		res := env.do(t, nil, http.MethodPost, "/api/auth/verify-email", map[string]string{"token": token})
		assertErrorMessage(t, res, http.StatusBadRequest, constants.ErrCodeUserNotFound, "User not found")
	})

	t.Run("corrupt token value", func(t *testing.T) {
		token := storeVerifyToken(t, unverified.ID)
		require.NoError(t, mr.Set(constants.VerifyTokenPrefix+redis.HashToken(token), "not-a-number"))

		res := env.do(t, nil, http.MethodPost, "/api/auth/verify-email", map[string]string{"token": token})
		assertError(t, res, http.StatusInternalServerError, constants.ErrCodeServerError)
	})
}

func TestVerificationHandler_VerifyEmail_DatabaseFailures(t *testing.T) {
	env := newEnv(t)
	testutil.StartRedis(t)
	user := env.user(t)
	setUnverifiedEmail(t, env.db, user)

	t.Run("user lookup fails", func(t *testing.T) {
		h := &handlerSet{verification: NewVerificationHandler(brokenStack(t).userRepo, nil)}
		res := call(t, h, nil, http.MethodPost, "/api/auth/verify-email", map[string]string{"token": storeVerifyToken(t, user.ID)})
		assertError(t, res, http.StatusInternalServerError, constants.ErrCodeServerError)
	})

	t.Run("update fails", func(t *testing.T) {
		faulty := newStack(faultyDB(t, failOn("update", "users")), env.cfg, false)
		h := &handlerSet{verification: NewVerificationHandler(faulty.userRepo, nil)}

		res := call(t, h, nil, http.MethodPost, "/api/auth/verify-email", map[string]string{"token": storeVerifyToken(t, user.ID)})

		assertErrorMessage(t, res, http.StatusInternalServerError, constants.ErrCodeUpdateFailed, "Failed to verify email")
		var stored models.User
		require.NoError(t, env.db.First(&stored, user.ID).Error)
		assert.False(t, stored.EmailVerified)
	})
}

func TestVerificationHandler_ResendVerificationEmail(t *testing.T) {
	env := newEnv(t)
	mr := testutil.StartRedis(t)
	smtp := newFakeSMTP(t, false)
	h := &handlerSet{verification: NewVerificationHandler(env.userRepo, newEmailService(t, smtp, env.cfg))}
	unverified := env.user(t)
	setUnverifiedEmail(t, env.db, unverified)
	alreadyVerified := env.user(t)

	t.Run("unknown user", func(t *testing.T) {
		res := call(t, h, &models.User{ID: 9999, Username: "ghost"}, http.MethodPost, "/api/auth/resend-verification", nil)
		assertErrorMessage(t, res, http.StatusBadRequest, constants.ErrCodeUserNotFound, "User not found")
	})

	t.Run("already verified", func(t *testing.T) {
		res := call(t, h, alreadyVerified, http.MethodPost, "/api/auth/resend-verification", nil)
		assertErrorMessage(t, res, http.StatusBadRequest, constants.ErrCodeAlreadyVerified, "Email is already verified")
		smtp.assertNoMail(t)
	})

	t.Run("sends a fresh link and starts a cooldown", func(t *testing.T) {
		res := call(t, h, unverified, http.MethodPost, "/api/auth/resend-verification", nil)
		assertSuccessMessage(t, res, http.StatusOK, constants.MsgVerificationEmailSent)

		mail := smtp.waitMail(t)
		assert.Contains(t, mail, "To: "+unverified.Email)
		token := tokenFromMail(t, mail)
		assert.Equal(t, []string{constants.VerifyTokenPrefix + redis.HashToken(token)}, verifyKeys(mr))
		assert.Equal(t, constants.VerifyResendCooldown, mr.TTL(cooldownKey(unverified.ID)))
	})

	t.Run("rejects requests during the cooldown", func(t *testing.T) {
		res := call(t, h, unverified, http.MethodPost, "/api/auth/resend-verification", nil)
		assertErrorMessage(t, res, http.StatusBadRequest, constants.ErrCodeVerifyResendCooldown,
			"Please wait before requesting another verification email")
		smtp.assertNoMail(t)
	})

	t.Run("allows a new request after the cooldown", func(t *testing.T) {
		mr.FastForward(constants.VerifyResendCooldown)

		res := call(t, h, unverified, http.MethodPost, "/api/auth/resend-verification", nil)

		assertSuccessMessage(t, res, http.StatusOK, constants.MsgVerificationEmailSent)
		smtp.waitMail(t)
	})
}

func TestVerificationHandler_ResendVerificationEmail_Failures(t *testing.T) {
	env := newEnv(t)
	user := env.user(t)
	setUnverifiedEmail(t, env.db, user)
	resend := func(t *testing.T, h *handlerSet) testutil.Response {
		return call(t, h, user, http.MethodPost, "/api/auth/resend-verification", nil)
	}

	t.Run("user lookup fails", func(t *testing.T) {
		h := &handlerSet{verification: NewVerificationHandler(brokenStack(t).userRepo, nil)}
		assertError(t, resend(t, h), http.StatusInternalServerError, constants.ErrCodeServerError)
	})

	t.Run("redis unavailable", func(t *testing.T) {
		assertError(t, resend(t, env.h), http.StatusInternalServerError, constants.ErrCodeServerError)
	})

	t.Run("smtp rejects the message", func(t *testing.T) {
		testutil.StartRedis(t)
		h := &handlerSet{verification: NewVerificationHandler(env.userRepo, newEmailService(t, newFakeSMTP(t, true), env.cfg))}

		assertErrorMessage(t, resend(t, h), http.StatusInternalServerError, constants.ErrCodeServerError, "Failed to send verification email")
	})

	t.Run("email service not configured", func(t *testing.T) {
		mr := testutil.StartRedis(t)

		assertSuccessMessage(t, resend(t, env.h), http.StatusOK, constants.MsgVerificationEmailSent)
		assert.Len(t, verifyKeys(mr), 1)
	})

	t.Run("cooldown cannot be recorded", func(t *testing.T) {
		mr := testutil.StartRedis(t)
		failRedisCommand(mr, "SET", constants.VerifyResendPrefix)
		smtp := newFakeSMTP(t, false)
		h := &handlerSet{verification: NewVerificationHandler(env.userRepo, newEmailService(t, smtp, env.cfg))}

		assertSuccessMessage(t, resend(t, h), http.StatusOK, constants.MsgVerificationEmailSent)
		smtp.waitMail(t)
		assert.False(t, mr.Exists(cooldownKey(user.ID)))
	})
}

func TestVerificationHandler_SendVerificationEmailForUser(t *testing.T) {
	ctx := context.Background()

	t.Run("redis unavailable", func(t *testing.T) {
		err := NewVerificationHandler(nil, nil).SendVerificationEmailForUser(ctx, 5, "five@example.com", "five")
		assert.Error(t, err)
	})

	t.Run("stores the token and emails the link", func(t *testing.T) {
		mr := testutil.StartRedis(t)
		smtp := newFakeSMTP(t, false)
		h := NewVerificationHandler(nil, newEmailService(t, smtp, testutil.Config()))

		require.NoError(t, h.SendVerificationEmailForUser(ctx, 5, "five@example.com", "five"))

		mail := smtp.waitMail(t)
		assert.Contains(t, mail, "Hi <strong>five</strong>")
		stored, err := mr.Get(constants.VerifyTokenPrefix + redis.HashToken(tokenFromMail(t, mail)))
		require.NoError(t, err)
		assert.Equal(t, "5", stored)
	})

	t.Run("without an email service", func(t *testing.T) {
		mr := testutil.StartRedis(t)

		require.NoError(t, NewVerificationHandler(nil, nil).SendVerificationEmailForUser(ctx, 5, "five@example.com", "five"))
		assert.Len(t, verifyKeys(mr), 1)
	})

	t.Run("smtp failure", func(t *testing.T) {
		testutil.StartRedis(t)
		h := NewVerificationHandler(nil, newEmailService(t, newFakeSMTP(t, true), testutil.Config()))

		assert.Error(t, h.SendVerificationEmailForUser(ctx, 5, "five@example.com", "five"))
	})
}
