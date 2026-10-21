import { describe, expect, it } from 'vitest';

import * as store from './index';
import * as auth from './useAuthStore';
import * as comments from './useCommentStore';
import * as completion from './useCompletionStore';
import * as follow from './useFollowStore';
import * as notificationPreview from './useNotificationPreviewStore';
import * as notifications from './useNotificationStore';
import * as push from './usePushStore';
import * as theme from './useThemeStore';
import * as toast from './useToastStore';

describe('store barrel', () => {
  it('re-exports every store and helper from one entry point', () => {
    expect(Object.fromEntries(Object.entries(store))).toEqual({
      useAuth: auth.useAuth,
      useAuthLoading: auth.useAuthLoading,
      useAuthStore: auth.useAuthStore,
      useCurrentUser: auth.useCurrentUser,
      useIsAuthenticated: auth.useIsAuthenticated,
      useCommentStore: comments.useCommentStore,
      useCompletionStore: completion.useCompletionStore,
      useMonthCompletion: completion.useMonthCompletion,
      useMonthCompletionLoading: completion.useMonthCompletionLoading,
      useFollowCounts: follow.useFollowCounts,
      useFollowStore: follow.useFollowStore,
      usePendingRequestsCount: follow.usePendingRequestsCount,
      useRelationship: follow.useRelationship,
      showNotificationPreview: notificationPreview.showNotificationPreview,
      useNotificationPreviewStore: notificationPreview.useNotificationPreviewStore,
      useHasUnread: notifications.useHasUnread,
      useNotifications: notifications.useNotifications,
      useNotificationsLoading: notifications.useNotificationsLoading,
      useNotificationStore: notifications.useNotificationStore,
      useUnreadCount: notifications.useUnreadCount,
      useWSStatus: notifications.useWSStatus,
      usePushError: push.usePushError,
      usePushLoading: push.usePushLoading,
      usePushPermission: push.usePushPermission,
      usePushPreferences: push.usePushPreferences,
      usePushStore: push.usePushStore,
      usePushSubscribed: push.usePushSubscribed,
      usePushSupported: push.usePushSupported,
      useIsDarkMode: theme.useIsDarkMode,
      useTheme: theme.useTheme,
      useThemePreference: theme.useThemePreference,
      useThemeStore: theme.useThemeStore,
      showError: toast.showError,
      showSuccess: toast.showSuccess,
      showToast: toast.showToast,
      useToastStore: toast.useToastStore,
    });
  });
});
