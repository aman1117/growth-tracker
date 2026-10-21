import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { STORAGE_KEYS } from '../constants/storage';
import { gl } from '../services/goodlogs';
import { nowInSeconds, tokenWith } from '../test/fixtures/shell';
import { signIn } from '../test/utils';
import {
  useAuth,
  useAuthLoading,
  useAuthStore,
  useCurrentUser,
  useIsAuthenticated,
} from './useAuthStore';

const PERSIST_KEY = 'auth-storage';
const DISMISSED_KEY = 'email-verification-dismissed-at';

const persisted = () => JSON.parse(localStorage.getItem(PERSIST_KEY) ?? 'null');

/** Seeds what a previous visit would have left in storage. */
const seedSession = (token: string | null, user = { id: 3, username: 'carol' }) => {
  localStorage.setItem(
    PERSIST_KEY,
    JSON.stringify({ state: { user, isAuthenticated: true }, version: 0 })
  );
  if (token) localStorage.setItem(STORAGE_KEYS.ACCESS_TOKEN, token);
};

describe('useAuthStore', () => {
  describe('login', () => {
    it('stores the session, marks the user signed in and identifies them for analytics', () => {
      useAuthStore.getState().login('jwt-1', 'alice', 7, 'https://cdn/pic.jpg', 'Hello there');

      expect(useAuthStore.getState()).toMatchObject({
        user: { id: 7, username: 'alice', profilePic: 'https://cdn/pic.jpg', bio: 'Hello there' },
        isAuthenticated: true,
        isLoading: false,
      });
      expect(localStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN)).toBe('jwt-1');
      expect(localStorage.getItem(STORAGE_KEYS.USERNAME)).toBe('alice');
      expect(localStorage.getItem(STORAGE_KEYS.USER_ID)).toBe('7');
      expect(localStorage.getItem(STORAGE_KEYS.PROFILE_PIC)).toBe('https://cdn/pic.jpg');
      expect(localStorage.getItem(STORAGE_KEYS.BIO)).toBe('Hello there');
      expect(gl.identify).toHaveBeenCalledWith('7');
      expect(gl.track).toHaveBeenCalledWith('login', { properties: { username: 'alice' } });
    });

    it('clears a previous user’s picture and bio when the new login has none', () => {
      localStorage.setItem(STORAGE_KEYS.PROFILE_PIC, 'old.jpg');
      localStorage.setItem(STORAGE_KEYS.BIO, 'old bio');

      useAuthStore.getState().login('jwt-2', 'bob', 8);

      expect(localStorage.getItem(STORAGE_KEYS.PROFILE_PIC)).toBeNull();
      expect(localStorage.getItem(STORAGE_KEYS.BIO)).toBeNull();
      expect(useAuthStore.getState().user).toEqual({
        id: 8,
        username: 'bob',
        profilePic: undefined,
        bio: undefined,
      });
    });

    it('persists only the user and the signed-in flag (never the token or loading flag)', () => {
      useAuthStore.getState().login('secret-token', 'alice', 7);

      expect(persisted()).toEqual({
        state: {
          user: { id: 7, username: 'alice' },
          isAuthenticated: true,
        },
        version: 0,
      });
      expect(localStorage.getItem(PERSIST_KEY)).not.toContain('secret-token');
    });
  });

  describe('logout', () => {
    it('clears every auth key, the verification dismissal and the user', () => {
      useAuthStore.getState().login('jwt-1', 'alice', 7, 'pic.jpg', 'bio');
      localStorage.setItem(DISMISSED_KEY, '123');

      useAuthStore.getState().logout();

      for (const key of [
        STORAGE_KEYS.ACCESS_TOKEN,
        STORAGE_KEYS.USERNAME,
        STORAGE_KEYS.USER_ID,
        STORAGE_KEYS.PROFILE_PIC,
        STORAGE_KEYS.BIO,
        DISMISSED_KEY,
      ]) {
        expect(localStorage.getItem(key)).toBeNull();
      }
      expect(useAuthStore.getState()).toMatchObject({ user: null, isAuthenticated: false });
      expect(persisted().state).toEqual({ user: null, isAuthenticated: false });
    });

    it('tracks the logout and resets the analytics identity', () => {
      signIn();
      useAuthStore.getState().logout();

      expect(gl.track).toHaveBeenCalledWith('logout');
      expect(gl.reset).toHaveBeenCalled();
    });
  });

  describe('profile updates', () => {
    it('updateUsername updates the user and the stored username', () => {
      signIn({ id: 1, username: 'old' });

      useAuthStore.getState().updateUsername('new_name');

      expect(useAuthStore.getState().user?.username).toBe('new_name');
      expect(localStorage.getItem(STORAGE_KEYS.USERNAME)).toBe('new_name');
    });

    it('updateProfilePic stores the picture and thumbnail, and removes them when cleared', () => {
      signIn();

      useAuthStore.getState().updateProfilePic('full.jpg', 'thumb.jpg');
      expect(useAuthStore.getState().user).toMatchObject({
        profilePic: 'full.jpg',
        profilePicThumb: 'thumb.jpg',
      });
      expect(localStorage.getItem(STORAGE_KEYS.PROFILE_PIC)).toBe('full.jpg');

      useAuthStore.getState().updateProfilePic(null);
      expect(useAuthStore.getState().user).toMatchObject({
        profilePic: null,
        profilePicThumb: null,
      });
      expect(localStorage.getItem(STORAGE_KEYS.PROFILE_PIC)).toBeNull();
    });

    it('updateBio stores the bio and removes it when cleared', () => {
      signIn();

      useAuthStore.getState().updateBio('Runner');
      expect(useAuthStore.getState().user?.bio).toBe('Runner');
      expect(localStorage.getItem(STORAGE_KEYS.BIO)).toBe('Runner');

      useAuthStore.getState().updateBio(null);
      expect(useAuthStore.getState().user?.bio).toBeNull();
      expect(localStorage.getItem(STORAGE_KEYS.BIO)).toBeNull();
    });

    it('updateEmailVerified flags the current user', () => {
      signIn({ emailVerified: false });

      useAuthStore.getState().updateEmailVerified(true);

      expect(useAuthStore.getState().user?.emailVerified).toBe(true);
    });

    it('profile updates leave a signed-out state untouched', () => {
      useAuthStore.setState({ user: null, isAuthenticated: false });
      const { updateUsername, updateProfilePic, updateBio, updateEmailVerified } =
        useAuthStore.getState();

      updateUsername('ghost');
      updateProfilePic('pic.jpg', 'thumb.jpg');
      updateBio('bio');
      updateEmailVerified(true);

      expect(useAuthStore.getState().user).toBeNull();
    });

    it('setLoading toggles the hydration flag', () => {
      useAuthStore.getState().setLoading(true);
      expect(useAuthStore.getState().isLoading).toBe(true);

      useAuthStore.getState().setLoading(false);
      expect(useAuthStore.getState().isLoading).toBe(false);
    });
  });

  describe('rehydration', () => {
    it('restores the persisted user when a token is stored', async () => {
      seedSession('opaque-token');

      await useAuthStore.persist.rehydrate();

      expect(useAuthStore.getState()).toMatchObject({
        user: { id: 3, username: 'carol' },
        isAuthenticated: true,
        isLoading: false,
      });
    });

    it('keeps a session whose token has not expired yet', async () => {
      seedSession(tokenWith({ user_id: 3, username: 'carol', exp: nowInSeconds() + 3600 }));

      await useAuthStore.persist.rehydrate();

      expect(useAuthStore.getState().isAuthenticated).toBe(true);
      expect(localStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN)).not.toBeNull();
    });

    it('signs out when the persisted user has no token', async () => {
      seedSession(null);

      await useAuthStore.persist.rehydrate();

      expect(useAuthStore.getState()).toMatchObject({
        user: null,
        isAuthenticated: false,
        isLoading: false,
      });
    });

    it('drops an expired token so protected screens are never flashed', async () => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      seedSession(tokenWith({ user_id: 3, username: 'carol', exp: nowInSeconds() - 60 }));

      await useAuthStore.persist.rehydrate();

      expect(info).toHaveBeenCalledWith('[Auth] Stored session expired, signing out');
      expect(localStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN)).toBeNull();
      expect(useAuthStore.getState()).toMatchObject({
        user: null,
        isAuthenticated: false,
        isLoading: false,
      });
    });

    it('finishes loading even when nothing was persisted', async () => {
      useAuthStore.setState({ isLoading: true });

      await useAuthStore.persist.rehydrate();

      expect(useAuthStore.getState()).toMatchObject({
        user: null,
        isAuthenticated: false,
        isLoading: false,
      });
    });
  });

  describe('selector hooks', () => {
    it('expose the loading flag, current user and signed-in state', () => {
      useAuthStore.setState({ isLoading: true });
      const loading = renderHook(() => useAuthLoading());
      const currentUser = renderHook(() => useCurrentUser());
      const authenticated = renderHook(() => useIsAuthenticated());

      expect(loading.result.current).toBe(true);
      expect(currentUser.result.current).toBeNull();
      expect(authenticated.result.current).toBe(false);

      act(() => {
        signIn({ id: 4, username: 'dana' });
      });

      expect(loading.result.current).toBe(false);
      expect(currentUser.result.current).toMatchObject({ id: 4, username: 'dana' });
      expect(authenticated.result.current).toBe(true);
    });

    it('useAuth offers the AuthContext-compatible API', () => {
      const { result } = renderHook(() => useAuth());

      act(() => result.current.login('jwt', 'erin', 12));
      expect(result.current).toMatchObject({
        user: { id: 12, username: 'erin' },
        isAuthenticated: true,
        isLoading: false,
      });

      act(() => result.current.updateUsername('erin_2'));
      act(() => result.current.updateProfilePic('p.jpg'));
      act(() => result.current.updateBio('bio'));
      act(() => result.current.updateEmailVerified(true));
      expect(result.current.user).toMatchObject({
        username: 'erin_2',
        profilePic: 'p.jpg',
        bio: 'bio',
        emailVerified: true,
      });

      act(() => result.current.logout());
      expect(result.current.user).toBeNull();
      expect(result.current.isAuthenticated).toBe(false);
    });
  });
});
