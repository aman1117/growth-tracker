package services

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/testutil"
	"github.com/aman1117/backend/pkg/models"
	"github.com/aman1117/backend/pkg/redis"
	goredis "github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func unreadKey(userID uint) string  { return fmt.Sprintf("%s%d", constants.NotifUnreadPrefix, userID) }
func pendingKey(userID uint) string { return fmt.Sprintf("%s%d", constants.NotifPendingPrefix, userID) }
func wsConnKey(userID uint) string  { return fmt.Sprintf("%s%d", constants.NotifWSConnPrefix, userID) }

// seedNotification stores a notification created at the given time.
func seedNotification(t *testing.T, db *gorm.DB, userID uint, createdAt time.Time, read bool) *models.Notification {
	t.Helper()
	n := &models.Notification{UserID: userID, Type: models.NotifTypeLikeReceived, Title: "t", Body: "b", CreatedAt: createdAt}
	if read {
		readAt := createdAt.Add(time.Minute)
		n.ReadAt = &readAt
	}
	require.NoError(t, db.Create(n).Error)
	return n
}

func TestNotificationService_Create(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()

	t.Run("persists and publishes to the user's channel", func(t *testing.T) {
		mr := startRedis(t)
		svc := newNotificationService(db)
		mr.Set(unreadKey(7), "3")

		sub := svc.SubscribeToNotifications(ctx, 7)
		require.NotNil(t, sub)
		defer sub.Close()
		_, err := sub.Receive(ctx) // subscription confirmation
		require.NoError(t, err)

		notif := &models.Notification{UserID: 7, Type: models.NotifTypeBadgeUnlocked, Title: "Hi", Body: "there"}
		require.NoError(t, svc.Create(ctx, notif))
		assert.NotZero(t, notif.ID)
		assert.False(t, mr.Exists(unreadKey(7)), "unread count cache is invalidated")

		recvCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		msg, err := sub.ReceiveMessage(recvCtx)
		require.NoError(t, err)
		assert.Equal(t, fmt.Sprintf("%s%d", constants.NotifChannelPrefix, 7), msg.Channel)
		var published models.Notification
		require.NoError(t, json.Unmarshal([]byte(msg.Payload), &published))
		assert.Equal(t, notif.ID, published.ID)
		assert.Equal(t, "Hi", published.Title)

		stored := notificationsOf(t, db, 7)
		require.Len(t, stored, 1)
		assert.Equal(t, models.NotifTypeBadgeUnlocked, stored[0].Type)
	})

	t.Run("works without Redis", func(t *testing.T) {
		svc := newNotificationService(db)
		require.False(t, redis.IsAvailable())
		require.NoError(t, svc.Create(ctx, &models.Notification{UserID: 8, Type: models.NotifTypeBadgeUnlocked, Title: "x"}))
		assert.Len(t, notificationsOf(t, db, 8), 1)
		assert.Nil(t, svc.SubscribeToNotifications(ctx, 8))
	})

	t.Run("database failure", func(t *testing.T) {
		svc := newNotificationService(testutil.BrokenDB(t))
		err := svc.Create(ctx, &models.Notification{UserID: 9, Type: models.NotifTypeBadgeUnlocked, Title: "x"})
		require.Error(t, err)
		assert.Contains(t, err.Error(), "failed to create notification")
	})
}

func TestNotificationService_GetByUserID(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	base := time.Date(2026, 3, 1, 10, 0, 0, 0, time.UTC)
	var ids []uint
	for i := 0; i < 3; i++ {
		ids = append(ids, seedNotification(t, db, 1, base.Add(time.Duration(i)*time.Minute), false).ID)
	}
	seedNotification(t, db, 2, base, false)
	svc := newNotificationService(db)

	page1, total, err := svc.GetByUserID(ctx, 1, 1, 2)
	require.NoError(t, err)
	assert.EqualValues(t, 3, total)
	require.Len(t, page1, 2)
	assert.Equal(t, []uint{ids[2], ids[1]}, []uint{page1[0].ID, page1[1].ID}, "newest first")

	page2, total, err := svc.GetByUserID(ctx, 1, 2, 2)
	require.NoError(t, err)
	assert.EqualValues(t, 3, total)
	require.Len(t, page2, 1)
	assert.Equal(t, ids[0], page2[0].ID)

	empty, total, err := svc.GetByUserID(ctx, 99, 1, 20)
	require.NoError(t, err)
	assert.Empty(t, empty)
	assert.Zero(t, total)

	t.Run("list failure", func(t *testing.T) {
		_, _, err := newNotificationService(testutil.BrokenDB(t)).GetByUserID(ctx, 1, 1, 10)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "failed to get notifications")
	})

	t.Run("count failure", func(t *testing.T) {
		broken := faultyDB(t, func(s stmtInfo) bool {
			_, isCount := s.Dest.(*int64)
			return s.is("query", "notifications") && isCount
		})
		_, _, err := newNotificationService(broken).GetByUserID(ctx, 1, 1, 10)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "failed to count notifications")
	})
}

