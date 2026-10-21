import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { cacheActivities, getDefaultTileSizes } from '../components/Dashboard/Dashboard.constants';
import { useTileConfig } from '../components/Dashboard/hooks/useTileConfig';
import { NotificationBell } from '../components/ui/Notification/NotificationBell';
import { API_ROUTES } from '../constants';
import { STORAGE_KEYS } from '../constants/storage';
import { api, apiClient } from '../services/api';
import { pushService } from '../services/pushService';
import { makeCustomTile, routeApi } from '../test/fixtures/dashboard';
import {
  deferred,
  makeComment,
  makeNotification,
  makePushPreferences,
  makeRelationship,
  nowInSeconds,
  tokenWith,
} from '../test/fixtures/shell';
import { ACTIVITY_NAMES } from '../types';
import {
  showToast,
  useAuthStore,
  useCommentStore,
  useCompletionStore,
  useFollowStore,
  useNotificationPreviewStore,
  useNotificationStore,
  usePushStore,
  useThemeStore,
  useToastStore,
} from './index';
import { resetUserStores } from './resetUserStores';

vi.mock('../services/pushService', () => ({
  pushService: {
    isSupported: vi.fn(),
    getPermissionState: vi.fn(),
    getExistingSubscription: vi.fn(),
    requestPermission: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    confirmSubscription: vi.fn(),
    unregisterDevice: vi.fn(),
    getPreferences: vi.fn(),
    updatePreferences: vi.fn(),
  },
}));
// The dashboard's `api` calls are answered by the tests; apiClient stays real for the 401 path
vi.mock('../services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/api')>()),
  api: { get: vi.fn(), post: vi.fn() },
}));

const push = vi.mocked(pushService);

const ALICE = { id: 7, username: 'alice' };
const BOB = { id: 8, username: 'bob' };
type Person = typeof ALICE;

const AUTH_STORAGE_KEY = 'auth-storage';
const PUSH_STORAGE_KEY = 'push-storage';
// Stands in for app-wide keys that are not per-user, such as PWA install state
const INSTALL_STORAGE_KEY = 'pwa-install-dismissed';
const ALICE_DAY = '2024-03-01';
const ALICE_DAY_CACHE = `dashboard_alice_${ALICE_DAY}`;
const ALICE_PREFERENCES = makePushPreferences({
  timezone: 'Asia/Kolkata',
  quiet_hours_enabled: true,
});

/** Every store that holds data for, or about, the signed-in user. */
const USER_STORES = {
  useNotificationStore,
  useNotificationPreviewStore,
  useFollowStore,
  useCommentStore,
  useCompletionStore,
  usePushStore,
};

/** localStorage keys that hold Alice's own dashboard data. */
const ALICE_DASHBOARD_KEYS = [
  STORAGE_KEYS.TILE_ORDER,
  STORAGE_KEYS.TILE_SIZES,
  STORAGE_KEYS.TILE_HIDDEN,
  STORAGE_KEYS.TILE_COLORS,
  STORAGE_KEYS.CUSTOM_TILES,
  ALICE_DAY_CACHE,
];

const sessionToken = ({ id, username }: Person, expiresIn = 3600) =>
  tokenWith({ user_id: id, username, exp: nowInSeconds() + expiresIn });

/** Signs in the way the login screen does; returns the session's token. */
const signInAs = (person: Person) => {
  const token = sessionToken(person);
  act(() => useAuthStore.getState().login(token, person.username, person.id));
  return token;
};

const signOutOfTheApp = () => act(() => useAuthStore.getState().logout());

/** What Alice's dashboard saves locally: her layout, custom tiles and a day with notes. */
function saveAliceDashboard() {
  localStorage.setItem(STORAGE_KEYS.TILE_ORDER, JSON.stringify(['custom:guitar-1', 'sleep']));
  localStorage.setItem(STORAGE_KEYS.TILE_SIZES, JSON.stringify({ sleep: 'wide' }));
  localStorage.setItem(STORAGE_KEYS.TILE_HIDDEN, JSON.stringify(['eating']));
  localStorage.setItem(STORAGE_KEYS.TILE_COLORS, JSON.stringify({ sleep: '#111111' }));
  localStorage.setItem(STORAGE_KEYS.CUSTOM_TILES, JSON.stringify([makeCustomTile()]));
  cacheActivities(ALICE.username, ALICE_DAY, { sleep: 8 }, { sleep: 'Private note' });
}

