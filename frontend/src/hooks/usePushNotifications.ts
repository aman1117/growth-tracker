/**
 * Push Notifications Hook
 *
 * React hook for managing push notification subscriptions.
 * Provides a simple interface for components to interact with push notifications.
 */

import { useCallback, useEffect } from 'react';

import { usePushStore } from '../store/usePushStore';
import type { PushPreferences, UpdatePreferencesRequest } from '../types/push';

interface UsePushNotificationsReturn {
  // State
  isSupported: boolean;
  permission: 'default' | 'granted' | 'denied' | 'unsupported';
  isSubscribed: boolean;
  isLoading: boolean;
  error: string | null;
  preferences: PushPreferences | null;

  // Actions
  subscribe: () => Promise<boolean>;
  unsubscribe: () => Promise<boolean>;
  toggleSubscription: () => Promise<boolean>;
  updatePreferences: (updates: UpdatePreferencesRequest) => Promise<boolean>;
  clearError: () => void;

  // Computed
  canSubscribe: boolean;
  showPermissionPrompt: boolean;
}

/**
 * Hook for managing push notification subscriptions
 *
 * @example
 * ```tsx
 * const { isSubscribed, toggleSubscription, canSubscribe } = usePushNotifications();
 *
 * return (
 *   <button onClick={toggleSubscription} disabled={!canSubscribe}>
 *     {isSubscribed ? 'Disable' : 'Enable'} Notifications
 *   </button>
 * );
 * ```
 */
export function usePushNotifications(): UsePushNotificationsReturn {
  const store = usePushStore();

  // Initialize on mount and re-check on visibility change
  useEffect(() => {
    store.checkSupport();

    // Fetch preferences if subscribed (only on initial mount)
    if (store.isSubscribed) {
      store.fetchPreferences();
    }

    // Re-check permission when tab becomes visible (user might have changed browser settings)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        store.checkSupport();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const subscribe = useCallback(async () => {
    return store.subscribe();
  }, [store]);

  const unsubscribe = useCallback(async () => {
    return store.unsubscribe();
  }, [store]);

  const toggleSubscription = useCallback(async () => {
    if (store.isSubscribed) {
      return store.unsubscribe();
    } else {
      return store.subscribe();
    }
  }, [store]);

  const updatePreferences = useCallback(
    async (updates: UpdatePreferencesRequest) => {
      return store.updatePreferences(updates);
    },
    [store]
  );

  const clearError = useCallback(() => {
    usePushStore.setState({ error: null });
  }, []);

  // Computed values
  const canSubscribe = store.isSupported && store.permission !== 'denied';
  const showPermissionPrompt =
    store.isSupported && store.permission === 'default' && !store.isSubscribed;

  return {
    // State
    isSupported: store.isSupported,
    permission: store.permission,
    isSubscribed: store.isSubscribed,
    isLoading: store.isLoading,
    error: store.error,
    preferences: store.preferences,

    // Actions
    subscribe,
    unsubscribe,
    toggleSubscription,
    updatePreferences,
    clearError,

    // Computed
    canSubscribe,
    showPermissionPrompt,
  };
}
