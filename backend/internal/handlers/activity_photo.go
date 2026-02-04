package handlers

import (
	"strconv"
	"time"

	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/logger"
	"github.com/aman1117/backend/internal/response"
	"github.com/aman1117/backend/internal/services"
	"github.com/gofiber/fiber/v2"
)

// ActivityPhotoHandler handles activity photo (story) requests
type ActivityPhotoHandler struct {
	photoSvc   *services.ActivityPhotoService
	authSvc    *services.AuthService
	profileSvc *services.ProfileService
}

// NewActivityPhotoHandler creates a new ActivityPhotoHandler
func NewActivityPhotoHandler(
	photoSvc *services.ActivityPhotoService,
	authSvc *services.AuthService,
	profileSvc *services.ProfileService,
) *ActivityPhotoHandler {
	return &ActivityPhotoHandler{
		photoSvc:   photoSvc,
		authSvc:    authSvc,
		profileSvc: profileSvc,
	}
}

// UploadPhoto handles activity photo uploads
// @Summary Upload activity photo
// @Description Upload a photo for an activity on a specific date (max 5MB, within 7 days)
// @Tags Activity Photos
// @Accept multipart/form-data
// @Produce json
// @Security BearerAuth
// @Param image formData file true "Image file (JPEG, PNG, WebP)"
// @Param activity_name formData string true "Activity name"
// @Param photo_date formData string true "Photo date (YYYY-MM-DD)"
// @Success 200 {object} map[string]interface{} "Photo uploaded successfully"
// @Failure 400 {object} dto.ErrorResponse "Validation error or duplicate"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Failure 409 {object} dto.ErrorResponse "Photo already exists"
// @Router /activity-photo [post]
func (h *ActivityPhotoHandler) UploadPhoto(c *fiber.Ctx) error {
	userID := getUserID(c)
	traceID := getTraceID(c)

	// Get form values
	activityName := c.FormValue("activity_name")
	photoDateStr := c.FormValue("photo_date")
	// Optional custom tile metadata
	activityIcon := c.FormValue("activity_icon")
	activityColor := c.FormValue("activity_color")
	activityLabel := c.FormValue("activity_label")

	if activityName == "" || photoDateStr == "" {
		logger.LogWithContext(traceID, userID).Warnw("Photo upload failed - missing fields")
		return response.BadRequest(c, "activity_name and photo_date are required", constants.ErrCodeMissingFields)
	}

	// Parse date
	photoDate, err := time.Parse(constants.DateFormat, photoDateStr)
	if err != nil {
		logger.LogWithContext(traceID, userID).Warnw("Photo upload failed - invalid date", "date", photoDateStr)
		return response.BadRequest(c, "Invalid date format, use YYYY-MM-DD", constants.ErrCodeInvalidDate)
	}

	// Get file
	file, err := c.FormFile("image")
	if err != nil {
		logger.LogWithContext(traceID, userID).Warnw("Photo upload failed - no image", "error", err)
		return response.BadRequest(c, "No image file provided", constants.ErrCodeInvalidRequest)
	}

	// Open file
	src, err := file.Open()
	if err != nil {
		logger.LogWithContext(traceID, userID).Errorw("Photo upload failed - file open error", "error", err)
		return response.InternalError(c, "Failed to read image file", constants.ErrCodeServerError)
	}
	defer src.Close()

	// Upload photo with optional custom tile metadata
	photo, err := h.photoSvc.Upload(c.Context(), userID, activityName, photoDate, src, file, activityIcon, activityColor, activityLabel)
	if err != nil {
		if err.Error() == "photo already exists for this activity on this date" {
			return response.Conflict(c, "Photo already exists for this activity on this date", constants.ErrCodeConflict)
		}
		logger.LogWithContext(traceID, userID).Errorw("Photo upload failed", "error", err)
		return response.BadRequest(c, err.Error(), constants.ErrCodeInvalidRequest)
	}

	logger.LogWithContext(traceID, userID).Infow("Activity photo uploaded",
		"photo_id", photo.ID,
		"activity_name", activityName,
		"photo_date", photoDateStr,
	)

	return response.JSON(c, fiber.Map{
		"success": true,
		"photo":   photo,
	})
}

