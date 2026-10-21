package repository

import (
	"fmt"
	"testing"
	"time"

	"github.com/aman1117/backend/internal/testutil"
	"github.com/aman1117/backend/pkg/models"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func createNotification(t *testing.T, db *gorm.DB, userID uint, typ models.NotificationType, createdAt time.Time, readAt *time.Time, meta models.NotificationMetadata) *models.Notification {
	t.Helper()
	n := &models.Notification{
		UserID: userID, Type: typ, Title: "New activity", Body: "Something happened",
		Metadata: meta, ReadAt: readAt, CreatedAt: createdAt,
	}
	require.NoError(t, db.Create(n).Error)
	return n
}

func notificationIDs(rows []models.Notification) []uint {
	ids := make([]uint, len(rows))
	for i, n := range rows {
		ids[i] = n.ID
	}
	return ids
}

func TestNotificationRepository_CreateAndGetByID(t *testing.T) {
	db := testutil.DB(t)
	repo := NewNotificationRepository(db)
	user := testutil.CreateUser(t, db)

	notif := &models.Notification{
		UserID: user.ID,
		Type:   models.NotifTypeLikeReceived,
		Title:  "alice liked your day",
		Body:   "Keep it up 🔥",
		Metadata: models.LikeMetadata{
			LikerID: 7, LikerUsername: "alice", LikedDate: "2026-03-09",
		}.ToMap(),
	}
	require.NoError(t, repo.Create(notif))
	require.NotZero(t, notif.ID)

	got, err := repo.GetByID(notif.ID)
	require.NoError(t, err)
	require.NotNil(t, got)
	assert.Equal(t, user.ID, got.UserID)
	assert.Equal(t, models.NotifTypeLikeReceived, got.Type)
	assert.Equal(t, "alice liked your day", got.Title)
	assert.Equal(t, "Keep it up 🔥", got.Body)
	assert.Equal(t, models.NotificationMetadata{
		"liker_id": float64(7), "liker_username": "alice", "liker_avatar": "", "liked_date": "2026-03-09",
	}, got.Metadata, "metadata round-trips through jsonb")
	assert.False(t, got.IsRead())
	assert.WithinDuration(t, time.Now(), got.CreatedAt, time.Minute)

	plain := &models.Notification{UserID: user.ID, Type: models.NotifTypeSystemAnnounce, Title: "Welcome"}
	require.NoError(t, repo.Create(plain))
	got, err = repo.GetByID(plain.ID)
	require.NoError(t, err)
	assert.Nil(t, got.Metadata, "no metadata is stored as NULL")

	got, err = repo.GetByID(9999)
	assert.NoError(t, err)
	assert.Nil(t, got)
}

func TestNotificationRepository_CreateBatch(t *testing.T) {
	db := testutil.DB(t)
	repo := NewNotificationRepository(db)
	user := testutil.CreateUser(t, db)

	require.NoError(t, repo.CreateBatch(nil))

	batch := make([]*models.Notification, 101) // more than one insert batch
	for i := range batch {
		batch[i] = &models.Notification{UserID: user.ID, Type: models.NotifTypeNewFollower, Title: fmt.Sprintf("follower %d", i)}
	}
	require.NoError(t, repo.CreateBatch(batch))

	for _, n := range batch {
		assert.NotZero(t, n.ID)
	}
	count, err := repo.CountByUserID(user.ID)
	require.NoError(t, err)
	assert.Equal(t, int64(101), count)
}

func TestNotificationRepository_ListsAndCounts(t *testing.T) {
	db := testutil.DB(t)
	repo := NewNotificationRepository(db)
	user, other := testutil.CreateUser(t, db), testutil.CreateUser(t, db)
	readAt := t0.Add(time.Hour)
	var all []*models.Notification
	for i := 0; i < 5; i++ {
		var read *time.Time
		if i%2 == 0 {
			read = &readAt
		}
		all = append(all, createNotification(t, db, user.ID, models.NotifTypeLikeReceived, t0.Add(time.Duration(i)*time.Minute), read, nil))
	}
	createNotification(t, db, other.ID, models.NotifTypeLikeReceived, t0.Add(time.Hour), nil, nil)

	t.Run("GetByUserID pages newest first", func(t *testing.T) {
		var pages [][]uint
		for offset := 0; offset <= 6; offset += 2 {
			got, err := repo.GetByUserID(user.ID, 2, offset)
			require.NoError(t, err)
			pages = append(pages, notificationIDs(got))
		}
		assert.Equal(t, [][]uint{
			{all[4].ID, all[3].ID}, {all[2].ID, all[1].ID}, {all[0].ID}, {},
		}, pages)
	})

	t.Run("GetUnreadByUserID", func(t *testing.T) {
		got, err := repo.GetUnreadByUserID(user.ID, 10)
		require.NoError(t, err)
		assert.Equal(t, []uint{all[3].ID, all[1].ID}, notificationIDs(got))

		got, err = repo.GetUnreadByUserID(user.ID, 1)
		require.NoError(t, err)
		assert.Equal(t, []uint{all[3].ID}, notificationIDs(got))
	})

	t.Run("counts", func(t *testing.T) {
		unread, err := repo.GetUnreadCount(user.ID)
		require.NoError(t, err)
		assert.Equal(t, int64(2), unread)

		total, err := repo.CountByUserID(user.ID)
		require.NoError(t, err)
		assert.Equal(t, int64(5), total)

		total, err = repo.CountByUserID(9999)
		require.NoError(t, err)
		assert.Zero(t, total)
	})
}

func TestNotificationRepository_MarkAsRead(t *testing.T) {
	db := testutil.DB(t)
	repo := NewNotificationRepository(db)
	user, other := testutil.CreateUser(t, db), testutil.CreateUser(t, db)
	unread := createNotification(t, db, user.ID, models.NotifTypeLikeReceived, t0, nil, nil)
	earlier := t0.Add(time.Minute)
	alreadyRead := createNotification(t, db, user.ID, models.NotifTypeLikeReceived, t0, &earlier, nil)
	othersUnread := createNotification(t, db, other.ID, models.NotifTypeLikeReceived, t0, nil, nil)
	reload := func(id uint) *models.Notification {
		n, err := repo.GetByID(id)
		require.NoError(t, err)
		require.NotNil(t, n)
		return n
	}

	require.NoError(t, repo.MarkAsRead(unread.ID, user.ID))
	got := reload(unread.ID)
	require.NotNil(t, got.ReadAt)
	assert.WithinDuration(t, time.Now(), *got.ReadAt, time.Minute)

	require.NoError(t, repo.MarkAsRead(alreadyRead.ID, user.ID))
	assert.True(t, reload(alreadyRead.ID).ReadAt.Equal(earlier), "the first read time is kept")

	require.NoError(t, repo.MarkAsRead(othersUnread.ID, user.ID), "not an error, but nothing happens")
	assert.Nil(t, reload(othersUnread.ID).ReadAt, "users cannot mark others' notifications")
}

func TestNotificationRepository_MarkAllAsRead(t *testing.T) {
	db := testutil.DB(t)
	repo := NewNotificationRepository(db)
	user, other := testutil.CreateUser(t, db), testutil.CreateUser(t, db)
	for i := 0; i < 3; i++ {
		createNotification(t, db, user.ID, models.NotifTypeNewFollower, t0, nil, nil)
	}
	createNotification(t, db, other.ID, models.NotifTypeNewFollower, t0, nil, nil)

	require.NoError(t, repo.MarkAllAsRead(user.ID))

	unread, err := repo.GetUnreadCount(user.ID)
	require.NoError(t, err)
	assert.Zero(t, unread)
	unread, err = repo.GetUnreadCount(other.ID)
	require.NoError(t, err)
	assert.Equal(t, int64(1), unread)
}

func TestNotificationRepository_Delete(t *testing.T) {
	db := testutil.DB(t)
	repo := NewNotificationRepository(db)
	user, other := testutil.CreateUser(t, db), testutil.CreateUser(t, db)
	mine := createNotification(t, db, user.ID, models.NotifTypeNewFollower, t0, nil, nil)
	theirs := createNotification(t, db, other.ID, models.NotifTypeNewFollower, t0, nil, nil)

	require.NoError(t, repo.Delete(mine.ID, user.ID))
	require.NoError(t, repo.Delete(theirs.ID, user.ID))

	got, err := repo.GetByID(mine.ID)
	require.NoError(t, err)
	assert.Nil(t, got)
	got, err = repo.GetByID(theirs.ID)
	require.NoError(t, err)
	assert.NotNil(t, got, "users cannot delete others' notifications")
}

func TestNotificationRepository_DeleteOlderThan(t *testing.T) {
	db := testutil.DB(t)
	repo := NewNotificationRepository(db)
	user := testutil.CreateUser(t, db)
	readCutoff, unreadCutoff := t0, t0.AddDate(0, 0, -30)
	readAt := t0.AddDate(0, 0, 2)
	createNotification(t, db, user.ID, models.NotifTypeLikeReceived, t0.AddDate(0, 0, -10), &readAt, nil) // read, old
	readRecent := createNotification(t, db, user.ID, models.NotifTypeLikeReceived, t0.AddDate(0, 0, 1), &readAt, nil)
	createNotification(t, db, user.ID, models.NotifTypeLikeReceived, t0.AddDate(0, 0, -40), nil, nil) // unread, very old
	unreadOld := createNotification(t, db, user.ID, models.NotifTypeLikeReceived, t0.AddDate(0, 0, -10), nil, nil)

	deleted, err := repo.DeleteOlderThan(readCutoff, unreadCutoff)

	require.NoError(t, err)
	assert.Equal(t, int64(2), deleted)
	var remaining []models.Notification
	require.NoError(t, db.Order("id").Find(&remaining).Error)
	assert.Equal(t, []uint{readRecent.ID, unreadOld.ID}, notificationIDs(remaining),
		"unread notifications are kept longer than read ones")
}

func TestNotificationRepository_DeleteOlderThan_UnreadDeleteFails(t *testing.T) {
	db := testutil.DB(t)
	user := testutil.CreateUser(t, db)
	readAt := t0
	createNotification(t, db, user.ID, models.NotifTypeLikeReceived, t0.AddDate(0, 0, -10), &readAt, nil)
	createNotification(t, db, user.ID, models.NotifTypeLikeReceived, t0.AddDate(0, 0, -40), nil, nil)
	repo := NewNotificationRepository(faultyDB(t, nth(2, on("delete", "notifications"))))

	deleted, err := repo.DeleteOlderThan(t0, t0.AddDate(0, 0, -30))

	assert.ErrorIs(t, err, errInjected)
	assert.Equal(t, int64(1), deleted, "read notifications already removed are reported")
}

func TestNotificationRepository_ExistsByTypeAndMetadata(t *testing.T) {
	db := testutil.DB(t)
	repo := NewNotificationRepository(db)
	user, other := testutil.CreateUser(t, db), testutil.CreateUser(t, db)
	now := time.Now()
	createNotification(t, db, user.ID, models.NotifTypeLikeReceived, now, nil,
		models.NotificationMetadata{"liker_username": "alice", "liker_id": 7})
	createNotification(t, db, user.ID, models.NotifTypeLikeReceived, now.Add(-2*time.Hour), nil,
		models.NotificationMetadata{"liker_username": "carol"})

	cases := []struct {
		name   string
		userID uint
		typ    models.NotificationType
		key    string
		value  interface{}
		within time.Duration
		want   bool
	}{
		{"matching notification", user.ID, models.NotifTypeLikeReceived, "liker_username", "alice", time.Hour, true},
		{"numbers compare as text", user.ID, models.NotifTypeLikeReceived, "liker_id", "7", time.Hour, true},
		{"different value", user.ID, models.NotifTypeLikeReceived, "liker_username", "bob", time.Hour, false},
		{"different key", user.ID, models.NotifTypeLikeReceived, "liked_date", "alice", time.Hour, false},
		{"different type", user.ID, models.NotifTypeStoryLiked, "liker_username", "alice", time.Hour, false},
		{"different user", other.ID, models.NotifTypeLikeReceived, "liker_username", "alice", time.Hour, false},
		{"outside the window", user.ID, models.NotifTypeLikeReceived, "liker_username", "carol", time.Hour, false},
		{"inside a wider window", user.ID, models.NotifTypeLikeReceived, "liker_username", "carol", 3 * time.Hour, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := repo.ExistsByTypeAndMetadata(tc.userID, tc.typ, tc.key, tc.value, tc.within)
			require.NoError(t, err)
			assert.Equal(t, tc.want, got)
		})
	}
}

