/**
 * Auth Store
 *
 * Global authentication state management using Zustand.
 * Replaces the AuthContext for more flexible state management.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { STORAGE_KEYS } from '../constants/storage';

export interface User {
  id: number;
  username: string;
  profilePic?: string | null;
  bio?: string | null;
  isVerified?: boolean;
  emailVerified?: boolean;
}

interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;

  // Actions - matching original AuthContext API
  login: (token: string, username: string, userId: number, profilePic?: string | null, bio?: string | null) => void;
  logout: () => void;
  updateUsername: (newUsername: string) => void;
  updateProfilePic: (url: string | null) => void;
  updateBio: (bio: string | null) => void;
  updateEmailVerified: (verified: boolean) => void;
  setLoading: (value: boolean) => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      isAuthenticated: false,
      isLoading: true,

      login: (token, username, userId, profilePic, bio) => {
        // Store token separately (not in persisted state for security)
        localStorage.setItem(STORAGE_KEYS.ACCESS_TOKEN, token);
        localStorage.setItem(STORAGE_KEYS.USERNAME, username);
        localStorage.setItem(STORAGE_KEYS.USER_ID, userId.toString());
        if (profilePic) {
          localStorage.setItem(STORAGE_KEYS.PROFILE_PIC, profilePic);
        } else {
          localStorage.removeItem(STORAGE_KEYS.PROFILE_PIC);
        }
        if (bio) {
          localStorage.setItem(STORAGE_KEYS.BIO, bio);
        } else {
          localStorage.removeItem(STORAGE_KEYS.BIO);
        }

        set({
          user: { id: userId, username, profilePic, bio },
          isAuthenticated: true,
          isLoading: false,
        });
      },

      logout: () => {
        // Clear all auth-related localStorage items
        localStorage.removeItem(STORAGE_KEYS.ACCESS_TOKEN);
        localStorage.removeItem(STORAGE_KEYS.USERNAME);
        localStorage.removeItem(STORAGE_KEYS.USER_ID);
        localStorage.removeItem(STORAGE_KEYS.PROFILE_PIC);
        localStorage.removeItem(STORAGE_KEYS.BIO);
        // Clear email verification dismissal so new user sees it
        localStorage.removeItem('email-verification-dismissed-at');

        set({
          user: null,
          isAuthenticated: false,
        });
      },

      updateUsername: (newUsername) => {
        localStorage.setItem(STORAGE_KEYS.USERNAME, newUsername);
        set((state) => ({
          user: state.user ? { ...state.user, username: newUsername } : null,
        }));
      },

      updateProfilePic: (url) => {
        if (url) {
          localStorage.setItem(STORAGE_KEYS.PROFILE_PIC, url);
        } else {
          localStorage.removeItem(STORAGE_KEYS.PROFILE_PIC);
        }
        set((state) => ({
          user: state.user ? { ...state.user, profilePic: url } : null,
        }));
      },

      updateBio: (bio) => {
        if (bio) {
          localStorage.setItem(STORAGE_KEYS.BIO, bio);
        } else {
          localStorage.removeItem(STORAGE_KEYS.BIO);
        }
        set((state) => ({
          user: state.user ? { ...state.user, bio } : null,
        }));
      },

      updateEmailVerified: (verified) => {
        set((state) => ({
          user: state.user ? { ...state.user, emailVerified: verified } : null,
        }));
      },

      setLoading: (value) => set({ isLoading: value }),
    }),
    {
      name: 'auth-storage',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        user: state.user,
        isAuthenticated: state.isAuthenticated,
      }),
      onRehydrateStorage: () => (state) => {
        // Also check localStorage for token on rehydration
        const token = localStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN);
        if (!token && state) {
          // No token means not authenticated
          state.user = null;
          state.isAuthenticated = false;
        }
        state?.setLoading(false);
      },
    }
  )
);

/**
 * Helper hook to check if auth is loading (hydrating from storage)
 */
export const useAuthLoading = () => {
  return useAuthStore((state) => state.isLoading);
};

/**
 * Helper hook to get current user
 */
export const useCurrentUser = () => {
  return useAuthStore((state) => state.user);
};

/**
 * Helper hook to check if authenticated
 */
export const useIsAuthenticated = () => {
  return useAuthStore((state) => state.isAuthenticated);
};

/**
 * Custom hook that provides the same API as the old AuthContext
 * This makes migration easier - components can use useAuth() directly
 */
export const useAuth = () => {
  const user = useAuthStore((state) => state.user);
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const isLoading = useAuthStore((state) => state.isLoading);
  const login = useAuthStore((state) => state.login);
  const logout = useAuthStore((state) => state.logout);
  const updateUsername = useAuthStore((state) => state.updateUsername);
  const updateProfilePic = useAuthStore((state) => state.updateProfilePic);
  const updateBio = useAuthStore((state) => state.updateBio);
  const updateEmailVerified = useAuthStore((state) => state.updateEmailVerified);

  return {
    user,
    isAuthenticated,
    isLoading,
    login,
    logout,
    updateUsername,
    updateProfilePic,
    updateBio,
    updateEmailVerified,
  };
};
