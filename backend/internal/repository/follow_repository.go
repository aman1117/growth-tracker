// Package repository provides data access layer for the follow system.
package repository

import (
	"errors"
	"time"

	"github.com/aman1117/backend/pkg/models"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// FollowRepository handles follow relationship data operations
type FollowRepository struct {
	db *gorm.DB
}

// NewFollowRepository creates a new FollowRepository
func NewFollowRepository(db *gorm.DB) *FollowRepository {
	return &FollowRepository{db: db}
}

// GetDB returns the underlying database connection for transactions
func (r *FollowRepository) GetDB() *gorm.DB {
	return r.db
}

// IsFollowing checks if followerID is actively following followeeID
func (r *FollowRepository) IsFollowing(followerID, followeeID uint) (bool, error) {
	var count int64
	err := r.db.Model(&models.FollowEdgeByFollower{}).
		Where("follower_id = ? AND followee_id = ? AND state = ?",
			followerID, followeeID, models.FollowStateActive).
		Count(&count).Error
	if err != nil {
		return false, err
	}
	return count > 0, nil
}

// ==================== Edge Operations ====================

// UpsertEdgeDualWrite creates or updates a follow edge in both tables atomically
func (r *FollowRepository) UpsertEdgeDualWrite(followerID, followeeID uint, state models.FollowState) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		now := time.Now()
		var acceptedAt *time.Time
		if state == models.FollowStateActive {
			acceptedAt = &now
		}

		// Upsert into follow_edges_by_follower
		edgeByFollower := models.FollowEdgeByFollower{
			FollowerID: followerID,
			FolloweeID: followeeID,
			State:      state,
			AcceptedAt: acceptedAt,
		}
		if err := tx.Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "follower_id"}, {Name: "followee_id"}},
			DoUpdates: clause.AssignmentColumns([]string{"state", "accepted_at", "updated_at"}),
		}).Create(&edgeByFollower).Error; err != nil {
			return err
		}

		// Upsert into follow_edges_by_followee
		edgeByFollowee := models.FollowEdgeByFollowee{
			FolloweeID: followeeID,
			FollowerID: followerID,
			State:      state,
			AcceptedAt: acceptedAt,
		}
		if err := tx.Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "followee_id"}, {Name: "follower_id"}},
			DoUpdates: clause.AssignmentColumns([]string{"state", "accepted_at", "updated_at"}),
		}).Create(&edgeByFollowee).Error; err != nil {
			return err
		}

		return nil
	})
}

// UpdateEdgeState updates the state of an existing edge
func (r *FollowRepository) UpdateEdgeState(followerID, followeeID uint, newState models.FollowState) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		now := time.Now()
		updates := map[string]interface{}{
			"state":      newState,
			"updated_at": now,
		}
		if newState == models.FollowStateActive {
			updates["accepted_at"] = now
		}

		// Update follow_edges_by_follower
		if err := tx.Model(&models.FollowEdgeByFollower{}).
			Where("follower_id = ? AND followee_id = ?", followerID, followeeID).
			Updates(updates).Error; err != nil {
			return err
		}

		// Update follow_edges_by_followee
		if err := tx.Model(&models.FollowEdgeByFollowee{}).
			Where("followee_id = ? AND follower_id = ?", followeeID, followerID).
			Updates(updates).Error; err != nil {
			return err
		}

		return nil
	})
}

// GetEdge retrieves the follow edge state between two users
func (r *FollowRepository) GetEdge(followerID, followeeID uint) (*models.FollowEdgeByFollower, error) {
	var edge models.FollowEdgeByFollower
	err := r.db.Where("follower_id = ? AND followee_id = ?", followerID, followeeID).First(&edge).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &edge, nil
}

// GetActiveEdge retrieves an active follow relationship
func (r *FollowRepository) GetActiveEdge(followerID, followeeID uint) (*models.FollowEdgeByFollower, error) {
	var edge models.FollowEdgeByFollower
	err := r.db.Where("follower_id = ? AND followee_id = ? AND state = ?",
		followerID, followeeID, models.FollowStateActive).First(&edge).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &edge, nil
}

