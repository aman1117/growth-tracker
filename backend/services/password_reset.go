/*
#Plan: Password Reset Handlers

Endpoints:
1. POST /auth/forgot-password
   - Always returns same response (security: don't reveal if user exists)
   - If user exists: generate token, store hash in Redis, send email
   - If user doesn't exist: do nothing, return same success message

2. POST /auth/reset-password
   - Validate passwords match
   - Validate password strength (min 8 chars)
   - Hash raw token, lookup in Redis
   - If found: update password in DB, delete Redis key
   - If not found: return invalid/expired error

3. GET /auth/reset-password/validate
   - Check if token is valid (exists in Redis)
   - Does NOT consume/delete the token
   - Returns { "valid": true/false }

Security Notes:
- Never log raw tokens
- Always hash tokens before Redis lookup
- Use bcrypt for password hashing
- Identical response for existing/non-existing users on forgot-password
*/

package services

import (
	"context"
	"fmt"
	"time"
	"unicode"

	"github.com/aman1117/backend/models"
	"github.com/aman1117/backend/utils"
	"github.com/gofiber/fiber/v2"
	"github.com/resend/resend-go/v3"
	"golang.org/x/crypto/bcrypt"
)

// ==================== Request/Response Types ====================

type ForgotPasswordRequest struct {
	Email string `json:"email"`
}

type ResetPasswordRequest struct {
	Token           string `json:"token"`
	NewPassword     string `json:"new_password"`
	ConfirmPassword string `json:"confirm_password"`
}

type ValidateTokenRequest struct {
	Token string `json:"token"`
}

// ==================== Handlers ====================

// ForgotPasswordHandler handles POST /auth/forgot-password
// IMPORTANT: Always returns the same response regardless of whether user exists
func ForgotPasswordHandler(c *fiber.Ctx) error {
	var req ForgotPasswordRequest
	if err := c.BodyParser(&req); err != nil {
		// Even on parse error, return generic success to not leak info
		return c.Status(fiber.StatusOK).JSON(fiber.Map{
			"success": true,
			"message": "If an account exists with this email, a password reset link has been sent.",
		})
	}

	// Generic success response (used for both existing and non-existing users)
	successResponse := fiber.Map{
		"success": true,
		"message": "If an account exists with this email, a password reset link has been sent.",
	}

	if req.Email == "" {
		return c.Status(fiber.StatusOK).JSON(successResponse)
	}

	// Look up user (do this in background-like manner - same response either way)
	db := utils.GetDB()
	var user models.User
	result := db.Where("email = ?", req.Email).First(&user)

	if result.Error != nil {
		// User doesn't exist - return same success response
		return c.Status(fiber.StatusOK).JSON(successResponse)
	}

	// User exists - generate token and send email
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	rawToken, tokenHash, err := utils.GenerateResetToken()
	if err != nil {
		// Log error internally but return success to user
		fmt.Printf("Error generating reset token: %v\n", err)
		return c.Status(fiber.StatusOK).JSON(successResponse)
	}

	// Store token hash in Redis
	if err := utils.StoreResetToken(ctx, tokenHash, user.ID); err != nil {
		fmt.Printf("Error storing reset token: %v\n", err)
		return c.Status(fiber.StatusOK).JSON(successResponse)
	}

	// Send email with reset link
	if err := sendPasswordResetEmail(user.Email, user.Username, rawToken); err != nil {
		fmt.Printf("Error sending reset email: %v\n", err)
		// Still return success - don't reveal email sending issues
	}

	return c.Status(fiber.StatusOK).JSON(successResponse)
}

// ResetPasswordHandler handles POST /auth/reset-password
func ResetPasswordHandler(c *fiber.Ctx) error {
	var req ResetPasswordRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success":    false,
			"error":      "Invalid request body",
			"error_code": "INVALID_REQUEST",
		})
	}

	// Validate token is provided
	if req.Token == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success":    false,
			"error":      "Reset token is required",
			"error_code": "MISSING_TOKEN",
		})
	}

	// Validate passwords match
	if req.NewPassword != req.ConfirmPassword {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success":    false,
			"error":      "Passwords do not match",
			"error_code": "PASSWORD_MISMATCH",
		})
	}

	// Validate password strength
	if err := validatePasswordStrength(req.NewPassword); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success":    false,
			"error":      err.Error(),
			"error_code": "WEAK_PASSWORD",
		})
	}

	// Validate and consume the token from Redis
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	userID, err := utils.ConsumeResetToken(ctx, req.Token)
	if err != nil {
		fmt.Printf("Error consuming reset token: %v\n", err)
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"success":    false,
			"error":      "An error occurred. Please try again.",
			"error_code": "SERVER_ERROR",
		})
	}

	if userID == 0 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success":    false,
			"error":      "Invalid or expired reset token",
			"error_code": "INVALID_TOKEN",
		})
	}

	// Hash the new password
	hashedPassword, err := bcrypt.GenerateFromPassword([]byte(req.NewPassword), bcrypt.DefaultCost)
	if err != nil {
		fmt.Printf("Error hashing password: %v\n", err)
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"success":    false,
			"error":      "An error occurred. Please try again.",
			"error_code": "SERVER_ERROR",
		})
	}

	// Update password in database
	db := utils.GetDB()
	result := db.Model(&models.User{}).Where("id = ?", userID).Update("password_hash", string(hashedPassword))
	if result.Error != nil {
		fmt.Printf("Error updating password: %v\n", result.Error)
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"success":    false,
			"error":      "Failed to update password",
			"error_code": "UPDATE_FAILED",
		})
	}

	return c.Status(fiber.StatusOK).JSON(fiber.Map{
		"success": true,
		"message": "Password updated successfully. You can now log in with your new password.",
	})
}

