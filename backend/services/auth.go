package services

import (
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/aman1117/backend/utils"
	"github.com/gofiber/fiber/v2"
	"golang.org/x/crypto/bcrypt"
)

// Username validation regex: lowercase letters, numbers, underscore, dot
var validUsername = regexp.MustCompile(`^[a-z0-9_.]+$`)

type registerRequest struct {
	Email    string `json:"email"`
	Username string `json:"username"`
	Password string `json:"password"`
}

type loginRequest struct {
	Identifier string `json:"identifier"`
	Password   string `json:"password"`
}

func RegisterHandler(c *fiber.Ctx) error {
	var body registerRequest
	if err := c.BodyParser(&body); err != nil {

		// return fiber.NewError(fiber.StatusBadRequest, "Invalid request body")
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success":    false,
			"error":      "Invalid request body",
			"error_code": "INVALID_REQUEST",
		})
	}

	if body.Email == "" || body.Username == "" || body.Password == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success":    false,
			"error":      "All fields are required",
			"error_code": "MISSING_FIELDS",
		})
	}

	if len(body.Password) < 8 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success":    false,
			"error":      "Password must be at least 8 characters long",
			"error_code": "PASSWORD_TOO_SHORT",
		})
	}

	// Validate username format
	if !validUsername.MatchString(body.Username) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success":    false,
			"error":      "Username can only contain lowercase letters, numbers, _ and .",
			"error_code": "INVALID_USERNAME_FORMAT",
		})
	}

	if len(body.Username) < 3 || len(body.Username) > 20 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success":    false,
			"error":      "Username must be between 3 and 20 characters",
			"error_code": "INVALID_USERNAME_LENGTH",
		})
	}

	body.Email = strings.TrimSpace(body.Email)
	body.Username = strings.ToLower(strings.TrimSpace(body.Username))
	body.Password = strings.TrimSpace(body.Password)
	if err := CreateUser(body.Email, body.Username, body.Password); err != nil {
		utils.Sugar.Warnw("Registration failed", "email", body.Email, "username", body.Username, "error", err)
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success":    false,
			"error":      "Could not create user (maybe email/username already used)",
			"error_code": "USER_EXISTS",
		})
	}

	utils.Sugar.Infow("New user registered", "username", body.Username)
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{
		"success": true,
		"message": "User created successfully.",
	})

}

func LoginHandler(c *fiber.Ctx) error {
	var body loginRequest

	if err := c.BodyParser(&body); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success":    false,
			"error":      "Invalid request body",
			"error_code": "INVALID_REQUEST",
		})
	}

	if body.Identifier == "" || body.Password == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success":    false,
			"error":      "All fields are required",
			"error_code": "MISSING_FIELDS",
		})
	}
	body.Password = strings.TrimSpace(body.Password)
	body.Identifier = strings.TrimSpace(body.Identifier)
	user, err := GetUserByIdentifier(body.Identifier)
	if err != nil {
		utils.Sugar.Errorw("Database error during login", "identifier", body.Identifier, "error", err)
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success":    false,
			"error":      "Database Error",
			"error_code": "DATABASE_ERROR",
		})
	}

	if user == nil {
		utils.Sugar.Warnw("Login attempt with non-existent user", "identifier", body.Identifier)
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success":    false,
			"error":      "Invalid credentials",
			"error_code": "INVALID_CREDENTIALS",
		})
	}

	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(body.Password)); err != nil {
		utils.Sugar.Warnw("Invalid password attempt", "identifier", body.Identifier)
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success":    false,
			"error":      "Invalid password",
			"error_code": "INVALID_PASSWORD",
		})
	}

	token, exp, err := utils.GenerateToken(user)

	traceID, _ := c.Locals("trace_id").(string)
	log := utils.LogWithFullContext(traceID, user.ID, user.Username)

	if err != nil {
		log.Errorw("Token generation failed", "error", err)
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success":    false,
			"error":      "Failed to generate token",
			"error_code": "TOKEN_GENERATION_FAILED",
		})
	}
	ttl, err := strconv.Atoi(utils.GetFromEnv("TTL_ACCESS_TOKEN"))
	if err != nil {
		utils.Sugar.Error("TTL_ACCESS_TOKEN env var is invalid")
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success":    false,
			"error":      "Failed to generate token",
			"error_code": "TOKEN_GENERATION_FAILED",
		})
	}

	log.Info("User logged in")
	return c.Status(fiber.StatusOK).JSON(fiber.Map{
		"success":      true,
		"access_token": token,
		"token_type":   "Bearer",
		"expires_at":   exp.UTC().Format(time.RFC3339),
		"expires_in":   int(ttl * 60),
	})

}

