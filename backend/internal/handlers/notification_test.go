package handlers

import (
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/dto"
	"github.com/aman1117/backend/internal/testutil"
	"github.com/aman1117/backend/pkg/models"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func titles(notifications []dto.NotificationDTO) []string {
	out := make([]string, 0, len(notifications))
	for _, n := range notifications {
		out = append(out, n.Title)
	}
	return out
}

func isRead(t *testing.T, env *testEnv, n *models.Notification) bool {
	t.Helper()
	var got models.Notification
	require.NoError(t, env.db.First(&got, n.ID).Error)
	return got.ReadAt != nil
}

func TestNotificationHandler_GetNotifications(t *testing.T) {
	env := newEnv(t)
	user, other, quiet := env.user(t), env.user(t), env.user(t)
	base := time.Date(2026, 3, 9, 8, 0, 0, 0, time.UTC)
	var created []*models.Notification
	for i := 0; i < 3; i++ {
		created = append(created, createNotification(t, env.db, user.ID, fmt.Sprintf("n%d", i), i == 0, base.Add(time.Duration(i)*time.Minute)))
	}
	createNotification(t, env.db, other.ID, "not mine", false, base)

	t.Run("newest first with default paging", func(t *testing.T) {
		got := decodeAs[dto.NotificationsResponse](t, env.do(t, user, http.MethodGet, "/api/notifications", nil), http.StatusOK)

		assert.True(t, got.Success)
		assert.EqualValues(t, 3, got.Total)
		assert.Equal(t, 1, got.Page)
		assert.Equal(t, 20, got.PageSize)
		assert.False(t, got.HasMore)
		require.Equal(t, []string{"n2", "n1", "n0"}, titles(got.Notifications))
		assert.Equal(t, dto.NotificationDTO{
			ID:        created[2].ID,
			Type:      string(models.NotifTypeSystemAnnounce),
			Title:     "n2",
			Body:      "n2 body",
			Metadata:  map[string]any{"source": "test"},
			CreatedAt: "2026-03-09T08:02:00Z",
		}, got.Notifications[0])
		assert.NotNil(t, got.Notifications[2].ReadAt, "read notifications carry read_at")
	})

	t.Run("pages", func(t *testing.T) {
		tests := []struct {
			query   string
			titles  []string
			hasMore bool
		}{
			{"page=1&page_size=2", []string{"n2", "n1"}, true},
			{"page=2&page_size=2", []string{"n0"}, false},
			{"page=3&page_size=2", []string{}, false},
		}
		for _, tc := range tests {
			got := decodeAs[dto.NotificationsResponse](t, env.do(t, user, http.MethodGet, "/api/notifications?"+tc.query, nil), http.StatusOK)
			assert.Equal(t, tc.titles, titles(got.Notifications), tc.query)
			assert.Equal(t, tc.hasMore, got.HasMore, tc.query)
			assert.EqualValues(t, 3, got.Total, tc.query)
			assert.Equal(t, 2, got.PageSize, tc.query)
		}
	})

	t.Run("out of range paging is clamped", func(t *testing.T) {
		tests := []struct {
			query    string
			page     int
			pageSize int
		}{
			{"page=0&page_size=0", 1, 20},
			{"page=-3&page_size=-1", 1, 20},
			{"page=abc&page_size=xyz", 1, 20},
			{"page_size=500", 1, 50},
		}
		for _, tc := range tests {
			got := decodeAs[dto.NotificationsResponse](t, env.do(t, user, http.MethodGet, "/api/notifications?"+tc.query, nil), http.StatusOK)
			assert.Equal(t, tc.page, got.Page, tc.query)
			assert.Equal(t, tc.pageSize, got.PageSize, tc.query)
			assert.Len(t, got.Notifications, 3, tc.query)
		}
	})

	t.Run("no notifications", func(t *testing.T) {
		got := decodeAs[dto.NotificationsResponse](t, env.do(t, quiet, http.MethodGet, "/api/notifications", nil), http.StatusOK)
		assert.NotNil(t, got.Notifications, "an empty list, not null")
		assert.Empty(t, got.Notifications)
		assert.Zero(t, got.Total)
	})
}

func TestNotificationHandler_UnreadCount(t *testing.T) {
	env := newEnv(t)
	mr := testutil.StartRedis(t)
	user := env.user(t)
	base := time.Date(2026, 3, 9, 8, 0, 0, 0, time.UTC)
	unread := createNotification(t, env.db, user.ID, "unread", false, base)
	createNotification(t, env.db, user.ID, "unread too", false, base)
	createNotification(t, env.db, user.ID, "read", true, base)
	key := constants.NotifUnreadPrefix + itoa(user.ID)
	unreadCount := func(t *testing.T) int64 {
		t.Helper()
		got := decodeAs[dto.UnreadCountResponse](t, env.do(t, user, http.MethodGet, "/api/notifications/unread-count", nil), http.StatusOK)
		assert.True(t, got.Success)
		return got.UnreadCount
	}

	assert.EqualValues(t, 2, unreadCount(t))
	cached, err := mr.Get(key)
	require.NoError(t, err)
	assert.Equal(t, "2", cached)

	require.Equal(t, http.StatusOK, env.do(t, user, http.MethodPatch, "/api/notifications/"+itoa(unread.ID)+"/read", nil).Status)
	assert.False(t, mr.Exists(key), "marking as read invalidates the cached count")
	assert.EqualValues(t, 1, unreadCount(t))
}

func TestNotificationHandler_MarkAsRead(t *testing.T) {
	env := newEnv(t)
	user, other := env.user(t), env.user(t)
	base := time.Date(2026, 3, 9, 8, 0, 0, 0, time.UTC)
	mine := createNotification(t, env.db, user.ID, "mine", false, base)
	theirs := createNotification(t, env.db, other.ID, "theirs", false, base)

	for _, id := range []string{"abc", "-1", "99999999999"} {
		t.Run("invalid id "+id, func(t *testing.T) {
			res := env.do(t, user, http.MethodPatch, "/api/notifications/"+id+"/read", nil)
			assertErrorMessage(t, res, http.StatusBadRequest, constants.ErrCodeInvalidRequest, "Invalid notification ID")
		})
	}

	t.Run("marks the notification as read", func(t *testing.T) {
		res := env.do(t, user, http.MethodPatch, "/api/notifications/"+itoa(mine.ID)+"/read", nil)
		require.Equal(t, http.StatusOK, res.Status)
		assert.Equal(t, map[string]any{"success": true, "message": "Notification marked as read"}, res.JSON(t))
		assert.True(t, isRead(t, env, mine))
	})

	t.Run("someone else's notification is left alone", func(t *testing.T) {
		res := env.do(t, user, http.MethodPatch, "/api/notifications/"+itoa(theirs.ID)+"/read", nil)
		require.Equal(t, http.StatusOK, res.Status)
		assert.False(t, isRead(t, env, theirs))
	})
}

func TestNotificationHandler_MarkAllAsRead(t *testing.T) {
	env := newEnv(t)
	user, other := env.user(t), env.user(t)
	base := time.Date(2026, 3, 9, 8, 0, 0, 0, time.UTC)
	a := createNotification(t, env.db, user.ID, "a", false, base)
	b := createNotification(t, env.db, user.ID, "b", false, base)
	theirs := createNotification(t, env.db, other.ID, "theirs", false, base)

	res := env.do(t, user, http.MethodPatch, "/api/notifications/read-all", nil)

	require.Equal(t, http.StatusOK, res.Status)
	assert.Equal(t, map[string]any{"success": true, "message": "All notifications marked as read"}, res.JSON(t))
	assert.True(t, isRead(t, env, a))
	assert.True(t, isRead(t, env, b))
	assert.False(t, isRead(t, env, theirs))
}

func TestNotificationHandler_DeleteNotification(t *testing.T) {
	env := newEnv(t)
	user, other := env.user(t), env.user(t)
	base := time.Date(2026, 3, 9, 8, 0, 0, 0, time.UTC)
	mine := createNotification(t, env.db, user.ID, "mine", false, base)
	theirs := createNotification(t, env.db, other.ID, "theirs", false, base)

	t.Run("invalid id", func(t *testing.T) {
		res := env.do(t, user, http.MethodDelete, "/api/notifications/abc", nil)
		assertErrorMessage(t, res, http.StatusBadRequest, constants.ErrCodeInvalidRequest, "Invalid notification ID")
	})

	for name, id := range map[string]uint{"unknown notification": 9999, "someone else's notification": theirs.ID} {
		t.Run(name, func(t *testing.T) {
			res := env.do(t, user, http.MethodDelete, "/api/notifications/"+itoa(id), nil)
			assertErrorMessage(t, res, http.StatusNotFound, constants.ErrCodeNotificationNotFound, "Notification not found")
		})
	}
	assert.EqualValues(t, 1, count(t, env.db, &models.Notification{}, "id = ?", theirs.ID))

	t.Run("deletes own notification", func(t *testing.T) {
		res := env.do(t, user, http.MethodDelete, "/api/notifications/"+itoa(mine.ID), nil)
		require.Equal(t, http.StatusOK, res.Status)
		assert.Equal(t, map[string]any{"success": true, "message": "Notification deleted"}, res.JSON(t))
		assert.Zero(t, count(t, env.db, &models.Notification{}, "id = ?", mine.ID))
	})
}

func TestNotificationHandler_DatabaseFailures(t *testing.T) {
	h := brokenStack(t).handlers()
	tests := []struct {
		method, target string
		code, message  string
	}{
		{http.MethodGet, "/api/notifications", constants.ErrCodeFetchFailed, "Failed to get notifications"},
		{http.MethodGet, "/api/notifications/unread-count", constants.ErrCodeFetchFailed, "Failed to get unread count"},
		{http.MethodPatch, "/api/notifications/1/read", constants.ErrCodeUpdateFailed, "Failed to mark as read"},
		{http.MethodPatch, "/api/notifications/read-all", constants.ErrCodeUpdateFailed, "Failed to mark all as read"},
		{http.MethodDelete, "/api/notifications/1", constants.ErrCodeDeleteFailed, "Failed to delete notification"},
	}
	for _, tc := range tests {
		t.Run(tc.method+" "+tc.target, func(t *testing.T) {
			res := call(t, h, ghostUser, tc.method, tc.target, nil)
			assertErrorMessage(t, res, http.StatusInternalServerError, tc.code, tc.message)
		})
	}
}
