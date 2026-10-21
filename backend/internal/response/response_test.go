package response_test

import (
	"testing"

	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/response"
	"github.com/aman1117/backend/internal/testutil"
	"github.com/gofiber/fiber/v2"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func errorBody(message, code string) map[string]any {
	return map[string]any{"success": false, "error": message, "error_code": code}
}

func TestHelpers_WriteStatusAndEnvelope(t *testing.T) {
	tests := []struct {
		name       string
		send       fiber.Handler
		wantStatus int
		wantBody   map[string]any
	}{
		{
			name:       "Success",
			send:       func(c *fiber.Ctx) error { return response.Success(c, "Saved") },
			wantStatus: fiber.StatusOK,
			wantBody:   map[string]any{"success": true, "message": "Saved"},
		},
		{
			name:       "Success without a message omits it",
			send:       func(c *fiber.Ctx) error { return response.Success(c, "") },
			wantStatus: fiber.StatusOK,
			wantBody:   map[string]any{"success": true},
		},
		{
			name:       "Created",
			send:       func(c *fiber.Ctx) error { return response.Created(c, constants.MsgUserCreated) },
			wantStatus: fiber.StatusCreated,
			wantBody:   map[string]any{"success": true, "message": constants.MsgUserCreated},
		},
		{
			name:       "Data",
			send:       func(c *fiber.Ctx) error { return response.Data(c, fiber.Map{"count": 3, "items": []string{"a"}}) },
			wantStatus: fiber.StatusOK,
			wantBody:   map[string]any{"success": true, "data": map[string]any{"count": float64(3), "items": []any{"a"}}},
		},
		{
			name:       "Data with a nil payload",
			send:       func(c *fiber.Ctx) error { return response.Data(c, nil) },
			wantStatus: fiber.StatusOK,
			wantBody:   map[string]any{"success": true, "data": nil},
		},
		{
			name:       "JSON sends the payload as is",
			send:       func(c *fiber.Ctx) error { return response.JSON(c, fiber.Map{"success": true, "is_private": false}) },
			wantStatus: fiber.StatusOK,
			wantBody:   map[string]any{"success": true, "is_private": false},
		},
		{
			name:       "Error with a custom status",
			send:       func(c *fiber.Ctx) error { return response.Error(c, fiber.StatusTeapot, "No coffee", "TEAPOT") },
			wantStatus: fiber.StatusTeapot,
			wantBody:   errorBody("No coffee", "TEAPOT"),
		},
		{
			name:       "BadRequest",
			send:       func(c *fiber.Ctx) error { return response.BadRequest(c, "Bad date", constants.ErrCodeInvalidDate) },
			wantStatus: fiber.StatusBadRequest,
			wantBody:   errorBody("Bad date", constants.ErrCodeInvalidDate),
		},
		{
			name: "Unauthorized",
			send: func(c *fiber.Ctx) error {
				return response.Unauthorized(c, "Invalid token", constants.ErrCodeInvalidToken)
			},
			wantStatus: fiber.StatusUnauthorized,
			wantBody:   errorBody("Invalid token", constants.ErrCodeInvalidToken),
		},
		{
			name:       "Forbidden",
			send:       func(c *fiber.Ctx) error { return response.Forbidden(c, "Not yours", constants.ErrCodeNotAuthorized) },
			wantStatus: fiber.StatusForbidden,
			wantBody:   errorBody("Not yours", constants.ErrCodeNotAuthorized),
		},
		{
			name:       "NotFound",
			send:       func(c *fiber.Ctx) error { return response.NotFound(c, "No comment", constants.ErrCodeCommentNotFound) },
			wantStatus: fiber.StatusNotFound,
			wantBody:   errorBody("No comment", constants.ErrCodeCommentNotFound),
		},
		{
			name:       "Conflict",
			send:       func(c *fiber.Ctx) error { return response.Conflict(c, "Taken", constants.ErrCodeUsernameTaken) },
			wantStatus: fiber.StatusConflict,
			wantBody:   errorBody("Taken", constants.ErrCodeUsernameTaken),
		},
		{
			name:       "InternalError",
			send:       func(c *fiber.Ctx) error { return response.InternalError(c, "Boom", constants.ErrCodeSaveFailed) },
			wantStatus: fiber.StatusInternalServerError,
			wantBody:   errorBody("Boom", constants.ErrCodeSaveFailed),
		},
		{
			name:       "ServiceUnavailable always uses SERVER_ERROR",
			send:       func(c *fiber.Ctx) error { return response.ServiceUnavailable(c, "Uploads are disabled") },
			wantStatus: fiber.StatusServiceUnavailable,
			wantBody:   errorBody("Uploads are disabled", constants.ErrCodeServerError),
		},
		{
			name:       "InvalidRequest",
			send:       response.InvalidRequest,
			wantStatus: fiber.StatusBadRequest,
			wantBody:   errorBody("Invalid request body", constants.ErrCodeInvalidRequest),
		},
		{
			name:       "MissingFields",
			send:       response.MissingFields,
			wantStatus: fiber.StatusBadRequest,
			wantBody:   errorBody("All fields are required", constants.ErrCodeMissingFields),
		},
		{
			name:       "UnauthorizedAccess",
			send:       response.UnauthorizedAccess,
			wantStatus: fiber.StatusUnauthorized,
			wantBody:   errorBody("Unauthorized", constants.ErrCodeUnauthorized),
		},
		{
			name:       "PrivateAccount",
			send:       response.PrivateAccount,
			wantStatus: fiber.StatusForbidden,
			wantBody:   errorBody("This account is private", constants.ErrCodeAccountPrivate),
		},
		{
			name:       "UserNotFound",
			send:       response.UserNotFound,
			wantStatus: fiber.StatusBadRequest,
			wantBody:   errorBody("Failed to find user", constants.ErrCodeUserNotFound),
		},
		{
			name:       "DatabaseError",
			send:       response.DatabaseError,
			wantStatus: fiber.StatusBadRequest,
			wantBody:   errorBody("Database Error", constants.ErrCodeDatabaseError),
		},
		{
			name:       "ServerError",
			send:       response.ServerError,
			wantStatus: fiber.StatusInternalServerError,
			wantBody:   errorBody("An error occurred. Please try again.", constants.ErrCodeServerError),
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			app := fiber.New()
			app.Get("/", tt.send)

			res := testutil.Do(t, app, fiber.MethodGet, "/", nil)

			assert.Equal(t, tt.wantStatus, res.Status)
			assert.Equal(t, fiber.MIMEApplicationJSON, res.Header.Get(fiber.HeaderContentType))
			assert.Equal(t, tt.wantBody, res.JSON(t))
		})
	}
}

func TestHelpers_ReturnEncodingErrors(t *testing.T) {
	var sendErr error
	app := fiber.New()
	app.Get("/", func(c *fiber.Ctx) error {
		sendErr = response.Data(c, func() {}) // functions cannot be encoded as JSON
		return nil
	})

	testutil.Do(t, app, fiber.MethodGet, "/", nil)

	require.Error(t, sendErr)
}