func AuthMiddleware(c *fiber.Ctx) error {
	authHeader := c.Get("Authorization")
	if authHeader == "" {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
			"success":    false,
			"error":      "Missing Authorization Header",
			"error_code": "MISSING_AUTH_HEADER",
		})
	}
	const prefix = "Bearer "

	if !strings.HasPrefix(authHeader, prefix) {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
			"success":    false,
			"error":      "Invalid Authorization Header",
			"error_code": "INVALID_AUTH_HEADER",
		})
	}

	tokenStr := strings.TrimSpace(authHeader[len(prefix):])

	claims, err := utils.ParseToken(tokenStr)

	if err != nil {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
			"success":    false,
			"error":      "Invalid token",
			"error_code": "INVALID_TOKEN",
		})
	}

	c.Locals("user_id", claims.UserID)
	c.Locals("username", claims.Username)

	return c.Next()

}

func ProtectedHandler(c *fiber.Ctx) error {
	username, _ := c.Locals("username").(string)
	userID, _ := c.Locals("user_id").(uint)
	return c.Status(fiber.StatusOK).JSON(fiber.Map{
		"success":  true,
		"user_id":  userID,
		"username": username,
	})
}

type updateUsernameRequest struct {
	NewUsername string `json:"new_username"`
}

func UpdateUsernameHandler(c *fiber.Ctx) error {
	userID, ok := c.Locals("user_id").(uint)
	if !ok {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
			"success":    false,
			"error":      "Unauthorized",
			"error_code": "UNAUTHORIZED",
		})
	}

	var body updateUsernameRequest
	if err := c.BodyParser(&body); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success":    false,
			"error":      "Invalid request body",
			"error_code": "INVALID_REQUEST",
		})
	}

	newUsername := strings.ToLower(strings.TrimSpace(body.NewUsername))

	if newUsername == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success":    false,
			"error":      "Username is required",
			"error_code": "MISSING_FIELDS",
		})
	}

	// Validate username format
	if !validUsername.MatchString(newUsername) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success":    false,
			"error":      "Username can only contain lowercase letters, numbers, _ and .",
			"error_code": "INVALID_USERNAME_FORMAT",
		})
	}

	if len(newUsername) < 3 || len(newUsername) > 20 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success":    false,
			"error":      "Username must be between 3 and 20 characters",
			"error_code": "INVALID_USERNAME_LENGTH",
		})
	}

	// Update username in database
	traceID, _ := c.Locals("trace_id").(string)
	log := utils.LogWithContext(traceID, userID)
	if err := UpdateUsername(userID, newUsername); err != nil {
		log.Warnw("Username update failed", "new_username", newUsername, "error", err)
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success":    false,
			"error":      "Username already taken or update failed",
			"error_code": "USERNAME_TAKEN",
		})
	}

	log.Infow("Username updated", "new_username", newUsername)
	return c.Status(fiber.StatusOK).JSON(fiber.Map{
		"success":      true,
		"message":      "Username updated successfully",
		"new_username": newUsername,
	})
}

type updatePrivacyRequest struct {
	IsPrivate bool `json:"is_private"`
}

func UpdatePrivacyHandler(c *fiber.Ctx) error {
	userID, ok := c.Locals("user_id").(uint)
	if !ok {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
			"success":    false,
			"error":      "Unauthorized",
			"error_code": "UNAUTHORIZED",
		})
	}

	var body updatePrivacyRequest
	if err := c.BodyParser(&body); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success":    false,
			"error":      "Invalid request body",
			"error_code": "INVALID_REQUEST",
		})
	}

	traceID, _ := c.Locals("trace_id").(string)
	log := utils.LogWithContext(traceID, userID)
	if err := UpdatePrivacy(userID, body.IsPrivate); err != nil {
		log.Errorw("Privacy update failed", "error", err)
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"success":    false,
			"error":      "Failed to update privacy setting",
			"error_code": "UPDATE_FAILED",
		})
	}

	log.Infow("Privacy updated", "is_private", body.IsPrivate)
	return c.Status(fiber.StatusOK).JSON(fiber.Map{
		"success":    true,
		"message":    "Privacy setting updated",
		"is_private": body.IsPrivate,
	})
}

func GetPrivacyHandler(c *fiber.Ctx) error {
	userID, ok := c.Locals("user_id").(uint)
	if !ok {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
			"success":    false,
			"error":      "Unauthorized",
			"error_code": "UNAUTHORIZED",
		})
	}

	isPrivate, err := GetUserPrivacy(userID)
	if err != nil {
		traceID, _ := c.Locals("trace_id").(string)
		utils.LogWithContext(traceID, userID).Errorw("Failed to get privacy setting", "error", err)
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"success":    false,
			"error":      "Failed to get privacy setting",
			"error_code": "FETCH_FAILED",
		})
	}

	return c.Status(fiber.StatusOK).JSON(fiber.Map{
		"success":    true,
		"is_private": isPrivate,
	})
}