// DeletePhoto handles activity photo deletion
// @Summary Delete activity photo
// @Description Delete a photo owned by the current user
// @Tags Activity Photos
// @Produce json
// @Security BearerAuth
// @Param id path int true "Photo ID"
// @Success 200 {object} dto.SuccessResponse "Photo deleted"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Failure 403 {object} dto.ErrorResponse "Not authorized to delete this photo"
// @Failure 404 {object} dto.ErrorResponse "Photo not found"
// @Router /activity-photo/{id} [delete]
func (h *ActivityPhotoHandler) DeletePhoto(c *fiber.Ctx) error {
	userID := getUserID(c)
	traceID := getTraceID(c)

	// Parse photo ID
	photoIDStr := c.Params("id")
	photoID, err := strconv.ParseUint(photoIDStr, 10, 32)
	if err != nil {
		return response.BadRequest(c, "Invalid photo ID", constants.ErrCodeInvalidRequest)
	}

	// Delete photo
	if err := h.photoSvc.Delete(c.Context(), uint(photoID), userID); err != nil {
		if err.Error() == "photo not found" {
			return response.NotFound(c, "Photo not found", constants.ErrCodeNotificationNotFound)
		}
		if err.Error() == "not authorized to delete this photo" {
			return response.Forbidden(c, "Not authorized to delete this photo", constants.ErrCodeNotAuthorized)
		}
		logger.LogWithContext(traceID, userID).Errorw("Photo deletion failed", "error", err)
		return response.InternalError(c, "Failed to delete photo", constants.ErrCodeDeleteFailed)
	}

	logger.LogWithContext(traceID, userID).Infow("Activity photo deleted", "photo_id", photoID)
	return response.Success(c, "Photo deleted successfully")
}

// GetPhotos retrieves activity photos for a user and date
// @Summary Get activity photos
// @Description Get photos for a user on a specific date. Records views for other users' photos.
// @Tags Activity Photos
// @Produce json
// @Security BearerAuth
// @Param user_id query int true "User ID"
// @Param date query string true "Date (YYYY-MM-DD)"
// @Success 200 {object} map[string]interface{} "Photos list"
// @Failure 400 {object} dto.ErrorResponse "Invalid request"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Failure 403 {object} dto.ErrorResponse "Not authorized to view photos"
// @Router /activity-photos [get]
func (h *ActivityPhotoHandler) GetPhotos(c *fiber.Ctx) error {
	viewerID := getUserID(c)
	traceID := getTraceID(c)

	// Parse query params
	targetUserIDStr := c.Query("user_id")
	dateStr := c.Query("date")

	if targetUserIDStr == "" || dateStr == "" {
		return response.BadRequest(c, "user_id and date are required", constants.ErrCodeMissingFields)
	}

	targetUserID, err := strconv.ParseUint(targetUserIDStr, 10, 32)
	if err != nil {
		return response.BadRequest(c, "Invalid user_id", constants.ErrCodeInvalidRequest)
	}

	photoDate, err := time.Parse(constants.DateFormat, dateStr)
	if err != nil {
		return response.BadRequest(c, "Invalid date format, use YYYY-MM-DD", constants.ErrCodeInvalidDate)
	}

	// Check if viewer can see target's stories
	canView, err := h.photoSvc.CanViewStories(c.Context(), viewerID, uint(targetUserID))
	if err != nil {
		logger.LogWithContext(traceID, viewerID).Errorw("Failed to check story access", "error", err)
		return response.InternalError(c, "Failed to check access", constants.ErrCodeServerError)
	}
	if !canView {
		return response.Forbidden(c, "You must follow this user to view their stories", constants.ErrCodeNotAuthorized)
	}

	// Get photos
	photos, err := h.photoSvc.GetByUserAndDate(c.Context(), uint(targetUserID), photoDate)
	if err != nil {
		logger.LogWithContext(traceID, viewerID).Errorw("Failed to get photos", "error", err)
		return response.InternalError(c, "Failed to get photos", constants.ErrCodeFetchFailed)
	}

	// Record views for other users' photos
	if viewerID != uint(targetUserID) {
		for _, photo := range photos {
			_ = h.photoSvc.RecordView(c.Context(), viewerID, photo.ID)
		}
	}

	return response.JSON(c, fiber.Map{
		"success": true,
		"photos":  photos,
	})
}