/** Fills every user-scoped store and Alice's saved dashboard the way her session would. */
async function browseAsAlice() {
  act(() => {
    useNotificationStore.setState({
      notifications: [makeNotification({ id: 1 })],
      unreadCount: 3,
      wsStatus: 'connected',
      page: 2,
      hasMore: false,
    });
    useNotificationPreviewStore.getState().showPreview(makeNotification({ id: 2 }));
    const follow = useFollowStore.getState();
    follow.setRelationship(42, makeRelationship({ following: true, is_mutual: true }));
    follow.setCounts(ALICE.id, { followers: 10, following: 5 });
    follow.setPendingRequestsCount(2);
    useCommentStore.setState({
      commentsByDay: { 'bob:2024-03-01': [makeComment({ liked_by_me: true, like_count: 1 })] },
      counts: { 'bob:2024-03-01': 1 },
      sort: 'newest',
    });
    useCompletionStore.getState().updateDay('bob', new Date(2024, 2, 1), 2.5);
    usePushStore.setState({ isSupported: true, permission: 'granted', isSubscribed: true });
  });
  saveAliceDashboard();
  push.getPreferences.mockResolvedValue({ success: true, preferences: ALICE_PREFERENCES });
  await act(() => usePushStore.getState().fetchPreferences());
}

const expectNoSavedDashboard = () => {
  for (const key of ALICE_DASHBOARD_KEYS) {
    expect(localStorage.getItem(key), key).toBeNull();
  }
};

/** Asserts that no user-scoped store or saved user data is left from the previous session. */
function expectNoUserData() {
  for (const [name, store] of Object.entries(USER_STORES)) {
    expect(store.getState(), name).toEqual(store.getInitialState());
  }
  expect(useNotificationStore.getState()).toMatchObject({ notifications: [], unreadCount: 0 });
  expect(useNotificationPreviewStore.getState().preview).toBeNull();
  expect(useFollowStore.getState()).toMatchObject({
    relationships: {},
    counts: {},
    pendingRequestsCount: 0,
  });
  expect(useCommentStore.getState()).toMatchObject({ commentsByDay: {}, counts: {} });
  expect(useCompletionStore.getState().monthlyData).toEqual({});
  expect(usePushStore.getState()).toMatchObject({ isSubscribed: false, preferences: null });
  expect(JSON.parse(localStorage.getItem(PUSH_STORAGE_KEY) ?? 'null')).toEqual({
    state: { isSubscribed: false },
    version: 0,
  });
  expectNoSavedDashboard();
}

/** App-wide state that must survive a change of user. */
function expectAppPreferencesKept() {
  expect(useThemeStore.getState().theme).toBe('dark');
  expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
  expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.THEME) ?? 'null')).toEqual({
    state: { theme: 'dark' },
    version: 0,
  });
  expect(localStorage.getItem(INSTALL_STORAGE_KEY)).toBe('1');
  expect(useToastStore.getState().toasts).toEqual([
    expect.objectContaining({ message: 'Theme updated' }),
  ]);
}

const choosePreferences = () =>
  act(() => {
    useThemeStore.getState().setTheme('dark');
    showToast('Theme updated', 'success', 0);
    localStorage.setItem(INSTALL_STORAGE_KEY, '1');
  });

