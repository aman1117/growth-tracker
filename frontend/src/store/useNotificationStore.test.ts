import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

import { apiClient } from '../services/api';
import { deferred, makeNotification } from '../test/fixtures/shell';
import type { NotificationsResponse } from '../types';
import {
  useHasUnread,
  useNotifications,
  useNotificationsLoading,
  useNotificationStore,
  useUnreadCount,
  useWSStatus,
} from './useNotificationStore';

vi.mock('../services/api', () => ({
  apiClient: { get: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

const client = vi.mocked(apiClient);
const store = () => useNotificationStore.getState();
const ids = () => store().notifications.map((n) => n.id);

const page = (
  notifications: NotificationsResponse['notifications'],
  hasMore = false
): NotificationsResponse => ({
  success: true,
  notifications,
  total: notifications.length,
  page: 1,
  page_size: 20,
  has_more: hasMore,
});

const NOW = new Date('2024-05-01T12:00:00Z');

describe('useNotificationStore', () => {
  let consoleError: MockInstance<typeof console.error>;

  beforeEach(() => {
    client.get.mockReset();
    client.patch.mockReset();
    client.delete.mockReset();
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  describe('fetchNotifications', () => {
    it('loads the first page', async () => {
      const request = deferred<NotificationsResponse>();
      client.get.mockReturnValue(request.promise);

      const loading = store().fetchNotifications();
      expect(store().isLoading).toBe(true);
      expect(client.get).toHaveBeenCalledWith('/notifications?page=1&page_size=20');

      request.resolve(page([makeNotification({ id: 1 }), makeNotification({ id: 2 })], true));
      await loading;

      expect(ids()).toEqual([1, 2]);
      expect(store()).toMatchObject({ hasMore: true, page: 2, isLoading: false, error: null });
    });

    it('appends the next page and skips notifications already shown', async () => {
      useNotificationStore.setState({
        notifications: [makeNotification({ id: 1 }), makeNotification({ id: 2 })],
        page: 2,
      });
      client.get.mockResolvedValue(
        page([makeNotification({ id: 2 }), makeNotification({ id: 3 })])
      );

      await store().fetchNotifications();

      expect(client.get).toHaveBeenCalledWith('/notifications?page=2&page_size=20');
      expect(ids()).toEqual([1, 2, 3]);
      expect(store()).toMatchObject({ hasMore: false, page: 3 });
    });

    it('reloads from the first page when reset', async () => {
      useNotificationStore.setState({
        notifications: [makeNotification({ id: 1 })],
        page: 4,
        hasMore: false,
      });
      client.get.mockResolvedValue(page([makeNotification({ id: 7 })], true));

      await store().fetchNotifications(true);

      expect(client.get).toHaveBeenCalledWith('/notifications?page=1&page_size=20');
      expect(ids()).toEqual([7]);
      expect(store()).toMatchObject({ page: 2, hasMore: true });
    });

    it('ignores calls while a page is loading', async () => {
      const request = deferred<NotificationsResponse>();
      client.get.mockReturnValue(request.promise);

      const first = store().fetchNotifications();
      await store().fetchNotifications();
      await store().fetchNotifications(true);

      expect(client.get).toHaveBeenCalledTimes(1);
      request.resolve(page([]));
      await first;
    });

    it('stops paging once there is nothing more to load', async () => {
      useNotificationStore.setState({ hasMore: false });

      await store().fetchNotifications();

      expect(client.get).not.toHaveBeenCalled();
    });

    it('never brings back notifications deleted on this device', async () => {
      store().startDeleting(901);
      client.get.mockResolvedValue(
        page([makeNotification({ id: 901 }), makeNotification({ id: 902 })])
      );

      await store().fetchNotifications(true);

      expect(ids()).toEqual([902]);
    });

    it('records the error and stops loading when the request fails', async () => {
      client.get.mockRejectedValueOnce(new Error('Server error'));
      await store().fetchNotifications();
      expect(store()).toMatchObject({ error: 'Server error', isLoading: false });

      client.get.mockRejectedValueOnce({ status: 500 });
      await store().fetchNotifications();
      expect(store().error).toBe('Failed to fetch notifications');
    });

    it('clears a previous error when retrying', async () => {
      useNotificationStore.setState({ error: 'Server error' });
      const request = deferred<NotificationsResponse>();
      client.get.mockReturnValue(request.promise);

      const loading = store().fetchNotifications();
      expect(store().error).toBeNull();

      request.resolve(page([]));
      await loading;
    });
  });

  describe('fetchUnreadCount', () => {
    it('stores the unread count', async () => {
      client.get.mockResolvedValue({ success: true, unread_count: 4 });

      await store().fetchUnreadCount();

      expect(client.get).toHaveBeenCalledWith('/notifications/unread-count');
      expect(store().unreadCount).toBe(4);
    });

    it('keeps the old count when the request fails', async () => {
      useNotificationStore.setState({ unreadCount: 2 });
      const error = new Error('Server error');
      client.get.mockRejectedValue(error);

      await store().fetchUnreadCount();

      expect(store().unreadCount).toBe(2);
      expect(consoleError).toHaveBeenCalledWith('Failed to fetch unread count:', error);
    });
  });

  describe('markAsRead', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(NOW);
    });

    it('marks an unread notification read and decrements the badge', async () => {
      useNotificationStore.setState({
        notifications: [makeNotification({ id: 5 }), makeNotification({ id: 6 })],
        unreadCount: 2,
      });
      client.patch.mockResolvedValue({ success: true });

      await store().markAsRead(5);

      expect(client.patch).toHaveBeenCalledWith('/notifications/5/read', {});
      expect(store().notifications[0].read_at).toBe(NOW.toISOString());
      expect(store().notifications[1].read_at).toBeNull();
      expect(store().unreadCount).toBe(1);
    });

    it('does not decrement the badge for read or unknown notifications', async () => {
      useNotificationStore.setState({
        notifications: [makeNotification({ id: 5, read_at: '2024-04-01T00:00:00Z' })],
        unreadCount: 3,
      });
      client.patch.mockResolvedValue({ success: true });

      await store().markAsRead(5);
      await store().markAsRead(404);

      expect(store().unreadCount).toBe(3);
    });

    it('never lets the badge go negative', async () => {
      useNotificationStore.setState({
        notifications: [makeNotification({ id: 5 })],
        unreadCount: 0,
      });
      client.patch.mockResolvedValue({ success: true });

      await store().markAsRead(5);

      expect(store().unreadCount).toBe(0);
    });

    it('rethrows failures so the caller can react', async () => {
      useNotificationStore.setState({
        notifications: [makeNotification({ id: 5 })],
        unreadCount: 1,
      });
      const error = new Error('Server error');
      client.patch.mockRejectedValue(error);

      await expect(store().markAsRead(5)).rejects.toBe(error);

      expect(store().unreadCount).toBe(1);
      expect(store().notifications[0].read_at).toBeNull();
      expect(consoleError).toHaveBeenCalledWith('Failed to mark notification as read:', error);
    });
  });

  describe('markAllAsRead', () => {
    it('marks everything read, keeping earlier read times', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(NOW);
      useNotificationStore.setState({
        notifications: [
          makeNotification({ id: 1 }),
          makeNotification({ id: 2, read_at: '2024-04-01T00:00:00Z' }),
        ],
        unreadCount: 1,
      });
      client.patch.mockResolvedValue({ success: true });

      await store().markAllAsRead();

      expect(client.patch).toHaveBeenCalledWith('/notifications/read-all', {});
      expect(store().notifications.map((n) => n.read_at)).toEqual([
        NOW.toISOString(),
        '2024-04-01T00:00:00Z',
      ]);
      expect(store().unreadCount).toBe(0);
    });

    it('rethrows failures and keeps the badge', async () => {
      useNotificationStore.setState({ unreadCount: 3 });
      const error = new Error('Server error');
      client.patch.mockRejectedValue(error);

      await expect(store().markAllAsRead()).rejects.toBe(error);

      expect(store().unreadCount).toBe(3);
      expect(consoleError).toHaveBeenCalledWith('Failed to mark all notifications as read:', error);
    });
  });

  describe('deleting', () => {
    it('startDeleting flags the notification for the exit animation', () => {
      store().startDeleting(911);

      expect(store().deletingIds).toEqual({ 911: true });
    });

    it('deleteNotification removes it, updates the badge and calls the API', async () => {
      useNotificationStore.setState({
        notifications: [makeNotification({ id: 912 }), makeNotification({ id: 913 })],
        unreadCount: 2,
      });
      store().startDeleting(912);
      client.delete.mockResolvedValue({ success: true });

      await store().deleteNotification(912);

      expect(ids()).toEqual([913]);
      expect(store().unreadCount).toBe(1);
      expect(store().deletingIds).toEqual({});
      expect(client.delete).toHaveBeenCalledWith('/notifications/912');
    });

    it('keeps the badge when a read notification is deleted', async () => {
      useNotificationStore.setState({
        notifications: [makeNotification({ id: 914, read_at: '2024-04-01T00:00:00Z' })],
        unreadCount: 2,
      });
      client.delete.mockResolvedValue({ success: true });

      await store().deleteNotification(914);

      expect(store().unreadCount).toBe(2);
    });

    it('treats "already deleted" (404) as success', async () => {
      useNotificationStore.setState({ notifications: [makeNotification({ id: 915 })] });
      client.delete.mockRejectedValue({ status: 404 });

      await store().deleteNotification(915);

      expect(ids()).toEqual([]);
      expect(consoleError).not.toHaveBeenCalled();
    });

    it('logs other failures but keeps the notification hidden', async () => {
      useNotificationStore.setState({ notifications: [makeNotification({ id: 916 })] });
      const error = Object.assign(new Error('Server error'), { status: 500 });
      client.delete.mockRejectedValue(error);

      await store().deleteNotification(916);

      expect(ids()).toEqual([]);
      expect(consoleError).toHaveBeenCalledWith('Failed to delete notification:', error);
    });
  });

  describe('real-time updates', () => {
    it('setWSStatus tracks the WebSocket connection', () => {
      store().setWSStatus('connecting');
      expect(store().wsStatus).toBe('connecting');

      store().setWSStatus('connected');
      expect(store().wsStatus).toBe('connected');
    });

    it('addNotification puts new notifications on top and bumps the badge', () => {
      useNotificationStore.setState({
        notifications: [makeNotification({ id: 1 })],
        unreadCount: 1,
      });

      store().addNotification(makeNotification({ id: 2 }));

      expect(ids()).toEqual([2, 1]);
      expect(store().unreadCount).toBe(2);
    });

    it('addNotification ignores duplicates and locally deleted notifications', () => {
      useNotificationStore.setState({
        notifications: [makeNotification({ id: 1 })],
        unreadCount: 1,
      });
      store().startDeleting(921);
      const before = store();

      store().addNotification(makeNotification({ id: 1 }));
      store().addNotification(makeNotification({ id: 921 }));

      expect(store().notifications).toBe(before.notifications);
      expect(store().unreadCount).toBe(1);
    });

    it('addNotification keeps at most 200 notifications', () => {
      const existing = Array.from({ length: 200 }, (_, i) => makeNotification({ id: 1000 + i }));
      useNotificationStore.setState({ notifications: existing });

      store().addNotification(makeNotification({ id: 5000 }));

      expect(ids()).toHaveLength(200);
      expect(ids()[0]).toBe(5000);
      expect(ids()).not.toContain(1199);
    });

    it('addPendingNotifications merges missed notifications newest first', () => {
      useNotificationStore.setState({
        notifications: [makeNotification({ id: 1, created_at: '2024-05-01T10:00:00Z' })],
        unreadCount: 1,
      });
      store().startDeleting(931);

      store().addPendingNotifications([
        makeNotification({ id: 1, created_at: '2024-05-01T10:00:00Z' }),
        makeNotification({ id: 2, created_at: '2024-05-01T11:00:00Z' }),
        makeNotification({
          id: 3,
          created_at: '2024-05-01T09:00:00Z',
          read_at: '2024-05-01T09:30:00Z',
        }),
        makeNotification({ id: 931, created_at: '2024-05-01T12:00:00Z' }),
      ]);

      expect(ids()).toEqual([2, 1, 3]);
      expect(store().unreadCount).toBe(2);
    });

    it('addPendingNotifications leaves state alone when nothing is new', () => {
      useNotificationStore.setState({
        notifications: [makeNotification({ id: 1 })],
        unreadCount: 1,
      });
      const before = store();

      store().addPendingNotifications([]);
      store().addPendingNotifications([makeNotification({ id: 1 })]);

      expect(store()).toBe(before);
    });

    it('addPendingNotifications keeps at most 200 notifications', () => {
      const pending = Array.from({ length: 205 }, (_, i) =>
        makeNotification({
          id: 2000 + i,
          created_at: new Date(Date.UTC(2024, 0, 1, 0, i)).toISOString(),
        })
      );

      store().addPendingNotifications(pending);

      expect(ids()).toHaveLength(200);
      expect(ids()[0]).toBe(2204);
    });
  });

  describe('state management', () => {
    it('clearError removes the error', () => {
      useNotificationStore.setState({ error: 'Server error' });

      store().clearError();

      expect(store().error).toBeNull();
    });

    it('reset returns to the initial state', () => {
      useNotificationStore.setState({
        notifications: [makeNotification()],
        unreadCount: 3,
        wsStatus: 'connected',
        page: 3,
        hasMore: false,
        error: 'x',
        deletingIds: { 1: true },
      });

      store().reset();

      expect(store()).toMatchObject({
        notifications: [],
        unreadCount: 0,
        wsStatus: 'disconnected',
        isLoading: false,
        hasMore: true,
        page: 1,
        error: null,
        deletingIds: {},
      });
    });
  });

  describe('selector hooks', () => {
    it('follow notifications, badge, connection and loading state', () => {
      const notifications = renderHook(() => useNotifications());
      const unread = renderHook(() => useUnreadCount());
      const hasUnread = renderHook(() => useHasUnread());
      const wsStatus = renderHook(() => useWSStatus());
      const loading = renderHook(() => useNotificationsLoading());

      expect(notifications.result.current).toEqual([]);
      expect(unread.result.current).toBe(0);
      expect(hasUnread.result.current).toBe(false);
      expect(wsStatus.result.current).toBe('disconnected');
      expect(loading.result.current).toBe(false);

      act(() => {
        store().addNotification(makeNotification({ id: 941 }));
        store().setWSStatus('reconnecting');
        useNotificationStore.setState({ isLoading: true });
      });

      expect(notifications.result.current.map((n) => n.id)).toEqual([941]);
      expect(unread.result.current).toBe(1);
      expect(hasUnread.result.current).toBe(true);
      expect(wsStatus.result.current).toBe('reconnecting');
      expect(loading.result.current).toBe(true);
    });
  });
});