// GetFollowingStories retrieves story groups from followed users
// @Summary Get following users' stories
// @Description Get photo stories from users the current user follows for a specific date
// @Tags Activity Photos
// @Produce json
// @Security BearerAuth
// @Param date query string true "Date (YYYY-MM-DD)"
// @Param limit query int false "Max users to return (default 20)"
// @Success 200 {object} map[string]interface{} "Story groups"
// @Failure 400 {object} dto.ErrorResponse "Invalid request"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Router /activity-photos/following [get]
func (h *ActivityPhotoHandler) GetFollowingStories(c *fiber.Ctx) error {
	viewerID := getUserID(c)
	traceID := getTraceID(c)

	dateStr := c.Query("date")
	if dateStr == "" {
		return response.BadRequest(c, "date is required", constants.ErrCodeMissingFields)
	}

	photoDate, err := time.Parse(constants.DateFormat, dateStr)
	if err != nil {
		return response.BadRequest(c, "Invalid date format, use YYYY-MM-DD", constants.ErrCodeInvalidDate)
	}

	limit := 20
	if limitStr := c.Query("limit"); limitStr != "" {
		if parsed, err := strconv.Atoi(limitStr); err == nil && parsed > 0 && parsed <= 50 {
			limit = parsed
		}
	}

	stories, err := h.photoSvc.GetFollowingStories(c.Context(), viewerID, photoDate, limit)
	if err != nil {
		logger.LogWithContext(traceID, viewerID).Errorw("Failed to get following stories", "error", err)
		return response.InternalError(c, "Failed to get stories", constants.ErrCodeFetchFailed)
	}

	return response.JSON(c, fiber.Map{
		"success": true,
		"stories": stories,
	})
}

// RecordView records that a user viewed a photo
// @Summary Record photo view
// @Description Record that the current user viewed a photo
// @Tags Activity Photos
// @Produce json
// @Security BearerAuth
// @Param id path int true "Photo ID"
// @Success 200 {object} map[string]interface{} "View recorded"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Failure 404 {object} dto.ErrorResponse "Photo not found"
// @Router /activity-photo/{id}/view [post]
func (h *ActivityPhotoHandler) RecordView(c *fiber.Ctx) error {
	userID := getUserID(c)
	traceID := getTraceID(c)

	// Parse photo ID
	photoIDStr := c.Params("id")
	photoID, err := strconv.ParseUint(photoIDStr, 10, 32)
	if err != nil {
		return response.BadRequest(c, "Invalid photo ID", constants.ErrCodeInvalidRequest)
	}

	err = h.photoSvc.RecordView(c.Context(), userID, uint(photoID))
	if err != nil {
		if err.Error() == "photo not found" {
			return response.NotFound(c, "Photo not found", constants.ErrCodeNotificationNotFound)
		}
		// Don't fail silently - owner shouldn't record view on their own photo
		if err.Error() == "cannot record view on own photo" {
			return response.JSON(c, fiber.Map{
				"success": true,
				"message": "skipped - own photo",
			})
		}
		logger.LogWithContext(traceID, userID).Errorw("Failed to record view", "error", err, "photo_id", photoID)
		return response.InternalError(c, "Failed to record view", constants.ErrCodeServerError)
	}

	return response.JSON(c, fiber.Map{
		"success": true,
	})
}

// GetPhotoViewers retrieves viewers of a photo
// @Summary Get photo viewers
// @Description Get list of users who viewed a photo (owner only)
// @Tags Activity Photos
// @Produce json
// @Security BearerAuth
// @Param id path int true "Photo ID"
// @Param limit query int false "Max results (default 20)"
// @Param offset query int false "Offset for pagination"
// @Success 200 {object} map[string]interface{} "Viewers list"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Failure 403 {object} dto.ErrorResponse "Not photo owner"
// @Failure 404 {object} dto.ErrorResponse "Photo not found"
// @Router /activity-photo/{id}/viewers [get]
func (h *ActivityPhotoHandler) GetPhotoViewers(c *fiber.Ctx) error {
	userID := getUserID(c)
	traceID := getTraceID(c)

	// Parse photo ID
	photoIDStr := c.Params("id")
	photoID, err := strconv.ParseUint(photoIDStr, 10, 32)
	if err != nil {
		return response.BadRequest(c, "Invalid photo ID", constants.ErrCodeInvalidRequest)
	}

	limit := 20
	if limitStr := c.Query("limit"); limitStr != "" {
		if parsed, err := strconv.Atoi(limitStr); err == nil && parsed > 0 && parsed <= 100 {
			limit = parsed
		}
	}

	offset := 0
	if offsetStr := c.Query("offset"); offsetStr != "" {
		if parsed, err := strconv.Atoi(offsetStr); err == nil && parsed >= 0 {
			offset = parsed
		}
	}

	viewers, total, err := h.photoSvc.GetViewers(c.Context(), uint(photoID), userID, limit, offset)
	if err != nil {
		if err.Error() == "photo not found" {
			return response.NotFound(c, "Photo not found", constants.ErrCodeNotificationNotFound)
		}
		if err.Error() == "not authorized to view photo viewers" {
			return response.Forbidden(c, "Only the photo owner can view viewers", constants.ErrCodeNotAuthorized)
		}
		logger.LogWithContext(traceID, userID).Errorw("Failed to get photo viewers", "error", err)
		return response.InternalError(c, "Failed to get viewers", constants.ErrCodeFetchFailed)
	}

	return response.JSON(c, fiber.Map{
		"success": true,
		"viewers": viewers,
		"total":   total,
	})
}

