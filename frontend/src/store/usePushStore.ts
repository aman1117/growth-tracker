/**
 * Push Notification Store
 *
 * Global push notification state management using Zustand.
 * Handles subscription status, permissions, and preferences.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { pushService } from '../services/pushService';
import type {
  PushState,
  PushActions,
  PushPermissionState,
  PushPreferences,
  UpdatePreferencesRequest,
} from '../types/push';

// ============================================================================
// Default Values
// ============================================================================

const DEFAULT_PREFERENCES: PushPreferences = {
  push_enabled: true,
  preferences: {
    like_received: true,
    badge_unlocked: true,
    streak_milestone: true,
    streak_at_risk: true,
    system_announcement: true,
  },
  quiet_hours_enabled: false,
  quiet_start: null,
  quiet_end: null,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
};

const initialState: PushState = {
  isSupported: false,
  permission: 'default',
  isSubscribed: false,
  isLoading: false,
  error: null,
  preferences: null,
};

// Internal state for preventing duplicate fetches
let preferencesFetchedFlag = false;

// ============================================================================
// Store
// ============================================================================

interface PushStore extends PushState, PushActions {}

export const usePushStore = create<PushStore>()(
  persist(
    (set, get) => ({
      ...initialState,

      // ==================== Check Support ====================

      checkSupport: () => {
        const isSupported = pushService.isSupported();
        const permissionState = pushService.getPermissionState();
        
        const permission: PushPermissionState = 
          permissionState === 'unsupported' ? 'unsupported' : permissionState;

        set({ isSupported, permission });

        // Check if already subscribed
        if (isSupported && permissionState === 'granted') {
          pushService.getExistingSubscription().then((subscription) => {
            set({ isSubscribed: !!subscription });
          });
        }

        return isSupported;
      },

      // ==================== Request Permission ====================

      requestPermission: async () => {
        const { isSupported } = get();
        
        if (!isSupported) {
          set({ error: 'Push notifications not supported' });
          return 'denied';
        }

        try {
          const permission = await pushService.requestPermission();
          set({ 
            permission: permission as PushPermissionState,
            error: null,
          });
          return permission;
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Permission request failed';
          set({ error: message });
          return 'denied';
        }
      },

      // ==================== Subscribe ====================

      subscribe: async () => {
        const { isSupported, permission } = get();

        if (!isSupported) {
          set({ error: 'Push notifications not supported' });
          return false;
        }

        if (permission === 'denied') {
          set({ error: 'Notification permission was denied' });
          return false;
        }

        set({ isLoading: true, error: null });

        try {
          const response = await pushService.subscribe();
          
          if (response.success) {
            set({ 
              isSubscribed: true, 
              isLoading: false,
              permission: 'granted',
            });

            // Fetch preferences after subscribing
            get().fetchPreferences();
            
            return true;
          } else {
            throw new Error(response.message || 'Subscription failed');
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to subscribe';
          set({ 
            isLoading: false, 
            error: message,
          });
          return false;
        }
      },

      // ==================== Unsubscribe ====================

      unsubscribe: async () => {
        set({ isLoading: true, error: null });

        try {
          await pushService.unsubscribe();
          preferencesFetchedFlag = false;
          set({ 
            isSubscribed: false, 
            isLoading: false,
            preferences: null,
          });
          return true;
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to unsubscribe';
          set({ 
            isLoading: false, 
            error: message,
          });
          return false;
        }
      },

      // ==================== Fetch Preferences ====================

      fetchPreferences: async (force = false) => {
        // Prevent duplicate fetches unless forced
        if (preferencesFetchedFlag && !force) {
          return;
        }
        
        preferencesFetchedFlag = true;
        
        try {
          const response = await pushService.getPreferences();
          
          if (response.success && response.preferences) {
            set({ preferences: response.preferences });
          } else {
            // Use defaults if no preferences exist
            set({ preferences: DEFAULT_PREFERENCES });
          }
        } catch {
          // Use defaults if preferences fetch fails (might not exist yet)
          set({ preferences: DEFAULT_PREFERENCES });
        }
      },

      // ==================== Update Preferences ====================

      updatePreferences: async (updates: UpdatePreferencesRequest) => {
        const { preferences } = get();
        
        // Optimistic update
        if (preferences) {
          set({
            preferences: {
              ...preferences,
              ...updates,
              preferences: {
                ...preferences.preferences,
                ...(updates.preferences || {}),
              },
            } as PushPreferences,
          });
        }

        try {
          const response = await pushService.updatePreferences(updates);
          
          if (response.success && response.preferences) {
            set({ preferences: response.preferences });
            return true;
          } else {
            // Revert optimistic update
            if (preferences) {
              set({ preferences });
            }
            return false;
          }
        } catch {
          // Revert optimistic update on failure
          if (preferences) {
            set({ preferences });
          }
          return false;
        }
      },

      // ==================== Reset ====================

      reset: () => {
        preferencesFetchedFlag = false; // Reset the module-level flag
        set(initialState);
      },
    }),
    {
      name: 'push-storage',
      partialize: (state) => ({
        // Only persist these fields
        isSubscribed: state.isSubscribed,
      }),
    }
  )
);

// ============================================================================
// Selector Hooks
// ============================================================================

export const usePushSupported = () => usePushStore((state) => state.isSupported);
export const usePushPermission = () => usePushStore((state) => state.permission);
export const usePushSubscribed = () => usePushStore((state) => state.isSubscribed);
export const usePushLoading = () => usePushStore((state) => state.isLoading);
export const usePushError = () => usePushStore((state) => state.error);
export const usePushPreferences = () => usePushStore((state) => state.preferences);