// GetPendingEdge retrieves a pending follow request
func (r *FollowRepository) GetPendingEdge(followerID, followeeID uint) (*models.FollowEdgeByFollower, error) {
	var edge models.FollowEdgeByFollower
	err := r.db.Where("follower_id = ? AND followee_id = ? AND state = ?",
		followerID, followeeID, models.FollowStatePending).First(&edge).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &edge, nil
}

// ==================== List Operations (Cursor-based Pagination) ====================

// FollowListCursor represents a cursor for paginated follow lists
type FollowListCursor struct {
	CreatedAt time.Time
	UserID    uint
}

// GetFollowersPaginated returns paginated followers for a user
func (r *FollowRepository) GetFollowersPaginated(followeeID uint, limit int, cursor *FollowListCursor) ([]models.FollowEdgeByFollowee, error) {
	query := r.db.Where("followee_id = ? AND state = ?", followeeID, models.FollowStateActive)

	if cursor != nil {
		query = query.Where("(created_at, follower_id) < (?, ?)", cursor.CreatedAt, cursor.UserID)
	}

	var edges []models.FollowEdgeByFollowee
	err := query.Order("created_at DESC, follower_id DESC").Limit(limit).Find(&edges).Error
	return edges, err
}

// GetFollowingPaginated returns paginated following for a user
func (r *FollowRepository) GetFollowingPaginated(followerID uint, limit int, cursor *FollowListCursor) ([]models.FollowEdgeByFollower, error) {
	query := r.db.Where("follower_id = ? AND state = ?", followerID, models.FollowStateActive)

	if cursor != nil {
		query = query.Where("(created_at, followee_id) < (?, ?)", cursor.CreatedAt, cursor.UserID)
	}

	var edges []models.FollowEdgeByFollower
	err := query.Order("created_at DESC, followee_id DESC").Limit(limit).Find(&edges).Error
	return edges, err
}

// GetPendingIncomingRequests returns paginated pending follow requests for a user
func (r *FollowRepository) GetPendingIncomingRequests(followeeID uint, limit int, cursor *FollowListCursor) ([]models.FollowEdgeByFollowee, error) {
	query := r.db.Where("followee_id = ? AND state = ?", followeeID, models.FollowStatePending)

	if cursor != nil {
		query = query.Where("(created_at, follower_id) < (?, ?)", cursor.CreatedAt, cursor.UserID)
	}

	var edges []models.FollowEdgeByFollowee
	err := query.Order("created_at DESC, follower_id DESC").Limit(limit).Find(&edges).Error
	return edges, err
}

// GetPendingOutgoingRequests returns paginated outgoing pending requests
func (r *FollowRepository) GetPendingOutgoingRequests(followerID uint, limit int, cursor *FollowListCursor) ([]models.FollowEdgeByFollower, error) {
	query := r.db.Where("follower_id = ? AND state = ?", followerID, models.FollowStatePending)

	if cursor != nil {
		query = query.Where("(created_at, followee_id) < (?, ?)", cursor.CreatedAt, cursor.UserID)
	}

	var edges []models.FollowEdgeByFollower
	err := query.Order("created_at DESC, followee_id DESC").Limit(limit).Find(&edges).Error
	return edges, err
}

// ==================== Batch Operations ====================

// BatchLookupRelationships returns the relationship states for viewer -> targets
func (r *FollowRepository) BatchLookupRelationships(viewerID uint, targetIDs []uint) (map[uint]models.RelationshipState, error) {
	result := make(map[uint]models.RelationshipState)
	for _, id := range targetIDs {
		result[id] = models.RelationshipNone
	}

	if len(targetIDs) == 0 {
		return result, nil
	}

	// Check outgoing: viewer -> targets (following or requested)
	var outgoingEdges []models.FollowEdgeByFollower
	err := r.db.Where("follower_id = ? AND followee_id IN ? AND state IN ?",
		viewerID, targetIDs, []models.FollowState{models.FollowStateActive, models.FollowStatePending}).
		Find(&outgoingEdges).Error
	if err != nil {
		return nil, err
	}

	for _, edge := range outgoingEdges {
		switch edge.State {
		case models.FollowStateActive:
			result[edge.FolloweeID] = models.RelationshipFollowing
		case models.FollowStatePending:
			result[edge.FolloweeID] = models.RelationshipRequested
		}
	}

	// Check incoming: targets -> viewer (pending requests to viewer)
	var incomingEdges []models.FollowEdgeByFollower
	err = r.db.Where("follower_id IN ? AND followee_id = ? AND state = ?",
		targetIDs, viewerID, models.FollowStatePending).
		Find(&incomingEdges).Error
	if err != nil {
		return nil, err
	}

	for _, edge := range incomingEdges {
		// Only set incoming pending if not already following
		if result[edge.FollowerID] == models.RelationshipNone {
			result[edge.FollowerID] = models.RelationshipIncomingPending
		}
	}

	return result, nil
}

