// Package services contains business logic for notifications.
package services

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/logger"
	"github.com/aman1117/backend/internal/repository"
	"github.com/aman1117/backend/pkg/models"
	"github.com/aman1117/backend/pkg/redis"
	goredis "github.com/redis/go-redis/v9"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// NotificationService handles notification business logic
type NotificationService struct {
	repo *repository.NotificationRepository
}

// NewNotificationService creates a new NotificationService
func NewNotificationService(
	repo *repository.NotificationRepository,
) *NotificationService {
	return &NotificationService{
		repo: repo,
	}
}

// ==================== Core CRUD Operations ====================

// Create creates a notification and attempts real-time delivery
func (s *NotificationService) Create(ctx context.Context, notif *models.Notification) error {
	// 1. Save to database (source of truth)
	if err := s.repo.Create(notif); err != nil {
		logger.Sugar.Errorw("Failed to create notification",
			"user_id", notif.UserID,
			"type", notif.Type,
			"error", err,
		)
		return fmt.Errorf("failed to create notification: %w", err)
	}

	// 2. Invalidate unread count cache
	s.invalidateUnreadCache(ctx, notif.UserID)

	// 3. Attempt real-time delivery via pub/sub
	s.publishNotification(ctx, notif)

	logger.Sugar.Infow("Notification created",
		"id", notif.ID,
		"user_id", notif.UserID,
		"type", notif.Type,
	)

	return nil
}

// GetByUserID retrieves paginated notifications for a user
func (s *NotificationService) GetByUserID(ctx context.Context, userID uint, page, pageSize int) ([]models.Notification, int64, error) {
	offset := (page - 1) * pageSize

	notifs, err := s.repo.GetByUserID(userID, pageSize, offset)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to get notifications: %w", err)
	}

	total, err := s.repo.CountByUserID(userID)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to count notifications: %w", err)
	}

	return notifs, total, nil
}

// GetUnreadCount returns the unread notification count (with caching)
func (s *NotificationService) GetUnreadCount(ctx context.Context, userID uint) (int64, error) {
	// Try cache first
	if redis.IsAvailable() {
		cacheKey := fmt.Sprintf("%s%d", constants.NotifUnreadPrefix, userID)
		cached, err := redis.Get().Get(ctx, cacheKey).Int64()
		if err == nil {
			return cached, nil
		}
		// Cache miss or error - fall through to DB
	}

	// Get from database
	count, err := s.repo.GetUnreadCount(userID)
	if err != nil {
		return 0, fmt.Errorf("failed to get unread count: %w", err)
	}

	// Cache the result
	if redis.IsAvailable() {
		cacheKey := fmt.Sprintf("%s%d", constants.NotifUnreadPrefix, userID)
		redis.Get().Set(ctx, cacheKey, count, constants.NotifUnreadCacheTTL)
	}

	return count, nil
}

// MarkAsRead marks a single notification as read
func (s *NotificationService) MarkAsRead(ctx context.Context, id, userID uint) error {
	if err := s.repo.MarkAsRead(id, userID); err != nil {
		return fmt.Errorf("failed to mark notification as read: %w", err)
	}

	s.invalidateUnreadCache(ctx, userID)
	return nil
}

// MarkAllAsRead marks all notifications as read for a user
func (s *NotificationService) MarkAllAsRead(ctx context.Context, userID uint) error {
	if err := s.repo.MarkAllAsRead(userID); err != nil {
		return fmt.Errorf("failed to mark all notifications as read: %w", err)
	}

	s.invalidateUnreadCache(ctx, userID)
	return nil
}

// Delete deletes a notification
func (s *NotificationService) Delete(ctx context.Context, id, userID uint) error {
	// Check if notification exists and belongs to user
	notif, err := s.repo.GetByID(id)
	if err != nil {
		return fmt.Errorf("failed to get notification: %w", err)
	}
	if notif == nil || notif.UserID != userID {
		return fmt.Errorf("notification not found")
	}

	if err := s.repo.Delete(id, userID); err != nil {
		return fmt.Errorf("failed to delete notification: %w", err)
	}

	if !notif.IsRead() {
		s.invalidateUnreadCache(ctx, userID)
	}

	return nil
}

// ==================== Notification Triggers ====================