// LikePhoto handles liking a photo
// @Summary Like a photo
// @Description Like a story photo (also records view)
// @Tags Activity Photos
// @Produce json
// @Security BearerAuth
// @Param id path int true "Photo ID"
// @Success 200 {object} map[string]interface{} "Photo liked"
// @Failure 400 {object} dto.ErrorResponse "Cannot like own photo"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Failure 403 {object} dto.ErrorResponse "Must follow user"
// @Failure 404 {object} dto.ErrorResponse "Photo not found"
// @Router /activity-photo/{id}/like [post]
func (h *ActivityPhotoHandler) LikePhoto(c *fiber.Ctx) error {
	userID := getUserID(c)
	traceID := getTraceID(c)

	// Parse photo ID
	photoIDStr := c.Params("id")
	photoID, err := strconv.ParseUint(photoIDStr, 10, 32)
	if err != nil {
		return response.BadRequest(c, "Invalid photo ID", constants.ErrCodeInvalidRequest)
	}

	err = h.photoSvc.LikePhoto(c.Context(), userID, uint(photoID))
	if err != nil {
		if err.Error() == "photo not found" {
			return response.NotFound(c, "Photo not found", constants.ErrCodeNotificationNotFound)
		}
		if err.Error() == "cannot like own photo" {
			return response.BadRequest(c, "Cannot like your own photo", constants.ErrCodeInvalidRequest)
		}
		if err.Error() == "must follow user to like their photos" {
			return response.Forbidden(c, "You must follow this user to like their photos", constants.ErrCodeNotAuthorized)
		}
		logger.LogWithContext(traceID, userID).Errorw("Failed to like photo", "error", err, "photo_id", photoID)
		return response.InternalError(c, "Failed to like photo", constants.ErrCodeServerError)
	}

	logger.LogWithContext(traceID, userID).Infow("Photo liked", "photo_id", photoID)
	return response.JSON(c, fiber.Map{
		"success": true,
	})
}

// UnlikePhoto handles unliking a photo
// @Summary Unlike a photo
// @Description Remove like from a story photo
// @Tags Activity Photos
// @Produce json
// @Security BearerAuth
// @Param id path int true "Photo ID"
// @Success 200 {object} map[string]interface{} "Photo unliked"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Failure 404 {object} dto.ErrorResponse "Photo not found"
// @Router /activity-photo/{id}/like [delete]
func (h *ActivityPhotoHandler) UnlikePhoto(c *fiber.Ctx) error {
	userID := getUserID(c)
	traceID := getTraceID(c)

	// Parse photo ID
	photoIDStr := c.Params("id")
	photoID, err := strconv.ParseUint(photoIDStr, 10, 32)
	if err != nil {
		return response.BadRequest(c, "Invalid photo ID", constants.ErrCodeInvalidRequest)
	}

	err = h.photoSvc.UnlikePhoto(c.Context(), userID, uint(photoID))
	if err != nil {
		if err.Error() == "photo not found" {
			return response.NotFound(c, "Photo not found", constants.ErrCodeNotificationNotFound)
		}
		logger.LogWithContext(traceID, userID).Errorw("Failed to unlike photo", "error", err, "photo_id", photoID)
		return response.InternalError(c, "Failed to unlike photo", constants.ErrCodeServerError)
	}

	logger.LogWithContext(traceID, userID).Infow("Photo unliked", "photo_id", photoID)
	return response.JSON(c, fiber.Map{
		"success": true,
	})
}

