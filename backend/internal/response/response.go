// Package response provides helper functions for consistent API responses.
package response

import (
	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/dto"
	"github.com/gofiber/fiber/v2"
)

// Success sends a success response with an optional message
func Success(c *fiber.Ctx, message string) error {
	return c.Status(fiber.StatusOK).JSON(dto.SuccessResponse{
		Success: true,
		Message: message,
	})
}

// Created sends a 201 Created response with a message
func Created(c *fiber.Ctx, message string) error {
	return c.Status(fiber.StatusCreated).JSON(dto.SuccessResponse{
		Success: true,
		Message: message,
	})
}

// Data sends a success response with data
func Data(c *fiber.Ctx, data interface{}) error {
	return c.Status(fiber.StatusOK).JSON(dto.DataResponse{
		Success: true,
		Data:    data,
	})
}

// JSON sends a custom JSON response with 200 status
func JSON(c *fiber.Ctx, data interface{}) error {
	return c.Status(fiber.StatusOK).JSON(data)
}

// Error sends an error response with the specified status code
func Error(c *fiber.Ctx, status int, message, errorCode string) error {
	return c.Status(status).JSON(dto.ErrorResponse{
		Success:   false,
		Error:     message,
		ErrorCode: errorCode,
	})
}

// BadRequest sends a 400 Bad Request response
func BadRequest(c *fiber.Ctx, message, errorCode string) error {
	return Error(c, fiber.StatusBadRequest, message, errorCode)
}

// Unauthorized sends a 401 Unauthorized response
func Unauthorized(c *fiber.Ctx, message, errorCode string) error {
	return Error(c, fiber.StatusUnauthorized, message, errorCode)
}

// Forbidden sends a 403 Forbidden response
func Forbidden(c *fiber.Ctx, message, errorCode string) error {
	return Error(c, fiber.StatusForbidden, message, errorCode)
}

// NotFound sends a 404 Not Found response
func NotFound(c *fiber.Ctx, message, errorCode string) error {
	return Error(c, fiber.StatusNotFound, message, errorCode)
}

// InternalError sends a 500 Internal Server Error response
func InternalError(c *fiber.Ctx, message, errorCode string) error {
	return Error(c, fiber.StatusInternalServerError, message, errorCode)
}

// ServiceUnavailable sends a 503 Service Unavailable response
func ServiceUnavailable(c *fiber.Ctx, message string) error {
	return Error(c, fiber.StatusServiceUnavailable, message, constants.ErrCodeServerError)
}

// ==================== Common Error Responses ====================

// InvalidRequest sends a standardized invalid request response
func InvalidRequest(c *fiber.Ctx) error {
	return BadRequest(c, "Invalid request body", constants.ErrCodeInvalidRequest)
}

// MissingFields sends a standardized missing fields response
func MissingFields(c *fiber.Ctx) error {
	return BadRequest(c, "All fields are required", constants.ErrCodeMissingFields)
}

// UnauthorizedAccess sends a standardized unauthorized response
func UnauthorizedAccess(c *fiber.Ctx) error {
	return Unauthorized(c, "Unauthorized", constants.ErrCodeUnauthorized)
}

// PrivateAccount sends a standardized private account response
func PrivateAccount(c *fiber.Ctx) error {
	return Forbidden(c, "This account is private", constants.ErrCodeAccountPrivate)
}

// UserNotFound sends a standardized user not found response
func UserNotFound(c *fiber.Ctx) error {
	return BadRequest(c, "Failed to find user", constants.ErrCodeUserNotFound)
}

// DatabaseError sends a standardized database error response
func DatabaseError(c *fiber.Ctx) error {
	return BadRequest(c, "Database Error", constants.ErrCodeDatabaseError)
}

// ServerError sends a standardized server error response
func ServerError(c *fiber.Ctx) error {
	return InternalError(c, "An error occurred. Please try again.", constants.ErrCodeServerError)
}