// NotifyLikeReceived creates a notification when someone likes a user's day.
// Uses NotificationDedupe table to ensure "only once ever" delivery per
// (recipient, liker, date) combination. Safe for unlike/re-like scenarios.
func (s *NotificationService) NotifyLikeReceived(
	ctx context.Context,
	recipientUserID uint,
	likerID uint,
	likerUsername string,
	likerAvatar string,
	likedDate string,
) error {
	// Build entity key for dedupe: "likedUserID:date"
	entityKey := fmt.Sprintf("%d:%s", recipientUserID, likedDate)

	// Use transaction to ensure atomicity of dedupe check + notification create
	db := s.repo.GetDB()
	return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// 1. Try to insert dedupe record with ON CONFLICT DO NOTHING
		dedupe := &models.NotificationDedupe{
			UserID:     recipientUserID,
			ActorID:    likerID,
			Type:       models.NotifTypeLikeReceived,
			EntityType: "day_like",
			EntityKey:  entityKey,
		}

		result := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(dedupe)
		if result.Error != nil {
			logger.Sugar.Errorw("Failed to create dedupe record",
				"user_id", recipientUserID,
				"actor_id", likerID,
				"entity_key", entityKey,
				"error", result.Error,
			)
			return result.Error
		}

		// 2. If dedupe record already existed (conflict), skip notification
		if result.RowsAffected == 0 {
			logger.Sugar.Debugw("Skipping duplicate like notification",
				"user_id", recipientUserID,
				"actor_id", likerID,
				"entity_key", entityKey,
			)
			return nil
		}

		// 3. Format the date nicely (e.g., "2 Jan, 2026")
		formattedDate := likedDate
		if parsedDate, err := time.Parse("2006-01-02", likedDate); err == nil {
			formattedDate = parsedDate.Format("2 Jan, 2006")
		}

		// 4. Create the notification
		notif := &models.Notification{
			UserID: recipientUserID,
			Type:   models.NotifTypeLikeReceived,
			Title:  "New Like!",
			Body:   fmt.Sprintf("%s liked your %s activities", likerUsername, formattedDate),
			Metadata: models.LikeMetadata{
				LikerID:       likerID,
				LikerUsername: likerUsername,
				LikerAvatar:   likerAvatar,
				LikedDate:     likedDate,
			}.ToMap(),
		}

		if err := tx.Create(notif).Error; err != nil {
			logger.Sugar.Errorw("Failed to create notification in transaction",
				"user_id", recipientUserID,
				"type", notif.Type,
				"error", err,
			)
			return err
		}

		logger.Sugar.Infow("Like notification created",
			"id", notif.ID,
			"user_id", recipientUserID,
			"liker_id", likerID,
			"liked_date", likedDate,
		)

		// Side effects run after transaction commits successfully
		// This is safe because GORM commits when callback returns nil
		s.invalidateUnreadCache(ctx, recipientUserID)
		s.publishNotification(ctx, notif)

		// Publish to push notification queue (Web Push)
		if publisher := GetPushPublisher(); publisher != nil && publisher.IsAvailable() {
			dedupeKey := fmt.Sprintf("like:%d:%s", recipientUserID, likedDate)
			// Navigate to the recipient's own day (home with date param), not the liker's profile
			deepLink := fmt.Sprintf("/?date=%s", likedDate)
			if err := publisher.PublishFromNotification(ctx, notif, dedupeKey, deepLink); err != nil {
				logger.Sugar.Warnw("Failed to publish push notification for like",
					"notif_id", notif.ID,
					"error", err,
				)
				// Non-fatal, in-app notification is still delivered
			}
		}

		return nil
	})
}

// NotifyBadgeUnlocked creates a notification when a user unlocks a badge
func (s *NotificationService) NotifyBadgeUnlocked(
	ctx context.Context,
	userID uint,
	badgeID, badgeName, badgeIcon string,
) error {
	notif := &models.Notification{
		UserID: userID,
		Type:   models.NotifTypeBadgeUnlocked,
		Title:  "Badge Unlocked! 🏆",
		Body:   fmt.Sprintf("You earned the %s badge", badgeName),
		Metadata: models.BadgeMetadata{
			BadgeID:   badgeID,
			BadgeName: badgeName,
			BadgeIcon: badgeIcon,
		}.ToMap(),
	}

	if err := s.Create(ctx, notif); err != nil {
		return err
	}

	// Publish to push notification queue (Web Push)
	if publisher := GetPushPublisher(); publisher != nil && publisher.IsAvailable() {
		dedupeKey := fmt.Sprintf("badge:%d:%s", userID, badgeID)
		deepLink := "/profile/badges"
		if err := publisher.PublishFromNotification(ctx, notif, dedupeKey, deepLink); err != nil {
			logger.Sugar.Warnw("Failed to publish push notification for badge",
				"notif_id", notif.ID,
				"error", err,
			)
			// Non-fatal, in-app notification is still delivered
		}
	}

	return nil
}

