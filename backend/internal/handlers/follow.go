// Package handlers provides HTTP handlers for the follow system.
package handlers

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"strconv"
	"strings"
	"time"

	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/dto"
	"github.com/aman1117/backend/internal/logger"
	"github.com/aman1117/backend/internal/repository"
	"github.com/aman1117/backend/internal/response"
	"github.com/aman1117/backend/internal/services"
	"github.com/aman1117/backend/pkg/models"
	"github.com/gofiber/fiber/v2"
)

// FollowHandler handles follow-related HTTP requests
type FollowHandler struct {
	followSvc *services.FollowService
	userRepo  *repository.UserRepository
	notifSvc  *services.NotificationService
}

// NewFollowHandler creates a new FollowHandler
func NewFollowHandler(
	followSvc *services.FollowService,
	userRepo *repository.UserRepository,
	notifSvc *services.NotificationService,
) *FollowHandler {
	return &FollowHandler{
		followSvc: followSvc,
		userRepo:  userRepo,
		notifSvc:  notifSvc,
	}
}

// getUserID extracts user ID from fiber context
func getUserIDFromContext(c *fiber.Ctx) uint {
	userID, ok := c.Locals("user_id").(uint)
	if !ok {
		return 0
	}
	return userID
}

// ==================== Follow Actions ====================

// FollowUser handles POST /api/users/:targetId/follow
// @Summary Follow a user
// @Description Follow a user or send a follow request (for private accounts)
// @Tags Follow
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param targetId path int true "Target User ID"
// @Success 200 {object} dto.FollowActionResponse
// @Failure 400 {object} dto.ErrorResponse
// @Failure 401 {object} dto.ErrorResponse
// @Failure 404 {object} dto.ErrorResponse
// @Router /users/{targetId}/follow [post]
func (h *FollowHandler) FollowUser(c *fiber.Ctx) error {
	viewerID := getUserIDFromContext(c)
	if viewerID == 0 {
		return response.Unauthorized(c, "Authentication required", constants.ErrCodeUnauthorized)
	}

	targetID, err := strconv.ParseUint(c.Params("targetId"), 10, 32)
	if err != nil {
		return response.Error(c, fiber.StatusBadRequest, "Invalid target user ID", constants.ErrCodeInvalidRequest)
	}

	result, err := h.followSvc.Follow(context.Background(), viewerID, uint(targetID))
	if err != nil {
		errMsg := err.Error()
		if strings.Contains(errMsg, constants.ErrCodeCannotFollowSelf) {
			return response.Error(c, fiber.StatusBadRequest, "Cannot follow yourself", constants.ErrCodeCannotFollowSelf)
		}
		if strings.Contains(errMsg, constants.ErrCodeUserNotFound) {
			return response.Error(c, fiber.StatusNotFound, "User not found", constants.ErrCodeUserNotFound)
		}
		if strings.Contains(errMsg, constants.ErrCodeFollowLimitExceeded) {
			return response.Error(c, fiber.StatusBadRequest, errMsg, constants.ErrCodeFollowLimitExceeded)
		}
		if strings.Contains(errMsg, constants.ErrCodeDailyLimitExceeded) {
			return response.Error(c, fiber.StatusBadRequest, errMsg, constants.ErrCodeDailyLimitExceeded)
		}
		logger.Sugar.Errorw("Failed to follow user",
			"viewer_id", viewerID,
			"target_id", targetID,
			"error", err,
		)
		return response.Error(c, fiber.StatusInternalServerError, "Failed to follow user", constants.ErrCodeServerError)
	}

	// Send notifications
	go h.sendFollowNotification(c, viewerID, uint(targetID), result.State)

	return c.JSON(dto.FollowActionResponse{
		Success: true,
		State:   string(result.State),
		Message: result.Message,
	})
}

