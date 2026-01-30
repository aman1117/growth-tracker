package handlers

import (
	"encoding/json"
	"strconv"
	"strings"
	"time"

	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/dto"
	"github.com/aman1117/backend/internal/logger"
	"github.com/aman1117/backend/internal/response"
	"github.com/aman1117/backend/internal/services"
	"github.com/aman1117/backend/internal/validator"
	"github.com/aman1117/backend/pkg/models"
	"github.com/aman1117/backend/pkg/redis"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
)

// ProfileHandler handles profile-related requests
type ProfileHandler struct {
	profileSvc *services.ProfileService
	authSvc    *services.AuthService
	followSvc  *services.FollowService
	streakSvc  *services.StreakService
}

// NewProfileHandler creates a new ProfileHandler
func NewProfileHandler(profileSvc *services.ProfileService, authSvc *services.AuthService, followSvc *services.FollowService, streakSvc *services.StreakService) *ProfileHandler {
	return &ProfileHandler{
		profileSvc: profileSvc,
		authSvc:    authSvc,
		followSvc:  followSvc,
		streakSvc:  streakSvc,
	}
}

// UpdatePrivacy handles privacy setting updates
// @Summary Update privacy setting
// @Description Set account privacy (public or private)
// @Tags Profile
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param request body dto.UpdatePrivacyRequest true "Privacy setting"
// @Success 200 {object} dto.PrivacyResponse "Privacy updated"
// @Failure 400 {object} dto.ErrorResponse "Invalid request"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Router /update-privacy [post]
func (h *ProfileHandler) UpdatePrivacy(c *fiber.Ctx) error {
	userID := getUserID(c)

	var req dto.UpdatePrivacyRequest
	if err := c.BodyParser(&req); err != nil {
		return response.InvalidRequest(c)
	}

	log := logger.LogWithContext(getTraceID(c), userID)
	if err := h.profileSvc.UpdatePrivacy(userID, req.IsPrivate); err != nil {
		log.Errorw("Privacy update failed", "error", err)
		return response.InternalError(c, "Failed to update privacy setting", constants.ErrCodeUpdateFailed)
	}

	log.Infow("Privacy updated", "is_private", req.IsPrivate)
	return response.JSON(c, fiber.Map{
		"success":    true,
		"message":    constants.MsgPrivacyUpdated,
		"is_private": req.IsPrivate,
	})
}

// GetPrivacy handles privacy setting retrieval
// @Summary Get privacy setting
// @Description Get current account privacy setting
// @Tags Profile
// @Produce json
// @Security BearerAuth
// @Success 200 {object} dto.PrivacyResponse "Privacy setting"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Router /get-privacy [get]
func (h *ProfileHandler) GetPrivacy(c *fiber.Ctx) error {
	userID := getUserID(c)

	isPrivate, err := h.profileSvc.GetPrivacy(userID)
	if err != nil {
		logger.LogWithContext(getTraceID(c), userID).Errorw("Failed to get privacy setting", "error", err)
		return response.InternalError(c, "Failed to get privacy setting", constants.ErrCodeFetchFailed)
	}

	return response.JSON(c, dto.PrivacyResponse{
		Success:   true,
		IsPrivate: isPrivate,
	})
}

// UpdateBio handles bio updates
// @Summary Update bio
// @Description Update user bio (max 150 characters)
// @Tags Profile
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param request body dto.UpdateBioRequest true "Bio content"
// @Success 200 {object} dto.BioResponse "Bio updated"
// @Failure 400 {object} dto.ErrorResponse "Validation error"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Router /update-bio [post]
func (h *ProfileHandler) UpdateBio(c *fiber.Ctx) error {
	userID := getUserID(c)

	var req dto.UpdateBioRequest
	if err := c.BodyParser(&req); err != nil {
		return response.InvalidRequest(c)
	}

	bio := validator.SanitizeBio(req.Bio)

	if err := validator.ValidateBio(bio); err != nil {
		return response.BadRequest(c, err.Message, err.ErrorCode)
	}

	log := logger.LogWithContext(getTraceID(c), userID)
	if err := h.profileSvc.UpdateBio(userID, bio); err != nil {
		log.Errorw("Bio update failed", "error", err)
		return response.InternalError(c, "Failed to update bio", constants.ErrCodeUpdateFailed)
	}

	log.Infow("Bio updated", "bio_length", len(bio))
	return response.JSON(c, fiber.Map{
		"success": true,
		"message": constants.MsgBioUpdated,
		"bio":     bio,
	})
}

// GetBio handles bio retrieval
// @Summary Get bio
// @Description Get current user's bio
// @Tags Profile
// @Produce json
// @Security BearerAuth
// @Success 200 {object} dto.BioResponse "Bio content"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Router /get-bio [get]
func (h *ProfileHandler) GetBio(c *fiber.Ctx) error {
	userID := getUserID(c)

	bio, err := h.profileSvc.GetBio(userID)
	if err != nil {
		logger.LogWithContext(getTraceID(c), userID).Errorw("Failed to get bio", "error", err)
		return response.InternalError(c, "Failed to get bio", constants.ErrCodeFetchFailed)
	}

	return response.JSON(c, dto.BioResponse{
		Success: true,
		Bio:     bio,
	})
}