// NotifyStreakMilestone creates a notification for streak milestones
func (s *NotificationService) NotifyStreakMilestone(
	ctx context.Context,
	userID uint,
	activityType string,
	streakCount int,
) error {
	notif := &models.Notification{
		UserID: userID,
		Type:   models.NotifTypeStreakMilestone,
		Title:  "Streak Milestone! 🔥",
		Body:   fmt.Sprintf("You've maintained a %d-day %s streak!", streakCount, activityType),
		Metadata: models.StreakMetadata{
			ActivityType: activityType,
			StreakCount:  streakCount,
		}.ToMap(),
	}

	return s.Create(ctx, notif)
}

// NotifyStreakAtRisk creates a notification when a streak is about to break
func (s *NotificationService) NotifyStreakAtRisk(
	ctx context.Context,
	userID uint,
	activityType string,
	streakCount int,
) error {
	notif := &models.Notification{
		UserID: userID,
		Type:   models.NotifTypeStreakAtRisk,
		Title:  "Streak at Risk! ⚠️",
		Body:   fmt.Sprintf("Don't lose your %d-day %s streak! Log today's activity.", streakCount, activityType),
		Metadata: models.StreakMetadata{
			ActivityType: activityType,
			StreakCount:  streakCount,
		}.ToMap(),
	}

	return s.Create(ctx, notif)
}

// NotifyStreakReminder creates a notification + push when user hasn't logged today.
// Used by the daily cron job at 10 PM IST to remind users while they still have time.
func (s *NotificationService) NotifyStreakReminder(
	ctx context.Context,
	userID uint,
	missedDate string,
) error {
	notif := &models.Notification{
		UserID: userID,
		Type:   models.NotifTypeStreakAtRisk,
		Title:  "Don't Lose Your Streak! 🔥",
		Body:   "You haven't logged today. Update now to keep your streak!",
		Metadata: models.StreakMetadata{
			ActivityType: "daily",
			StreakCount:  0, // Unknown at reminder time
		}.ToMap(),
	}

	if err := s.Create(ctx, notif); err != nil {
		return err
	}

	// Publish to push notification queue (Web Push)
	if publisher := GetPushPublisher(); publisher != nil && publisher.IsAvailable() {
		dedupeKey := fmt.Sprintf("streak_reminder:%d:%s", userID, missedDate)
		// Navigate to home (today's date view) so user can log
		deepLink := "/"
		// Use 2 hour TTL (7200 seconds) since reminder is sent at 10 PM and deadline is midnight
		ttlSeconds := 7200
		data := notif.Metadata
		if data == nil {
			data = make(map[string]interface{})
		}
		data["notification_id"] = notif.ID

		if err := publisher.PublishPushNotification(
			ctx,
			userID,
			notif.Type,
			notif.Title,
			notif.Body,
			dedupeKey,
			deepLink,
			data,
			ttlSeconds,
		); err != nil {
			logger.Sugar.Warnw("Failed to publish push notification for streak reminder",
				"notif_id", notif.ID,
				"user_id", userID,
				"error", err,
			)
			// Non-fatal, in-app notification is still delivered
		}
	}

	logger.Sugar.Infow("Streak reminder notification sent",
		"user_id", userID,
		"missed_date", missedDate,
	)

	return nil
}

// ==================== Follow Notification Triggers ====================