// UnfollowUser handles DELETE /api/users/:targetId/follow
// @Summary Unfollow a user
// @Description Unfollow a user
// @Tags Follow
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param targetId path int true "Target User ID"
// @Success 200 {object} dto.SuccessResponse
// @Failure 400 {object} dto.ErrorResponse
// @Failure 401 {object} dto.ErrorResponse
// @Router /users/{targetId}/follow [delete]
func (h *FollowHandler) UnfollowUser(c *fiber.Ctx) error {
	viewerID := getUserIDFromContext(c)
	if viewerID == 0 {
		return response.Unauthorized(c, "Authentication required", constants.ErrCodeUnauthorized)
	}

	targetID, err := strconv.ParseUint(c.Params("targetId"), 10, 32)
	if err != nil {
		return response.Error(c, fiber.StatusBadRequest, "Invalid target user ID", constants.ErrCodeInvalidRequest)
	}

	if err := h.followSvc.Unfollow(context.Background(), viewerID, uint(targetID)); err != nil {
		errMsg := err.Error()
		if strings.Contains(errMsg, constants.ErrCodeNotFollowing) {
			return response.Error(c, fiber.StatusBadRequest, "Not following this user", constants.ErrCodeNotFollowing)
		}
		logger.Sugar.Errorw("Failed to unfollow user",
			"viewer_id", viewerID,
			"target_id", targetID,
			"error", err,
		)
		return response.Error(c, fiber.StatusInternalServerError, "Failed to unfollow user", constants.ErrCodeServerError)
	}

	return c.JSON(dto.SuccessResponse{
		Success: true,
		Message: "Unfollowed successfully",
	})
}

// CancelFollowRequest handles POST /api/follow-requests/:targetId/cancel
// @Summary Cancel a follow request
// @Description Cancel an outgoing pending follow request
// @Tags Follow
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param targetId path int true "Target User ID"
// @Success 200 {object} dto.SuccessResponse
// @Failure 400 {object} dto.ErrorResponse
// @Failure 401 {object} dto.ErrorResponse
// @Router /follow-requests/{targetId}/cancel [post]
func (h *FollowHandler) CancelFollowRequest(c *fiber.Ctx) error {
	viewerID := getUserIDFromContext(c)
	if viewerID == 0 {
		return response.Unauthorized(c, "Authentication required", constants.ErrCodeUnauthorized)
	}

	targetID, err := strconv.ParseUint(c.Params("targetId"), 10, 32)
	if err != nil {
		return response.Error(c, fiber.StatusBadRequest, "Invalid target user ID", constants.ErrCodeInvalidRequest)
	}

	if err := h.followSvc.CancelRequest(context.Background(), viewerID, uint(targetID)); err != nil {
		errMsg := err.Error()
		if strings.Contains(errMsg, constants.ErrCodeNoFollowRequest) {
			return response.Error(c, fiber.StatusBadRequest, "No pending request found", constants.ErrCodeNoFollowRequest)
		}
		logger.Sugar.Errorw("Failed to cancel follow request",
			"viewer_id", viewerID,
			"target_id", targetID,
			"error", err,
		)
		return response.Error(c, fiber.StatusInternalServerError, "Failed to cancel request", constants.ErrCodeServerError)
	}

	return c.JSON(dto.SuccessResponse{
		Success: true,
		Message: "Follow request cancelled",
	})
}

// ==================== Request Management ====================

// GetIncomingRequests handles GET /api/me/follow-requests/incoming
// @Summary Get incoming follow requests
// @Description Get paginated list of pending follow requests
// @Tags Follow
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param cursor query string false "Pagination cursor"
// @Param limit query int false "Number of results" default(20)
// @Success 200 {object} dto.FollowRequestListResponse
// @Failure 401 {object} dto.ErrorResponse
// @Router /me/follow-requests/incoming [get]
func (h *FollowHandler) GetIncomingRequests(c *fiber.Ctx) error {
	viewerID := getUserIDFromContext(c)
	if viewerID == 0 {
		return response.Unauthorized(c, "Authentication required", constants.ErrCodeUnauthorized)
	}

	limit, _ := strconv.Atoi(c.Query("limit", "20"))
	cursor := decodeCursor(c.Query("cursor"))

	edges, hasMore, err := h.followSvc.GetPendingIncomingRequests(context.Background(), viewerID, limit, cursor)
	if err != nil {
		logger.Sugar.Errorw("Failed to get incoming follow requests",
			"viewer_id", viewerID,
			"error", err,
		)
		return response.Error(c, fiber.StatusInternalServerError, "Failed to get requests", constants.ErrCodeServerError)
	}

	// Fetch user details for each request
	requests := make([]dto.FollowRequestDTO, 0, len(edges))
	for _, edge := range edges {
		user, err := h.userRepo.FindByID(edge.FollowerID)
		if err != nil || user == nil {
			continue
		}
		requests = append(requests, dto.FollowRequestDTO{
			ID:          user.ID,
			Username:    user.Username,
			ProfilePic:  user.ProfilePic,
			Bio:         user.Bio,
			IsVerified:  user.IsVerified,
			RequestedAt: edge.CreatedAt.Format(time.RFC3339),
		})
	}

	var nextCursor string
	if hasMore && len(edges) > 0 {
		lastEdge := edges[len(edges)-1]
		nextCursor = encodeCursor(lastEdge.CreatedAt, lastEdge.FollowerID)
	}

	return c.JSON(dto.FollowRequestListResponse{
		Success:    true,
		Requests:   requests,
		NextCursor: nextCursor,
		HasMore:    hasMore,
	})
}