func TestNotificationRepository_ExistsByTypeAndMetadata_MatchesNonStringValues(t *testing.T) {
	db := testutil.DB(t)
	repo := NewNotificationRepository(db)
	user := testutil.CreateUser(t, db)
	createNotification(t, db, user.ID, models.NotifTypeLikeReceived, time.Now(), nil, models.NotificationMetadata{
		"liker_id": 7, "photo_count": 2, "verified": true, "hours": 2.5,
	})

	for _, tc := range []struct {
		name  string
		key   string
		value interface{}
		want  bool
	}{
		{"uint", "liker_id", uint(7), true},
		{"int", "photo_count", 2, true},
		{"bool", "verified", true, true},
		{"float", "hours", 2.5, true},
		{"different number", "liker_id", uint(8), false},
		{"different bool", "verified", false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			exists, err := repo.ExistsByTypeAndMetadata(user.ID, models.NotifTypeLikeReceived, tc.key, tc.value, time.Hour)
			require.NoError(t, err)
			assert.Equal(t, tc.want, exists)
		})
	}
}

func TestNotificationRepository_CreateDedupeRecord(t *testing.T) {
	db := testutil.DB(t)
	repo := NewNotificationRepository(db)
	user, actor := testutil.CreateUser(t, db), testutil.CreateUser(t, db)
	dedupe := func(key string) *models.NotificationDedupe {
		return &models.NotificationDedupe{
			UserID: user.ID, ActorID: actor.ID, Type: models.NotifTypeLikeReceived, EntityType: "day_like", EntityKey: key,
		}
	}

	created, err := repo.CreateDedupeRecord(dedupe(fmt.Sprintf("%d:2026-03-09", user.ID)))
	require.NoError(t, err)
	assert.True(t, created)

	created, err = repo.CreateDedupeRecord(dedupe(fmt.Sprintf("%d:2026-03-09", user.ID)))
	require.NoError(t, err)
	assert.False(t, created, "the same notification is only ever sent once")

	created, err = repo.CreateDedupeRecord(dedupe(fmt.Sprintf("%d:2026-03-10", user.ID)))
	require.NoError(t, err)
	assert.True(t, created, "another day is a different entity")

	var rows int64
	require.NoError(t, db.Model(&models.NotificationDedupe{}).Count(&rows).Error)
	assert.Equal(t, int64(2), rows)
}