// ValidateResetTokenHandler handles GET /auth/reset-password/validate
// This endpoint checks if a token is valid WITHOUT consuming it
func ValidateResetTokenHandler(c *fiber.Ctx) error {
	token := c.Query("token")
	if token == "" {
		return c.Status(fiber.StatusOK).JSON(fiber.Map{
			"success": true,
			"valid":   false,
		})
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	userID, err := utils.ValidateResetToken(ctx, token)
	if err != nil {
		fmt.Printf("Error validating reset token: %v\n", err)
		return c.Status(fiber.StatusOK).JSON(fiber.Map{
			"success": true,
			"valid":   false,
		})
	}

	return c.Status(fiber.StatusOK).JSON(fiber.Map{
		"success": true,
		"valid":   userID > 0,
	})
}

// ==================== Helper Functions ====================

// validatePasswordStrength checks if password meets requirements
func validatePasswordStrength(password string) error {
	if len(password) < 8 {
		return fmt.Errorf("password must be at least 8 characters long")
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
		return fmt.Errorf("password must contain at least one letter")
	}
	if !hasNumber {
		return fmt.Errorf("password must contain at least one number")
	}

	return nil
}

// sendPasswordResetEmail sends password reset email via Resend
func sendPasswordResetEmail(email, username, token string) error {
	client, err := InitResendClient()
	if err != nil {
		return fmt.Errorf("failed to initialize email client: %w", err)
	}

	frontendURL := utils.GetFromEnv("FRONTEND_BASE_URL")
	if frontendURL == "" {
		frontendURL = "http://localhost:5173"
	}

	resetLink := fmt.Sprintf("%s/reset-password?token=%s", frontendURL, token)

	// Email HTML template
	htmlContent := fmt.Sprintf(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;">
    <table width="100%%" cellpadding="0" cellspacing="0" style="background-color: #f5f5f5; padding: 40px 20px;">
        <tr>
            <td align="center">
                <table width="100%%" style="max-width: 480px; background-color: #ffffff; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.08);">
                    <tr>
                        <td style="padding: 40px 32px;">
                            <!-- Header -->
                            <div style="text-align: center; margin-bottom: 32px;">
                                <h1 style="margin: 0; font-size: 24px; font-weight: 700; color: #1a1a1a;">
                                    🔐 Password Reset
                                </h1>
                            </div>
                            
                            <!-- Content -->
                            <p style="margin: 0 0 16px; font-size: 16px; color: #333; line-height: 1.5;">
                                Hi <strong>%s</strong>,
                            </p>
                            <p style="margin: 0 0 24px; font-size: 16px; color: #333; line-height: 1.5;">
                                We received a request to reset your password for your Growth Tracker account. Click the button below to set a new password:
                            </p>
                            
                            <!-- CTA Button -->
                            <div style="text-align: center; margin: 32px 0;">
                                <a href="%s" style="display: inline-block; padding: 14px 32px; background-color: #0066ff; color: #ffffff; text-decoration: none; font-weight: 600; font-size: 16px; border-radius: 8px;">
                                    Reset Password
                                </a>
                            </div>
                            
                            <!-- Expiry Notice -->
                            <p style="margin: 0 0 16px; font-size: 14px; color: #666; line-height: 1.5;">
                                ⏰ This link will expire in <strong>15 minutes</strong>.
                            </p>
                            
                            <!-- Security Notice -->
                            <div style="background-color: #f8f9fa; border-radius: 8px; padding: 16px; margin-top: 24px;">
                                <p style="margin: 0; font-size: 14px; color: #666; line-height: 1.5;">
                                    If you didn't request this password reset, you can safely ignore this email. Your password will remain unchanged.
                                </p>
                            </div>
                            
                            <!-- Link fallback -->
                            <p style="margin: 24px 0 0; font-size: 12px; color: #999; line-height: 1.5; word-break: break-all;">
                                If the button doesn't work, copy and paste this link into your browser:<br>
                                <a href="%s" style="color: #0066ff;">%s</a>
                            </p>
                        </td>
                    </tr>
                    
                    <!-- Footer -->
                    <tr>
                        <td style="padding: 24px 32px; border-top: 1px solid #eee; text-align: center;">
                            <p style="margin: 0; font-size: 12px; color: #999;">
                                Growth Tracker • Track your daily activities
                            </p>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>
`, username, resetLink, resetLink, resetLink)

	params := &resend.SendEmailRequest{
		From:    "Growth Tracker <aman@amancodes.dev>",
		To:      []string{email},
		Subject: "Reset Your Password - Growth Tracker",
		Html:    htmlContent,
	}

	_, err = client.Emails.Send(params)
	if err != nil {
		return fmt.Errorf("failed to send email: %w", err)
	}

	return nil
}