// NotifyFollowRequest creates a notification when someone requests to follow
func (s *NotificationService) NotifyFollowRequest(
	ctx context.Context,
	recipientUserID uint,
	requesterID uint,
	requesterUsername string,
	requesterAvatar string,
) error {
	// Build entity key for dedupe
	entityKey := fmt.Sprintf("follow_request:%d", requesterID)

	// Use transaction to ensure atomicity of dedupe check + notification create
	db := s.repo.GetDB()
	return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// Try to insert dedupe record with ON CONFLICT DO NOTHING
		dedupe := &models.NotificationDedupe{
			UserID:     recipientUserID,
			ActorID:    requesterID,
			Type:       models.NotifTypeFollowRequest,
			EntityType: "follow",
			EntityKey:  entityKey,
		}

		result := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(dedupe)
		if result.Error != nil {
			return result.Error
		}

		// If dedupe record already existed, skip notification
		if result.RowsAffected == 0 {
			logger.Sugar.Debugw("Skipping duplicate follow request notification",
				"user_id", recipientUserID,
				"actor_id", requesterID,
			)
			return nil
		}

		// Create the notification
		notif := &models.Notification{
			UserID: recipientUserID,
			Type:   models.NotifTypeFollowRequest,
			Title:  "New Follow Request",
			Body:   fmt.Sprintf("%s wants to follow you", requesterUsername),
			Metadata: models.FollowMetadata{
				ActorID:       requesterID,
				ActorUsername: requesterUsername,
				ActorAvatar:   requesterAvatar,
			}.ToMap(),
		}

		if err := tx.Create(notif).Error; err != nil {
			return err
		}

		logger.Sugar.Infow("Follow request notification created",
			"id", notif.ID,
			"user_id", recipientUserID,
			"requester_id", requesterID,
		)

		// Side effects
		s.invalidateUnreadCache(ctx, recipientUserID)
		s.publishNotification(ctx, notif)

		// Publish to push notification queue
		if publisher := GetPushPublisher(); publisher != nil && publisher.IsAvailable() {
			dedupeKey := fmt.Sprintf("follow_request:%d:%d", recipientUserID, requesterID)
			deepLink := fmt.Sprintf("/user/%s", requesterUsername)
			if err := publisher.PublishFromNotification(ctx, notif, dedupeKey, deepLink); err != nil {
				logger.Sugar.Warnw("Failed to publish push notification for follow request",
					"notif_id", notif.ID,
					"error", err,
				)
			}
		}

		return nil
	})
}

// NotifyFollowAccepted creates a notification when a follow request is accepted
func (s *NotificationService) NotifyFollowAccepted(
	ctx context.Context,
	recipientUserID uint,
	accepterID uint,
	accepterUsername string,
	accepterAvatar string,
) error {
	notif := &models.Notification{
		UserID: recipientUserID,
		Type:   models.NotifTypeFollowAccepted,
		Title:  "Follow Request Accepted! 🎉",
		Body:   fmt.Sprintf("%s accepted your follow request", accepterUsername),
		Metadata: models.FollowMetadata{
			ActorID:       accepterID,
			ActorUsername: accepterUsername,
			ActorAvatar:   accepterAvatar,
		}.ToMap(),
	}

	if err := s.Create(ctx, notif); err != nil {
		return err
	}

	// Publish to push notification queue
	if publisher := GetPushPublisher(); publisher != nil && publisher.IsAvailable() {
		dedupeKey := fmt.Sprintf("follow_accepted:%d:%d", recipientUserID, accepterID)
		deepLink := fmt.Sprintf("/user/%s", accepterUsername)
		if err := publisher.PublishFromNotification(ctx, notif, dedupeKey, deepLink); err != nil {
			logger.Sugar.Warnw("Failed to publish push notification for follow accepted",
				"notif_id", notif.ID,
				"error", err,
			)
		}
	}

	return nil
}