func TestNotificationRepository_GetDB(t *testing.T) {
	db := testutil.DB(t)
	assert.Same(t, db, NewNotificationRepository(db).GetDB())
}

func TestNotificationRepository_DatabaseErrors(t *testing.T) {
	repo := NewNotificationRepository(testutil.BrokenDB(t))
	notif := func() *models.Notification {
		return &models.Notification{UserID: 1, Type: models.NotifTypeNewFollower, Title: "t"}
	}

	calls := map[string]func() error{
		"Create":            func() error { return repo.Create(notif()) },
		"CreateBatch":       func() error { return repo.CreateBatch([]*models.Notification{notif()}) },
		"GetByID":           func() error { _, err := repo.GetByID(1); return err },
		"GetByUserID":       func() error { _, err := repo.GetByUserID(1, 10, 0); return err },
		"GetUnreadByUserID": func() error { _, err := repo.GetUnreadByUserID(1, 10); return err },
		"GetUnreadCount":    func() error { _, err := repo.GetUnreadCount(1); return err },
		"MarkAsRead":        func() error { return repo.MarkAsRead(1, 1) },
		"MarkAllAsRead":     func() error { return repo.MarkAllAsRead(1) },
		"Delete":            func() error { return repo.Delete(1, 1) },
		"DeleteOlderThan":   func() error { _, err := repo.DeleteOlderThan(t0, t0); return err },
		"CountByUserID":     func() error { _, err := repo.CountByUserID(1); return err },
		"ExistsByTypeAndMetadata": func() error {
			_, err := repo.ExistsByTypeAndMetadata(1, models.NotifTypeLikeReceived, "k", "v", time.Hour)
			return err
		},
		"CreateDedupeRecord": func() error {
			_, err := repo.CreateDedupeRecord(&models.NotificationDedupe{UserID: 1, ActorID: 2, Type: models.NotifTypeLikeReceived, EntityType: "day_like", EntityKey: "k"})
			return err
		},
	}
	for name, call := range calls {
		t.Run(name, func(t *testing.T) { assert.Error(t, call()) })
	}
}
