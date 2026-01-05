package handlers

import (
	"strconv"

	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/dto"
	"github.com/aman1117/backend/internal/logger"
	"github.com/aman1117/backend/internal/response"
	"github.com/aman1117/backend/internal/services"
	"github.com/gofiber/fiber/v2"
)

// NotificationHandler handles notification-related requests
type NotificationHandler struct {
	notifSvc *services.NotificationService
}

// NewNotificationHandler creates a new NotificationHandler
func NewNotificationHandler(notifSvc *services.NotificationService) *NotificationHandler {
	return &NotificationHandler{
		notifSvc: notifSvc,
	}
}

// GetNotifications returns paginated notifications for the authenticated user
// @Summary Get notifications
// @Description Get paginated list of notifications for the current user
// @Tags Notifications
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param page query int false "Page number (default: 1)"
// @Param page_size query int false "Page size (default: 20, max: 50)"
// @Success 200 {object} dto.NotificationsResponse "Notifications list"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Router /notifications [get]
func (h *NotificationHandler) GetNotifications(c *fiber.Ctx) error {
	userID := getUserID(c)
	log := logger.LogWithContext(getTraceID(c), userID)

	// Parse pagination params
	page := c.QueryInt("page", 1)
	pageSize := c.QueryInt("page_size", 20)

	// Validate pagination
	if page < 1 {
		page = 1
	}
	if pageSize < 1 {
		pageSize = 20
	}
	if pageSize > 50 {
		pageSize = 50 // Max page size
	}

	log.Infow("GetNotifications request",
		"page", page,
		"page_size", pageSize,
	)

	notifications, total, err := h.notifSvc.GetByUserID(c.Context(), userID, page, pageSize)
	if err != nil {
		log.Errorw("Failed to get notifications", "error", err)
		return response.InternalError(c, "Failed to get notifications", constants.ErrCodeFetchFailed)
	}

	hasMore := int64(page*pageSize) < total

	return c.JSON(dto.NotificationsResponse{
		Success:       true,
		Notifications: dto.NotificationsToDTOs(notifications),
		Total:         total,
		Page:          page,
		PageSize:      pageSize,
		HasMore:       hasMore,
	})
}

// GetUnreadCount returns the unread notification count
// @Summary Get unread count
// @Description Get the count of unread notifications
// @Tags Notifications
// @Produce json
// @Security BearerAuth
// @Success 200 {object} dto.UnreadCountResponse "Unread count"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Router /notifications/unread-count [get]
func (h *NotificationHandler) GetUnreadCount(c *fiber.Ctx) error {
	userID := getUserID(c)
	log := logger.LogWithContext(getTraceID(c), userID)

	count, err := h.notifSvc.GetUnreadCount(c.Context(), userID)
	if err != nil {
		log.Errorw("Failed to get unread count", "error", err)
		return response.InternalError(c, "Failed to get unread count", constants.ErrCodeFetchFailed)
	}

	return c.JSON(dto.UnreadCountResponse{
		Success:     true,
		UnreadCount: count,
	})
}

// MarkAsRead marks a single notification as read
// @Summary Mark notification as read
// @Description Mark a specific notification as read
// @Tags Notifications
// @Produce json
// @Security BearerAuth
// @Param id path int true "Notification ID"
// @Success 200 {object} dto.NotificationActionResponse "Success"
// @Failure 400 {object} dto.ErrorResponse "Invalid ID"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Router /notifications/{id}/read [patch]
func (h *NotificationHandler) MarkAsRead(c *fiber.Ctx) error {
	userID := getUserID(c)
	log := logger.LogWithContext(getTraceID(c), userID)

	// Parse notification ID from path
	idStr := c.Params("id")
	id, err := strconv.ParseUint(idStr, 10, 32)
	if err != nil {
		return response.BadRequest(c, "Invalid notification ID", constants.ErrCodeInvalidRequest)
	}

	log.Infow("MarkAsRead request", "notification_id", id)

	if err := h.notifSvc.MarkAsRead(c.Context(), uint(id), userID); err != nil {
		log.Errorw("Failed to mark notification as read", "notification_id", id, "error", err)
		return response.InternalError(c, "Failed to mark as read", constants.ErrCodeUpdateFailed)
	}

	return c.JSON(dto.NotificationActionResponse{
		Success: true,
		Message: "Notification marked as read",
	})
}

// MarkAllAsRead marks all notifications as read
// @Summary Mark all as read
// @Description Mark all notifications as read for the current user
// @Tags Notifications
// @Produce json
// @Security BearerAuth
// @Success 200 {object} dto.NotificationActionResponse "Success"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Router /notifications/read-all [patch]
func (h *NotificationHandler) MarkAllAsRead(c *fiber.Ctx) error {
	userID := getUserID(c)
	log := logger.LogWithContext(getTraceID(c), userID)

	log.Infow("MarkAllAsRead request")

	if err := h.notifSvc.MarkAllAsRead(c.Context(), userID); err != nil {
		log.Errorw("Failed to mark all notifications as read", "error", err)
		return response.InternalError(c, "Failed to mark all as read", constants.ErrCodeUpdateFailed)
	}

	return c.JSON(dto.NotificationActionResponse{
		Success: true,
		Message: "All notifications marked as read",
	})
}

// DeleteNotification deletes a notification
// @Summary Delete notification
// @Description Delete a specific notification
// @Tags Notifications
// @Produce json
// @Security BearerAuth
// @Param id path int true "Notification ID"
// @Success 200 {object} dto.NotificationActionResponse "Success"
// @Failure 400 {object} dto.ErrorResponse "Invalid ID"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Failure 404 {object} dto.ErrorResponse "Not found"
// @Router /notifications/{id} [delete]
func (h *NotificationHandler) DeleteNotification(c *fiber.Ctx) error {
	userID := getUserID(c)
	log := logger.LogWithContext(getTraceID(c), userID)

	// Parse notification ID from path
	idStr := c.Params("id")
	id, err := strconv.ParseUint(idStr, 10, 32)
	if err != nil {
		return response.BadRequest(c, "Invalid notification ID", constants.ErrCodeInvalidRequest)
	}

	log.Infow("DeleteNotification request", "notification_id", id)

	if err := h.notifSvc.Delete(c.Context(), uint(id), userID); err != nil {
		log.Errorw("Failed to delete notification", "notification_id", id, "error", err)
		if err.Error() == "notification not found" {
			return response.NotFound(c, "Notification not found", constants.ErrCodeNotificationNotFound)
		}
		return response.InternalError(c, "Failed to delete notification", constants.ErrCodeDeleteFailed)
	}

	return c.JSON(dto.NotificationActionResponse{
		Success: true,
		Message: "Notification deleted",
	})
}
