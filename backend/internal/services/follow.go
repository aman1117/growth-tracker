// Package services contains business logic for the follow system.
package services

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/aman1117/backend/internal/config"
	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/logger"
	"github.com/aman1117/backend/internal/repository"
	"github.com/aman1117/backend/pkg/models"
	"github.com/aman1117/backend/pkg/redis"
)

// FollowService handles follow-related business logic
type FollowService struct {
	repo     *repository.FollowRepository
	userRepo *repository.UserRepository
	cfg      *config.FollowConfig
}

// NewFollowService creates a new FollowService
func NewFollowService(
	repo *repository.FollowRepository,
	userRepo *repository.UserRepository,
	cfg *config.FollowConfig,
) *FollowService {
	return &FollowService{
		repo:     repo,
		userRepo: userRepo,
		cfg:      cfg,
	}
}

// FollowResult represents the result of a follow action
type FollowResult struct {
	State   models.FollowState
	Message string
}

// MutualEdge represents a mutual follower with timestamp for cursor pagination
type MutualEdge struct {
	UserID    uint
	CreatedAt time.Time
}

// ==================== Core Follow Operations ====================

// Follow initiates a follow relationship (ACTIVE for public, PENDING for private accounts)
func (s *FollowService) Follow(ctx context.Context, followerID, followeeID uint) (*FollowResult, error) {
	// Validate: cannot follow self
	if followerID == followeeID {
		return nil, fmt.Errorf("%s: cannot follow yourself", constants.ErrCodeCannotFollowSelf)
	}

	// Check if target user exists
	targetUser, err := s.userRepo.FindByID(followeeID)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch target user: %w", err)
	}
	if targetUser == nil {
		return nil, fmt.Errorf("%s: target user not found", constants.ErrCodeUserNotFound)
	}

	// Check existing relationship
	existingEdge, err := s.repo.GetEdge(followerID, followeeID)
	if err != nil {
		return nil, fmt.Errorf("failed to check existing relationship: %w", err)
	}

	// Handle existing edge states
	var previousState *models.FollowState
	if existingEdge != nil {
		switch existingEdge.State {
		case models.FollowStateActive:
			return &FollowResult{State: models.FollowStateActive, Message: "Already following"}, nil
		case models.FollowStatePending:
			return &FollowResult{State: models.FollowStatePending, Message: "Follow request already pending"}, nil
		case models.FollowStateRemoved:
			// Can re-follow, continue with the flow
			previousState = &existingEdge.State
		}
	}

	// Check rate limits
	if err := s.checkFollowLimits(ctx, followerID); err != nil {
		return nil, err
	}

	// Determine follow state based on target's privacy
	state := models.FollowStateActive
	if targetUser.IsPrivate {
		state = models.FollowStatePending
	}

	// Create the follow edge AND update counters atomically
	if err := s.repo.CreateFollowWithCounters(followerID, followeeID, state, previousState); err != nil {
		return nil, fmt.Errorf("failed to create follow: %w", err)
	}

	// Invalidate relationship cache
	s.invalidateRelationshipCache(ctx, followerID, followeeID)

	logger.Sugar.Infow("Follow action completed",
		"follower_id", followerID,
		"followee_id", followeeID,
		"state", state,
	)

	if state == models.FollowStatePending {
		return &FollowResult{State: state, Message: "Follow request sent"}, nil
	}
	return &FollowResult{State: state, Message: "Now following"}, nil
}

// Unfollow removes a follow relationship
func (s *FollowService) Unfollow(ctx context.Context, followerID, followeeID uint) error {
	// Check existing relationship
	existingEdge, err := s.repo.GetEdge(followerID, followeeID)
	if err != nil {
		return fmt.Errorf("failed to check existing relationship: %w", err)
	}
	if existingEdge == nil || existingEdge.State == models.FollowStateRemoved {
		return fmt.Errorf("%s: not following this user", constants.ErrCodeNotFollowing)
	}

	previousState := existingEdge.State

	// Remove follow AND update counters atomically
	if err := s.repo.RemoveFollowWithCounters(followerID, followeeID, previousState); err != nil {
		return fmt.Errorf("failed to unfollow: %w", err)
	}

	// Invalidate caches
	s.invalidateRelationshipCache(ctx, followerID, followeeID)

	logger.Sugar.Infow("Unfollow completed",
		"follower_id", followerID,
		"followee_id", followeeID,
	)

	return nil
}