type changePasswordRequest struct {
	CurrentPassword string `json:"current_password"`
	NewPassword     string `json:"new_password"`
}

func ChangePasswordHandler(c *fiber.Ctx) error {
	userID, ok := c.Locals("user_id").(uint)
	if !ok {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
			"success":    false,
			"error":      "Unauthorized",
			"error_code": "UNAUTHORIZED",
		})
	}

	var body changePasswordRequest
	if err := c.BodyParser(&body); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success":    false,
			"error":      "Invalid request body",
			"error_code": "INVALID_REQUEST",
		})
	}

	body.CurrentPassword = strings.TrimSpace(body.CurrentPassword)
	body.NewPassword = strings.TrimSpace(body.NewPassword)

	if body.CurrentPassword == "" || body.NewPassword == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success":    false,
			"error":      "All fields are required",
			"error_code": "MISSING_FIELDS",
		})
	}

	if len(body.NewPassword) < 8 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success":    false,
			"error":      "Password must be at least 8 characters",
			"error_code": "PASSWORD_TOO_SHORT",
		})
	}

	// Get current user
	user, err := GetUserByID(userID)
	if err != nil || user == nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"success":    false,
			"error":      "User not found",
			"error_code": "USER_NOT_FOUND",
		})
	}

	traceID, _ := c.Locals("trace_id").(string)
	log := utils.LogWithFullContext(traceID, userID, user.Username)

	// Verify current password
	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(body.CurrentPassword)); err != nil {
		log.Warn("Invalid current password for password change")
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success":    false,
			"error":      "Current password is incorrect",
			"error_code": "INVALID_PASSWORD",
		})
	}

	// Hash and save new password
	hashedPassword, err := bcrypt.GenerateFromPassword([]byte(body.NewPassword), bcrypt.DefaultCost)
	if err != nil {
		log.Errorw("Failed to hash new password", "error", err)
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"success":    false,
			"error":      "Failed to process password",
			"error_code": "HASH_FAILED",
		})
	}

	if err := UpdateUserPassword(userID, string(hashedPassword)); err != nil {
		log.Errorw("Failed to update password in DB", "error", err)
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"success":    false,
			"error":      "Failed to update password",
			"error_code": "UPDATE_FAILED",
		})
	}

	log.Info("Password changed successfully")
	return c.Status(fiber.StatusOK).JSON(fiber.Map{
		"success": true,
		"message": "Password changed successfully",
	})
}

type updateBioRequest struct {
	Bio string `json:"bio"`
}

func UpdateBioHandler(c *fiber.Ctx) error {
	userID, ok := c.Locals("user_id").(uint)
	if !ok {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
			"success":    false,
			"error":      "Unauthorized",
			"error_code": "UNAUTHORIZED",
		})
	}

	var body updateBioRequest
	if err := c.BodyParser(&body); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success":    false,
			"error":      "Invalid request body",
			"error_code": "INVALID_REQUEST",
		})
	}

	bio := strings.TrimSpace(body.Bio)

	// Validate bio length (max 150 characters)
	if len(bio) > 150 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success":    false,
			"error":      "Bio must be 150 characters or less",
			"error_code": "BIO_TOO_LONG",
		})
	}

	traceID, _ := c.Locals("trace_id").(string)
	log := utils.LogWithContext(traceID, userID)
	if err := UpdateBio(userID, bio); err != nil {
		log.Errorw("Bio update failed", "error", err)
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"success":    false,
			"error":      "Failed to update bio",
			"error_code": "UPDATE_FAILED",
		})
	}

	log.Infow("Bio updated", "bio_length", len(bio))
	return c.Status(fiber.StatusOK).JSON(fiber.Map{
		"success": true,
		"message": "Bio updated successfully",
		"bio":     bio,
	})
}

func GetBioHandler(c *fiber.Ctx) error {
	userID, ok := c.Locals("user_id").(uint)
	if !ok {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
			"success":    false,
			"error":      "Unauthorized",
			"error_code": "UNAUTHORIZED",
		})
	}

	bio, err := GetUserBio(userID)
	if err != nil {
		traceID, _ := c.Locals("trace_id").(string)
		utils.LogWithContext(traceID, userID).Errorw("Failed to get bio", "error", err)
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"success":    false,
			"error":      "Failed to get bio",
			"error_code": "FETCH_FAILED",
		})
	}

	return c.Status(fiber.StatusOK).JSON(fiber.Map{
		"success": true,
		"bio":     bio,
	})
}