// AcceptFollowRequest handles POST /api/me/follow-requests/:requesterId/accept
// @Summary Accept a follow request
// @Description Accept an incoming follow request
// @Tags Follow
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param requesterId path int true "Requester User ID"
// @Success 200 {object} dto.SuccessResponse
// @Failure 400 {object} dto.ErrorResponse
// @Failure 401 {object} dto.ErrorResponse
// @Router /me/follow-requests/{requesterId}/accept [post]
func (h *FollowHandler) AcceptFollowRequest(c *fiber.Ctx) error {
	viewerID := getUserIDFromContext(c)
	if viewerID == 0 {
		return response.Unauthorized(c, "Authentication required", constants.ErrCodeUnauthorized)
	}

	requesterID, err := strconv.ParseUint(c.Params("requesterId"), 10, 32)
	if err != nil {
		return response.Error(c, fiber.StatusBadRequest, "Invalid requester ID", constants.ErrCodeInvalidRequest)
	}

	if err := h.followSvc.AcceptRequest(context.Background(), viewerID, uint(requesterID)); err != nil {
		errMsg := err.Error()
		if strings.Contains(errMsg, constants.ErrCodeNoFollowRequest) {
			return response.Error(c, fiber.StatusBadRequest, "No pending request found", constants.ErrCodeNoFollowRequest)
		}
		logger.Sugar.Errorw("Failed to accept follow request",
			"viewer_id", viewerID,
			"requester_id", requesterID,
			"error", err,
		)
		return response.Error(c, fiber.StatusInternalServerError, "Failed to accept request", constants.ErrCodeServerError)
	}

	// Send notification to requester
	go h.sendAcceptedNotification(c, viewerID, uint(requesterID))

	return c.JSON(dto.SuccessResponse{
		Success: true,
		Message: "Follow request accepted",
	})
}

// DeclineFollowRequest handles POST /api/me/follow-requests/:requesterId/decline
// @Summary Decline a follow request
// @Description Decline an incoming follow request
// @Tags Follow
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param requesterId path int true "Requester User ID"
// @Success 200 {object} dto.SuccessResponse
// @Failure 400 {object} dto.ErrorResponse
// @Failure 401 {object} dto.ErrorResponse
// @Router /me/follow-requests/{requesterId}/decline [post]
func (h *FollowHandler) DeclineFollowRequest(c *fiber.Ctx) error {
	viewerID := getUserIDFromContext(c)
	if viewerID == 0 {
		return response.Unauthorized(c, "Authentication required", constants.ErrCodeUnauthorized)
	}

	requesterID, err := strconv.ParseUint(c.Params("requesterId"), 10, 32)
	if err != nil {
		return response.Error(c, fiber.StatusBadRequest, "Invalid requester ID", constants.ErrCodeInvalidRequest)
	}

	if err := h.followSvc.DeclineRequest(context.Background(), viewerID, uint(requesterID)); err != nil {
		errMsg := err.Error()
		if strings.Contains(errMsg, constants.ErrCodeNoFollowRequest) {
			return response.Error(c, fiber.StatusBadRequest, "No pending request found", constants.ErrCodeNoFollowRequest)
		}
		logger.Sugar.Errorw("Failed to decline follow request",
			"viewer_id", viewerID,
			"requester_id", requesterID,
			"error", err,
		)
		return response.Error(c, fiber.StatusInternalServerError, "Failed to decline request", constants.ErrCodeServerError)
	}

	return c.JSON(dto.SuccessResponse{
		Success: true,
		Message: "Follow request declined",
	})
}