// NotifyNewFollower creates a notification when someone starts following (public account)
func (s *NotificationService) NotifyNewFollower(
	ctx context.Context,
	recipientUserID uint,
	followerID uint,
	followerUsername string,
	followerAvatar string,
) error {
	// Build entity key for dedupe
	entityKey := fmt.Sprintf("new_follower:%d", followerID)

	// Use transaction to ensure atomicity of dedupe check + notification create
	db := s.repo.GetDB()
	return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// Try to insert dedupe record
		dedupe := &models.NotificationDedupe{
			UserID:     recipientUserID,
			ActorID:    followerID,
			Type:       models.NotifTypeNewFollower,
			EntityType: "follow",
			EntityKey:  entityKey,
		}

		result := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(dedupe)
		if result.Error != nil {
			return result.Error
		}

		// If dedupe record already existed, skip notification
		if result.RowsAffected == 0 {
			logger.Sugar.Debugw("Skipping duplicate new follower notification",
				"user_id", recipientUserID,
				"actor_id", followerID,
			)
			return nil
		}

		// Create the notification
		notif := &models.Notification{
			UserID: recipientUserID,
			Type:   models.NotifTypeNewFollower,
			Title:  "New Follower! 👋",
			Body:   fmt.Sprintf("%s started following you", followerUsername),
			Metadata: models.FollowMetadata{
				ActorID:       followerID,
				ActorUsername: followerUsername,
				ActorAvatar:   followerAvatar,
			}.ToMap(),
		}

		if err := tx.Create(notif).Error; err != nil {
			return err
		}

		logger.Sugar.Infow("New follower notification created",
			"id", notif.ID,
			"user_id", recipientUserID,
			"follower_id", followerID,
		)

		// Side effects
		s.invalidateUnreadCache(ctx, recipientUserID)
		s.publishNotification(ctx, notif)

		// Publish to push notification queue
		if publisher := GetPushPublisher(); publisher != nil && publisher.IsAvailable() {
			dedupeKey := fmt.Sprintf("new_follower:%d:%d", recipientUserID, followerID)
			deepLink := fmt.Sprintf("/user/%s", followerUsername)
			if err := publisher.PublishFromNotification(ctx, notif, dedupeKey, deepLink); err != nil {
				logger.Sugar.Warnw("Failed to publish push notification for new follower",
					"notif_id", notif.ID,
					"error", err,
				)
			}
		}

		return nil
	})
}

// ==================== Redis Pub/Sub Operations ====================

// publishNotification publishes a notification to Redis pub/sub
// Falls back to pending queue if pub/sub fails
func (s *NotificationService) publishNotification(ctx context.Context, notif *models.Notification) {
	if !redis.IsAvailable() {
		return
	}

	payload, err := json.Marshal(notif)
	if err != nil {
		logger.Sugar.Warnw("Failed to marshal notification for pub/sub",
			"notif_id", notif.ID,
			"error", err,
		)
		return
	}

	channel := fmt.Sprintf("%s%d", constants.NotifChannelPrefix, notif.UserID)
	err = redis.Get().Publish(ctx, channel, payload).Err()

	if err != nil {
		// Pub/sub failed - queue for retry
		logger.Sugar.Warnw("Pub/sub failed, queueing notification",
			"user_id", notif.UserID,
			"notif_id", notif.ID,
			"error", err,
		)
		s.queuePendingNotification(ctx, notif.UserID, payload)
	}
}

// queuePendingNotification adds a notification to the pending queue
func (s *NotificationService) queuePendingNotification(ctx context.Context, userID uint, payload []byte) {
	if !redis.IsAvailable() {
		return
	}

	key := fmt.Sprintf("%s%d", constants.NotifPendingPrefix, userID)

	// LPUSH to add to list, then set TTL
	pipe := redis.Get().Pipeline()
	pipe.LPush(ctx, key, payload)
	pipe.Expire(ctx, key, constants.NotifPendingTTL)

	if _, err := pipe.Exec(ctx); err != nil {
		logger.Sugar.Errorw("Failed to queue pending notification",
			"user_id", userID,
			"error", err,
		)
	}
}

// GetPendingNotifications retrieves and clears pending notifications for a user
// Called when WebSocket reconnects to deliver missed notifications
func (s *NotificationService) GetPendingNotifications(ctx context.Context, userID uint) ([]models.Notification, error) {
	if !redis.IsAvailable() {
		return nil, nil
	}

	key := fmt.Sprintf("%s%d", constants.NotifPendingPrefix, userID)
	var notifications []models.Notification

	// Pop all pending notifications
	for {
		payload, err := redis.Get().RPop(ctx, key).Bytes()
		if err == goredis.Nil {
			break // Queue empty
		}
		if err != nil {
			logger.Sugar.Errorw("Failed to pop pending notification",
				"user_id", userID,
				"error", err,
			)
			break
		}

		var notif models.Notification
		if err := json.Unmarshal(payload, &notif); err != nil {
			logger.Sugar.Warnw("Failed to unmarshal pending notification",
				"user_id", userID,
				"error", err,
			)
			continue
		}
		notifications = append(notifications, notif)
	}

	return notifications, nil
}

