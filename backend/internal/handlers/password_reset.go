package handlers

import (
	"context"
	"time"

	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/dto"
	"github.com/aman1117/backend/internal/logger"
	"github.com/aman1117/backend/internal/response"
	"github.com/aman1117/backend/internal/services"
	"github.com/aman1117/backend/internal/validator"
	"github.com/aman1117/backend/pkg/redis"
	"github.com/gofiber/fiber/v2"
)

// PasswordResetHandler handles password reset requests
type PasswordResetHandler struct {
	authSvc  *services.AuthService
	emailSvc *services.EmailService
}

// NewPasswordResetHandler creates a new PasswordResetHandler
func NewPasswordResetHandler(authSvc *services.AuthService, emailSvc *services.EmailService) *PasswordResetHandler {
	return &PasswordResetHandler{
		authSvc:  authSvc,
		emailSvc: emailSvc,
	}
}

// ForgotPassword handles forgot password requests
// @Summary Request password reset
// @Description Send password reset email (always returns success for security)
// @Tags Authentication
// @Accept json
// @Produce json
// @Param request body dto.ForgotPasswordRequest true "User email"
// @Success 200 {object} dto.SuccessResponse "Reset email sent (if user exists)"
// @Router /auth/forgot-password [post]
// IMPORTANT: Always returns the same response regardless of whether user exists
func (h *PasswordResetHandler) ForgotPassword(c *fiber.Ctx) error {
	var req dto.ForgotPasswordRequest

	// Generic success response (used for both existing and non-existing users)
	successResponse := fiber.Map{
		"success": true,
		"message": constants.MsgPasswordResetSent,
	}

	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusOK).JSON(successResponse)
	}

	if req.Email == "" {
		return c.Status(fiber.StatusOK).JSON(successResponse)
	}

	// Look up user
	user, err := h.authSvc.GetUserByEmail(req.Email)
	if err != nil || user == nil {
		// User doesn't exist - return same success response
		return c.Status(fiber.StatusOK).JSON(successResponse)
	}

	// Generate token
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	rawToken, tokenHash, err := redis.GenerateResetToken()
	if err != nil {
		logger.Sugar.Errorw("Error generating reset token", "user_id", user.ID, "email", req.Email, "error", err)
		return c.Status(fiber.StatusOK).JSON(successResponse)
	}

	// Store token hash in Redis
	if err := redis.StoreResetToken(ctx, tokenHash, user.ID); err != nil {
		logger.Sugar.Errorw("Error storing reset token", "user_id", user.ID, "error", err)
		return c.Status(fiber.StatusOK).JSON(successResponse)
	}

	// Send email
	if h.emailSvc != nil {
		if err := h.emailSvc.SendPasswordResetEmail(user.Email, user.Username, rawToken); err != nil {
			logger.Sugar.Errorw("Error sending reset email", "user_id", user.ID, "email", user.Email, "error", err)
		}
	}

	return c.Status(fiber.StatusOK).JSON(successResponse)
}

// ResetPassword handles password reset requests
// @Summary Reset password with token
// @Description Reset password using the token from email
// @Tags Authentication
// @Accept json
// @Produce json
// @Param request body dto.ResetPasswordRequest true "Reset token and new password"
// @Success 200 {object} dto.SuccessResponse "Password reset successful"
// @Failure 400 {object} dto.ErrorResponse "Invalid token or validation error"
// @Router /auth/reset-password [post]
func (h *PasswordResetHandler) ResetPassword(c *fiber.Ctx) error {
	var req dto.ResetPasswordRequest

	if err := c.BodyParser(&req); err != nil {
		return response.InvalidRequest(c)
	}

	if req.Token == "" {
		return response.BadRequest(c, "Reset token is required", constants.ErrCodeMissingToken)
	}

	if req.NewPassword != req.ConfirmPassword {
		return response.BadRequest(c, "Passwords do not match", constants.ErrCodePasswordMismatch)
	}

	if err := validator.ValidatePasswordStrength(req.NewPassword); err != nil {
		return response.BadRequest(c, err.Message, err.ErrorCode)
	}

	// Validate and consume token
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	userID, err := redis.ConsumeResetToken(ctx, req.Token)
	if err != nil {
		logger.Sugar.Errorw("Error consuming reset token", "error", err)
		return response.ServerError(c)
	}

	if userID == 0 {
		return response.BadRequest(c, "Invalid or expired reset token", constants.ErrCodeInvalidResetToken)
	}

	// Update password
	if err := h.authSvc.ResetPassword(userID, req.NewPassword); err != nil {
		logger.LogWithUserID(userID).Errorw("Error updating password", "error", err)
		return response.InternalError(c, "Failed to update password", constants.ErrCodeUpdateFailed)
	}

	return response.Success(c, constants.MsgPasswordReset)
}

// ValidateResetToken validates a reset token without consuming it
func (h *PasswordResetHandler) ValidateResetToken(c *fiber.Ctx) error {
	token := c.Query("token")
	if token == "" {
		return response.JSON(c, fiber.Map{
			"success": true,
			"valid":   false,
		})
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	userID, err := redis.ValidateResetToken(ctx, token)
	if err != nil {
		logger.Sugar.Errorw("Error validating reset token", "error", err)
		return response.JSON(c, fiber.Map{
			"success": true,
			"valid":   false,
		})
	}

	return response.JSON(c, fiber.Map{
		"success": true,
		"valid":   userID > 0,
	})
}
