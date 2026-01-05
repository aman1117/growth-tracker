/**
 * Notification Store
 *
 * Global notification state management using Zustand.
 * Handles notification fetching, WebSocket status, and real-time updates.
 */

import { create } from 'zustand';
import { apiClient } from '../services/api';
import { API_ROUTES } from '../constants';
import type {
  Notification,
  NotificationsResponse,
  UnreadCountResponse,
  NotificationActionResponse,
  WSConnectionStatus,
  NotificationState,
  NotificationActions,
} from '../types';

const DEFAULT_PAGE_SIZE = 20;

// Track deleted notification IDs to prevent them from being re-added via WebSocket
const deletedNotificationIds = new Set<number>();

interface NotificationStore extends NotificationState, NotificationActions {}

const initialState: NotificationState = {
  notifications: [],
  unreadCount: 0,
  wsStatus: 'disconnected',
  isLoading: false,
  hasMore: true,
  page: 1,
  error: null,
  deletingIds: {},
};

export const useNotificationStore = create<NotificationStore>((set, get) => ({
  ...initialState,

  // ==================== Data Fetching ====================

  fetchNotifications: async (reset = false) => {
    const { isLoading, hasMore, page } = get();
    
    if (isLoading || (!reset && !hasMore)) return;

    const targetPage = reset ? 1 : page;

    set({ isLoading: true, error: null });

    try {
      const response = await apiClient.get<NotificationsResponse>(
        `${API_ROUTES.NOTIFICATION.LIST}?page=${targetPage}&page_size=${DEFAULT_PAGE_SIZE}`
      );

      // Filter out any notifications that were deleted locally
      const filteredNotifications = response.notifications.filter(
        (n) => !deletedNotificationIds.has(n.id)
      );

      set((state) => ({
        notifications: reset 
          ? filteredNotifications 
          : [...state.notifications, ...filteredNotifications.filter(
              (n) => !state.notifications.some((existing) => existing.id === n.id)
            )],
        hasMore: response.has_more,
        page: targetPage + 1,
        isLoading: false,
      }));
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to fetch notifications',
        isLoading: false,
      });
    }
  },

  fetchUnreadCount: async () => {
    try {
      const response = await apiClient.get<UnreadCountResponse>(
        API_ROUTES.NOTIFICATION.UNREAD_COUNT
      );
      set({ unreadCount: response.unread_count });
    } catch (error) {
      console.error('Failed to fetch unread count:', error);
    }
  },

  // ==================== Actions ====================

  markAsRead: async (id: number) => {
    try {
      await apiClient.patch<NotificationActionResponse>(
        API_ROUTES.NOTIFICATION.MARK_READ(id),
        {}
      );

      set((state) => {
        const notification = state.notifications.find((n) => n.id === id);
        const wasUnread = notification && !notification.read_at;

        return {
          notifications: state.notifications.map((n) =>
            n.id === id ? { ...n, read_at: new Date().toISOString() } : n
          ),
          unreadCount: wasUnread ? Math.max(0, state.unreadCount - 1) : state.unreadCount,
        };
      });
    } catch (error) {
      console.error('Failed to mark notification as read:', error);
      throw error;
    }
  },

  markAllAsRead: async () => {
    try {
      await apiClient.patch<NotificationActionResponse>(
        API_ROUTES.NOTIFICATION.MARK_ALL_READ,
        {}
      );

      set((state) => ({
        notifications: state.notifications.map((n) => ({
          ...n,
          read_at: n.read_at || new Date().toISOString(),
        })),
        unreadCount: 0,
      }));
    } catch (error) {
      console.error('Failed to mark all notifications as read:', error);
      throw error;
    }
  },

  // Start delete animation (called immediately on X click)
  startDeleting: (id: number) => {
    // Also add to permanent deleted set to prevent re-adding
    deletedNotificationIds.add(id);
    
    set((state) => ({
      deletingIds: { ...state.deletingIds, [id]: true },
    }));
  },

  deleteNotification: async (id: number) => {
    // Remove from UI using atomic update
    set((state) => {
      const notification = state.notifications.find((n) => n.id === id);
      const wasUnread = notification && !notification.read_at;
      
      // Remove from deletingIds
      const { [id]: _, ...remainingDeletingIds } = state.deletingIds;
      
      return {
        notifications: state.notifications.filter((n) => n.id !== id),
        unreadCount: wasUnread ? Math.max(0, state.unreadCount - 1) : state.unreadCount,
        deletingIds: remainingDeletingIds,
      };
    });

    try {
      await apiClient.delete<NotificationActionResponse>(
        API_ROUTES.NOTIFICATION.DELETE(id)
      );
    } catch (error) {
      // If 404, notification was already deleted - that's fine
      const apiError = error as { status?: number };
      if (apiError.status !== 404) {
        console.error('Failed to delete notification:', error);
      }
    }
  },

  // ==================== WebSocket ====================

  setWSStatus: (status: WSConnectionStatus) => {
    set({ wsStatus: status });
  },

  addNotification: (notification: Notification) => {
    // Skip if this notification was recently deleted
    if (deletedNotificationIds.has(notification.id)) {
      return;
    }
    
    set((state) => {
      // Also check if it already exists
      if (state.notifications.some((n) => n.id === notification.id)) {
        return state;
      }
      // Add to beginning (newest first), limit to 200 notifications
      const updated = [notification, ...state.notifications].slice(0, 200);
      return {
        notifications: updated,
        unreadCount: state.unreadCount + 1,
      };
    });
  },

  addPendingNotifications: (notifications: Notification[]) => {
    if (notifications.length === 0) return;

    set((state) => {
      // Filter out duplicates by ID and deleted notifications
      const existingIds = new Set(state.notifications.map((n) => n.id));
      const newNotifications = notifications.filter(
        (n) => !existingIds.has(n.id) && !deletedNotificationIds.has(n.id)
      );
      
      if (newNotifications.length === 0) return state;

      // Count unread among new notifications
      const newUnread = newNotifications.filter((n) => !n.read_at).length;

      // Merge and sort by created_at (newest first), limit to 200
      const merged = [...newNotifications, ...state.notifications]
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
        .slice(0, 200);

      return {
        notifications: merged,
        unreadCount: state.unreadCount + newUnread,
      };
    });
  },

  // ==================== State Management ====================

  clearError: () => set({ error: null }),

  reset: () => set(initialState),
}));

// ==================== Convenience Hooks ====================

/**
 * Get notifications state only
 */
export const useNotifications = () =>
  useNotificationStore((state) => state.notifications);

/**
 * Get unread count only
 */
export const useUnreadCount = () =>
  useNotificationStore((state) => state.unreadCount);

/**
 * Get WebSocket connection status
 */
export const useWSStatus = () =>
  useNotificationStore((state) => state.wsStatus);

/**
 * Get loading state
 */
export const useNotificationsLoading = () =>
  useNotificationStore((state) => state.isLoading);

/**
 * Check if there are unread notifications
 */
export const useHasUnread = () =>
  useNotificationStore((state) => state.unreadCount > 0);