// SubscribeToNotifications returns a Redis pub/sub subscription for a user
func (s *NotificationService) SubscribeToNotifications(ctx context.Context, userID uint) *goredis.PubSub {
	if !redis.IsAvailable() {
		return nil
	}

	channel := fmt.Sprintf("%s%d", constants.NotifChannelPrefix, userID)
	return redis.Get().Subscribe(ctx, channel)
}

// ==================== WebSocket Connection Tracking ====================

// TrackWSConnection tracks a WebSocket connection for a user
// Returns false if max connections exceeded
func (s *NotificationService) TrackWSConnection(ctx context.Context, userID uint, connID string) (bool, error) {
	if !redis.IsAvailable() {
		return true, nil // Allow if Redis not available
	}

	key := fmt.Sprintf("%s%d", constants.NotifWSConnPrefix, userID)

	// Check current connection count
	count, err := redis.Get().SCard(ctx, key).Result()
	if err != nil && err != goredis.Nil {
		return false, fmt.Errorf("failed to check connection count: %w", err)
	}

	if count >= int64(constants.WSMaxConnsPerUser) {
		return false, nil // Max connections reached
	}

	// Add connection to set with TTL
	pipe := redis.Get().Pipeline()
	pipe.SAdd(ctx, key, connID)
	pipe.Expire(ctx, key, constants.NotifWSConnTTL)

	if _, err := pipe.Exec(ctx); err != nil {
		return false, fmt.Errorf("failed to track connection: %w", err)
	}

	return true, nil
}

// RemoveWSConnection removes a WebSocket connection tracking
func (s *NotificationService) RemoveWSConnection(ctx context.Context, userID uint, connID string) {
	if !redis.IsAvailable() {
		return
	}

	key := fmt.Sprintf("%s%d", constants.NotifWSConnPrefix, userID)
	redis.Get().SRem(ctx, key, connID)
}

// RefreshWSConnection refreshes the TTL for connection tracking
func (s *NotificationService) RefreshWSConnection(ctx context.Context, userID uint) {
	if !redis.IsAvailable() {
		return
	}

	key := fmt.Sprintf("%s%d", constants.NotifWSConnPrefix, userID)
	redis.Get().Expire(ctx, key, constants.NotifWSConnTTL)
}

// GetWSConnectionCount returns the number of active WebSocket connections for a user
func (s *NotificationService) GetWSConnectionCount(ctx context.Context, userID uint) (int64, error) {
	if !redis.IsAvailable() {
		return 0, nil
	}

	key := fmt.Sprintf("%s%d", constants.NotifWSConnPrefix, userID)
	count, err := redis.Get().SCard(ctx, key).Result()
	if err == goredis.Nil {
		return 0, nil
	}
	return count, err
}

// ==================== Cleanup Operations ====================

// CleanupOldNotifications removes old notifications based on retention policy
func (s *NotificationService) CleanupOldNotifications(ctx context.Context) (int64, error) {
	readCutoff := time.Now().AddDate(0, 0, -constants.NotifReadRetentionDays)
	unreadCutoff := time.Now().AddDate(0, 0, -constants.NotifUnreadRetentionDays)

	deleted, err := s.repo.DeleteOlderThan(readCutoff, unreadCutoff)
	if err != nil {
		logger.Sugar.Errorw("Failed to cleanup old notifications",
			"read_cutoff", readCutoff,
			"unread_cutoff", unreadCutoff,
			"error", err,
		)
		return 0, err
	}

	if deleted > 0 {
		logger.Sugar.Infow("Cleaned up old notifications",
			"deleted_count", deleted,
			"read_cutoff", readCutoff,
			"unread_cutoff", unreadCutoff,
		)
	}

	return deleted, nil
}

// ==================== Helper Functions ====================

// invalidateUnreadCache invalidates the cached unread count for a user
func (s *NotificationService) invalidateUnreadCache(ctx context.Context, userID uint) {
	if !redis.IsAvailable() {
		return
	}

	cacheKey := fmt.Sprintf("%s%d", constants.NotifUnreadPrefix, userID)
	if err := redis.Get().Del(ctx, cacheKey).Err(); err != nil {
		logger.Sugar.Warnw("Failed to invalidate unread cache",
			"user_id", userID,
			"error", err,
		)
	}
}