// CancelRequest cancels an outgoing pending follow request
func (s *FollowService) CancelRequest(ctx context.Context, followerID, targetID uint) error {
	// Check for pending request
	pendingEdge, err := s.repo.GetPendingEdge(followerID, targetID)
	if err != nil {
		return fmt.Errorf("failed to check pending request: %w", err)
	}
	if pendingEdge == nil {
		return fmt.Errorf("%s: no pending request found", constants.ErrCodeNoFollowRequest)
	}

	// Cancel request AND update counters atomically
	if err := s.repo.RemoveFollowWithCounters(followerID, targetID, models.FollowStatePending); err != nil {
		return fmt.Errorf("failed to cancel request: %w", err)
	}

	// Invalidate caches
	s.invalidateRelationshipCache(ctx, followerID, targetID)

	logger.Sugar.Infow("Follow request cancelled",
		"follower_id", followerID,
		"target_id", targetID,
	)

	return nil
}

// ==================== Request Management ====================

// AcceptRequest accepts an incoming follow request
func (s *FollowService) AcceptRequest(ctx context.Context, viewerID, requesterID uint) error {
	// Check for pending request
	pendingEdge, err := s.repo.GetPendingEdge(requesterID, viewerID)
	if err != nil {
		return fmt.Errorf("failed to check pending request: %w", err)
	}
	if pendingEdge == nil {
		return fmt.Errorf("%s: no pending request found", constants.ErrCodeNoFollowRequest)
	}

	// Accept request AND update counters atomically
	if err := s.repo.AcceptFollowWithCounters(requesterID, viewerID); err != nil {
		return fmt.Errorf("failed to accept request: %w", err)
	}

	// Invalidate caches
	s.invalidateRelationshipCache(ctx, requesterID, viewerID)

	logger.Sugar.Infow("Follow request accepted",
		"viewer_id", viewerID,
		"requester_id", requesterID,
	)

	return nil
}

// DeclineRequest declines an incoming follow request
func (s *FollowService) DeclineRequest(ctx context.Context, viewerID, requesterID uint) error {
	// Check for pending request
	pendingEdge, err := s.repo.GetPendingEdge(requesterID, viewerID)
	if err != nil {
		return fmt.Errorf("failed to check pending request: %w", err)
	}
	if pendingEdge == nil {
		return fmt.Errorf("%s: no pending request found", constants.ErrCodeNoFollowRequest)
	}

	// Decline request AND update counters atomically
	if err := s.repo.RemoveFollowWithCounters(requesterID, viewerID, models.FollowStatePending); err != nil {
		return fmt.Errorf("failed to decline request: %w", err)
	}

	// Invalidate caches
	s.invalidateRelationshipCache(ctx, requesterID, viewerID)

	logger.Sugar.Infow("Follow request declined",
		"viewer_id", viewerID,
		"requester_id", requesterID,
	)

	return nil
}

// RemoveFollower removes a follower from the viewer's followers list
func (s *FollowService) RemoveFollower(ctx context.Context, viewerID, followerID uint) error {
	// Check if the user is actually following us
	activeEdge, err := s.repo.GetActiveEdge(followerID, viewerID)
	if err != nil {
		return fmt.Errorf("failed to check follow status: %w", err)
	}
	if activeEdge == nil {
		return fmt.Errorf("%s: user is not following you", constants.ErrCodeNotFollowing)
	}

	// Remove follower AND update counters atomically
	if err := s.repo.RemoveFollowWithCounters(followerID, viewerID, models.FollowStateActive); err != nil {
		return fmt.Errorf("failed to remove follower: %w", err)
	}

	// Invalidate caches
	s.invalidateRelationshipCache(ctx, followerID, viewerID)

	logger.Sugar.Infow("Follower removed",
		"viewer_id", viewerID,
		"follower_id", followerID,
	)

	return nil
}

// ==================== List Operations ====================

