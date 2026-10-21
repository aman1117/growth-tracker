/**
 * How the session lifecycle treats this browser's push subscription, through the real auth
 * store, push store, pushService and API client. Only the browser APIs and the network are
 * stubbed.
 */
import { act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { API_ROUTES } from '../constants';
import { STORAGE_KEYS } from '../constants/storage';
import { apiClient } from '../services/api';
import { nowInSeconds, tokenWith } from '../test/fixtures/shell';
import { jsonResponse, mockFetch } from '../test/utils';
import { useAuthStore } from './useAuthStore';
import { usePushStore } from './usePushStore';

const API_URL = 'http://localhost:8000/api';
const SUBSCRIPTIONS_URL = `${API_URL}/push/subscriptions`;
const ENDPOINT = 'https://push.example.com/subscription/alice';

const ALICE = { id: 7, username: 'alice' };
const BOB = { id: 8, username: 'bob' };
type Person = typeof ALICE;

const tokenFor = ({ id, username }: Person, expiresIn = 3600) =>
  tokenWith({ user_id: id, username, exp: nowInSeconds() + expiresIn });

const signInAs = (person: Person) => {
  const token = tokenFor(person);
  act(() => useAuthStore.getState().login(token, person.username, person.id));
  return token;
};

/** What the app does when a signed-in session starts (see PushSessionCheck in App.tsx) */
const startSessionPushCheck = () =>
  act(() => {
    usePushStore.getState().checkSupport();
  });

/** Lets fire-and-forget work started by the code under test run to the end */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A browser with push permission and an existing subscription (unless no worker is installed) */
function stubSubscribedBrowser({ serviceWorkerInstalled = true } = {}) {
  const subscription = {
    endpoint: ENDPOINT,
    getKey: vi.fn((name: string) => new Uint8Array(name === 'auth' ? [1, 2, 3] : [4, 5]).buffer),
    unsubscribe: vi.fn().mockResolvedValue(true),
  };
  vi.stubGlobal('Notification', { permission: 'granted', requestPermission: vi.fn() });
  vi.stubGlobal('PushManager', class {});
  const registration = {
    pushManager: { getSubscription: vi.fn().mockResolvedValue(subscription), subscribe: vi.fn() },
  };
  const serviceWorker = {
    ready: serviceWorkerInstalled ? Promise.resolve(registration) : new Promise<never>(() => {}),
    getRegistration: vi.fn().mockResolvedValue(serviceWorkerInstalled ? registration : undefined),
  };
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: serviceWorker });
  return { subscription, serviceWorker };
}

afterEach(() => {
  Reflect.deleteProperty(navigator, 'serviceWorker');
});