func TestNotificationService_GetUnreadCount(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	now := time.Now()
	seedNotification(t, db, 1, now, false)
	seedNotification(t, db, 1, now, false)
	seedNotification(t, db, 1, now, true)
	svc := newNotificationService(db)

	t.Run("without Redis reads the database", func(t *testing.T) {
		count, err := svc.GetUnreadCount(ctx, 1)
		require.NoError(t, err)
		assert.EqualValues(t, 2, count)
	})

	t.Run("caches the count and serves later reads from the cache", func(t *testing.T) {
		mr := startRedis(t)
		count, err := svc.GetUnreadCount(ctx, 1)
		require.NoError(t, err)
		assert.EqualValues(t, 2, count)

		cached, err := mr.Get(unreadKey(1))
		require.NoError(t, err)
		assert.Equal(t, "2", cached)
		assert.Equal(t, constants.NotifUnreadCacheTTL, mr.TTL(unreadKey(1)))

		mr.Set(unreadKey(1), "42")
		count, err = svc.GetUnreadCount(ctx, 1)
		require.NoError(t, err)
		assert.EqualValues(t, 42, count, "cache hit")
	})

	t.Run("falls back to the database when Redis fails", func(t *testing.T) {
		mr := startRedis(t)
		mr.SetError("boom")
		count, err := svc.GetUnreadCount(ctx, 1)
		require.NoError(t, err)
		assert.EqualValues(t, 2, count)
	})

	t.Run("database failure", func(t *testing.T) {
		_, err := newNotificationService(testutil.BrokenDB(t)).GetUnreadCount(ctx, 1)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "failed to get unread count")
	})
}

func TestNotificationService_MarkAsRead(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	mr := startRedis(t)
	mine := seedNotification(t, db, 1, time.Now(), false)
	other := seedNotification(t, db, 1, time.Now(), false)
	foreign := seedNotification(t, db, 2, time.Now(), false)
	svc := newNotificationService(db)

	mr.Set(unreadKey(1), "2")
	require.NoError(t, svc.MarkAsRead(ctx, mine.ID, 1))
	assert.False(t, mr.Exists(unreadKey(1)))

	require.NoError(t, svc.MarkAsRead(ctx, foreign.ID, 1), "marking someone else's notification is a no-op")

	count, err := svc.GetUnreadCount(ctx, 1)
	require.NoError(t, err)
	assert.EqualValues(t, 1, count)
	count, err = svc.GetUnreadCount(ctx, 2)
	require.NoError(t, err)
	assert.EqualValues(t, 1, count, "the other user's notification stays unread")

	require.NoError(t, svc.MarkAllAsRead(ctx, 1))
	var stored models.Notification
	require.NoError(t, db.First(&stored, other.ID).Error)
	assert.True(t, stored.IsRead())
	count, err = svc.GetUnreadCount(ctx, 1)
	require.NoError(t, err)
	assert.Zero(t, count)

	t.Run("cache invalidation failure is not an error", func(t *testing.T) {
		failRedisCommands(t, mr, errInjected, "del")
		assert.NoError(t, svc.MarkAllAsRead(ctx, 1))
	})

	t.Run("database failures", func(t *testing.T) {
		broken := newNotificationService(testutil.BrokenDB(t))
		err := broken.MarkAsRead(ctx, mine.ID, 1)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "failed to mark notification as read")
		err = broken.MarkAllAsRead(ctx, 1)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "failed to mark all notifications as read")
	})
}

func TestNotificationService_Delete(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	mr := startRedis(t)
	svc := newNotificationService(db)

	t.Run("unread notification invalidates the unread cache", func(t *testing.T) {
		n := seedNotification(t, db, 1, time.Now(), false)
		mr.Set(unreadKey(1), "1")
		require.NoError(t, svc.Delete(ctx, n.ID, 1))
		assert.False(t, mr.Exists(unreadKey(1)))
		assert.Empty(t, notificationsOf(t, db, 1))
	})

	t.Run("read notification keeps the unread cache", func(t *testing.T) {
		n := seedNotification(t, db, 1, time.Now(), true)
		mr.Set(unreadKey(1), "0")
		require.NoError(t, svc.Delete(ctx, n.ID, 1))
		assert.True(t, mr.Exists(unreadKey(1)))
		assert.Empty(t, notificationsOf(t, db, 1))
	})

	t.Run("missing or foreign notification", func(t *testing.T) {
		n := seedNotification(t, db, 2, time.Now(), false)
		assert.EqualError(t, svc.Delete(ctx, 999999, 1), "notification not found")
		assert.EqualError(t, svc.Delete(ctx, n.ID, 1), "notification not found")
		assert.Len(t, notificationsOf(t, db, 2), 1, "someone else's notification is not deleted")
	})

	t.Run("lookup failure", func(t *testing.T) {
		err := newNotificationService(testutil.BrokenDB(t)).Delete(ctx, 1, 1)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "failed to get notification")
	})

	t.Run("delete failure", func(t *testing.T) {
		n := seedNotification(t, db, 3, time.Now(), false)
		broken := newNotificationService(faultyDB(t, failingOn("delete", "notifications")))
		err := broken.Delete(ctx, n.ID, 3)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "failed to delete notification")
		assert.Len(t, notificationsOf(t, db, 3), 1)
	})
}