// GetProfile handles full profile retrieval
// @Summary Get user profile
// @Description Get full profile of authenticated user
// @Tags Profile
// @Produce json
// @Security BearerAuth
// @Success 200 {object} dto.ProfileResponse "User profile"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Failure 404 {object} dto.ErrorResponse "User not found"
// @Router /profile [get]
func (h *ProfileHandler) GetProfile(c *fiber.Ctx) error {
	userID := getUserID(c)

	user, err := h.profileSvc.GetProfile(userID)
	if err != nil || user == nil {
		return response.NotFound(c, "User not found", constants.ErrCodeUserNotFound)
	}

	// Get follow counts
	var followersCount, followingCount int64
	if h.followSvc != nil {
		followersCount, followingCount, _ = h.followSvc.GetFollowCounts(c.Context(), userID)
	}

	return response.JSON(c, dto.ProfileResponse{
		Success:        true,
		Username:       user.Username,
		Email:          user.Email,
		ProfilePic:     user.ProfilePic,
		Bio:            user.Bio,
		IsPrivate:      user.IsPrivate,
		IsVerified:     user.IsVerified,
		EmailVerified:  user.EmailVerified,
		FollowersCount: followersCount,
		FollowingCount: followingCount,
	})
}

// GetUserProfile handles public profile retrieval for another user
// @Summary Get another user's profile
// @Description Get public profile of another user by ID
// @Tags Profile
// @Produce json
// @Security BearerAuth
// @Param userId path int true "User ID"
// @Success 200 {object} dto.PublicProfileResponse "User profile"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Failure 404 {object} dto.ErrorResponse "User not found"
// @Router /users/{userId}/profile [get]
func (h *ProfileHandler) GetUserProfile(c *fiber.Ctx) error {
	viewerID := getUserID(c)

	targetID, err := strconv.ParseUint(c.Params("userId"), 10, 32)
	if err != nil {
		return response.Error(c, fiber.StatusBadRequest, "Invalid user ID", constants.ErrCodeInvalidRequest)
	}

	user, err := h.profileSvc.GetProfile(uint(targetID))
	if err != nil || user == nil {
		return response.NotFound(c, "User not found", constants.ErrCodeUserNotFound)
	}

	// Get follow counts
	var followersCount, followingCount int64
	if h.followSvc != nil {
		followersCount, followingCount, _ = h.followSvc.GetFollowCounts(c.Context(), uint(targetID))
	}

	// Get relationship state
	var relationshipState string = "NONE"
	if h.followSvc != nil && viewerID != uint(targetID) {
		state, _ := h.followSvc.GetRelationshipState(c.Context(), viewerID, uint(targetID))
		relationshipState = string(state)
	}

	resp := dto.PublicProfileResponse{
		Success:           true,
		ID:                user.ID,
		Username:          user.Username,
		ProfilePic:        user.ProfilePic,
		IsPrivate:         user.IsPrivate,
		IsVerified:        user.IsVerified,
		FollowersCount:    followersCount,
		FollowingCount:    followingCount,
		RelationshipState: relationshipState,
	}

	// Determine if viewer can see private info (own profile, public profile, or following)
	canViewPrivateInfo := viewerID == uint(targetID) || !user.IsPrivate || relationshipState == "FOLLOWING"

	// Only show bio if viewer can see private info
	if canViewPrivateInfo {
		resp.Bio = user.Bio
	}

	// Only show last_logged_at if viewer can see private info and streak exists
	if canViewPrivateInfo && h.streakSvc != nil {
		streak, err := h.streakSvc.GetLatestActiveStreak(uint(targetID))
		if err == nil && streak != nil {
			resp.LastLoggedAt = &streak.ActivityDate
		}
	}

	return response.JSON(c, resp)
}

// SearchUsers handles user search requests
// @Summary Search users
// @Description Search for users by username (excludes private accounts)
// @Tags Users
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param request body dto.SearchUsersRequest true "Search query"
// @Success 200 {object} dto.DataResponse{data=[]dto.UserDTO} "List of users"
// @Failure 400 {object} dto.ErrorResponse "Invalid request"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Router /users [post]
func (h *ProfileHandler) SearchUsers(c *fiber.Ctx) error {
	currentUserID := getUserID(c)
	traceID := getTraceID(c)

	var req dto.SearchUsersRequest
	if err := c.BodyParser(&req); err != nil {
		return response.InvalidRequest(c)
	}

	users, err := h.profileSvc.SearchUsers(req.Username)
	if err != nil {
		logger.LogWithContext(traceID, currentUserID).Errorw("User search failed", "query", req.Username, "error", err)
		return response.BadRequest(c, "Failed to find users", constants.ErrCodeFetchFailed)
	}

	// Get IDs of private users to check if current user follows them
	var privateUserIDs []uint
	for _, u := range users {
		if u.IsPrivate {
			privateUserIDs = append(privateUserIDs, u.ID)
		}
	}

	// Lookup which private users the current user follows
	followingSet := make(map[uint]bool)
	if len(privateUserIDs) > 0 && currentUserID != 0 {
		relationships, err := h.followSvc.LookupRelationships(c.Context(), currentUserID, privateUserIDs)
		if err == nil {
			for userID, state := range relationships {
				if state == models.RelationshipFollowing {
					followingSet[userID] = true
				}
			}
		}
	}

	logger.LogWithContext(traceID, currentUserID).Debugw("User search completed", "query", req.Username, "found", len(users))
	return response.Data(c, sanitizeUsersWithFollowing(users, followingSet))
}