// GetMutualFollowerIDs returns IDs of users who both follow targetUserID and viewerID follows
func (r *FollowRepository) GetMutualFollowerIDs(viewerID, targetUserID uint, limit int, cursor *FollowListCursor) ([]uint, error) {
	// Find users that viewerID follows AND who also follow targetUserID
	query := r.db.Table("follow_edges_by_follower AS f1").
		Select("f1.followee_id").
		Joins("INNER JOIN follow_edges_by_followee AS f2 ON f1.followee_id = f2.follower_id").
		Where("f1.follower_id = ? AND f1.state = ?", viewerID, models.FollowStateActive).
		Where("f2.followee_id = ? AND f2.state = ?", targetUserID, models.FollowStateActive)

	if cursor != nil {
		query = query.Where("f1.created_at < ?", cursor.CreatedAt)
	}

	var userIDs []uint
	err := query.Order("f1.created_at DESC").Limit(limit).Pluck("f1.followee_id", &userIDs).Error
	return userIDs, err
}

// MutualEdgeRow represents a row returned from the mutuals query with timestamps
type MutualEdgeRow struct {
	UserID    uint      `gorm:"column:user_id"`
	CreatedAt time.Time `gorm:"column:created_at"`
}

// GetMutualFollowersWithTimestamps returns mutual followers with timestamps for cursor pagination
func (r *FollowRepository) GetMutualFollowersWithTimestamps(viewerID, targetUserID uint, limit int, cursor *FollowListCursor) ([]MutualEdgeRow, error) {
	// Find users that viewerID follows AND who also follow targetUserID
	query := r.db.Table("follow_edges_by_follower AS f1").
		Select("f1.followee_id AS user_id, f1.created_at").
		Joins("INNER JOIN follow_edges_by_followee AS f2 ON f1.followee_id = f2.follower_id").
		Where("f1.follower_id = ? AND f1.state = ?", viewerID, models.FollowStateActive).
		Where("f2.followee_id = ? AND f2.state = ?", targetUserID, models.FollowStateActive)

	if cursor != nil {
		query = query.Where("(f1.created_at, f1.followee_id) < (?, ?)", cursor.CreatedAt, cursor.UserID)
	}

	var edges []MutualEdgeRow
	err := query.Order("f1.created_at DESC, f1.followee_id DESC").Limit(limit).Scan(&edges).Error
	return edges, err
}

// ==================== Counter Operations ====================

// GetOrCreateCounter gets or creates a follow counter for a user
func (r *FollowRepository) GetOrCreateCounter(userID uint) (*models.FollowCounter, error) {
	var counter models.FollowCounter
	err := r.db.Where("user_id = ?", userID).First(&counter).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			counter = models.FollowCounter{UserID: userID}
			if err := r.db.Create(&counter).Error; err != nil {
				return nil, err
			}
			return &counter, nil
		}
		return nil, err
	}
	return &counter, nil
}

// IncrementFollowersCount atomically increments the followers count
func (r *FollowRepository) IncrementFollowersCount(userID uint, delta int64) error {
	return r.db.Exec(
		`INSERT INTO follow_counters (user_id, followers_count, following_count, pending_requests_count, updated_at)
		 VALUES (?, ?, 0, 0, NOW())
		 ON CONFLICT (user_id) DO UPDATE SET
		 followers_count = follow_counters.followers_count + ?,
		 updated_at = NOW()`,
		userID, delta, delta,
	).Error
}