func TestNotificationService_NotifyLikeReceived(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	svc := newNotificationService(db)

	t.Run("notifies once per liker and day and pushes it", func(t *testing.T) {
		mr := startRedis(t)
		publisher := installPushPublisher(t, 10)
		mr.Set(unreadKey(1), "5")

		require.NoError(t, svc.NotifyLikeReceived(ctx, 1, 2, "bob", "https://img/bob.jpg", "2026-01-02"))
		require.NoError(t, svc.NotifyLikeReceived(ctx, 1, 2, "bob", "https://img/bob.jpg", "2026-01-02"), "unlike + re-like")

		notifs := notificationsOf(t, db, 1)
		require.Len(t, notifs, 1)
		n := notifs[0]
		assert.Equal(t, models.NotifTypeLikeReceived, n.Type)
		assert.Equal(t, "New Like!", n.Title)
		assert.Equal(t, "bob liked your 2 Jan, 2026 activities", n.Body)
		assert.Equal(t, "bob", n.Metadata["liker_username"])
		assert.Equal(t, "2026-01-02", n.Metadata["liked_date"])
		assert.EqualValues(t, 2, n.Metadata["liker_id"])
		assert.False(t, mr.Exists(unreadKey(1)))

		pushes := queuedPushes(t, publisher)
		require.Len(t, pushes, 1)
		assert.Equal(t, uint(1), pushes[0].UserID)
		assert.Equal(t, "like:1:2026-01-02", pushes[0].DedupeKey)
		assert.Equal(t, "/?date=2026-01-02", pushes[0].DeepLink)
		assert.Equal(t, 3600, pushes[0].TTLSeconds)
		assert.EqualValues(t, n.ID, pushes[0].Data["notification_id"])
	})

	t.Run("another day or liker is a new notification; odd dates are kept verbatim", func(t *testing.T) {
		require.NoError(t, svc.NotifyLikeReceived(ctx, 3, 2, "bob", "", "2026-01-03"))
		require.NoError(t, svc.NotifyLikeReceived(ctx, 3, 4, "carol", "", "2026-01-03"))
		require.NoError(t, svc.NotifyLikeReceived(ctx, 3, 4, "carol", "", "yesterday"))
		notifs := notificationsOf(t, db, 3)
		require.Len(t, notifs, 3)
		assert.Equal(t, "carol liked your yesterday activities", notifs[2].Body)
	})

	t.Run("push queue full is not an error", func(t *testing.T) {
		installPushPublisher(t, 0)
		require.NoError(t, svc.NotifyLikeReceived(ctx, 5, 2, "bob", "", "2026-01-04"))
		assert.Len(t, notificationsOf(t, db, 5), 1)
	})

	t.Run("dedupe insert failure", func(t *testing.T) {
		broken := newNotificationService(faultyDB(t, failingOn("create", "notification_dedupes")))
		require.ErrorIs(t, broken.NotifyLikeReceived(ctx, 6, 2, "bob", "", "2026-01-05"), errInjected)
		assert.Empty(t, notificationsOf(t, db, 6))
	})

	t.Run("notification insert failure rolls back the dedupe record", func(t *testing.T) {
		broken := newNotificationService(faultyDB(t, failingOn("create", "notifications")))
		require.ErrorIs(t, broken.NotifyLikeReceived(ctx, 7, 2, "bob", "", "2026-01-06"), errInjected)
		var dedupes int64
		require.NoError(t, db.Model(&models.NotificationDedupe{}).Where("user_id = ?", 7).Count(&dedupes).Error)
		assert.Zero(t, dedupes)

		require.NoError(t, svc.NotifyLikeReceived(ctx, 7, 2, "bob", "", "2026-01-06"), "a retry still notifies")
		assert.Len(t, notificationsOf(t, db, 7), 1)
	})
}