// AutocompleteUsers handles user autocomplete requests
// @Summary Autocomplete users
// @Description Search for users by username prefix with fuzzy matching, ranked by relevance and popularity
// @Tags Users
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param q query string true "Search query (1-80 chars)" minLength(1) maxLength(80)
// @Param limit query int false "Max results (1-20, default 12)" minimum(1) maximum(20) default(12)
// @Success 200 {object} dto.AutocompleteResponse "Autocomplete suggestions"
// @Failure 400 {object} dto.ErrorResponse "Invalid request"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Failure 500 {object} dto.ErrorResponse "Server error"
// @Router /autocomplete/users [get]
func (h *ProfileHandler) AutocompleteUsers(c *fiber.Ctx) error {
	start := time.Now()
	userID := getUserID(c)
	traceID := getTraceID(c)
	requestID := uuid.New().String()

	log := logger.LogWithContext(traceID, userID)

	// Parse and validate query parameter
	query := strings.TrimSpace(c.Query("q"))
	if query == "" {
		return response.BadRequest(c, "Query parameter 'q' is required", constants.ErrCodeMissingFields)
	}

	// Enforce query length limits
	if len(query) > 80 {
		query = query[:80]
	}

	// Parse limit parameter
	limit := 12
	if limitStr := c.Query("limit"); limitStr != "" {
		if parsedLimit, err := strconv.Atoi(limitStr); err == nil {
			if parsedLimit >= 1 && parsedLimit <= 20 {
				limit = parsedLimit
			}
		}
	}

	// Normalize query for cache key (lowercase)
	cacheKey := strings.ToLower(query)

	// Try to get from cache
	if cached, err := redis.GetAutocompleteCache(c.Context(), cacheKey); err == nil && cached != "" {
		var cachedResponse dto.AutocompleteResponse
		if err := json.Unmarshal([]byte(cached), &cachedResponse); err == nil {
			// Update requestID for this request (cache hit)
			cachedResponse.RequestID = requestID
			log.Debugw("Autocomplete cache hit",
				"query", query,
				"request_id", requestID,
				"results", len(cachedResponse.Suggestions),
				"duration_ms", time.Since(start).Milliseconds(),
			)
			return response.JSON(c, cachedResponse)
		}
	}

	// Cache miss - query database
	results, err := h.profileSvc.AutocompleteUsers(query, limit)
	if err != nil {
		log.Errorw("Autocomplete query failed",
			"query", query,
			"request_id", requestID,
			"error", err,
		)
		return response.InternalError(c, "Failed to search users", constants.ErrCodeFetchFailed)
	}

	// Convert to DTO
	suggestions := make([]dto.AutocompleteSuggestion, 0, len(results))
	for _, r := range results {
		suggestions = append(suggestions, dto.AutocompleteSuggestion{
			Text:  r.Username,
			Kind:  "user",
			Score: r.Score,
			Meta: dto.AutocompleteSuggestionMeta{
				ProfilePic:     r.ProfilePic,
				IsVerified:     r.IsVerified,
				FollowersCount: r.FollowersCount,
			},
		})
	}

	resp := dto.AutocompleteResponse{
		Query:       query,
		RequestID:   requestID,
		Suggestions: suggestions,
	}

	// Cache the response (without requestID, we'll add it on cache hit)
	cacheResp := resp
	cacheResp.RequestID = "" // Don't cache the request ID
	if cacheData, err := json.Marshal(cacheResp); err == nil {
		_ = redis.SetAutocompleteCache(c.Context(), cacheKey, string(cacheData))
	}

	duration := time.Since(start)
	log.Infow("Autocomplete completed",
		"query", query,
		"request_id", requestID,
		"results", len(suggestions),
		"duration_ms", duration.Milliseconds(),
	)

	return response.JSON(c, resp)
}

// sanitizeUsersWithFollowing converts users to DTOs, including bio for public profiles
// or private profiles that the current user follows
func sanitizeUsersWithFollowing(users []models.User, followingSet map[uint]bool) []dto.UserDTO {
	result := make([]dto.UserDTO, 0, len(users))
	for _, u := range users {
		d := dto.UserDTO{
			ID:         u.ID,
			Username:   u.Username,
			Email:      u.Email,
			ProfilePic: u.ProfilePic,
			IsPrivate:  u.IsPrivate,
			IsVerified: u.IsVerified,
		}
		// Include bio for public profiles OR private profiles the viewer follows
		if !u.IsPrivate || followingSet[u.ID] {
			d.Bio = u.Bio
		}
		result = append(result, d)
	}
	return result
}