// GetPhotoInteractions retrieves combined viewers and likers of a photo
// @Summary Get photo interactions
// @Description Get combined list of viewers and likers with interaction type (owner only)
// @Tags Activity Photos
// @Produce json
// @Security BearerAuth
// @Param id path int true "Photo ID"
// @Param limit query int false "Max results (default 20)"
// @Param offset query int false "Offset for pagination"
// @Success 200 {object} map[string]interface{} "Interactions list"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Failure 403 {object} dto.ErrorResponse "Not photo owner"
// @Failure 404 {object} dto.ErrorResponse "Photo not found"
// @Router /activity-photo/{id}/interactions [get]
func (h *ActivityPhotoHandler) GetPhotoInteractions(c *fiber.Ctx) error {
	userID := getUserID(c)
	traceID := getTraceID(c)

	// Parse photo ID
	photoIDStr := c.Params("id")
	photoID, err := strconv.ParseUint(photoIDStr, 10, 32)
	if err != nil {
		return response.BadRequest(c, "Invalid photo ID", constants.ErrCodeInvalidRequest)
	}

	limit := 20
	if limitStr := c.Query("limit"); limitStr != "" {
		if parsed, err := strconv.Atoi(limitStr); err == nil && parsed > 0 && parsed <= 100 {
			limit = parsed
		}
	}

	offset := 0
	if offsetStr := c.Query("offset"); offsetStr != "" {
		if parsed, err := strconv.Atoi(offsetStr); err == nil && parsed >= 0 {
			offset = parsed
		}
	}

	interactions, total, err := h.photoSvc.GetPhotoInteractions(c.Context(), uint(photoID), userID, limit, offset)
	if err != nil {
		if err.Error() == "photo not found" {
			return response.NotFound(c, "Photo not found", constants.ErrCodeNotificationNotFound)
		}
		if err.Error() == "not authorized to view photo interactions" {
			return response.Forbidden(c, "Only the photo owner can view interactions", constants.ErrCodeNotAuthorized)
		}
		logger.LogWithContext(traceID, userID).Errorw("Failed to get photo interactions", "error", err)
		return response.InternalError(c, "Failed to get interactions", constants.ErrCodeFetchFailed)
	}

	return response.JSON(c, fiber.Map{
		"success":      true,
		"interactions": interactions,
		"total":        total,
	})
}

// GetPhotoLikeStatus retrieves like status and count for a photo
// @Summary Get photo like status
// @Description Get whether current user has liked a photo and total like count
// @Tags Activity Photos
// @Produce json
// @Security BearerAuth
// @Param id path int true "Photo ID"
// @Success 200 {object} map[string]interface{} "Like status"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Failure 404 {object} dto.ErrorResponse "Photo not found"
// @Router /activity-photo/{id}/like-status [get]
func (h *ActivityPhotoHandler) GetPhotoLikeStatus(c *fiber.Ctx) error {
	userID := getUserID(c)
	traceID := getTraceID(c)

	// Parse photo ID
	photoIDStr := c.Params("id")
	photoID, err := strconv.ParseUint(photoIDStr, 10, 32)
	if err != nil {
		return response.BadRequest(c, "Invalid photo ID", constants.ErrCodeInvalidRequest)
	}

	// Check if user has liked
	liked, err := h.photoSvc.HasLikedPhoto(c.Context(), userID, uint(photoID))
	if err != nil {
		logger.LogWithContext(traceID, userID).Errorw("Failed to get like status", "error", err, "photo_id", photoID)
		return response.InternalError(c, "Failed to get like status", constants.ErrCodeFetchFailed)
	}

	// Get like count
	likeCount, err := h.photoSvc.GetPhotoLikeCount(c.Context(), uint(photoID))
	if err != nil {
		logger.LogWithContext(traceID, userID).Errorw("Failed to get like count", "error", err, "photo_id", photoID)
		return response.InternalError(c, "Failed to get like count", constants.ErrCodeFetchFailed)
	}

	return response.JSON(c, fiber.Map{
		"success":    true,
		"liked":      liked,
		"like_count": likeCount,
	})
}