func TestNotificationService_SimpleTriggers(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	svc := newNotificationService(db)

	t.Run("badge unlocked", func(t *testing.T) {
		publisher := installPushPublisher(t, 10)
		require.NoError(t, svc.NotifyBadgeUnlocked(ctx, 1, "flame_keeper", "Flame Keeper", "Flame"))
		notifs := notificationsOf(t, db, 1)
		require.Len(t, notifs, 1)
		assert.Equal(t, models.NotifTypeBadgeUnlocked, notifs[0].Type)
		assert.Equal(t, "You earned the Flame Keeper badge", notifs[0].Body)
		assert.Equal(t, "flame_keeper", notifs[0].Metadata["badge_id"])

		pushes := queuedPushes(t, publisher)
		require.Len(t, pushes, 1)
		assert.Equal(t, "badge:1:flame_keeper", pushes[0].DedupeKey)
		assert.Equal(t, "/profile/badges", pushes[0].DeepLink)
	})

	t.Run("streak milestone and streak at risk", func(t *testing.T) {
		require.NoError(t, svc.NotifyStreakMilestone(ctx, 2, "study", 30))
		require.NoError(t, svc.NotifyStreakAtRisk(ctx, 2, "study", 12))
		notifs := notificationsOf(t, db, 2)
		require.Len(t, notifs, 2)
		assert.Equal(t, models.NotifTypeStreakMilestone, notifs[0].Type)
		assert.Equal(t, "You've maintained a 30-day study streak!", notifs[0].Body)
		assert.EqualValues(t, 30, notifs[0].Metadata["streak_count"])
		assert.Equal(t, models.NotifTypeStreakAtRisk, notifs[1].Type)
		assert.Equal(t, "Don't lose your 12-day study streak! Log today's activity.", notifs[1].Body)
	})

	t.Run("streak reminder pushes with a two hour TTL", func(t *testing.T) {
		publisher := installPushPublisher(t, 10)
		require.NoError(t, svc.NotifyStreakReminder(ctx, 3, "2026-05-01"))
		notifs := notificationsOf(t, db, 3)
		require.Len(t, notifs, 1)
		assert.Equal(t, models.NotifTypeStreakAtRisk, notifs[0].Type)
		assert.Equal(t, "Don't Lose Your Streak! 🔥", notifs[0].Title)
		assert.Equal(t, "daily", notifs[0].Metadata["activity_type"])

		pushes := queuedPushes(t, publisher)
		require.Len(t, pushes, 1)
		assert.Equal(t, "streak_reminder:3:2026-05-01", pushes[0].DedupeKey)
		assert.Equal(t, "/", pushes[0].DeepLink)
		assert.Equal(t, 7200, pushes[0].TTLSeconds)
		assert.EqualValues(t, notifs[0].ID, pushes[0].Data["notification_id"])
	})

	t.Run("follow accepted", func(t *testing.T) {
		publisher := installPushPublisher(t, 10)
		require.NoError(t, svc.NotifyFollowAccepted(ctx, 4, 5, "erin", "https://img/erin.jpg"))
		notifs := notificationsOf(t, db, 4)
		require.Len(t, notifs, 1)
		assert.Equal(t, models.NotifTypeFollowAccepted, notifs[0].Type)
		assert.Equal(t, "erin accepted your follow request", notifs[0].Body)
		assert.Equal(t, "https://img/erin.jpg", notifs[0].Metadata["actor_avatar"])

		pushes := queuedPushes(t, publisher)
		require.Len(t, pushes, 1)
		assert.Equal(t, "follow_accepted:4:5", pushes[0].DedupeKey)
		assert.Equal(t, "/user/erin", pushes[0].DeepLink)
	})

	t.Run("push queue full is not an error", func(t *testing.T) {
		installPushPublisher(t, 0)
		require.NoError(t, svc.NotifyBadgeUnlocked(ctx, 6, "titan", "Titan", "Crown"))
		require.NoError(t, svc.NotifyStreakReminder(ctx, 6, "2026-05-01"))
		require.NoError(t, svc.NotifyFollowAccepted(ctx, 6, 5, "erin", ""))
		assert.Len(t, notificationsOf(t, db, 6), 3)
	})

	t.Run("database failures are returned", func(t *testing.T) {
		installPushPublisher(t, 10)
		broken := newNotificationService(testutil.BrokenDB(t))
		assert.Error(t, broken.NotifyBadgeUnlocked(ctx, 7, "titan", "Titan", "Crown"))
		assert.Error(t, broken.NotifyStreakMilestone(ctx, 7, "study", 7))
		assert.Error(t, broken.NotifyStreakAtRisk(ctx, 7, "study", 7))
		assert.Error(t, broken.NotifyStreakReminder(ctx, 7, "2026-05-01"))
		assert.Error(t, broken.NotifyFollowAccepted(ctx, 7, 5, "erin", ""))
	})
}