// RemoveFollower handles DELETE /api/me/followers/:followerId
// @Summary Remove a follower
// @Description Remove a user from your followers list
// @Tags Follow
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param followerId path int true "Follower User ID"
// @Success 200 {object} dto.SuccessResponse
// @Failure 400 {object} dto.ErrorResponse
// @Failure 401 {object} dto.ErrorResponse
// @Router /me/followers/{followerId} [delete]
func (h *FollowHandler) RemoveFollower(c *fiber.Ctx) error {
	viewerID := getUserIDFromContext(c)
	if viewerID == 0 {
		return response.Unauthorized(c, "Authentication required", constants.ErrCodeUnauthorized)
	}

	followerID, err := strconv.ParseUint(c.Params("followerId"), 10, 32)
	if err != nil {
		return response.Error(c, fiber.StatusBadRequest, "Invalid follower ID", constants.ErrCodeInvalidRequest)
	}

	if err := h.followSvc.RemoveFollower(context.Background(), viewerID, uint(followerID)); err != nil {
		errMsg := err.Error()
		if strings.Contains(errMsg, constants.ErrCodeNotFollowing) {
			return response.Error(c, fiber.StatusBadRequest, "User is not following you", constants.ErrCodeNotFollowing)
		}
		logger.Sugar.Errorw("Failed to remove follower",
			"viewer_id", viewerID,
			"follower_id", followerID,
			"error", err,
		)
		return response.Error(c, fiber.StatusInternalServerError, "Failed to remove follower", constants.ErrCodeServerError)
	}

	return c.JSON(dto.SuccessResponse{
		Success: true,
		Message: "Follower removed",
	})
}

// ==================== List Operations ====================

// GetFollowers handles GET /api/users/:userId/followers
// @Summary Get user's followers
// @Description Get paginated list of user's followers
// @Tags Follow
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param userId path int true "User ID"
// @Param cursor query string false "Pagination cursor"
// @Param limit query int false "Number of results" default(20)
// @Success 200 {object} dto.FollowListResponse
// @Failure 401 {object} dto.ErrorResponse
// @Failure 403 {object} dto.ErrorResponse
// @Router /users/{userId}/followers [get]
func (h *FollowHandler) GetFollowers(c *fiber.Ctx) error {
	viewerID := getUserIDFromContext(c)
	if viewerID == 0 {
		return response.Unauthorized(c, "Authentication required", constants.ErrCodeUnauthorized)
	}

	targetID, err := strconv.ParseUint(c.Params("userId"), 10, 32)
	if err != nil {
		return response.Error(c, fiber.StatusBadRequest, "Invalid user ID", constants.ErrCodeInvalidRequest)
	}

	limit, _ := strconv.Atoi(c.Query("limit", "20"))
	cursor := decodeCursor(c.Query("cursor"))

	edges, hasMore, err := h.followSvc.GetFollowers(context.Background(), viewerID, uint(targetID), limit, cursor)
	if err != nil {
		errMsg := err.Error()
		if strings.Contains(errMsg, constants.ErrCodeAccountPrivate) {
			return response.Error(c, fiber.StatusForbidden, "This account is private", constants.ErrCodeAccountPrivate)
		}
		if strings.Contains(errMsg, constants.ErrCodeUserNotFound) {
			return response.Error(c, fiber.StatusNotFound, "User not found", constants.ErrCodeUserNotFound)
		}
		return response.Error(c, fiber.StatusInternalServerError, "Failed to get followers", constants.ErrCodeServerError)
	}

	// Fetch user details
	users := make([]dto.FollowUserDTO, 0, len(edges))
	for _, edge := range edges {
		user, err := h.userRepo.FindByID(edge.FollowerID)
		if err != nil || user == nil {
			continue
		}
		users = append(users, dto.FollowUserDTO{
			ID:         user.ID,
			Username:   user.Username,
			ProfilePic: user.ProfilePic,
			Bio:        user.Bio,
			IsPrivate:  user.IsPrivate,
			IsVerified: user.IsVerified,
			FollowedAt: edge.CreatedAt.Format(time.RFC3339),
		})
	}

	var nextCursor string
	if hasMore && len(edges) > 0 {
		lastEdge := edges[len(edges)-1]
		nextCursor = encodeCursor(lastEdge.CreatedAt, lastEdge.FollowerID)
	}

	return c.JSON(dto.FollowListResponse{
		Success:    true,
		Users:      users,
		NextCursor: nextCursor,
		HasMore:    hasMore,
	})
}