// GetFollowers returns paginated followers for a user
func (s *FollowService) GetFollowers(ctx context.Context, viewerID, targetUserID uint, limit int, cursor *repository.FollowListCursor) ([]models.FollowEdgeByFollowee, bool, error) {
	// Check privacy
	if err := s.checkListAccess(ctx, viewerID, targetUserID); err != nil {
		return nil, false, err
	}

	// Clamp limit
	if limit <= 0 || limit > constants.FollowListMaxLimit {
		limit = constants.FollowListDefaultLimit
	}

	// Fetch one extra to check for more
	edges, err := s.repo.GetFollowersPaginated(targetUserID, limit+1, cursor)
	if err != nil {
		return nil, false, fmt.Errorf("failed to get followers: %w", err)
	}

	hasMore := len(edges) > limit
	if hasMore {
		edges = edges[:limit]
	}

	return edges, hasMore, nil
}

// GetFollowing returns paginated following for a user
func (s *FollowService) GetFollowing(ctx context.Context, viewerID, targetUserID uint, limit int, cursor *repository.FollowListCursor) ([]models.FollowEdgeByFollower, bool, error) {
	// Check privacy
	if err := s.checkListAccess(ctx, viewerID, targetUserID); err != nil {
		return nil, false, err
	}

	// Clamp limit
	if limit <= 0 || limit > constants.FollowListMaxLimit {
		limit = constants.FollowListDefaultLimit
	}

	// Fetch one extra to check for more
	edges, err := s.repo.GetFollowingPaginated(targetUserID, limit+1, cursor)
	if err != nil {
		return nil, false, fmt.Errorf("failed to get following: %w", err)
	}

	hasMore := len(edges) > limit
	if hasMore {
		edges = edges[:limit]
	}

	return edges, hasMore, nil
}

// GetPendingIncomingRequests returns paginated incoming follow requests
func (s *FollowService) GetPendingIncomingRequests(ctx context.Context, viewerID uint, limit int, cursor *repository.FollowListCursor) ([]models.FollowEdgeByFollowee, bool, error) {
	// Clamp limit
	if limit <= 0 || limit > constants.FollowListMaxLimit {
		limit = constants.FollowListDefaultLimit
	}

	// Fetch one extra to check for more
	edges, err := s.repo.GetPendingIncomingRequests(viewerID, limit+1, cursor)
	if err != nil {
		return nil, false, fmt.Errorf("failed to get pending requests: %w", err)
	}

	hasMore := len(edges) > limit
	if hasMore {
		edges = edges[:limit]
	}

	return edges, hasMore, nil
}

// ==================== Relationship Lookup ====================

// LookupRelationships returns relationship states for multiple targets
func (s *FollowService) LookupRelationships(ctx context.Context, viewerID uint, targetIDs []uint) (map[uint]models.RelationshipState, error) {
	// Try cache first for each target
	result := make(map[uint]models.RelationshipState)
	uncachedIDs := make([]uint, 0)

	if redis.IsAvailable() {
		for _, targetID := range targetIDs {
			cacheKey := fmt.Sprintf("%s%d:%d", constants.FollowRelCachePrefix, viewerID, targetID)
			cached, err := redis.Get().Get(ctx, cacheKey).Result()
			if err == nil {
				result[targetID] = models.RelationshipState(cached)
			} else {
				uncachedIDs = append(uncachedIDs, targetID)
			}
		}
	} else {
		uncachedIDs = targetIDs
	}

	// Fetch uncached from DB
	if len(uncachedIDs) > 0 {
		dbResult, err := s.repo.BatchLookupRelationships(viewerID, uncachedIDs)
		if err != nil {
			return nil, fmt.Errorf("failed to lookup relationships: %w", err)
		}

		// Merge and cache results
		for targetID, state := range dbResult {
			result[targetID] = state
			if redis.IsAvailable() {
				cacheKey := fmt.Sprintf("%s%d:%d", constants.FollowRelCachePrefix, viewerID, targetID)
				redis.Get().Set(ctx, cacheKey, string(state), constants.FollowRelCacheTTL)
			}
		}
	}

	return result, nil
}

// GetRelationshipState returns the relationship state for viewer -> target
func (s *FollowService) GetRelationshipState(ctx context.Context, viewerID, targetID uint) (models.RelationshipState, error) {
	relationships, err := s.LookupRelationships(ctx, viewerID, []uint{targetID})
	if err != nil {
		return models.RelationshipNone, err
	}
	if state, exists := relationships[targetID]; exists {
		return state, nil
	}
	return models.RelationshipNone, nil
}