// IncrementFollowingCount atomically increments the following count
func (r *FollowRepository) IncrementFollowingCount(userID uint, delta int64) error {
	return r.db.Exec(
		`INSERT INTO follow_counters (user_id, followers_count, following_count, pending_requests_count, updated_at)
		 VALUES (?, 0, ?, 0, NOW())
		 ON CONFLICT (user_id) DO UPDATE SET
		 following_count = follow_counters.following_count + ?,
		 updated_at = NOW()`,
		userID, delta, delta,
	).Error
}

// IncrementPendingRequestsCount atomically increments the pending requests count
func (r *FollowRepository) IncrementPendingRequestsCount(userID uint, delta int64) error {
	return r.db.Exec(
		`INSERT INTO follow_counters (user_id, followers_count, following_count, pending_requests_count, updated_at)
		 VALUES (?, 0, 0, ?, NOW())
		 ON CONFLICT (user_id) DO UPDATE SET
		 pending_requests_count = follow_counters.pending_requests_count + ?,
		 updated_at = NOW()`,
		userID, delta, delta,
	).Error
}

// GetFollowCounts retrieves the follow counts for a user
func (r *FollowRepository) GetFollowCounts(userID uint) (followersCount, followingCount int64, err error) {
	var counter models.FollowCounter
	err = r.db.Where("user_id = ?", userID).First(&counter).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return 0, 0, nil
		}
		return 0, 0, err
	}
	return counter.FollowersCount, counter.FollowingCount, nil
}

// GetPendingRequestsCount retrieves the pending requests count for a user
func (r *FollowRepository) GetPendingRequestsCount(userID uint) (int64, error) {
	var counter models.FollowCounter
	err := r.db.Where("user_id = ?", userID).First(&counter).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return 0, nil
		}
		return 0, err
	}
	return counter.PendingRequestsCount, nil
}

// ==================== Cleanup Operations ====================

// CleanupOldTombstones removes REMOVED edges older than the specified duration
func (r *FollowRepository) CleanupOldTombstones(olderThan time.Time) (int64, error) {
	var totalDeleted int64

	// Delete from follow_edges_by_follower
	result := r.db.Where("state = ? AND updated_at < ?", models.FollowStateRemoved, olderThan).
		Delete(&models.FollowEdgeByFollower{})
	if result.Error != nil {
		return 0, result.Error
	}
	totalDeleted += result.RowsAffected

	// Delete from follow_edges_by_followee
	result = r.db.Where("state = ? AND updated_at < ?", models.FollowStateRemoved, olderThan).
		Delete(&models.FollowEdgeByFollowee{})
	if result.Error != nil {
		return totalDeleted, result.Error
	}
	totalDeleted += result.RowsAffected

	return totalDeleted, nil
}

// ==================== Count Queries (for validation) ====================

// CountFollowing returns the total active following count for a user
func (r *FollowRepository) CountFollowing(userID uint) (int64, error) {
	var count int64
	err := r.db.Model(&models.FollowEdgeByFollower{}).
		Where("follower_id = ? AND state = ?", userID, models.FollowStateActive).
		Count(&count).Error
	return count, err
}

// CountDailyFollows returns the number of follows made by a user today
func (r *FollowRepository) CountDailyFollows(userID uint) (int64, error) {
	var count int64
	today := time.Now().Truncate(24 * time.Hour)
	tomorrow := today.Add(24 * time.Hour)

	err := r.db.Model(&models.FollowEdgeByFollower{}).
		Where("follower_id = ? AND created_at >= ? AND created_at < ?", userID, today, tomorrow).
		Count(&count).Error
	return count, err
}

// CountPendingRequestsFor returns the number of pending follow requests for a user
func (r *FollowRepository) CountPendingRequestsFor(userID uint) (int64, error) {
	var count int64
	err := r.db.Model(&models.FollowEdgeByFollowee{}).
		Where("followee_id = ? AND state = ?", userID, models.FollowStatePending).
		Count(&count).Error
	return count, err
}