// GetFollowing handles GET /api/users/:userId/following
// @Summary Get user's following
// @Description Get paginated list of users that user follows
// @Tags Follow
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param userId path int true "User ID"
// @Param cursor query string false "Pagination cursor"
// @Param limit query int false "Number of results" default(20)
// @Success 200 {object} dto.FollowListResponse
// @Failure 401 {object} dto.ErrorResponse
// @Failure 403 {object} dto.ErrorResponse
// @Router /users/{userId}/following [get]
func (h *FollowHandler) GetFollowing(c *fiber.Ctx) error {
	viewerID := getUserIDFromContext(c)
	if viewerID == 0 {
		return response.Unauthorized(c, "Authentication required", constants.ErrCodeUnauthorized)
	}

	targetID, err := strconv.ParseUint(c.Params("userId"), 10, 32)
	if err != nil {
		return response.Error(c, fiber.StatusBadRequest, "Invalid user ID", constants.ErrCodeInvalidRequest)
	}

	limit, _ := strconv.Atoi(c.Query("limit", "20"))
	cursor := decodeCursor(c.Query("cursor"))

	edges, hasMore, err := h.followSvc.GetFollowing(context.Background(), viewerID, uint(targetID), limit, cursor)
	if err != nil {
		errMsg := err.Error()
		if strings.Contains(errMsg, constants.ErrCodeAccountPrivate) {
			return response.Error(c, fiber.StatusForbidden, "This account is private", constants.ErrCodeAccountPrivate)
		}
		if strings.Contains(errMsg, constants.ErrCodeUserNotFound) {
			return response.Error(c, fiber.StatusNotFound, "User not found", constants.ErrCodeUserNotFound)
		}
		return response.Error(c, fiber.StatusInternalServerError, "Failed to get following", constants.ErrCodeServerError)
	}

	// Fetch user details
	users := make([]dto.FollowUserDTO, 0, len(edges))
	for _, edge := range edges {
		user, err := h.userRepo.FindByID(edge.FolloweeID)
		if err != nil || user == nil {
			continue
		}
		users = append(users, dto.FollowUserDTO{
			ID:         user.ID,
			Username:   user.Username,
			ProfilePic: user.ProfilePic,
			Bio:        user.Bio,
			IsPrivate:  user.IsPrivate,
			IsVerified: user.IsVerified,
			FollowedAt: edge.CreatedAt.Format(time.RFC3339),
		})
	}

	var nextCursor string
	if hasMore && len(edges) > 0 {
		lastEdge := edges[len(edges)-1]
		nextCursor = encodeCursor(lastEdge.CreatedAt, lastEdge.FolloweeID)
	}

	return c.JSON(dto.FollowListResponse{
		Success:    true,
		Users:      users,
		NextCursor: nextCursor,
		HasMore:    hasMore,
	})
}

// ==================== Relationship Lookup ====================

// LookupRelationships handles POST /api/relationships/lookup
// @Summary Lookup relationship states
// @Description Batch lookup relationship states for multiple users
// @Tags Follow
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param body body dto.RelationshipLookupRequest true "Target user IDs"
// @Success 200 {object} dto.RelationshipLookupResponse
// @Failure 400 {object} dto.ErrorResponse
// @Failure 401 {object} dto.ErrorResponse
// @Router /relationships/lookup [post]
func (h *FollowHandler) LookupRelationships(c *fiber.Ctx) error {
	viewerID := getUserIDFromContext(c)
	if viewerID == 0 {
		return response.Unauthorized(c, "Authentication required", constants.ErrCodeUnauthorized)
	}

	var req dto.RelationshipLookupRequest
	if err := c.BodyParser(&req); err != nil {
		return response.Error(c, fiber.StatusBadRequest, "Invalid request body", constants.ErrCodeInvalidRequest)
	}

	if len(req.TargetIDs) == 0 {
		return c.JSON(dto.RelationshipLookupResponse{
			Success:       true,
			Relationships: make(map[uint]string),
		})
	}

	// Limit batch size
	if len(req.TargetIDs) > 100 {
		req.TargetIDs = req.TargetIDs[:100]
	}

	relationships, err := h.followSvc.LookupRelationships(context.Background(), viewerID, req.TargetIDs)
	if err != nil {
		return response.Error(c, fiber.StatusInternalServerError, "Failed to lookup relationships", constants.ErrCodeServerError)
	}

	// Convert to string map for JSON
	result := make(map[uint]string)
	for id, state := range relationships {
		result[id] = string(state)
	}

	return c.JSON(dto.RelationshipLookupResponse{
		Success:       true,
		Relationships: result,
	})
}

