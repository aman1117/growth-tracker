package handlers

import (
	"context"
	"time"

	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/dto"
	"github.com/aman1117/backend/internal/logger"
	"github.com/aman1117/backend/internal/repository"
	"github.com/aman1117/backend/internal/response"
	"github.com/aman1117/backend/internal/services"
	"github.com/aman1117/backend/pkg/redis"
	"github.com/gofiber/fiber/v2"
)

// VerificationHandler handles email verification requests
type VerificationHandler struct {
	userRepo *repository.UserRepository
	emailSvc *services.EmailService
}

// NewVerificationHandler creates a new VerificationHandler
func NewVerificationHandler(userRepo *repository.UserRepository, emailSvc *services.EmailService) *VerificationHandler {
	return &VerificationHandler{
		userRepo: userRepo,
		emailSvc: emailSvc,
	}
}

// VerifyEmail handles email verification from the link in the email
// @Summary Verify email address
// @Description Verify user's email address using the token from email
// @Tags Authentication
// @Accept json
// @Produce json
// @Param request body dto.VerifyEmailRequest true "Verification token"
// @Success 200 {object} dto.SuccessResponse "Email verified successfully"
// @Failure 400 {object} dto.ErrorResponse "Invalid or expired token"
// @Router /auth/verify-email [post]
func (h *VerificationHandler) VerifyEmail(c *fiber.Ctx) error {
	var req dto.VerifyEmailRequest

	if err := c.BodyParser(&req); err != nil {
		return response.InvalidRequest(c)
	}

	if req.Token == "" {
		return response.BadRequest(c, "Verification token is required", constants.ErrCodeMissingToken)
	}

	// Validate and consume token
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	userID, err := redis.ConsumeVerifyToken(ctx, req.Token)
	if err != nil {
		logger.Sugar.Errorw("Error consuming verify token", "error", err)
		return response.ServerError(c)
	}

	if userID == 0 {
		return response.BadRequest(c, "Invalid or expired verification link", constants.ErrCodeInvalidVerifyToken)
	}

	// Check if already verified
	user, err := h.userRepo.FindByID(userID)
	if err != nil {
		logger.LogWithUserID(userID).Errorw("Error finding user for verification", "error", err)
		return response.ServerError(c)
	}

	if user == nil {
		return response.BadRequest(c, "User not found", constants.ErrCodeUserNotFound)
	}

	if user.EmailVerified {
		// Already verified - return success anyway (idempotent)
		return response.JSON(c, fiber.Map{
			"success":          true,
			"message":          constants.MsgEmailVerified,
			"already_verified": true,
		})
	}

	// Update email verified status
	if err := h.userRepo.UpdateEmailVerified(userID, true); err != nil {
		logger.LogWithUserID(userID).Errorw("Error updating email verified status", "error", err)
		return response.InternalError(c, "Failed to verify email", constants.ErrCodeUpdateFailed)
	}

	logger.LogWithUserID(userID).Infow("Email verified successfully", "username", user.Username)

	return response.JSON(c, fiber.Map{
		"success": true,
		"message": constants.MsgEmailVerified,
	})
}

// ResendVerificationEmail resends the verification email to an authenticated user
// @Summary Resend verification email
// @Description Resend verification email to the authenticated user (rate limited)
// @Tags Authentication
// @Accept json
// @Produce json
// @Security BearerAuth
// @Success 200 {object} dto.SuccessResponse "Verification email sent"
// @Failure 400 {object} dto.ErrorResponse "Already verified or in cooldown"
// @Failure 429 {object} dto.ErrorResponse "Rate limit exceeded"
// @Router /auth/resend-verification [post]
func (h *VerificationHandler) ResendVerificationEmail(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uint)

	// Get user
	user, err := h.userRepo.FindByID(userID)
	if err != nil {
		logger.LogWithUserID(userID).Errorw("Error finding user for resend verification", "error", err)
		return response.ServerError(c)
	}

	if user == nil {
		return response.BadRequest(c, "User not found", constants.ErrCodeUserNotFound)
	}

	// Check if already verified
	if user.EmailVerified {
		return response.BadRequest(c, "Email is already verified", constants.ErrCodeAlreadyVerified)
	}

	// Check cooldown
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	inCooldown, err := redis.CheckVerifyResendCooldown(ctx, userID)
	if err != nil {
		logger.LogWithUserID(userID).Warnw("Error checking resend cooldown", "error", err)
		// Continue anyway - better to allow resend than block
	}

	if inCooldown {
		return response.BadRequest(c, "Please wait before requesting another verification email", constants.ErrCodeVerifyResendCooldown)
	}

	// Generate new token
	rawToken, tokenHash, err := redis.GenerateVerifyToken()
	if err != nil {
		logger.LogWithUserID(userID).Errorw("Error generating verify token", "error", err)
		return response.ServerError(c)
	}

	// Store token
	if err := redis.StoreVerifyToken(ctx, tokenHash, userID); err != nil {
		logger.LogWithUserID(userID).Errorw("Error storing verify token", "error", err)
		return response.ServerError(c)
	}

	// Set cooldown
	if err := redis.SetVerifyResendCooldown(ctx, userID); err != nil {
		logger.LogWithUserID(userID).Warnw("Error setting resend cooldown", "error", err)
		// Continue anyway
	}

	// Send email
	if h.emailSvc != nil {
		if err := h.emailSvc.SendVerificationEmail(user.Email, user.Username, rawToken); err != nil {
			logger.LogWithUserID(userID).Errorw("Error sending verification email", "error", err)
			return response.InternalError(c, "Failed to send verification email", constants.ErrCodeServerError)
		}
	}

	logger.LogWithUserID(userID).Infow("Verification email resent", "email", user.Email)

	return response.Success(c, constants.MsgVerificationEmailSent)
}

// SendVerificationEmailForUser sends a verification email to a newly registered user
// This is called internally during registration
func (h *VerificationHandler) SendVerificationEmailForUser(ctx context.Context, userID uint, email, username string) error {
	// Generate token
	rawToken, tokenHash, err := redis.GenerateVerifyToken()
	if err != nil {
		return err
	}

	// Store token
	if err := redis.StoreVerifyToken(ctx, tokenHash, userID); err != nil {
		return err
	}

	// Send email
	if h.emailSvc != nil {
		return h.emailSvc.SendVerificationEmail(email, username, rawToken)
	}

	return nil
}
