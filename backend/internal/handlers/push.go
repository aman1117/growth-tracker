package handlers

import (
	"time"

	"github.com/aman1117/backend/internal/config"
	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/dto"
	"github.com/aman1117/backend/internal/logger"
	"github.com/aman1117/backend/internal/repository"
	"github.com/aman1117/backend/internal/response"
	"github.com/aman1117/backend/pkg/models"
	"github.com/gofiber/fiber/v2"
)

const (
	// MaxPayloadSize is the maximum size of push notification payload (4KB)
	MaxPayloadSize = 4096
	// MaxEndpointLength is the maximum length of a subscription endpoint
	MaxEndpointLength = 2048
	// MaxUserAgentLength is the maximum length of user agent string
	MaxUserAgentLength = 500
	// MaxPlatformLength is the maximum length of platform string
	MaxPlatformLength = 50
	// MaxBrowserLength is the maximum length of browser string
	MaxBrowserLength = 50
)

// PushHandler handles push notification subscription requests
type PushHandler struct {
	pushRepo *repository.PushRepository
	config   *config.Config
}

// NewPushHandler creates a new PushHandler
func NewPushHandler(pushRepo *repository.PushRepository, cfg *config.Config) *PushHandler {
	return &PushHandler{
		pushRepo: pushRepo,
		config:   cfg,
	}
}

// GetVapidPublicKey returns the VAPID public key for push subscription
// @Summary Get VAPID public key
// @Description Get the VAPID public key needed for push subscription registration
// @Tags Push Notifications
// @Accept json
// @Produce json
// @Success 200 {object} dto.VapidPublicKeyResponse "VAPID public key"
// @Router /push/vapid-public-key [get]
func (h *PushHandler) GetVapidPublicKey(c *fiber.Ctx) error {
	log := logger.LogWithContext(getTraceID(c), 0)

	if h.config.WebPush.VapidPublicKey == "" {
		log.Errorw("VAPID public key not configured")
		return response.InternalError(c, "Push notifications not configured", constants.ErrCodeConfigError)
	}

	return c.JSON(dto.VapidPublicKeyResponse{
		Success:   true,
		KeyID:     h.config.WebPush.VapidKeyID,
		PublicKey: h.config.WebPush.VapidPublicKey,
	})
}

