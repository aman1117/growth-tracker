package handlers

import (
	"context"
	"encoding/json"
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

// LikeHandler handles like-related requests
type LikeHandler struct {
	likeRepo        *repository.LikeRepository
	authSvc         *services.AuthService
	profileSvc      *services.ProfileService
	notificationSvc *services.NotificationService
}

// NewLikeHandler creates a new LikeHandler
func NewLikeHandler(likeRepo *repository.LikeRepository, authSvc *services.AuthService, profileSvc *services.ProfileService, notificationSvc *services.NotificationService) *LikeHandler {
	return &LikeHandler{
		likeRepo:        likeRepo,
		authSvc:         authSvc,
		profileSvc:      profileSvc,
		notificationSvc: notificationSvc,
	}
}

// LikeDay handles liking a user's day
// @Summary Like a user's day
// @Description Like another user's day (only public profiles can be liked)
// @Tags Likes
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param request body dto.LikeDayRequest true "Like request"
// @Success 200 {object} dto.LikeActionResponse "Like successful"
// @Failure 400 {object} dto.ErrorResponse "Validation error"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Failure 403 {object} dto.ErrorResponse "Private account"
// @Router /like-day [post]
func (h *LikeHandler) LikeDay(c *fiber.Ctx) error {
	var req dto.LikeDayRequest
	if err := c.BodyParser(&req); err != nil {
		return response.InvalidRequest(c)
	}

	if req.Username == "" || req.Date == "" {
		return response.BadRequest(c, "Username and date are required", constants.ErrCodeMissingFields)
	}

	userID := getUserID(c)
	currentUsername := getUsername(c)
	log := logger.LogWithContext(getTraceID(c), userID)

	log.Infow("LikeDay request received",
		"current_user_id", userID,
		"current_username", currentUsername,
		"target_username", req.Username,
		"date", req.Date,
	)

	// Parse date
	date, err := time.Parse(constants.DateFormat, req.Date)
	if err != nil {
		log.Warnw("Invalid date format", "date", req.Date, "error", err)
		return response.BadRequest(c, "Invalid date format, use YYYY-MM-DD", constants.ErrCodeInvalidDate)
	}
	date = date.Truncate(24 * time.Hour)

	// Find the target user
	targetUser, err := h.authSvc.GetUserByUsername(req.Username)
	if err != nil {
		log.Errorw("Failed to find target user", "target_username", req.Username, "error", err)
		return response.BadRequest(c, "Failed to find user", constants.ErrCodeDatabaseError)
	}
	if targetUser == nil {
		log.Warnw("Target user not found", "target_username", req.Username)
		return response.BadRequest(c, "User not found", constants.ErrCodeUserNotFound)
	}

	log.Infow("Target user found",
		"target_user_id", targetUser.ID,
		"target_username", targetUser.Username,
		"target_is_private", targetUser.IsPrivate,
	)

	// Check if target user's profile is public (skip for own profile)
	if targetUser.IsPrivate && targetUser.ID != userID {
		log.Warnw("Cannot like private account", "target_user_id", targetUser.ID)
		return response.Forbidden(c, "Cannot like a private account's day", constants.ErrCodeAccountPrivate)
	}

	// Check if already liked
	alreadyLiked, err := h.likeRepo.HasLiked(userID, targetUser.ID, date)
	if err != nil {
		log.Errorw("Failed to check like status",
			"liker_id", userID,
			"liked_user_id", targetUser.ID,
			"date", date.Format("2006-01-02"),
			"error", err,
		)
		return response.InternalError(c, "Failed to process like", constants.ErrCodeDatabaseError)
	}

	log.Infow("HasLiked check result",
		"liker_id", userID,
		"liked_user_id", targetUser.ID,
		"date", date.Format("2006-01-02"),
		"already_liked", alreadyLiked,
	)

	if alreadyLiked {
		// Return current count without error
		count, _ := h.likeRepo.CountLikesForDay(targetUser.ID, date)
		log.Infow("User already liked this day, returning existing state",
			"count", count,
		)
		return c.JSON(dto.LikeActionResponse{
			Success:  true,
			Liked:    true,
			NewCount: count,
		})
	}

	// Create like
	log.Infow("Creating new like",
		"liker_id", userID,
		"liked_user_id", targetUser.ID,
		"date", date.Format("2006-01-02"),
	)
	if err := h.likeRepo.Create(userID, targetUser.ID, date); err != nil {
		log.Errorw("Failed to create like",
			"liker_id", userID,
			"liked_user_id", targetUser.ID,
			"date", date.Format("2006-01-02"),
			"error", err,
		)
		return response.InternalError(c, "Failed to like day", constants.ErrCodeCreateFailed)
	}

	// Invalidate likes cache
	if redis.IsAvailable() {
		ctx := context.Background()
		dateStr := date.Format(constants.DateFormat)
		if err := redis.InvalidateLikesCache(ctx, targetUser.ID, dateStr); err != nil {
			log.Warnw("Failed to invalidate likes cache",
				"liked_user_id", targetUser.ID,
				"date", dateStr,
				"error", err,
			)
		}
	}

	// Send notification to the target user (if not liking own day)
	// Uses NotifyLikeReceived which handles dedupe via NotificationDedupe table
	if targetUser.ID != userID && h.notificationSvc != nil {
		// Get current user's avatar for the notification
		var likerAvatar string
		if profile, err := h.profileSvc.GetProfile(userID); err == nil && profile != nil && profile.ProfilePic != nil {
			likerAvatar = *profile.ProfilePic
		}

		if err := h.notificationSvc.NotifyLikeReceived(
			context.Background(),
			targetUser.ID,   // recipient
			userID,          // liker
			currentUsername, // liker username
			likerAvatar,     // liker avatar
			req.Date,        // liked date
		); err != nil {
			log.Warnw("Failed to create like notification",
				"target_user_id", targetUser.ID,
				"liker_id", userID,
				"error", err,
			)
		}
	}

	// Get new count
	count, _ := h.likeRepo.CountLikesForDay(targetUser.ID, date)

	log.Infow("Like created successfully",
		"liker_id", userID,
		"liked_user_id", targetUser.ID,
		"target_username", req.Username,
		"date", req.Date,
		"new_count", count,
	)
	return c.JSON(dto.LikeActionResponse{
		Success:  true,
		Liked:    true,
		NewCount: count,
	})
}

// UnlikeDay handles unliking a user's day
// @Summary Unlike a user's day
// @Description Remove a like from a user's day
// @Tags Likes
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param request body dto.LikeDayRequest true "Unlike request"
// @Success 200 {object} dto.LikeActionResponse "Unlike successful"
// @Failure 400 {object} dto.ErrorResponse "Validation error"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Router /unlike-day [post]
func (h *LikeHandler) UnlikeDay(c *fiber.Ctx) error {
	var req dto.LikeDayRequest
	if err := c.BodyParser(&req); err != nil {
		return response.InvalidRequest(c)
	}

	if req.Username == "" || req.Date == "" {
		return response.BadRequest(c, "Username and date are required", constants.ErrCodeMissingFields)
	}

	userID := getUserID(c)
	currentUsername := getUsername(c)
	log := logger.LogWithContext(getTraceID(c), userID)

	log.Infow("UnlikeDay request received",
		"current_user_id", userID,
		"current_username", currentUsername,
		"target_username", req.Username,
		"date", req.Date,
	)

	// Parse date
	date, err := time.Parse(constants.DateFormat, req.Date)
	if err != nil {
		return response.BadRequest(c, "Invalid date format, use YYYY-MM-DD", constants.ErrCodeInvalidDate)
	}
	date = date.Truncate(24 * time.Hour)

	// Find the target user
	targetUser, err := h.authSvc.GetUserByUsername(req.Username)
	if err != nil {
		log.Errorw("Failed to find user", "target_username", req.Username, "error", err)
		return response.BadRequest(c, "Failed to find user", constants.ErrCodeDatabaseError)
	}
	if targetUser == nil {
		log.Warnw("Target user not found", "target_username", req.Username)
		return response.BadRequest(c, "User not found", constants.ErrCodeUserNotFound)
	}

	log.Infow("Attempting to delete like",
		"liker_id", userID,
		"liked_user_id", targetUser.ID,
		"date", date.Format("2006-01-02"),
	)

	// Delete like
	if err := h.likeRepo.Delete(userID, targetUser.ID, date); err != nil {
		log.Warnw("Like not found or delete failed",
			"liker_id", userID,
			"liked_user_id", targetUser.ID,
			"date", date.Format("2006-01-02"),
			"error", err,
		)
		// If like not found, that's okay - just return success with current count
		count, _ := h.likeRepo.CountLikesForDay(targetUser.ID, date)
		return c.JSON(dto.LikeActionResponse{
			Success:  true,
			Liked:    false,
			NewCount: count,
		})
	}

	// Invalidate likes cache
	if redis.IsAvailable() {
		ctx := context.Background()
		dateStr := date.Format(constants.DateFormat)
		if err := redis.InvalidateLikesCache(ctx, targetUser.ID, dateStr); err != nil {
			log.Warnw("Failed to invalidate likes cache",
				"liked_user_id", targetUser.ID,
				"date", dateStr,
				"error", err,
			)
		}
	}

	// Get new count
	count, _ := h.likeRepo.CountLikesForDay(targetUser.ID, date)

	log.Infow("Like deleted successfully",
		"liker_id", userID,
		"liked_user_id", targetUser.ID,
		"target_username", req.Username,
		"date", req.Date,
		"new_count", count,
	)
	return c.JSON(dto.LikeActionResponse{
		Success:  true,
		Liked:    false,
		NewCount: count,
	})
}

// GetLikes handles getting likes for a user's day
// @Summary Get likes for a day
// @Description Get all likes for a specific user's day (only visible if profile is public or it's your own day)
// @Tags Likes
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param request body dto.GetLikesRequest true "Get likes request"
// @Success 200 {object} dto.LikesResponse "Likes data"
// @Failure 400 {object} dto.ErrorResponse "Validation error"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Failure 403 {object} dto.ErrorResponse "Private account"
// @Router /get-likes [post]
func (h *LikeHandler) GetLikes(c *fiber.Ctx) error {
	var req dto.GetLikesRequest
	if err := c.BodyParser(&req); err != nil {
		return response.InvalidRequest(c)
	}

	if req.Username == "" || req.Date == "" {
		return response.BadRequest(c, "Username and date are required", constants.ErrCodeMissingFields)
	}

	userID := getUserID(c)
	currentUsername := getUsername(c)
	log := logger.LogWithContext(getTraceID(c), userID)

	log.Infow("GetLikes request received",
		"current_user_id", userID,
		"current_username", currentUsername,
		"target_username", req.Username,
		"date", req.Date,
	)

	// Parse date
	date, err := time.Parse(constants.DateFormat, req.Date)
	if err != nil {
		return response.BadRequest(c, "Invalid date format, use YYYY-MM-DD", constants.ErrCodeInvalidDate)
	}
	date = date.Truncate(24 * time.Hour)

	// Find the target user
	targetUser, err := h.authSvc.GetUserByUsername(req.Username)
	if err != nil {
		log.Errorw("Failed to find user", "target_username", req.Username, "error", err)
		return response.BadRequest(c, "Failed to find user", constants.ErrCodeDatabaseError)
	}
	if targetUser == nil {
		log.Warnw("Target user not found", "target_username", req.Username)
		return response.BadRequest(c, "User not found", constants.ErrCodeUserNotFound)
	}

	log.Infow("Target user found",
		"target_user_id", targetUser.ID,
		"target_username", targetUser.Username,
		"target_is_private", targetUser.IsPrivate,
	)

	// Check if user can view likes (either public profile or own profile)
	if targetUser.IsPrivate && targetUser.ID != userID {
		log.Warnw("Cannot view likes for private account", "target_user_id", targetUser.ID)
		return response.Forbidden(c, "Cannot view likes for a private account", constants.ErrCodeAccountPrivate)
	}

	dateStr := date.Format(constants.DateFormat)
	ctx := context.Background()
	var likerDTOs []dto.LikerDTO

	// Try to get likes from cache
	if redis.IsAvailable() {
		cachedData, err := redis.GetLikesCache(ctx, targetUser.ID, dateStr)
		if err != nil {
			log.Warnw("Failed to get likes from cache",
				"liked_user_id", targetUser.ID,
				"date", dateStr,
				"error", err,
			)
		} else if cachedData != "" {
			// Cache hit - unmarshal the cached data
			if err := json.Unmarshal([]byte(cachedData), &likerDTOs); err != nil {
				log.Warnw("Failed to unmarshal cached likes data",
					"liked_user_id", targetUser.ID,
					"date", dateStr,
					"error", err,
				)
				likerDTOs = nil // Reset to fetch from DB
			} else {
				log.Infow("GetLikes cache hit",
					"liked_user_id", targetUser.ID,
					"date", dateStr,
					"likes_count", len(likerDTOs),
				)
			}
		}
	}

	// If cache miss or cache unavailable, fetch from database
	if likerDTOs == nil {
		likes, err := h.likeRepo.GetLikesForDay(targetUser.ID, date)
		if err != nil {
			log.Errorw("Failed to get likes",
				"liked_user_id", targetUser.ID,
				"date", dateStr,
				"error", err,
			)
			return response.InternalError(c, "Failed to get likes", constants.ErrCodeFetchFailed)
		}

		// Convert to DTOs
		likerDTOs = make([]dto.LikerDTO, len(likes))
		for i, like := range likes {
			likerDTOs[i] = dto.LikerDTO{
				ID:         like.LikerID,
				Username:   like.Username,
				ProfilePic: like.ProfilePic,
				IsVerified: like.IsVerified,
				LikedAt:    like.CreatedAt.Format(time.RFC3339),
			}
		}

		// Cache the result
		if redis.IsAvailable() {
			cacheData, err := json.Marshal(likerDTOs)
			if err != nil {
				log.Warnw("Failed to marshal likes data for caching",
					"liked_user_id", targetUser.ID,
					"date", dateStr,
					"error", err,
				)
			} else {
				if err := redis.SetLikesCache(ctx, targetUser.ID, dateStr, string(cacheData)); err != nil {
					log.Warnw("Failed to set likes cache",
						"liked_user_id", targetUser.ID,
						"date", dateStr,
						"error", err,
					)
				} else {
					log.Infow("GetLikes cached successfully",
						"liked_user_id", targetUser.ID,
						"date", dateStr,
						"likes_count", len(likerDTOs),
					)
				}
			}
		}
	}

	// Check if current user has liked (not cached as it's user-specific)
	userHasLiked, hasLikedErr := h.likeRepo.HasLiked(userID, targetUser.ID, date)
	if hasLikedErr != nil {
		log.Errorw("Failed to check if user has liked",
			"liker_id", userID,
			"liked_user_id", targetUser.ID,
			"date", dateStr,
			"error", hasLikedErr,
		)
	}

	log.Infow("GetLikes result",
		"current_user_id", userID,
		"target_user_id", targetUser.ID,
		"date", dateStr,
		"likes_count", len(likerDTOs),
		"user_has_liked", userHasLiked,
	)

	return c.JSON(dto.LikesResponse{
		Success:      true,
		Data:         likerDTOs,
		Count:        int64(len(likerDTOs)),
		UserHasLiked: userHasLiked,
	})
}