func TestNotificationService_NotifyDayCompleted(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	svc := newNotificationService(db)

	t.Run("no followers", func(t *testing.T) {
		require.NoError(t, svc.NotifyDayCompleted(ctx, 1, "alice", "", "2026-02-10", nil))
		assert.Zero(t, countRows(t, db, &models.Notification{}))
		assert.Zero(t, countRows(t, db, &models.NotificationDedupe{}))
	})

	t.Run("notifies every follower once per day", func(t *testing.T) {
		require.NoError(t, svc.NotifyDayCompleted(ctx, 1, "alice", "https://img/a.jpg", "2026-02-10", []uint{10, 11}))
		require.NoError(t, svc.NotifyDayCompleted(ctx, 1, "alice", "https://img/a.jpg", "2026-02-10", []uint{10, 11, 12}),
			"hours dropping below 24 and back do not notify again")

		for _, follower := range []uint{10, 11} {
			notifs := notificationsOf(t, db, follower)
			require.Len(t, notifs, 1)
			assert.Equal(t, models.NotifTypeStreakMilestone, notifs[0].Type)
			assert.Equal(t, "Day Completed! 🎯", notifs[0].Title)
			assert.Equal(t, "alice logged all 24 hours on 10 Feb, 2026", notifs[0].Body)
			assert.Equal(t, "2026-02-10", notifs[0].Metadata["completed_date"])
		}
		assert.Empty(t, notificationsOf(t, db, 12))

		require.NoError(t, svc.NotifyDayCompleted(ctx, 1, "alice", "", "2026-02-11", []uint{12}), "a new day notifies again")
		assert.Len(t, notificationsOf(t, db, 12), 1)
	})

	t.Run("pushes with a four hour TTL and keeps unparsable dates", func(t *testing.T) {
		publisher := installPushPublisher(t, 10)
		require.NoError(t, svc.NotifyDayCompleted(ctx, 2, "bob", "", "someday", []uint{20}))
		notifs := notificationsOf(t, db, 20)
		require.Len(t, notifs, 1)
		assert.Equal(t, "bob logged all 24 hours on someday", notifs[0].Body)

		pushes := queuedPushes(t, publisher)
		require.Len(t, pushes, 1)
		assert.Equal(t, "day_completed:20:2:someday", pushes[0].DedupeKey)
		assert.Equal(t, "/user/bob?date=someday", pushes[0].DeepLink)
		assert.Equal(t, 14400, pushes[0].TTLSeconds)
		assert.EqualValues(t, notifs[0].ID, pushes[0].Data["notification_id"])
	})

	t.Run("push queue full is not an error", func(t *testing.T) {
		installPushPublisher(t, 0)
		require.NoError(t, svc.NotifyDayCompleted(ctx, 3, "carol", "", "2026-02-10", []uint{30}))
		assert.Len(t, notificationsOf(t, db, 30), 1)
	})

	t.Run("one failing follower does not stop the others", func(t *testing.T) {
		broken := newNotificationService(faultyDB(t, func(s stmtInfo) bool {
			n, ok := s.Dest.(*models.Notification)
			return s.is("create", "notifications") && ok && n.UserID == 40
		}))
		require.NoError(t, broken.NotifyDayCompleted(ctx, 4, "dave", "", "2026-02-10", []uint{40, 41}))
		assert.Empty(t, notificationsOf(t, db, 40))
		assert.Len(t, notificationsOf(t, db, 41), 1)
	})

	t.Run("concurrent sender wins the dedupe race", func(t *testing.T) {
		racer := newNotificationService(faultyDB(t, func(s stmtInfo) bool {
			if s.is("create", "notification_dedupes") {
				require.NoError(t, db.Create(&models.NotificationDedupe{
					UserID: 50, ActorID: 5, Type: models.NotifTypeStreakMilestone,
					EntityType: "day_completed", EntityKey: "day_completed:5:2026-02-10",
				}).Error)
			}
			return false
		}))
		require.NoError(t, racer.NotifyDayCompleted(ctx, 5, "erin", "", "2026-02-10", []uint{50}))
		assert.Empty(t, notificationsOf(t, db, 50))
	})

	t.Run("dedupe lookup failure", func(t *testing.T) {
		err := newNotificationService(testutil.BrokenDB(t)).NotifyDayCompleted(ctx, 6, "f", "", "2026-02-10", []uint{60})
		require.Error(t, err)
		assert.Contains(t, err.Error(), "failed to check dedupe")
	})

	t.Run("dedupe insert failure", func(t *testing.T) {
		broken := newNotificationService(faultyDB(t, failingOn("create", "notification_dedupes")))
		err := broken.NotifyDayCompleted(ctx, 7, "g", "", "2026-02-10", []uint{70})
		require.Error(t, err)
		assert.Contains(t, err.Error(), "failed to create dedupe record")
		assert.Empty(t, notificationsOf(t, db, 70))
	})
}

