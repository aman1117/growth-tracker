/**
 * User-scoped store reset
 *
 * Zustand stores are module singletons that outlive a session. Every store below holds data
 * fetched for, or about, the signed-in user, so it is reset whenever a session ends or a new
 * one starts; otherwise the next person to sign in on the same tab would briefly see the
 * previous user's notifications, follow state, comments ("liked by me"), calendar data and
 * push preferences. The user's data kept in localStorage (dashboard layout, custom tiles and
 * per-day activity caches) is cleared at the same moments.
 *
 * App-wide state is deliberately not reset: the theme preference (persisted per device),
 * transient toasts and any storage key not declared per-user (see USER_STORAGE_KEYS).
 *
 * The auth store calls this, so these stores must never import the auth store.
 */

import type { StoreApi } from 'zustand';

import { ACTIVITY_CACHE_KEY_PREFIX, USER_STORAGE_KEYS } from '../constants/storage';
import { useCommentStore } from './useCommentStore';
import { useCompletionStore } from './useCompletionStore';
import { useFollowStore } from './useFollowStore';
import { useNotificationPreviewStore } from './useNotificationPreviewStore';
import { useNotificationStore } from './useNotificationStore';
import { usePushStore } from './usePushStore';

const restoreInitialState = <T>(store: StoreApi<T>) => {
  store.setState(store.getInitialState(), true);
};

/** Removes the user's data from localStorage: dashboard layout, custom tiles, day caches. */
function clearUserStorage(): void {
  try {
    USER_STORAGE_KEYS.forEach((key) => localStorage.removeItem(key));

    // Collect first: removing keys while indexing localStorage shifts the indexes
    const activityCaches: string[] = [];
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (key?.startsWith(ACTIVITY_CACHE_KEY_PREFIX)) activityCaches.push(key);
    }
    activityCaches.forEach((key) => localStorage.removeItem(key));
  } catch (error) {
    // Storage can be unavailable (e.g. blocked by the browser); the session change still goes on
    console.warn('[Session] Could not clear the previous user’s saved data', error);
  }
}

/** Resets every user-scoped store to its initial state and clears the user's saved data. */
export function resetUserStores(): void {
  restoreInitialState(useNotificationStore);
  restoreInitialState(useNotificationPreviewStore);
  restoreInitialState(useFollowStore);
  restoreInitialState(useCommentStore);
  restoreInitialState(useCompletionStore);
  // reset() also clears the "preferences fetched" flag so the next user's preferences load,
  // and persists isSubscribed: false. It never touches the browser's push subscription:
  // an explicit logout unregisters it (useAuthStore), otherwise the next session confirms
  // it with the server (checkSupport).
  usePushStore.getState().reset();
  clearUserStorage();
}