// ==================== Mutuals ====================

// GetMutuals handles GET /api/users/:userId/mutuals
// @Summary Get mutual followers
// @Description Get users that both viewer follows and who follow the target user
// @Tags Follow
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param userId path int true "Target User ID"
// @Param cursor query string false "Pagination cursor"
// @Param limit query int false "Number of results" default(20)
// @Success 200 {object} dto.MutualsResponse
// @Failure 401 {object} dto.ErrorResponse
// @Failure 403 {object} dto.ErrorResponse
// @Router /users/{userId}/mutuals [get]
func (h *FollowHandler) GetMutuals(c *fiber.Ctx) error {
	viewerID := getUserIDFromContext(c)
	if viewerID == 0 {
		return response.Unauthorized(c, "Authentication required", constants.ErrCodeUnauthorized)
	}

	targetID, err := strconv.ParseUint(c.Params("userId"), 10, 32)
	if err != nil {
		return response.Error(c, fiber.StatusBadRequest, "Invalid user ID", constants.ErrCodeInvalidRequest)
	}

	limit, _ := strconv.Atoi(c.Query("limit", "20"))
	cursor := decodeCursor(c.Query("cursor"))

	mutualEdges, hasMore, err := h.followSvc.GetMutualsWithTimestamps(context.Background(), viewerID, uint(targetID), limit, cursor)
	if err != nil {
		errMsg := err.Error()
		if strings.Contains(errMsg, constants.ErrCodeAccountPrivate) {
			return response.Error(c, fiber.StatusForbidden, "This account is private", constants.ErrCodeAccountPrivate)
		}
		logger.Sugar.Errorw("Failed to get mutuals",
			"viewer_id", viewerID,
			"target_id", targetID,
			"error", err,
		)
		return response.Error(c, fiber.StatusInternalServerError, "Failed to get mutuals", constants.ErrCodeServerError)
	}

	// Fetch user details
	users := make([]dto.FollowUserDTO, 0, len(mutualEdges))
	for _, edge := range mutualEdges {
		user, err := h.userRepo.FindByID(edge.UserID)
		if err != nil || user == nil {
			continue
		}
		users = append(users, dto.FollowUserDTO{
			ID:         user.ID,
			Username:   user.Username,
			ProfilePic: user.ProfilePic,
			Bio:        user.Bio,
			IsPrivate:  user.IsPrivate,
			IsVerified: user.IsVerified,
			FollowedAt: edge.CreatedAt.Format(time.RFC3339),
		})
	}

	var nextCursor string
	if hasMore && len(mutualEdges) > 0 {
		lastEdge := mutualEdges[len(mutualEdges)-1]
		nextCursor = encodeCursor(lastEdge.CreatedAt, lastEdge.UserID)
	}

	return c.JSON(dto.MutualsResponse{
		Success:    true,
		Users:      users,
		NextCursor: nextCursor,
		HasMore:    hasMore,
	})
}

// GetFollowCounts handles GET /api/users/:userId/follow-counts
// @Summary Get follow counts
// @Description Get followers and following counts for a user
// @Tags Follow
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param userId path int true "User ID"
// @Success 200 {object} dto.FollowCountsResponse
// @Failure 401 {object} dto.ErrorResponse
// @Router /users/{userId}/follow-counts [get]
func (h *FollowHandler) GetFollowCounts(c *fiber.Ctx) error {
	viewerID := getUserIDFromContext(c)
	if viewerID == 0 {
		return response.Unauthorized(c, "Authentication required", constants.ErrCodeUnauthorized)
	}

	targetID, err := strconv.ParseUint(c.Params("userId"), 10, 32)
	if err != nil {
		return response.Error(c, fiber.StatusBadRequest, "Invalid user ID", constants.ErrCodeInvalidRequest)
	}

	followersCount, followingCount, err := h.followSvc.GetFollowCounts(context.Background(), uint(targetID))
	if err != nil {
		logger.Sugar.Errorw("Failed to get follow counts",
			"viewer_id", viewerID,
			"target_id", targetID,
			"error", err,
		)
		return response.Error(c, fiber.StatusInternalServerError, "Failed to get counts", constants.ErrCodeServerError)
	}

	countsDTO := dto.FollowCountsDTO{
		FollowersCount: followersCount,
		FollowingCount: followingCount,
	}

	// Include pending requests count if viewing own profile
	if viewerID == uint(targetID) {
		_, _, pendingErr := h.followSvc.GetFollowCounts(context.Background(), viewerID)
		if pendingErr == nil {
			// Get pending count from a separate method
			pendingCount := h.followSvc.GetPendingRequestsCount(context.Background(), viewerID)
			countsDTO.PendingRequestsCount = pendingCount
		}
	}

	return c.JSON(dto.FollowCountsResponse{
		Success: true,
		Counts:  countsDTO,
	})
}