func TestNotificationService_NotifyDayCompleted_EachFollowerKeepsItsOwnNotificationID(t *testing.T) {
	db := testDB(t)
	publisher := installPushPublisher(t, 10)
	followers := []uint{80, 81, 82}

	require.NoError(t, newNotificationService(db).NotifyDayCompleted(context.Background(), 8, "hank", "", "2026-02-10", followers))

	pushes := queuedPushes(t, publisher)
	require.Len(t, pushes, len(followers))
	for i, follower := range followers {
		notifs := notificationsOf(t, db, follower)
		require.Len(t, notifs, 1)
		assert.NotContains(t, notifs[0].Metadata, "notification_id", "stored metadata of follower %d", follower)
		assert.Equal(t, "hank", notifs[0].Metadata["completed_username"])
		assert.Equal(t, follower, pushes[i].UserID)
		assert.EqualValues(t, notifs[0].ID, pushes[i].Data["notification_id"], "push for follower %d", follower)
	}
}

func TestNotificationService_FollowTriggers(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	svc := newNotificationService(db)

	cases := []struct {
		name     string
		notify   func(s *NotificationService, ctx context.Context, recipient, actor uint, username, avatar string) error
		typ      models.NotificationType
		title    string
		body     string
		pushKey  string
		deepLink string
	}{
		{
			name:     "follow request",
			notify:   (*NotificationService).NotifyFollowRequest,
			typ:      models.NotifTypeFollowRequest,
			title:    "New Follow Request",
			body:     "frank wants to follow you",
			pushKey:  "follow_request:%d:%d",
			deepLink: "/user/frank",
		},
		{
			name:     "new follower",
			notify:   (*NotificationService).NotifyNewFollower,
			typ:      models.NotifTypeNewFollower,
			title:    "New Follower! 👋",
			body:     "frank started following you",
			pushKey:  "new_follower:%d:%d",
			deepLink: "/user/frank",
		},
	}

	for i, tc := range cases {
		recipient := uint(100*i + 1)
		t.Run(tc.name, func(t *testing.T) {
			publisher := installPushPublisher(t, 10)
			require.NoError(t, tc.notify(svc, ctx, recipient, 9, "frank", "https://img/f.jpg"))
			require.NoError(t, tc.notify(svc, ctx, recipient, 9, "frank", "https://img/f.jpg"), "duplicate is skipped")

			notifs := notificationsOf(t, db, recipient)
			require.Len(t, notifs, 1)
			assert.Equal(t, tc.typ, notifs[0].Type)
			assert.Equal(t, tc.title, notifs[0].Title)
			assert.Equal(t, tc.body, notifs[0].Body)
			assert.Equal(t, "frank", notifs[0].Metadata["actor_username"])

			pushes := queuedPushes(t, publisher)
			require.Len(t, pushes, 1)
			assert.Equal(t, fmt.Sprintf(tc.pushKey, recipient, 9), pushes[0].DedupeKey)
			assert.Equal(t, tc.deepLink, pushes[0].DeepLink)
		})

		t.Run(tc.name+" push queue full", func(t *testing.T) {
			installPushPublisher(t, 0)
			require.NoError(t, tc.notify(svc, ctx, recipient+1, 9, "frank", ""))
			assert.Len(t, notificationsOf(t, db, recipient+1), 1)
		})

		t.Run(tc.name+" dedupe failure", func(t *testing.T) {
			broken := newNotificationService(faultyDB(t, failingOn("create", "notification_dedupes")))
			require.ErrorIs(t, tc.notify(broken, ctx, recipient+2, 9, "frank", ""), errInjected)
		})

		t.Run(tc.name+" notification failure", func(t *testing.T) {
			broken := newNotificationService(faultyDB(t, failingOn("create", "notifications")))
			require.ErrorIs(t, tc.notify(broken, ctx, recipient+3, 9, "frank", ""), errInjected)
			assert.Empty(t, notificationsOf(t, db, recipient+3))
		})
	}
}

