// Package handlers contains HTTP handlers for the application.
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

// AuthHandler handles authentication-related requests
type AuthHandler struct {
	authSvc    *services.AuthService
	tokenSvc   *TokenService
	profileSvc *services.ProfileService
	emailSvc   *services.EmailService
}

// NewAuthHandler creates a new AuthHandler
func NewAuthHandler(authSvc *services.AuthService, tokenSvc *TokenService, profileSvc *services.ProfileService, emailSvc *services.EmailService) *AuthHandler {
	return &AuthHandler{
		authSvc:    authSvc,
		tokenSvc:   tokenSvc,
		profileSvc: profileSvc,
		emailSvc:   emailSvc,
	}
}

// Register handles user registration
// @Summary Register a new user
// @Description Create a new user account with email, username, and password
// @Tags Authentication
// @Accept json
// @Produce json
// @Param request body dto.RegisterRequest true "Registration details"
// @Success 201 {object} dto.SuccessResponse "User created successfully"
// @Failure 400 {object} dto.ErrorResponse "Validation error or user exists"
// @Router /register [post]
func (h *AuthHandler) Register(c *fiber.Ctx) error {
	var req dto.RegisterRequest
	if err := c.BodyParser(&req); err != nil {
		return response.InvalidRequest(c)
	}

	if req.Email == "" || req.Username == "" || req.Password == "" {
		return response.MissingFields(c)
	}

	// Validate and sanitize
	if err := validator.ValidatePassword(req.Password); err != nil {
		return response.BadRequest(c, err.Message, err.ErrorCode)
	}

	if err := validator.ValidateUsername(req.Username); err != nil {
		return response.BadRequest(c, err.Message, err.ErrorCode)
	}

	req.Email = validator.SanitizeEmail(req.Email)
	req.Username = validator.SanitizeUsername(req.Username)

	if err := h.authSvc.Register(req.Email, req.Username, req.Password); err != nil {
		logger.Sugar.Warnw("Registration failed", "email", req.Email, "username", req.Username, "error", err)
		return response.BadRequest(c, "Could not create user (maybe email/username already used)", constants.ErrCodeUserExists)
	}

	// Get the newly created user to get their ID for the verification token
	user, err := h.authSvc.GetUserByEmail(req.Email)
	if err == nil && user != nil && h.emailSvc != nil {
		// Send verification email asynchronously (don't block registration)
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()

			// Generate verification token
			rawToken, tokenHash, err := redis.GenerateVerifyToken()
			if err != nil {
				logger.Sugar.Warnw("Failed to generate verify token during registration", "user_id", user.ID, "error", err)
				return
			}

			// Store token
			if err := redis.StoreVerifyToken(ctx, tokenHash, user.ID); err != nil {
				logger.Sugar.Warnw("Failed to store verify token during registration", "user_id", user.ID, "error", err)
				return
			}

			// Send email
			if err := h.emailSvc.SendVerificationEmail(user.Email, user.Username, rawToken); err != nil {
				logger.Sugar.Warnw("Failed to send verification email during registration", "user_id", user.ID, "error", err)
				return
			}

			logger.Sugar.Infow("Verification email sent for new user", "user_id", user.ID, "username", user.Username)
		}()
	}

	logger.Sugar.Infow("New user registered", "username", req.Username)
	return response.Created(c, constants.MsgUserCreated)
}

// Login handles user login
// @Summary User login
// @Description Authenticate user with email/username and password, returns JWT token
// @Tags Authentication
// @Accept json
// @Produce json
// @Param request body dto.LoginRequest true "Login credentials"
// @Success 200 {object} dto.LoginResponse "Login successful with JWT token"
// @Failure 400 {object} dto.ErrorResponse "Invalid credentials"
// @Router /login [post]
func (h *AuthHandler) Login(c *fiber.Ctx) error {
	var req dto.LoginRequest
	if err := c.BodyParser(&req); err != nil {
		return response.InvalidRequest(c)
	}

	if req.Identifier == "" || req.Password == "" {
		return response.MissingFields(c)
	}

	user, err := h.authSvc.Authenticate(req.Identifier, req.Password)
	if err != nil {
		if err.Error() == "user not found" {
			logger.Sugar.Warnw("Login attempt with non-existent user", "identifier", req.Identifier)
			return response.BadRequest(c, "Invalid credentials", constants.ErrCodeInvalidCredentials)
		}
		logger.Sugar.Warnw("Invalid password attempt", "identifier", req.Identifier)
		return response.BadRequest(c, "Invalid password", constants.ErrCodeInvalidPassword)
	}

	token, exp, expiresIn, err := h.tokenSvc.Generate(user)
	if err != nil {
		logger.LogWithFullContext(getTraceID(c), user.ID, user.Username).Errorw("Token generation failed", "error", err)
		return response.BadRequest(c, "Failed to generate token", constants.ErrCodeTokenGenFailed)
	}

	logger.LogWithFullContext(getTraceID(c), user.ID, user.Username).Info("User logged in")

	return response.JSON(c, dto.LoginResponse{
		Success:     true,
		AccessToken: token,
		TokenType:   "Bearer",
		ExpiresAt:   exp.UTC().Format(time.RFC3339),
		ExpiresIn:   expiresIn,
	})
}