// ==================== Mutuals ====================

// GetMutuals returns users that both viewer follows and who follow the target user
func (s *FollowService) GetMutuals(ctx context.Context, viewerID, targetUserID uint, limit int, cursor *repository.FollowListCursor) ([]uint, bool, error) {
	// Check privacy
	if err := s.checkListAccess(ctx, viewerID, targetUserID); err != nil {
		return nil, false, err
	}

	// Clamp limit
	if limit <= 0 || limit > constants.FollowListMaxLimit {
		limit = constants.FollowListDefaultLimit
	}

	// Fetch one extra to check for more
	userIDs, err := s.repo.GetMutualFollowerIDs(viewerID, targetUserID, limit+1, cursor)
	if err != nil {
		return nil, false, fmt.Errorf("failed to get mutuals: %w", err)
	}

	hasMore := len(userIDs) > limit
	if hasMore {
		userIDs = userIDs[:limit]
	}

	return userIDs, hasMore, nil
}

// GetMutualsWithTimestamps returns mutual followers with timestamps for cursor pagination
func (s *FollowService) GetMutualsWithTimestamps(ctx context.Context, viewerID, targetUserID uint, limit int, cursor *repository.FollowListCursor) ([]MutualEdge, bool, error) {
	// Check privacy
	if err := s.checkListAccess(ctx, viewerID, targetUserID); err != nil {
		return nil, false, err
	}

	// Clamp limit
	if limit <= 0 || limit > constants.FollowListMaxLimit {
		limit = constants.FollowListDefaultLimit
	}

	// Fetch one extra to check for more
	rows, err := s.repo.GetMutualFollowersWithTimestamps(viewerID, targetUserID, limit+1, cursor)
	if err != nil {
		return nil, false, fmt.Errorf("failed to get mutuals: %w", err)
	}

	hasMore := len(rows) > limit
	if hasMore {
		rows = rows[:limit]
	}

	// Convert repository type to service type
	edges := make([]MutualEdge, len(rows))
	for i, row := range rows {
		edges[i] = MutualEdge{
			UserID:    row.UserID,
			CreatedAt: row.CreatedAt,
		}
	}

	return edges, hasMore, nil
}

// ==================== Counts ====================

// GetFollowCounts returns cached or fresh follow counts for a user
func (s *FollowService) GetFollowCounts(ctx context.Context, userID uint) (followersCount, followingCount int64, err error) {
	// Try cache first
	if redis.IsAvailable() {
		cacheKey := fmt.Sprintf("%s%d", constants.FollowCountCachePrefix, userID)
		cached, err := redis.Get().HGetAll(ctx, cacheKey).Result()
		if err == nil && len(cached) > 0 {
			if fc, ok := cached["followers"]; ok {
				fmt.Sscanf(fc, "%d", &followersCount)
			}
			if fg, ok := cached["following"]; ok {
				fmt.Sscanf(fg, "%d", &followingCount)
			}
			return followersCount, followingCount, nil
		}
	}

	// Get from DB
	followersCount, followingCount, err = s.repo.GetFollowCounts(userID)
	if err != nil {
		return 0, 0, err
	}

	// Cache the result
	if redis.IsAvailable() {
		cacheKey := fmt.Sprintf("%s%d", constants.FollowCountCachePrefix, userID)
		redis.Get().HSet(ctx, cacheKey,
			"followers", followersCount,
			"following", followingCount,
		)
		redis.Get().Expire(ctx, cacheKey, constants.FollowCountCacheTTL)
	}

	return followersCount, followingCount, nil
}

// GetPendingRequestsCount returns the count of pending follow requests for a user
func (s *FollowService) GetPendingRequestsCount(ctx context.Context, userID uint) int64 {
	count, err := s.repo.CountPendingRequestsFor(userID)
	if err != nil {
		return 0
	}
	return count
}

// ReconcileCounters recalculates counters from actual edge data for a user
// Use this to fix counter drift
func (s *FollowService) ReconcileCounters(ctx context.Context, userID uint) error {
	if err := s.repo.ReconcileCounters(userID); err != nil {
		return fmt.Errorf("failed to reconcile counters: %w", err)
	}

	// Invalidate cache after reconciliation
	if redis.IsAvailable() {
		cacheKey := fmt.Sprintf("%s%d", constants.FollowCountCachePrefix, userID)
		redis.Get().Del(ctx, cacheKey)
	}

	logger.Sugar.Infow("Counters reconciled", "user_id", userID)
	return nil
}