func TestNotificationService_CommentTriggers(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	svc := newNotificationService(db)

	type notifier func(s *NotificationService, ctx context.Context, recipient, actor uint,
		actorName, avatar string, commentID uint, preview, owner, date string) error

	cases := []struct {
		name    string
		notify  notifier
		typ     models.NotificationType
		title   string
		body    string
		pushKey func(recipient, actor uint) string
	}{
		{
			name: "comment received", notify: (*NotificationService).NotifyCommentReceived,
			typ: models.NotifTypeCommentReceived, title: "New Comment", body: "gina commented on your day",
			pushKey: func(uint, uint) string { return "comment:77" },
		},
		{
			name: "comment reply", notify: (*NotificationService).NotifyCommentReply,
			typ: models.NotifTypeCommentReply, title: "New Reply", body: "gina replied to your comment",
			pushKey: func(uint, uint) string { return "reply:77" },
		},
		{
			name: "comment mention", notify: (*NotificationService).NotifyCommentMention,
			typ: models.NotifTypeCommentMention, title: "You were mentioned", body: "gina mentioned you in a comment",
			pushKey: func(recipient, _ uint) string { return fmt.Sprintf("mention:77:%d", recipient) },
		},
		{
			name: "comment liked", notify: (*NotificationService).NotifyCommentLiked,
			typ: models.NotifTypeCommentLiked, title: "Comment Liked", body: "gina liked your comment",
			pushKey: func(_ uint, actor uint) string { return fmt.Sprintf("comment_like:77:%d", actor) },
		},
	}

	for i, tc := range cases {
		recipient := uint(100*i + 1)
		t.Run(tc.name, func(t *testing.T) {
			publisher := installPushPublisher(t, 10)
			require.NoError(t, tc.notify(svc, ctx, recipient, 8, "gina", "https://img/g.jpg", 77, "nice day", "hank", "2026-03-04"))
			require.NoError(t, tc.notify(svc, ctx, recipient, 8, "gina", "https://img/g.jpg", 77, "nice day", "hank", "2026-03-04"))

			notifs := notificationsOf(t, db, recipient)
			require.Len(t, notifs, 1, "the same comment event notifies once")
			n := notifs[0]
			assert.Equal(t, tc.typ, n.Type)
			assert.Equal(t, tc.title, n.Title)
			assert.Equal(t, tc.body, n.Body)
			assert.EqualValues(t, 77, n.Metadata["comment_id"])
			assert.Equal(t, "nice day", n.Metadata["comment_preview"])
			assert.Equal(t, "hank", n.Metadata["day_owner_username"])
			assert.Equal(t, "2026-03-04", n.Metadata["day_date"])
			assert.EqualValues(t, 8, n.Metadata["author_id"])

			pushes := queuedPushes(t, publisher)
			require.Len(t, pushes, 1)
			assert.Equal(t, tc.pushKey(recipient, 8), pushes[0].DedupeKey)
			assert.Equal(t, "/user/hank?date=2026-03-04&comments=true", pushes[0].DeepLink)
		})

		t.Run(tc.name+" dedupe failure", func(t *testing.T) {
			broken := newNotificationService(faultyDB(t, failingOn("create", "notification_dedupes")))
			require.ErrorIs(t, tc.notify(broken, ctx, recipient+1, 8, "gina", "", 77, "p", "hank", "2026-03-04"), errInjected)
		})

		t.Run(tc.name+" notification failure", func(t *testing.T) {
			broken := newNotificationService(faultyDB(t, failingOn("create", "notifications")))
			require.ErrorIs(t, tc.notify(broken, ctx, recipient+2, 8, "gina", "", 77, "p", "hank", "2026-03-04"), errInjected)
			assert.Empty(t, notificationsOf(t, db, recipient+2))
		})
	}
}

func TestNotificationService_PendingQueue(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	svc := newNotificationService(db)

	t.Run("Redis unavailable", func(t *testing.T) {
		pending, err := svc.GetPendingNotifications(ctx, 1)
		require.NoError(t, err)
		assert.Nil(t, pending)
		svc.queuePendingNotification(ctx, 1, []byte(`{}`)) // no-op
		svc.publishNotification(ctx, &models.Notification{UserID: 1})
	})

	t.Run("failed publish is queued and delivered on reconnect, oldest first", func(t *testing.T) {
		mr := startRedis(t)
		failRedisCommands(t, mr, errInjected, "publish")

		first := &models.Notification{UserID: 2, Type: models.NotifTypeBadgeUnlocked, Title: "first"}
		second := &models.Notification{UserID: 2, Type: models.NotifTypeBadgeUnlocked, Title: "second"}
		require.NoError(t, svc.Create(ctx, first))
		require.NoError(t, svc.Create(ctx, second))

		queued, err := mr.List(pendingKey(2))
		require.NoError(t, err)
		assert.Len(t, queued, 2)
		assert.Equal(t, constants.NotifPendingTTL, mr.TTL(pendingKey(2)))

		_, err = mr.Lpush(pendingKey(2), "not json") // newest entry is corrupt
		require.NoError(t, err)

		pending, err := svc.GetPendingNotifications(ctx, 2)
		require.NoError(t, err)
		require.Len(t, pending, 2)
		assert.Equal(t, "first", pending[0].Title)
		assert.Equal(t, "second", pending[1].Title)
		assert.False(t, mr.Exists(pendingKey(2)), "the queue is drained")

		pending, err = svc.GetPendingNotifications(ctx, 2)
		require.NoError(t, err)
		assert.Empty(t, pending)
	})

	t.Run("Redis failures are swallowed", func(t *testing.T) {
		mr := startRedis(t)
		mr.SetError("boom")
		require.NoError(t, svc.Create(ctx, &models.Notification{UserID: 3, Type: models.NotifTypeBadgeUnlocked, Title: "x"}))
		pending, err := svc.GetPendingNotifications(ctx, 3)
		require.NoError(t, err)
		assert.Empty(t, pending)
		assert.Len(t, notificationsOf(t, db, 3), 1, "the notification is still stored")
	})

	t.Run("unmarshalable notification is not published", func(t *testing.T) {
		mr := startRedis(t)
		svc.publishNotification(ctx, &models.Notification{UserID: 4, Metadata: models.NotificationMetadata{"bad": make(chan int)}})
		assert.False(t, mr.Exists(pendingKey(4)))
	})
}