// RegisterSubscription registers a new push subscription for the authenticated user
// @Summary Register push subscription
// @Description Register a new Web Push subscription for the authenticated user's device
// @Tags Push Notifications
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param subscription body dto.RegisterPushSubscriptionRequest true "Push subscription data"
// @Success 200 {object} dto.PushSubscriptionResponse "Subscription registered"
// @Failure 400 {object} dto.ErrorResponse "Invalid request"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Failure 409 {object} dto.ErrorResponse "Endpoint conflict"
// @Router /push/subscriptions [post]
func (h *PushHandler) RegisterSubscription(c *fiber.Ctx) error {
	userID := getUserID(c)
	log := logger.LogWithContext(getTraceID(c), userID)

	var req dto.RegisterPushSubscriptionRequest
	if err := c.BodyParser(&req); err != nil {
		log.Warnw("Invalid request body", "error", err)
		return response.BadRequest(c, "Invalid request body", constants.ErrCodeInvalidInput)
	}

	// Validate required fields
	if req.Subscription.Endpoint == "" {
		return response.BadRequest(c, "Endpoint is required", constants.ErrCodeInvalidInput)
	}
	if req.Subscription.Keys.P256dh == "" || req.Subscription.Keys.Auth == "" {
		return response.BadRequest(c, "Keys (p256dh and auth) are required", constants.ErrCodeInvalidInput)
	}

	// Validate endpoint length
	if len(req.Subscription.Endpoint) > MaxEndpointLength {
		return response.BadRequest(c, "Endpoint too long", constants.ErrCodeInvalidInput)
	}

	// Validate endpoint is a valid HTTPS URL (push endpoints must be HTTPS)
	if !isValidPushEndpoint(req.Subscription.Endpoint) {
		return response.BadRequest(c, "Invalid push endpoint URL", constants.ErrCodeInvalidInput)
	}

	// Validate VAPID key ID matches current key
	if req.KeyID != "" && req.KeyID != h.config.WebPush.VapidKeyID {
		log.Warnw("VAPID key ID mismatch", "provided", req.KeyID, "expected", h.config.WebPush.VapidKeyID)
		// Allow registration but use current key ID
	}

	log.Infow("Registering push subscription",
		"endpoint_origin", extractOrigin(req.Subscription.Endpoint),
		"platform", req.Device.Platform,
		"browser", req.Device.Browser,
	)

	// Create subscription model
	sub := &models.PushSubscription{
		UserID:     userID,
		Endpoint:   req.Subscription.Endpoint,
		P256dh:     req.Subscription.Keys.P256dh,
		Auth:       req.Subscription.Keys.Auth,
		VapidKeyID: h.config.WebPush.VapidKeyID,
		Status:     models.PushSubscriptionStatusActive,
		UserAgent:  truncateString(req.Device.UserAgent, MaxUserAgentLength),
		Platform:   truncateString(req.Device.Platform, MaxPlatformLength),
		Browser:    truncateString(req.Device.Browser, MaxBrowserLength),
	}

	// Upsert subscription
	if err := h.pushRepo.UpsertSubscription(sub); err != nil {
		if err == repository.ErrEndpointConflict {
			log.Warnw("Endpoint registered to another user", "endpoint_origin", extractOrigin(req.Subscription.Endpoint))
			return response.Conflict(c, "Endpoint already registered to another user", constants.ErrCodeConflict)
		}
		log.Errorw("Failed to register subscription", "error", err)
		return response.InternalError(c, "Failed to register subscription", constants.ErrCodeDatabaseError)
	}

	// Ensure user has push preferences
	if _, err := h.pushRepo.GetOrCreatePreference(userID); err != nil {
		log.Warnw("Failed to create default push preferences", "error", err)
		// Non-fatal, continue
	}

	log.Infow("Push subscription registered successfully", "subscription_id", sub.ID)

	return c.JSON(dto.PushSubscriptionResponse{
		Success: true,
		Message: "Subscription registered successfully",
	})
}

// UnregisterSubscription removes a push subscription
// @Summary Unregister push subscription
// @Description Remove a Web Push subscription for the authenticated user
// @Tags Push Notifications
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param subscription body dto.UnregisterPushSubscriptionRequest true "Subscription endpoint to remove"
// @Success 200 {object} dto.SuccessResponse "Subscription removed"
// @Failure 400 {object} dto.ErrorResponse "Invalid request"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Router /push/subscriptions [delete]
func (h *PushHandler) UnregisterSubscription(c *fiber.Ctx) error {
	userID := getUserID(c)
	log := logger.LogWithContext(getTraceID(c), userID)

	var req dto.UnregisterPushSubscriptionRequest
	if err := c.BodyParser(&req); err != nil {
		log.Warnw("Invalid request body", "error", err)
		return response.BadRequest(c, "Invalid request body", constants.ErrCodeInvalidInput)
	}

	if req.Endpoint == "" {
		return response.BadRequest(c, "Endpoint is required", constants.ErrCodeInvalidInput)
	}

	log.Infow("Unregistering push subscription", "endpoint_origin", extractOrigin(req.Endpoint))

	if err := h.pushRepo.DeleteSubscription(req.Endpoint, userID); err != nil {
		log.Errorw("Failed to unregister subscription", "error", err)
		return response.InternalError(c, "Failed to unregister subscription", constants.ErrCodeDatabaseError)
	}

	log.Infow("Push subscription unregistered successfully")

	return c.JSON(dto.SuccessResponse{
		Success: true,
		Message: "Subscription removed",
	})
}