describe('resetUserStores', () => {
  beforeEach(() => {
    Object.values(push).forEach((fn) => fn.mockReset());
    // Also clears the push store's module-level "preferences already fetched" flag
    usePushStore.getState().reset();
  });

  it('returns every user-scoped store to its initial state', async () => {
    await browseAsAlice();
    choosePreferences();
    expect(localStorage.getItem(ALICE_DAY_CACHE)).not.toBeNull();

    act(() => resetUserStores());

    expectNoUserData();
    expectAppPreferencesKept();
  });

  it('lets the next user load their own push preferences', async () => {
    await browseAsAlice();
    act(() => resetUserStores());
    const bobPreferences = makePushPreferences({ timezone: 'America/Denver' });
    push.getPreferences.mockResolvedValue({ success: true, preferences: bobPreferences });

    await act(() => usePushStore.getState().fetchPreferences());

    expect(push.getPreferences).toHaveBeenCalledTimes(2);
    expect(usePushStore.getState().preferences).toEqual(bobPreferences);
  });

  describe('when the session ends', () => {
    it('signing out clears the user’s data and keeps the theme', async () => {
      const token = signInAs(ALICE);
      await browseAsAlice();
      choosePreferences();

      signOutOfTheApp();

      expect(useAuthStore.getState()).toMatchObject({ user: null, isAuthenticated: false });
      expectNoUserData();
      expectAppPreferencesKept();
      // Captured before logout cleared it from storage
      expect(push.unregisterDevice).toHaveBeenCalledExactlyOnceWith(token);
      expect(localStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN)).toBeNull();
    });

    it('a 401 clears the session, and the app that reloads finds none of the user’s data', async () => {
      signInAs(ALICE);
      await browseAsAlice();
      choosePreferences();
      vi.stubGlobal('location', { ...window.location, pathname: '/settings' });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 401 })));

      await expect(apiClient.get(API_ROUTES.NOTIFICATION.UNREAD_COUNT)).rejects.toMatchObject({
        statusCode: 401,
      });
      expect(localStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN)).toBeNull();
      expect(window.location.href).toBe('/login');

      // The redirect reloads the app, which starts by restoring the auth store from storage
      await act(() => useAuthStore.persist.rehydrate());

      expect(useAuthStore.getState()).toMatchObject({ user: null, isAuthenticated: false });
      expectNoUserData();
      expectAppPreferencesKept();
      // Only an explicit logout stops push on this device
      expect(push.unregisterDevice).not.toHaveBeenCalled();
    });

    it('an expired session found on start-up is cleared the same way', async () => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      localStorage.setItem(
        AUTH_STORAGE_KEY,
        JSON.stringify({ state: { user: ALICE, isAuthenticated: true }, version: 0 })
      );
      localStorage.setItem(STORAGE_KEYS.ACCESS_TOKEN, sessionToken(ALICE, -60));
      localStorage.setItem(
        PUSH_STORAGE_KEY,
        JSON.stringify({ state: { isSubscribed: true }, version: 0 })
      );
      saveAliceDashboard();
      // On a real start-up the push store restores its state before the auth store does
      await usePushStore.persist.rehydrate();
      expect(usePushStore.getState().isSubscribed).toBe(true);

      await useAuthStore.persist.rehydrate();

      expect(info).toHaveBeenCalledWith('[Auth] Stored session expired, signing out');
      expect(useAuthStore.getState().user).toBeNull();
      expectNoUserData();
      expect(push.unregisterDevice).not.toHaveBeenCalled();
    });

    it('a start-up without a previous session leaves the other stores alone', async () => {
      localStorage.setItem(
        PUSH_STORAGE_KEY,
        JSON.stringify({ state: { isSubscribed: true }, version: 0 })
      );
      await usePushStore.persist.rehydrate();

      await useAuthStore.persist.rehydrate();

      expect(useAuthStore.getState().user).toBeNull();
      expect(usePushStore.getState().isSubscribed).toBe(true);
    });
  });

  describe('the next user to sign in', () => {
    const renderBell = () => render(<NotificationBell onClick={vi.fn()} isOpen={false} />);
    const bell = () => screen.getByRole('button', { name: /^Notifications/ });

    it('sees none of the previous user’s data', async () => {
      renderBell();
      signInAs(ALICE);
      await browseAsAlice();
      expect(bell()).toHaveAccessibleName('Notifications (3 unread)');

      signOutOfTheApp();
      signInAs(BOB);

      expect(useAuthStore.getState().user).toMatchObject({ id: BOB.id, username: BOB.username });
      expect(bell()).toHaveAccessibleName('Notifications');
      expect(screen.queryByText('3')).not.toBeInTheDocument();
      expect(useFollowStore.getState().relationships).toEqual({});
      expect(useCommentStore.getState().commentsByDay).toEqual({});
    });

    it('never sees a response that arrived for the previous user after they signed out', async () => {
      renderBell();
      signInAs(ALICE);
      const response = deferred<Response>();
      vi.stubGlobal(
        'fetch',
        vi.fn(() => response.promise)
      );
      const unreadCount = useNotificationStore.getState().fetchUnreadCount();

      signOutOfTheApp();
      response.resolve(
        new Response(JSON.stringify({ success: true, unread_count: 5 }), { status: 200 })
      );
      await act(() => unreadCount);
      signInAs(BOB);

      expect(bell()).toHaveAccessibleName('Notifications');
      expect(useNotificationStore.getState().unreadCount).toBe(0);
    });

    it('keeps push for its owner when their session expired on this device', async () => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      signInAs(ALICE);
      await browseAsAlice();
      // The session expires while the app is closed; the next start-up finds the old token
      localStorage.setItem(STORAGE_KEYS.ACCESS_TOKEN, sessionToken(ALICE, -60));
      await act(() => useAuthStore.persist.rehydrate());
      expect(info).toHaveBeenCalledWith('[Auth] Stored session expired, signing out');
      const subscription = { endpoint: 'https://push.example/alice' } as PushSubscription;
      push.isSupported.mockReturnValue(true);
      push.getPermissionState.mockReturnValue('granted');
      push.getExistingSubscription.mockResolvedValue(subscription);
      push.confirmSubscription.mockResolvedValue('registered');

      // Alice signs in again; the app checks the device's push subscription for the session
      signInAs(ALICE);
      act(() => {
        usePushStore.getState().checkSupport();
      });
      await vi.waitFor(() => expect(usePushStore.getState().isSubscribed).toBe(true));
      await act(() => usePushStore.getState().fetchPreferences());

      expect(push.confirmSubscription).toHaveBeenCalledExactlyOnceWith(subscription);
      expect(usePushStore.getState()).toMatchObject({
        isSupported: true,
        permission: 'granted',
        isSubscribed: true,
        preferences: ALICE_PREFERENCES,
      });
      expect(push.getPreferences).toHaveBeenCalledTimes(2);
      expect(push.unregisterDevice).not.toHaveBeenCalled();
    });
  });

  describe('saved dashboard data', () => {
    it('is cleared when the next user signs in, even if it was saved after a sign-out', async () => {
      signInAs(ALICE);
      choosePreferences();
      signOutOfTheApp();
      // A save of Alice's layout that was still in flight lands after she signed out
      saveAliceDashboard();

      signInAs(BOB);

      expectNoSavedDashboard();
      expectAppPreferencesKept();
    });

    it('never gives a new user without a saved layout the previous user’s tiles', async () => {
      signInAs(ALICE);
      await browseAsAlice();
      signOutOfTheApp();
      signInAs(BOB);
      routeApi(api, { 'GET /tile-config': { success: true, data: null } });

      const { result } = renderHook(() =>
        useTileConfig({ isReadOnly: false, targetUsername: BOB.username })
      );
      await waitFor(() => expect(result.current.configLoading).toBe(false));

      expect(api.get).toHaveBeenCalledWith('/tile-config');
      expect(result.current).toMatchObject({
        tileOrder: [...ACTIVITY_NAMES],
        tileSizes: getDefaultTileSizes(),
        hiddenTiles: [],
        tileColors: {},
        customTiles: [],
      });
    });

    it('does not stop the change of user when the browser blocks storage', async () => {
      await browseAsAlice();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const storageError = new Error('storage unavailable');
      vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
        throw storageError;
      });

      act(() => resetUserStores());

      expect(warn).toHaveBeenCalledExactlyOnceWith(
        '[Session] Could not clear the previous user’s saved data',
        storageError
      );
      for (const [name, store] of Object.entries(USER_STORES)) {
        expect(store.getState(), name).toEqual(store.getInitialState());
      }
    });
  });
});