func TestNotificationService_WebSocketTracking(t *testing.T) {
	ctx := context.Background()
	svc := newNotificationService(nil)

	t.Run("Redis unavailable allows every connection", func(t *testing.T) {
		ok, err := svc.TrackWSConnection(ctx, 1, "c1")
		require.NoError(t, err)
		assert.True(t, ok)
		svc.RemoveWSConnection(ctx, 1, "c1")
		svc.RefreshWSConnection(ctx, 1)
		count, err := svc.GetWSConnectionCount(ctx, 1)
		require.NoError(t, err)
		assert.Zero(t, count)
	})

	t.Run("limits connections per user", func(t *testing.T) {
		mr := startRedis(t)
		for i := 0; i < constants.WSMaxConnsPerUser; i++ {
			ok, err := svc.TrackWSConnection(ctx, 1, fmt.Sprintf("conn-%d", i))
			require.NoError(t, err)
			require.True(t, ok)
		}
		ok, err := svc.TrackWSConnection(ctx, 1, "one-too-many")
		require.NoError(t, err)
		assert.False(t, ok)

		count, err := svc.GetWSConnectionCount(ctx, 1)
		require.NoError(t, err)
		assert.EqualValues(t, constants.WSMaxConnsPerUser, count)
		assert.Equal(t, constants.NotifWSConnTTL, mr.TTL(wsConnKey(1)))

		svc.RemoveWSConnection(ctx, 1, "conn-0")
		count, err = svc.GetWSConnectionCount(ctx, 1)
		require.NoError(t, err)
		assert.EqualValues(t, constants.WSMaxConnsPerUser-1, count)

		mr.FastForward(30 * time.Second)
		svc.RefreshWSConnection(ctx, 1)
		assert.Equal(t, constants.NotifWSConnTTL, mr.TTL(wsConnKey(1)), "heartbeat refreshes the TTL")

		mr.FastForward(constants.NotifWSConnTTL + time.Second)
		count, err = svc.GetWSConnectionCount(ctx, 1)
		require.NoError(t, err)
		assert.Zero(t, count, "stale tracking expires")
	})

	t.Run("count lookup failure", func(t *testing.T) {
		mr := startRedis(t)
		mr.SetError("boom")
		ok, err := svc.TrackWSConnection(ctx, 2, "c")
		require.Error(t, err)
		assert.False(t, ok)
		_, err = svc.GetWSConnectionCount(ctx, 2)
		assert.Error(t, err)
	})

	t.Run("tracking write failure", func(t *testing.T) {
		mr := startRedis(t)
		failRedisCommands(t, mr, errInjected, "sadd")
		ok, err := svc.TrackWSConnection(ctx, 3, "c")
		require.ErrorIs(t, err, errInjected)
		assert.False(t, ok)
	})

	t.Run("missing set reads as zero", func(t *testing.T) {
		mr := startRedis(t)
		failRedisCommands(t, mr, goredis.Nil, "scard")
		count, err := svc.GetWSConnectionCount(ctx, 4)
		require.NoError(t, err)
		assert.Zero(t, count)
		ok, err := svc.TrackWSConnection(ctx, 4, "c")
		require.NoError(t, err)
		assert.True(t, ok)
	})
}

func TestNotificationService_CleanupOldNotifications(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	now := time.Now()
	day := 24 * time.Hour

	keepRecentRead := seedNotification(t, db, 1, now.Add(-29*day), true)
	dropOldRead := seedNotification(t, db, 1, now.Add(-31*day), true)
	keepOldUnread := seedNotification(t, db, 1, now.Add(-89*day), false)
	dropAncientUnread := seedNotification(t, db, 1, now.Add(-91*day), false)

	svc := newNotificationService(db)
	deleted, err := svc.CleanupOldNotifications(ctx)
	require.NoError(t, err)
	assert.EqualValues(t, 2, deleted)

	var remaining []uint
	for _, n := range notificationsOf(t, db, 1) {
		remaining = append(remaining, n.ID)
	}
	assert.ElementsMatch(t, []uint{keepRecentRead.ID, keepOldUnread.ID}, remaining)
	assert.NotContains(t, remaining, dropOldRead.ID)
	assert.NotContains(t, remaining, dropAncientUnread.ID)

	deleted, err = svc.CleanupOldNotifications(ctx)
	require.NoError(t, err)
	assert.Zero(t, deleted)

	_, err = newNotificationService(testutil.BrokenDB(t)).CleanupOldNotifications(ctx)
	assert.Error(t, err)
}