// UpdateUsername handles username update requests
// @Summary Update username
// @Description Update the authenticated user's username
// @Tags Profile
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param request body dto.UpdateUsernameRequest true "New username"
// @Success 200 {object} dto.UsernameUpdateResponse "Username updated successfully"
// @Failure 400 {object} dto.ErrorResponse "Validation error or username taken"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Router /update-username [post]
func (h *AuthHandler) UpdateUsername(c *fiber.Ctx) error {
	userID := getUserID(c)

	var req dto.UpdateUsernameRequest
	if err := c.BodyParser(&req); err != nil {
		return response.InvalidRequest(c)
	}

	newUsername := validator.SanitizeUsername(req.NewUsername)

	if newUsername == "" {
		return response.BadRequest(c, "Username is required", constants.ErrCodeMissingFields)
	}

	if err := validator.ValidateUsername(newUsername); err != nil {
		return response.BadRequest(c, err.Message, err.ErrorCode)
	}

	log := logger.LogWithContext(getTraceID(c), userID)
	if err := h.authSvc.UpdateUsername(userID, newUsername); err != nil {
		log.Warnw("Username update failed", "new_username", newUsername, "error", err)
		return response.BadRequest(c, "Username already taken or update failed", constants.ErrCodeUsernameTaken)
	}

	log.Infow("Username updated", "new_username", newUsername)
	return response.JSON(c, dto.UsernameUpdateResponse{
		Success:     true,
		Message:     constants.MsgUsernameUpdated,
		NewUsername: newUsername,
	})
}

// ChangePassword handles password change requests
// @Summary Change password
// @Description Change the authenticated user's password
// @Tags Profile
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param request body dto.ChangePasswordRequest true "Current and new password"
// @Success 200 {object} dto.SuccessResponse "Password changed successfully"
// @Failure 400 {object} dto.ErrorResponse "Validation error or incorrect password"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Router /change-password [post]
func (h *AuthHandler) ChangePassword(c *fiber.Ctx) error {
	userID := getUserID(c)

	var req dto.ChangePasswordRequest
	if err := c.BodyParser(&req); err != nil {
		return response.InvalidRequest(c)
	}

	if req.CurrentPassword == "" || req.NewPassword == "" {
		return response.MissingFields(c)
	}

	if err := validator.ValidatePassword(req.NewPassword); err != nil {
		return response.BadRequest(c, err.Message, err.ErrorCode)
	}

	user, _ := h.authSvc.GetUserByID(userID)
	log := logger.LogWithFullContext(getTraceID(c), userID, "")
	if user != nil {
		log = logger.LogWithFullContext(getTraceID(c), userID, user.Username)
	}

	if err := h.authSvc.ChangePassword(userID, req.CurrentPassword, req.NewPassword); err != nil {
		if err.Error() == "current password is incorrect" {
			log.Warn("Invalid current password for password change")
			return response.BadRequest(c, "Current password is incorrect", constants.ErrCodeInvalidPassword)
		}
		log.Errorw("Failed to change password", "error", err)
		return response.InternalError(c, "Failed to update password", constants.ErrCodeUpdateFailed)
	}

	log.Info("Password changed successfully")
	return response.Success(c, constants.MsgPasswordChanged)
}

// ==================== Helper functions ====================

func getUserID(c *fiber.Ctx) uint {
	userID, _ := c.Locals("user_id").(uint)
	return userID
}

func getUsername(c *fiber.Ctx) string {
	username, _ := c.Locals("username").(string)
	return username
}

func getTraceID(c *fiber.Ctx) string {
	traceID, _ := c.Locals("trace_id").(string)
	return traceID
}