// ==================== Helper Methods ====================

// checkFollowLimits validates that the user hasn't exceeded follow limits
func (s *FollowService) checkFollowLimits(ctx context.Context, followerID uint) error {
	// Check total following limit
	totalFollowing, err := s.repo.CountFollowing(followerID)
	if err != nil {
		return fmt.Errorf("failed to count following: %w", err)
	}
	if int(totalFollowing) >= s.cfg.MaxTotalFollowing {
		return fmt.Errorf("%s: you have reached the maximum following limit of %d",
			constants.ErrCodeFollowLimitExceeded, s.cfg.MaxTotalFollowing)
	}

	// Check daily limit
	dailyFollows, err := s.repo.CountDailyFollows(followerID)
	if err != nil {
		return fmt.Errorf("failed to count daily follows: %w", err)
	}
	if int(dailyFollows) >= s.cfg.MaxFollowsPerDay {
		return fmt.Errorf("%s: you have reached the daily follow limit of %d",
			constants.ErrCodeDailyLimitExceeded, s.cfg.MaxFollowsPerDay)
	}

	return nil
}

// checkListAccess verifies the viewer can access the target user's follow lists
func (s *FollowService) checkListAccess(ctx context.Context, viewerID, targetUserID uint) error {
	// Always allow viewing own lists
	if viewerID == targetUserID {
		return nil
	}

	// Check if target is private
	targetUser, err := s.userRepo.FindByID(targetUserID)
	if err != nil {
		return fmt.Errorf("failed to fetch target user: %w", err)
	}
	if targetUser == nil {
		return fmt.Errorf("%s: user not found", constants.ErrCodeUserNotFound)
	}

	// Public accounts: anyone can view
	if !targetUser.IsPrivate {
		return nil
	}

	// Private accounts: only approved followers can view
	activeEdge, err := s.repo.GetActiveEdge(viewerID, targetUserID)
	if err != nil {
		return fmt.Errorf("failed to check follow status: %w", err)
	}
	if activeEdge == nil {
		return fmt.Errorf("%s: this account is private", constants.ErrCodeAccountPrivate)
	}

	return nil
}

// publishFollowEvent publishes a follow event to Redis for async processing
func (s *FollowService) publishFollowEvent(ctx context.Context, eventType models.FollowEventType, followerID, followeeID uint, state models.FollowState) {
	if !redis.IsAvailable() {
		// Fall back to synchronous counter updates
		s.updateCountersSynchronously(eventType, followerID, followeeID, state)
		return
	}

	event := models.FollowEvent{
		Type:       eventType,
		FollowerID: followerID,
		FolloweeID: followeeID,
		State:      state,
		Timestamp:  time.Now(),
	}

	payload, err := json.Marshal(event)
	if err != nil {
		logger.Sugar.Errorw("Failed to marshal follow event",
			"event_type", eventType,
			"error", err,
		)
		// Fall back to synchronous updates
		s.updateCountersSynchronously(eventType, followerID, followeeID, state)
		return
	}

	if err := redis.Get().Publish(ctx, constants.FollowEventChannel, payload).Err(); err != nil {
		logger.Sugar.Errorw("Failed to publish follow event",
			"event_type", eventType,
			"error", err,
		)
		// Fall back to synchronous updates
		s.updateCountersSynchronously(eventType, followerID, followeeID, state)
	}
}

// updateCountersSynchronously updates counters directly (fallback when Redis unavailable)
func (s *FollowService) updateCountersSynchronously(eventType models.FollowEventType, followerID, followeeID uint, state models.FollowState) {
	switch eventType {
	case models.FollowEventCreated:
		if state == models.FollowStatePending {
			// Follow request sent to private account - only increment pending count
			s.repo.IncrementPendingRequestsCount(followeeID, 1)
		} else {
			// Direct follow to public account - increment following/followers
			s.repo.IncrementFollowingCount(followerID, 1)
			s.repo.IncrementFollowersCount(followeeID, 1)
		}

	case models.FollowEventAccepted:
		// Transition from pending to active
		s.repo.IncrementFollowingCount(followerID, 1)
		s.repo.IncrementFollowersCount(followeeID, 1)
		s.repo.IncrementPendingRequestsCount(followeeID, -1)

	case models.FollowEventRemoved:
		s.repo.IncrementFollowingCount(followerID, -1)
		s.repo.IncrementFollowersCount(followeeID, -1)

	case models.FollowEventDeclined:
		s.repo.IncrementPendingRequestsCount(followeeID, -1)
	}
}