// GetPreferences returns the user's push notification preferences
// @Summary Get push preferences
// @Description Get push notification preferences for the authenticated user
// @Tags Push Notifications
// @Accept json
// @Produce json
// @Security BearerAuth
// @Success 200 {object} dto.PushPreferencesResponse "Push preferences"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Router /push/preferences [get]
func (h *PushHandler) GetPreferences(c *fiber.Ctx) error {
	userID := getUserID(c)
	log := logger.LogWithContext(getTraceID(c), userID)

	pref, err := h.pushRepo.GetOrCreatePreference(userID)
	if err != nil {
		log.Errorw("Failed to get push preferences", "error", err)
		return response.InternalError(c, "Failed to get preferences", constants.ErrCodeDatabaseError)
	}

	return c.JSON(dto.PushPreferencesResponse{
		Success:     true,
		Preferences: dto.PushPreferenceToDTO(pref),
	})
}

// UpdatePreferences updates the user's push notification preferences
// @Summary Update push preferences
// @Description Update push notification preferences for the authenticated user
// @Tags Push Notifications
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param preferences body dto.UpdatePushPreferencesRequest true "Preference updates"
// @Success 200 {object} dto.PushPreferencesResponse "Updated preferences"
// @Failure 400 {object} dto.ErrorResponse "Invalid request"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Router /push/preferences [put]
func (h *PushHandler) UpdatePreferences(c *fiber.Ctx) error {
	userID := getUserID(c)
	log := logger.LogWithContext(getTraceID(c), userID)

	var req dto.UpdatePushPreferencesRequest
	if err := c.BodyParser(&req); err != nil {
		log.Warnw("Invalid request body", "error", err)
		return response.BadRequest(c, "Invalid request body", constants.ErrCodeInvalidInput)
	}

	// Get existing preferences
	pref, err := h.pushRepo.GetOrCreatePreference(userID)
	if err != nil {
		log.Errorw("Failed to get push preferences", "error", err)
		return response.InternalError(c, "Failed to get preferences", constants.ErrCodeDatabaseError)
	}

	// Apply updates
	if req.PushEnabled != nil {
		pref.PushEnabled = *req.PushEnabled
	}
	if req.Preferences != nil {
		if pref.Preferences == nil {
			pref.Preferences = models.PushPreferences{}
		}
		for k, v := range req.Preferences {
			if !isValidNotificationType(k) {
				return response.BadRequest(c, "Invalid notification type: "+k, constants.ErrCodeInvalidInput)
			}
			pref.Preferences[k] = v
		}
	}
	if req.QuietHoursEnabled != nil {
		pref.QuietHoursEnabled = *req.QuietHoursEnabled
	}
	if req.QuietStart != nil {
		if !isValidTimeFormat(*req.QuietStart) {
			return response.BadRequest(c, "Invalid quiet_start format (expected HH:MM)", constants.ErrCodeInvalidInput)
		}
		pref.QuietStart = *req.QuietStart
	}
	if req.QuietEnd != nil {
		if !isValidTimeFormat(*req.QuietEnd) {
			return response.BadRequest(c, "Invalid quiet_end format (expected HH:MM)", constants.ErrCodeInvalidInput)
		}
		pref.QuietEnd = *req.QuietEnd
	}
	if req.Timezone != nil {
		if !isValidTimezone(*req.Timezone) {
			return response.BadRequest(c, "Invalid timezone", constants.ErrCodeInvalidInput)
		}
		pref.Timezone = *req.Timezone
	}

	// Validate quiet hours consistency: if enabled, both start and end must be set
	if pref.QuietHoursEnabled && (pref.QuietStart == "" || pref.QuietEnd == "") {
		return response.BadRequest(c, "Quiet hours requires both start and end times", constants.ErrCodeInvalidInput)
	}

	// Save updates
	if err := h.pushRepo.UpdatePreference(pref); err != nil {
		log.Errorw("Failed to update push preferences", "error", err)
		return response.InternalError(c, "Failed to update preferences", constants.ErrCodeDatabaseError)
	}

	log.Infow("Push preferences updated")

	return c.JSON(dto.PushPreferencesResponse{
		Success:     true,
		Preferences: dto.PushPreferenceToDTO(pref),
	})
}