// ReconcileMyCounters handles POST /api/me/follow-counts/reconcile
// @Summary Reconcile follow counts
// @Description Recalculate follow counts from actual edge data (fixes counter drift)
// @Tags Follow
// @Accept json
// @Produce json
// @Security BearerAuth
// @Success 200 {object} dto.SuccessResponse
// @Failure 401 {object} dto.ErrorResponse
// @Router /me/follow-counts/reconcile [post]
func (h *FollowHandler) ReconcileMyCounters(c *fiber.Ctx) error {
	viewerID := getUserIDFromContext(c)
	if viewerID == 0 {
		return response.Unauthorized(c, "Authentication required", constants.ErrCodeUnauthorized)
	}

	if err := h.followSvc.ReconcileCounters(context.Background(), viewerID); err != nil {
		logger.Sugar.Errorw("Failed to reconcile counters",
			"viewer_id", viewerID,
			"error", err,
		)
		return response.Error(c, fiber.StatusInternalServerError, "Failed to reconcile counts", constants.ErrCodeServerError)
	}

	return c.JSON(dto.SuccessResponse{
		Success: true,
		Message: "Follow counts reconciled",
	})
}

// ==================== Notification Helpers ====================

// sendFollowNotification sends notifications when someone follows/requests to follow
func (h *FollowHandler) sendFollowNotification(c *fiber.Ctx, followerID, followeeID uint, state models.FollowState) {
	if h.notifSvc == nil {
		return
	}

	follower, err := h.userRepo.FindByID(followerID)
	if err != nil || follower == nil {
		return
	}

	var avatar string
	if follower.ProfilePic != nil {
		avatar = *follower.ProfilePic
	}

	ctx := context.Background()

	switch state {
	case models.FollowStatePending:
		// Follow request notification
		h.notifSvc.NotifyFollowRequest(ctx, followeeID, followerID, follower.Username, avatar)
	case models.FollowStateActive:
		// New follower notification (public account)
		h.notifSvc.NotifyNewFollower(ctx, followeeID, followerID, follower.Username, avatar)
	}
}

// sendAcceptedNotification sends notification when follow request is accepted
func (h *FollowHandler) sendAcceptedNotification(c *fiber.Ctx, viewerID, requesterID uint) {
	if h.notifSvc == nil {
		return
	}

	viewer, err := h.userRepo.FindByID(viewerID)
	if err != nil || viewer == nil {
		return
	}

	var avatar string
	if viewer.ProfilePic != nil {
		avatar = *viewer.ProfilePic
	}

	ctx := context.Background()
	h.notifSvc.NotifyFollowAccepted(ctx, requesterID, viewerID, viewer.Username, avatar)
}

// ==================== Cursor Helpers ====================

type cursorData struct {
	CreatedAt time.Time `json:"c"`
	UserID    uint      `json:"u"`
}

func encodeCursor(createdAt time.Time, userID uint) string {
	data := cursorData{CreatedAt: createdAt, UserID: userID}
	bytes, _ := json.Marshal(data)
	return base64.URLEncoding.EncodeToString(bytes)
}

func decodeCursor(cursor string) *repository.FollowListCursor {
	if cursor == "" {
		return nil
	}

	bytes, err := base64.URLEncoding.DecodeString(cursor)
	if err != nil {
		return nil
	}

	var data cursorData
	if err := json.Unmarshal(bytes, &data); err != nil {
		return nil
	}

	return &repository.FollowListCursor{
		CreatedAt: data.CreatedAt,
		UserID:    data.UserID,
	}
}
