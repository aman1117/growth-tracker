package handlers

import (
	"encoding/json"
	"strconv"
	"time"

	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/dto"
	"github.com/aman1117/backend/internal/logger"
	"github.com/aman1117/backend/internal/response"
	"github.com/aman1117/backend/internal/services"
	"github.com/aman1117/backend/pkg/redis"
	"github.com/gofiber/fiber/v2"
)

// SearchSuggestionsHandler handles search suggestion requests
type SearchSuggestionsHandler struct {
	searchSvc *services.SearchSuggestionsService
}

// NewSearchSuggestionsHandler creates a new SearchSuggestionsHandler
func NewSearchSuggestionsHandler(searchSvc *services.SearchSuggestionsService) *SearchSuggestionsHandler {
	return &SearchSuggestionsHandler{
		searchSvc: searchSvc,
	}
}

// GetSearchSuggestions returns recent searches and trending users for the authenticated user
// @Summary Get search suggestions
// @Description Get recent searches and personalized trending users for autocomplete on focus
// @Tags Search
// @Produce json
// @Security BearerAuth
// @Success 200 {object} dto.SearchSuggestionsResponse "Recent and trending users"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Failure 500 {object} dto.ErrorResponse "Server error"
// @Router /search/suggestions [get]
func (h *SearchSuggestionsHandler) GetSearchSuggestions(c *fiber.Ctx) error {
	start := time.Now()
	userID := getUserID(c)
	traceID := getTraceID(c)
	log := logger.LogWithContext(traceID, userID)

	// Validate user ID
	if userID == 0 {
		return response.BadRequest(c, "Invalid user context", constants.ErrCodeInvalidRequest)
	}

	// Get recent searches (up to 5)
	recentResults, err := h.searchSvc.GetRecentSearches(userID, 5)
	if err != nil {
		log.Errorw("Failed to get recent searches", "error", err)
		// Don't fail entirely - continue with empty recent
		recentResults = nil
	}

	// Create set of recent user IDs for deduplication
	recentUserIDs := make(map[uint]bool)
	recent := make([]dto.SearchSuggestionUser, 0, len(recentResults))
	for _, r := range recentResults {
		recentUserIDs[r.ID] = true
		recent = append(recent, dto.SearchSuggestionUser{
			ID:             r.ID,
			Username:       r.Username,
			ProfilePic:     r.ProfilePic,
			IsVerified:     r.IsVerified,
			FollowersCount: r.FollowersCount,
		})
	}

	// Try to get trending from cache first (5-minute TTL)
	var trending []dto.SearchSuggestionUser
	cacheKey := trendingCacheKey(userID)

	if cached, err := redis.GetTrendingCache(c.Context(), cacheKey); err == nil && cached != "" {
		if err := json.Unmarshal([]byte(cached), &trending); err != nil {
			log.Warnw("Failed to unmarshal trending cache", "error", err)
			trending = nil
		}
	}

	// Cache miss - query database
	if trending == nil {
		// Calculate how many trending to fetch to fill up to 6 total
		// (accounting for deduplication)
		trendingLimit := 6
		if len(recent) < 5 {
			trendingLimit = 6 - len(recent) + 3 // Fetch extra for deduplication buffer
		}

		trendingResults, err := h.searchSvc.GetTrendingUsersForUser(userID, trendingLimit)
		if err != nil {
			log.Errorw("Failed to get trending users", "error", err)
			trendingResults = nil
		}

		trending = make([]dto.SearchSuggestionUser, 0, len(trendingResults))
		for _, t := range trendingResults {
			// Skip if already in recent searches
			if recentUserIDs[t.ID] {
				continue
			}
			trending = append(trending, dto.SearchSuggestionUser{
				ID:             t.ID,
				Username:       t.Username,
				ProfilePic:     t.ProfilePic,
				IsVerified:     t.IsVerified,
				FollowersCount: t.FollowersCount,
			})
		}

		// Cache trending results (without deduplication, we'll dedupe on read)
		if cacheData, err := json.Marshal(trending); err == nil {
			_ = redis.SetTrendingCache(c.Context(), cacheKey, string(cacheData))
		}
	} else {
		// Filter cached trending to remove users now in recent
		filtered := make([]dto.SearchSuggestionUser, 0, len(trending))
		for _, t := range trending {
			if !recentUserIDs[t.ID] {
				filtered = append(filtered, t)
			}
		}
		trending = filtered
	}

	// Limit total to 6 (up to 5 recent + remaining trending)
	maxTrending := 6 - len(recent)
	if maxTrending < 0 {
		maxTrending = 0
	}
	if len(trending) > maxTrending {
		trending = trending[:maxTrending]
	}

	duration := time.Since(start)
	log.Infow("Search suggestions retrieved",
		"recent_count", len(recent),
		"trending_count", len(trending),
		"duration_ms", duration.Milliseconds(),
	)

	return response.JSON(c, dto.SearchSuggestionsResponse{
		Recent:   recent,
		Trending: trending,
	})
}