describe('push across the session lifecycle', () => {
  describe('signing out', () => {
    it('unregisters this device with the session’s token, then drops the subscription', async () => {
      const { subscription } = stubSubscribedBrowser();
      const fetchMock = mockFetch(() => jsonResponse({ success: true }));
      const token = signInAs(ALICE);

      act(() => useAuthStore.getState().logout());

      // logout itself is synchronous; the device is unregistered right after
      expect(useAuthStore.getState().user).toBeNull();
      expect(localStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN)).toBeNull();
      await vi.waitFor(() => expect(subscription.unsubscribe).toHaveBeenCalledTimes(1));
      expect(fetchMock).toHaveBeenCalledExactlyOnceWith(SUBSCRIPTIONS_URL, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ endpoint: ENDPOINT }),
        keepalive: true,
      });
      expect(fetchMock.mock.invocationCallOrder[0]).toBeLessThan(
        subscription.unsubscribe.mock.invocationCallOrder[0]
      );
    });

    it('still completes, and drops the subscription, when the request fails', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { subscription } = stubSubscribedBrowser();
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
      signInAs(ALICE);

      act(() => useAuthStore.getState().logout());

      expect(useAuthStore.getState().user).toBeNull();
      await vi.waitFor(() => expect(subscription.unsubscribe).toHaveBeenCalledTimes(1));
      expect(warn).toHaveBeenCalledWith(
        '[Push] Could not reach the server to unregister this device',
        expect.any(TypeError)
      );
    });

    it('still completes without a service worker', async () => {
      const { serviceWorker } = stubSubscribedBrowser({ serviceWorkerInstalled: false });
      const fetchMock = mockFetch(() => jsonResponse({ success: true }));
      signInAs(ALICE);

      act(() => useAuthStore.getState().logout());
      await settle();

      expect(useAuthStore.getState().user).toBeNull();
      expect(serviceWorker.getRegistration).toHaveBeenCalledTimes(1);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('a session that ends without signing out keeps push on this device', () => {
    it('when it expires', async () => {
      vi.spyOn(console, 'info').mockImplementation(() => {});
      const { subscription, serviceWorker } = stubSubscribedBrowser();
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      localStorage.setItem(
        'auth-storage',
        JSON.stringify({ state: { user: ALICE, isAuthenticated: true }, version: 0 })
      );
      localStorage.setItem(STORAGE_KEYS.ACCESS_TOKEN, tokenFor(ALICE, -60));

      await act(() => useAuthStore.persist.rehydrate());
      await settle();

      expect(useAuthStore.getState().user).toBeNull();
      expect(serviceWorker.getRegistration).not.toHaveBeenCalled();
      expect(subscription.unsubscribe).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('when the server answers 401', async () => {
      const { subscription, serviceWorker } = stubSubscribedBrowser();
      signInAs(ALICE);
      vi.stubGlobal('location', { ...window.location, pathname: '/settings' });
      const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
      vi.stubGlobal('fetch', fetchMock);

      await expect(apiClient.get(API_ROUTES.NOTIFICATION.UNREAD_COUNT)).rejects.toMatchObject({
        statusCode: 401,
      });
      // The redirect to /login reloads the app, which starts by restoring the auth store
      await act(() => useAuthStore.persist.rehydrate());
      await settle();

      expect(useAuthStore.getState().user).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(serviceWorker.getRegistration).not.toHaveBeenCalled();
      expect(subscription.unsubscribe).not.toHaveBeenCalled();
    });
  });

  describe('when a session starts on a browser that already has a subscription', () => {
    it('turns push off when the subscription belongs to another account', async () => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      const { subscription } = stubSubscribedBrowser();
      const fetchMock = mockFetch((url, init) =>
        url === SUBSCRIPTIONS_URL && init?.method === 'POST'
          ? jsonResponse(
              {
                success: false,
                error: 'Endpoint already registered to another user',
                error_code: 'CONFLICT',
              },
              { status: 409 }
            )
          : undefined
      );
      // Alice's session here ended without unregistering; Bob signs in
      const bobsToken = signInAs(BOB);

      startSessionPushCheck();

      await vi.waitFor(() => expect(subscription.unsubscribe).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(usePushStore.getState().isSubscribed).toBe(false));
      const [, init] = fetchMock.mock.calls[0];
      expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${bobsToken}`);
      expect(JSON.parse(String(init?.body)).subscription.endpoint).toBe(ENDPOINT);
      expect(info).toHaveBeenCalledWith(
        '[Push] This browser was subscribed for another account; removing it'
      );
    });

    it('keeps push on for the account that registered it, asking only once', async () => {
      const { subscription } = stubSubscribedBrowser();
      const fetchMock = mockFetch(() =>
        jsonResponse({ success: true, message: 'Subscription registered successfully' })
      );
      signInAs(ALICE);

      startSessionPushCheck();
      await vi.waitFor(() => expect(usePushStore.getState().isSubscribed).toBe(true));
      startSessionPushCheck();
      await settle();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][1]?.method).toBe('POST');
      expect(subscription.unsubscribe).not.toHaveBeenCalled();
      expect(usePushStore.getState().isSubscribed).toBe(true);
    });

    it('never contacts the server while signed out', async () => {
      stubSubscribedBrowser();
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      startSessionPushCheck();
      await vi.waitFor(() => expect(usePushStore.getState().isSubscribed).toBe(true));
      await settle();

      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