// invalidateRelationshipCache invalidates cached relationship state
func (s *FollowService) invalidateRelationshipCache(ctx context.Context, followerID, followeeID uint) {
	if !redis.IsAvailable() {
		return
	}

	// Invalidate relationship cache
	relCacheKey := fmt.Sprintf("%s%d:%d", constants.FollowRelCachePrefix, followerID, followeeID)
	redis.Get().Del(ctx, relCacheKey)

	// Invalidate count caches
	followerCountKey := fmt.Sprintf("%s%d", constants.FollowCountCachePrefix, followerID)
	followeeCountKey := fmt.Sprintf("%s%d", constants.FollowCountCachePrefix, followeeID)
	redis.Get().Del(ctx, followerCountKey, followeeCountKey)
}

// ==================== Counter Event Subscriber ====================

// StartFollowCounterSubscriber starts the Redis subscriber for follow events
// This runs in a goroutine and updates counters asynchronously
func (s *FollowService) StartFollowCounterSubscriber(ctx context.Context) {
	if !redis.IsAvailable() {
		logger.Sugar.Warn("Redis not available, follow counter subscriber not started")
		return
	}

	go func() {
		pubsub := redis.Get().Subscribe(ctx, constants.FollowEventChannel)
		defer pubsub.Close()

		logger.Sugar.Info("Follow counter subscriber started")

		ch := pubsub.Channel()
		for {
			select {
			case <-ctx.Done():
				logger.Sugar.Info("Follow counter subscriber stopped")
				return
			case msg := <-ch:
				if msg == nil {
					continue
				}
				s.handleFollowEvent(ctx, msg.Payload)
			}
		}
	}()
}

// handleFollowEvent processes a follow event from the pub/sub channel
func (s *FollowService) handleFollowEvent(ctx context.Context, payload string) {
	var event models.FollowEvent
	if err := json.Unmarshal([]byte(payload), &event); err != nil {
		logger.Sugar.Errorw("Failed to unmarshal follow event",
			"payload", payload,
			"error", err,
		)
		return
	}

	// Update counters based on event type
	switch event.Type {
	case models.FollowEventCreated:
		switch event.State {
		case models.FollowStateActive:
			// Direct follow (public account)
			s.repo.IncrementFollowingCount(event.FollowerID, 1)
			s.repo.IncrementFollowersCount(event.FolloweeID, 1)
		case models.FollowStatePending:
			// Follow request (private account)
			s.repo.IncrementPendingRequestsCount(event.FolloweeID, 1)
		}

	case models.FollowEventAccepted:
		// Request accepted: pending -> active
		s.repo.IncrementFollowingCount(event.FollowerID, 1)
		s.repo.IncrementFollowersCount(event.FolloweeID, 1)
		s.repo.IncrementPendingRequestsCount(event.FolloweeID, -1)

	case models.FollowEventRemoved:
		// Unfollow
		s.repo.IncrementFollowingCount(event.FollowerID, -1)
		s.repo.IncrementFollowersCount(event.FolloweeID, -1)

	case models.FollowEventDeclined:
		// Request declined or cancelled
		s.repo.IncrementPendingRequestsCount(event.FolloweeID, -1)
	}

	// Invalidate count caches
	if redis.IsAvailable() {
		followerCountKey := fmt.Sprintf("%s%d", constants.FollowCountCachePrefix, event.FollowerID)
		followeeCountKey := fmt.Sprintf("%s%d", constants.FollowCountCachePrefix, event.FolloweeID)
		redis.Get().Del(ctx, followerCountKey, followeeCountKey)
	}

	logger.Sugar.Debugw("Follow event processed",
		"event_type", event.Type,
		"follower_id", event.FollowerID,
		"followee_id", event.FolloweeID,
	)
}