// DeleteRecentSearch removes a specific recent search
// @Summary Delete a recent search
// @Description Remove a specific user from recent searches
// @Tags Search
// @Produce json
// @Security BearerAuth
// @Param userId path int true "User ID to remove from recent searches"
// @Success 200 {object} dto.SuccessResponse "Recent search deleted"
// @Failure 400 {object} dto.ErrorResponse "Invalid user ID"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Failure 500 {object} dto.ErrorResponse "Server error"
// @Router /search/recent/{userId} [delete]
func (h *SearchSuggestionsHandler) DeleteRecentSearch(c *fiber.Ctx) error {
	userID := getUserID(c)
	traceID := getTraceID(c)
	log := logger.LogWithContext(traceID, userID)

	// Validate user ID
	if userID == 0 {
		return response.BadRequest(c, "Invalid user context", constants.ErrCodeInvalidRequest)
	}

	targetID, err := strconv.ParseUint(c.Params("userId"), 10, 32)
	if err != nil || targetID == 0 {
		return response.BadRequest(c, "Invalid user ID", constants.ErrCodeInvalidRequest)
	}

	if err := h.searchSvc.DeleteRecentSearch(userID, uint(targetID)); err != nil {
		log.Errorw("Failed to delete recent search", "target_id", targetID, "error", err)
		return response.InternalError(c, "Failed to delete recent search", constants.ErrCodeDeleteFailed)
	}

	log.Infow("Recent search deleted", "target_id", targetID)
	return response.JSON(c, dto.SuccessResponse{
		Success: true,
		Message: "Recent search deleted",
	})
}

// ClearRecentSearches removes all recent searches for the user
// @Summary Clear all recent searches
// @Description Remove all users from recent search history
// @Tags Search
// @Produce json
// @Security BearerAuth
// @Success 200 {object} dto.SuccessResponse "Recent searches cleared"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Failure 500 {object} dto.ErrorResponse "Server error"
// @Router /search/recent [delete]
func (h *SearchSuggestionsHandler) ClearRecentSearches(c *fiber.Ctx) error {
	userID := getUserID(c)
	traceID := getTraceID(c)
	log := logger.LogWithContext(traceID, userID)

	// Validate user ID
	if userID == 0 {
		return response.BadRequest(c, "Invalid user context", constants.ErrCodeInvalidRequest)
	}

	if err := h.searchSvc.ClearRecentSearches(userID); err != nil {
		log.Errorw("Failed to clear recent searches", "error", err)
		return response.InternalError(c, "Failed to clear recent searches", constants.ErrCodeDeleteFailed)
	}

	log.Infow("Recent searches cleared")
	return response.JSON(c, dto.SuccessResponse{
		Success: true,
		Message: "Recent searches cleared",
	})
}

// trendingCacheKey returns the Redis cache key for trending users
func trendingCacheKey(userID uint) string {
	return "trending:user:" + strconv.FormatUint(uint64(userID), 10)
}