// RunCleanup performs cleanup of stale push data (admin endpoint)
// @Summary Cleanup stale push data
// @Description Cleanup stale subscriptions, gone subscriptions, and old delivery logs
// @Tags Push Notifications
// @Accept json
// @Produce json
// @Security BearerAuth
// @Success 200 {object} dto.CleanupResponse "Cleanup results"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Router /push/cleanup [post]
func (h *PushHandler) RunCleanup(c *fiber.Ctx) error {
	log := logger.LogWithContext(getTraceID(c), 0)
	log.Info("Running push data cleanup")

	// Cleanup stale subscriptions (no success in 90 days)
	staleCount, err := h.pushRepo.CleanupStaleSubscriptions(90)
	if err != nil {
		log.Errorw("Failed to cleanup stale subscriptions", "error", err)
	}

	// Cleanup gone subscriptions older than 7 days
	goneCount, err := h.pushRepo.CleanupGoneSubscriptions(7)
	if err != nil {
		log.Errorw("Failed to cleanup gone subscriptions", "error", err)
	}

	// Cleanup delivery logs older than 30 days
	logsCount, err := h.pushRepo.CleanupOldDeliveryLogs(30)
	if err != nil {
		log.Errorw("Failed to cleanup old delivery logs", "error", err)
	}

	log.Infow("Push cleanup completed",
		"stale_subscriptions", staleCount,
		"gone_subscriptions", goneCount,
		"old_logs", logsCount,
	)

	return c.JSON(fiber.Map{
		"success":                     true,
		"stale_subscriptions_cleaned": staleCount,
		"gone_subscriptions_deleted":  goneCount,
		"old_logs_deleted":            logsCount,
	})
}

// extractOrigin extracts the origin from a URL for safe logging
func extractOrigin(url string) string {
	// Simple extraction - just get the first ~50 chars for logging
	if len(url) > 50 {
		return url[:50] + "..."
	}
	return url
}

// isValidTimeFormat validates "HH:MM" format
func isValidTimeFormat(s string) bool {
	if len(s) != 5 || s[2] != ':' {
		return false
	}
	hour := (s[0]-'0')*10 + (s[1] - '0')
	minute := (s[3]-'0')*10 + (s[4] - '0')
	return hour <= 23 && minute <= 59 && s[0] >= '0' && s[0] <= '2' && s[1] >= '0' && s[1] <= '9' && s[3] >= '0' && s[3] <= '5' && s[4] >= '0' && s[4] <= '9'
}

// isValidTimezone validates an IANA timezone using time.LoadLocation
func isValidTimezone(tz string) bool {
	if tz == "" || len(tz) > 50 {
		return false
	}
	_, err := time.LoadLocation(tz)
	return err == nil
}

// isValidPushEndpoint validates that the endpoint is a valid HTTPS URL
func isValidPushEndpoint(endpoint string) bool {
	// Push endpoints must be HTTPS URLs from known push services
	if len(endpoint) < 10 {
		return false
	}
	// Must start with https://
	if len(endpoint) < 8 || endpoint[:8] != "https://" {
		return false
	}
	return true
}

// isValidNotificationType checks if a notification type key is valid
func isValidNotificationType(notifType string) bool {
	validTypes := map[string]bool{
		"like_received":       true,
		"badge_unlocked":      true,
		"streak_milestone":    true,
		"streak_at_risk":      true,
		"system_announcement": true,
	}
	return validTypes[notifType]
}

// truncateString truncates a string to maxLen
func truncateString(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen]
}
