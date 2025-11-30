package services

import (
	"strconv"
	"strings"
	"time"

	"github.com/aman1117/backend/utils"
	"github.com/gofiber/fiber/v2"
	"golang.org/x/crypto/bcrypt"
)

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
			"success": false,
			"error":   "Invalid request body",
		})
	}

	if body.Email == "" || body.Username == "" || body.Password == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success": false,
			"error":   "All fields are required",
		})
	}

	if len(body.Password) < 8 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success": false,
			"error":   "Password must be at least 8 characters long",
		})
	}
	body.Email = strings.TrimSpace(body.Email)
	body.Username = strings.TrimSpace(body.Username)
	body.Password = strings.TrimSpace(body.Password)
	if err := CreateUser(body.Email, body.Username, body.Password); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success": false,
			"error":   "Could not create user (maybe email/username already used)",
		})
	}

	return c.Status(fiber.StatusCreated).JSON(fiber.Map{
		"success": true,
		"message": "User created successfully.",
	})

}

func LoginHandler(c *fiber.Ctx) error {
	var body loginRequest

	if err := c.BodyParser(&body); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success": false,
			"error":   "Invalid request body",
		})
	}

	if body.Identifier == "" || body.Password == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success": false,
			"error":   "All fields are required",
		})
	}
	body.Password = strings.TrimSpace(body.Password)
	body.Identifier = strings.TrimSpace(body.Identifier)
	user, err := GetUserByIdentifier(body.Identifier)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success": false,
			"error":   "Database Error",
		})
	}

	if user == nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success": false,
			"error":   "Invalid credentials",
		})
	}

	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(body.Password)); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success": false,
			"error":   "Invalid password",
		})
	}

	token, exp, err := utils.GenerateToken(user)

	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success": false,
			"error":   "Failed to generate token",
		})
	}
	ttl, err := strconv.Atoi(utils.GetFromEnv("TTL_ACCESS_TOKEN"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success": false,
			"error":   "Failed to generate token",
		})
	}

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
			"success": false,
			"error":   "Missing Authorization Header",
		})
	}
	const prefix = "Bearer "

	if !strings.HasPrefix(authHeader, prefix) {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
			"success": false,
			"error":   "Invalid Authorization Header",
		})
	}

	tokenStr := strings.TrimSpace(authHeader[len(prefix):])

	claims, err := utils.ParseToken(tokenStr)

	if err != nil {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
			"success": false,
			"error":   "Invalid token",
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
