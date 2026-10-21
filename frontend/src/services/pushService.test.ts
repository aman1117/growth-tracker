import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { STORAGE_KEYS } from '../constants/storage';
import { jsonResponse, mockFetch } from '../test/utils';

type PushServiceModule = typeof import('./pushService');

const BASE_URL = 'http://localhost:8000/api';
// URL-safe base64 with '-', '_' and no padding: decodes to the bytes [1, 15, 191].
const VAPID_KEY = 'AQ-_';
const ENDPOINT = 'https://push.example.com/subscription/1';
const FRESH_ENDPOINT = 'https://push.example.com/subscription/2';
const CONFLICT = {
  success: false,
  error: 'Endpoint already registered to another user',
  error_code: 'CONFLICT',
};

let pushService: PushServiceModule['pushService'];

beforeEach(async () => {
  // The VAPID key is cached at module level, so every test gets a fresh service.
  vi.resetModules();
  ({ pushService } = await import('./pushService'));
});

afterEach(() => {
  Reflect.deleteProperty(navigator, 'serviceWorker');
});

function makeSubscription({ withKeys = true, endpoint = ENDPOINT } = {}) {
  const keys: Record<string, ArrayBuffer> = {
    p256dh: new Uint8Array([251, 255, 0, 1]).buffer,
    auth: new Uint8Array([1, 2, 3]).buffer,
  };
  return {
    endpoint,
    getKey: vi.fn((name: string) => (withKeys ? keys[name] : null)),
    unsubscribe: vi.fn().mockResolvedValue(true),
  };
}

type FakeSubscription = ReturnType<typeof makeSubscription>;
const asPushSubscription = (subscription: FakeSubscription) =>
  subscription as unknown as PushSubscription;

interface PushEnvironmentOptions {
  permission?: NotificationPermission;
  requestResult?: NotificationPermission;
  existing?: FakeSubscription | null;
  created?: FakeSubscription;
  /** Without a registered service worker, `ready` never settles */
  serviceWorkerInstalled?: boolean;
}

/** Installs the Notification, PushManager and service worker APIs that jsdom lacks. */
function stubPushEnvironment({
  permission = 'granted',
  requestResult = 'granted',
  existing = null,
  created = makeSubscription(),
  serviceWorkerInstalled = true,
}: PushEnvironmentOptions = {}) {
  const requestPermission = vi.fn().mockResolvedValue(requestResult);
  vi.stubGlobal('Notification', { permission, requestPermission });
  vi.stubGlobal('PushManager', class {});
  const pushManager = {
    subscribe: vi.fn().mockResolvedValue(created),
    getSubscription: vi.fn().mockResolvedValue(existing),
  };
  const registration = { pushManager, showNotification: vi.fn().mockResolvedValue(undefined) };
  const serviceWorker = {
    ready: serviceWorkerInstalled ? Promise.resolve(registration) : new Promise<never>(() => {}),
    getRegistration: vi.fn().mockResolvedValue(serviceWorkerInstalled ? registration : undefined),
  };
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: serviceWorker });
  return { requestPermission, pushManager, registration, serviceWorker, created };
}

/** Answers the VAPID key request and records the subscription calls. */
function mockPushApi({ vapid = { success: true, publicKey: VAPID_KEY, keyId: 'k1' } } = {}) {
  return mockFetch((url, init) => {
    if (url === `${BASE_URL}/push/vapid-public-key`) return jsonResponse(vapid);
    if (url === `${BASE_URL}/push/subscriptions` && init?.method === 'POST') {
      return jsonResponse({ success: true, subscription_id: 12 });
    }
    if (url === `${BASE_URL}/push/subscriptions` && init?.method === 'DELETE') {
      return jsonResponse({ success: true });
    }
    return undefined;
  });
}

const requestsTo = (fetchMock: ReturnType<typeof mockFetch>, path: string) =>
  fetchMock.mock.calls.filter(([url]) => String(url) === `${BASE_URL}${path}`);

describe('pushService support detection', () => {
  it('is supported when service workers, PushManager and Notification all exist', () => {
    stubPushEnvironment({ permission: 'default' });

    expect(pushService.isSupported()).toBe(true);
    expect(pushService.getPermissionState()).toBe('default');
  });

  it.each([
    ['service workers', () => Reflect.deleteProperty(navigator, 'serviceWorker')],
    ['PushManager', () => Reflect.deleteProperty(window, 'PushManager')],
    ['Notification', () => Reflect.deleteProperty(window, 'Notification')],
  ])('is unsupported without %s', (_api, remove) => {
    stubPushEnvironment();
    remove();

    expect(pushService.isSupported()).toBe(false);
    expect(pushService.getPermissionState()).toBe('unsupported');
  });

  it('asks the browser for permission', async () => {
    const { requestPermission } = stubPushEnvironment({ permission: 'default' });

    await expect(pushService.requestPermission()).resolves.toBe('granted');
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it('refuses to ask for permission in unsupported browsers', async () => {
    await expect(pushService.requestPermission()).rejects.toThrow(
      'Push notifications are not supported'
    );
  });
});

describe('pushService.getVapidPublicKey', () => {
  it('fetches the key once and caches it', async () => {
    const fetchMock = mockPushApi();

    await expect(pushService.getVapidPublicKey()).resolves.toBe(VAPID_KEY);
    await expect(pushService.getVapidPublicKey()).resolves.toBe(VAPID_KEY);

    expect(requestsTo(fetchMock, '/push/vapid-public-key')).toHaveLength(1);
  });

  it.each([
    ['the request was unsuccessful', { success: false, publicKey: VAPID_KEY, keyId: 'k1' }],
    ['the key is missing', { success: true, publicKey: '', keyId: 'k1' }],
  ])('fails when %s', async (_label, vapid) => {
    mockPushApi({ vapid });

    await expect(pushService.getVapidPublicKey()).rejects.toThrow(
      'Failed to fetch VAPID public key'
    );
  });
});

describe('pushService.subscribe', () => {
  it('subscribes the browser and registers the subscription with the backend', async () => {
    const { pushManager } = stubPushEnvironment();
    const fetchMock = mockPushApi();
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36'
    );

    await expect(pushService.subscribe()).resolves.toEqual({ success: true, subscription_id: 12 });

    expect(pushManager.subscribe).toHaveBeenCalledTimes(1);
    const options = pushManager.subscribe.mock.calls[0][0];
    expect(options.userVisibleOnly).toBe(true);
    expect([...new Uint8Array(options.applicationServerKey)]).toEqual([1, 15, 191]);

    const [, init] = requestsTo(fetchMock, '/push/subscriptions')[0];
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      subscription: { endpoint: ENDPOINT, keys: { p256dh: '-_8AAQ', auth: 'AQID' } },
      device: {
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36',
        browser: 'chrome',
        platform: 'windows',
      },
    });
  });

  it.each([
    ['Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0', 'firefox', 'linux'],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/130.0 Safari/537.36 Edg/130.0',
      'edge',
      'macos',
    ],
    [
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/130.0 Mobile Safari/537.36',
      'chrome',
      'android',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile/15E148 Safari/604.1',
      'safari',
      'ios',
    ],
    ['Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) Safari/604.1', 'safari', 'ios'],
    ['CustomAgent/1.0', 'unknown', 'unknown'],
  ])('reports the device for "%s"', async (userAgent, browser, platform) => {
    stubPushEnvironment();
    const fetchMock = mockPushApi();
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);

    await pushService.subscribe();

    const [, init] = requestsTo(fetchMock, '/push/subscriptions')[0];
    expect(JSON.parse(String(init?.body)).device).toEqual({ userAgent, browser, platform });
  });

  it('pads URL-safe VAPID keys before decoding them', async () => {
    const { pushManager } = stubPushEnvironment();
    mockPushApi({ vapid: { success: true, publicKey: 'AQ', keyId: 'k1' } });

    await pushService.subscribe();

    const options = pushManager.subscribe.mock.calls[0][0];
    expect([...new Uint8Array(options.applicationServerKey)]).toEqual([1]);
  });

  it('asks for permission first when the user has not decided yet', async () => {
    const { requestPermission, pushManager } = stubPushEnvironment({ permission: 'default' });
    mockPushApi();

    await expect(pushService.subscribe()).resolves.toMatchObject({ success: true });

    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(pushManager.subscribe).toHaveBeenCalledTimes(1);
  });

  it.each<NotificationPermission>(['denied', 'default'])(
    'stops when the permission prompt ends with "%s"',
    async (requestResult) => {
      const { pushManager } = stubPushEnvironment({ permission: 'default', requestResult });
      const fetchMock = mockPushApi();

      await expect(pushService.subscribe()).rejects.toThrow('Notification permission not granted');

      expect(pushManager.subscribe).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it('does not prompt again once permission was denied', async () => {
    const { requestPermission } = stubPushEnvironment({ permission: 'denied' });

    await expect(pushService.subscribe()).rejects.toThrow('Notification permission denied');
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('fails in unsupported browsers', async () => {
    await expect(pushService.subscribe()).rejects.toThrow('Push notifications are not supported');
  });

  it('rejects a browser subscription without encryption keys', async () => {
    stubPushEnvironment({ created: makeSubscription({ withKeys: false }) });
    const fetchMock = mockPushApi();

    await expect(pushService.subscribe()).rejects.toThrow(
      'Invalid push subscription: missing keys'
    );
    expect(requestsTo(fetchMock, '/push/subscriptions')).toHaveLength(0);
  });

  it('surfaces backend registration failures', async () => {
    stubPushEnvironment();
    mockFetch((url) =>
      url.endsWith('/push/vapid-public-key')
        ? jsonResponse({ success: true, publicKey: VAPID_KEY, keyId: 'k1' })
        : jsonResponse({ error: 'Too many devices' }, { status: 400 })
    );

    await expect(pushService.subscribe()).rejects.toThrow('Too many devices');
  });

  it('replaces a subscription another account registered, and registers the new one', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const stale = makeSubscription();
    const fresh = makeSubscription({ endpoint: FRESH_ENDPOINT });
    const { pushManager } = stubPushEnvironment();
    pushManager.subscribe.mockResolvedValueOnce(stale).mockResolvedValueOnce(fresh);
    const { endpoints } = mockRegistrations({ conflicts: 1 });

    await expect(pushService.subscribe()).resolves.toMatchObject({ success: true });

    expect(endpoints).toEqual([ENDPOINT, FRESH_ENDPOINT]);
    expect(stale.unsubscribe).toHaveBeenCalledTimes(1);
    // The stale subscription is dropped first, so the browser creates a new endpoint
    expect(stale.unsubscribe.mock.invocationCallOrder[0]).toBeLessThan(
      pushManager.subscribe.mock.invocationCallOrder[1]
    );
    expect(fresh.unsubscribe).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(
      '[Push] Replacing a subscription registered to another account'
    );
  });

  it('tries the fresh subscription only once', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { pushManager } = stubPushEnvironment();
    pushManager.subscribe
      .mockResolvedValueOnce(makeSubscription())
      .mockResolvedValueOnce(makeSubscription({ endpoint: FRESH_ENDPOINT }));
    const { endpoints } = mockRegistrations({ conflicts: 2 });

    await expect(pushService.subscribe()).rejects.toMatchObject({
      statusCode: 409,
      message: 'Endpoint already registered to another user',
    });

    expect(endpoints).toEqual([ENDPOINT, FRESH_ENDPOINT]);
    expect(pushManager.subscribe).toHaveBeenCalledTimes(2);
  });
});

/** Answers the VAPID key and registrations; the first `conflicts` registrations get a 409. */
function mockRegistrations({ conflicts }: { conflicts: number }) {
  const endpoints: string[] = [];
  const fetchMock = mockFetch((url, init) => {
    if (url === `${BASE_URL}/push/vapid-public-key`) {
      return jsonResponse({ success: true, publicKey: VAPID_KEY, keyId: 'k1' });
    }
    if (url === `${BASE_URL}/push/subscriptions` && init?.method === 'POST') {
      endpoints.push(JSON.parse(String(init.body)).subscription.endpoint);
      return endpoints.length <= conflicts
        ? jsonResponse(CONFLICT, { status: 409 })
        : jsonResponse({ success: true, message: 'Subscription registered successfully' });
    }
    return undefined;
  });
  return { fetchMock, endpoints };
}

describe('pushService.unsubscribe', () => {
  it('unregisters the subscription from the backend, then from the browser', async () => {
    const existing = makeSubscription();
    stubPushEnvironment({ existing });
    const fetchMock = mockPushApi();

    await expect(pushService.unsubscribe()).resolves.toEqual({
      success: true,
      message: 'Unsubscribed successfully',
    });

    const [, init] = requestsTo(fetchMock, '/push/subscriptions')[0];
    expect(init?.method).toBe('DELETE');
    expect(JSON.parse(String(init?.body))).toEqual({ endpoint: ENDPOINT });
    expect(existing.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('still unsubscribes the browser when the backend call fails', async () => {
    const existing = makeSubscription();
    stubPushEnvironment({ existing });
    mockFetch(() => jsonResponse({ error: 'Server error' }, { status: 500 }));

    await expect(pushService.unsubscribe()).resolves.toMatchObject({ success: true });
    expect(existing.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('succeeds without contacting the backend when there is no subscription', async () => {
    const { pushManager } = stubPushEnvironment({ existing: null });
    const fetchMock = mockPushApi();

    await expect(pushService.getExistingSubscription()).resolves.toBeNull();
    await expect(pushService.unsubscribe()).resolves.toMatchObject({ success: true });

    expect(pushManager.getSubscription).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('pushService.confirmSubscription', () => {
  it('registers the browser’s existing subscription again for the signed-in user', async () => {
    const existing = makeSubscription();
    const fetchMock = mockPushApi();

    await expect(pushService.confirmSubscription(asPushSubscription(existing))).resolves.toBe(
      'registered'
    );

    const [, init] = requestsTo(fetchMock, '/push/subscriptions')[0];
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body)).subscription).toEqual({
      endpoint: ENDPOINT,
      keys: { p256dh: '-_8AAQ', auth: 'AQID' },
    });
    expect(existing.unsubscribe).not.toHaveBeenCalled();
  });

  it('removes a subscription that another account registered', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const existing = makeSubscription();
    mockFetch(() => jsonResponse(CONFLICT, { status: 409 }));

    await expect(pushService.confirmSubscription(asPushSubscription(existing))).resolves.toBe(
      'removed'
    );

    expect(existing.unsubscribe).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      '[Push] This browser was subscribed for another account; removing it'
    );
  });

  it('reports the subscription removed even if the browser fails to drop it', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const existing = makeSubscription();
    const failure = new Error('Unsubscribe failed');
    existing.unsubscribe.mockRejectedValue(failure);
    mockFetch(() => jsonResponse(CONFLICT, { status: 409 }));

    await expect(pushService.confirmSubscription(asPushSubscription(existing))).resolves.toBe(
      'removed'
    );

    expect(warn).toHaveBeenCalledWith(
      '[Push] Could not remove the other account’s subscription',
      failure
    );
  });

  it.each([
    [
      'offline',
      () => vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))),
    ],
    [
      'a server error',
      () => mockFetch(() => jsonResponse({ error: 'Database error' }, { status: 500 })),
    ],
  ])('leaves the subscription alone when the server cannot confirm it (%s)', async (_, fail) => {
    const existing = makeSubscription();
    fail();

    await expect(pushService.confirmSubscription(asPushSubscription(existing))).resolves.toBe(
      'unchecked'
    );

    expect(existing.unsubscribe).not.toHaveBeenCalled();
  });
});

describe('pushService.unregisterDevice', () => {
  it('tells the server with the given token, then removes the browser subscription', async () => {
    const existing = makeSubscription();
    stubPushEnvironment({ existing });
    const fetchMock = mockPushApi();

    await expect(pushService.unregisterDevice('jwt-alice')).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(`${BASE_URL}/push/subscriptions`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer jwt-alice' },
      body: JSON.stringify({ endpoint: ENDPOINT }),
      keepalive: true,
    });
    expect(existing.unsubscribe).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.invocationCallOrder[0]).toBeLessThan(
      existing.unsubscribe.mock.invocationCallOrder[0]
    );
  });

  it('still removes the browser subscription when the server cannot be reached', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const existing = makeSubscription();
    stubPushEnvironment({ existing });
    const offline = new TypeError('Failed to fetch');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(offline));

    await expect(pushService.unregisterDevice('jwt-alice')).resolves.toBeUndefined();

    expect(existing.unsubscribe).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '[Push] Could not reach the server to unregister this device',
      offline
    );
  });

  it('bypasses the app’s 401 handling and still removes the subscription', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const existing = makeSubscription();
    stubPushEnvironment({ existing });
    mockFetch(() => jsonResponse({ error: 'Unauthorized' }, { status: 401 }));
    // apiClient's 401 handling would clear these and reload the app
    localStorage.setItem(STORAGE_KEYS.USERNAME, 'alice');

    await pushService.unregisterDevice('expired-jwt');

    expect(existing.unsubscribe).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(STORAGE_KEYS.USERNAME)).toBe('alice');
    expect(warn).toHaveBeenCalledWith('[Push] Server did not unregister this device', {
      status: 401,
    });
  });

  it('only removes the browser subscription when no token is left', async () => {
    const existing = makeSubscription();
    stubPushEnvironment({ existing });
    const fetchMock = mockPushApi();

    await pushService.unregisterDevice(null);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(existing.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('has nothing to do when the browser holds no subscription', async () => {
    const { pushManager } = stubPushEnvironment({ existing: null });
    const fetchMock = mockPushApi();

    await expect(pushService.unregisterDevice('jwt-alice')).resolves.toBeUndefined();

    expect(pushManager.getSubscription).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not wait for a service worker that is not installed', async () => {
    const { serviceWorker } = stubPushEnvironment({ serviceWorkerInstalled: false });
    const fetchMock = mockPushApi();

    await expect(pushService.unregisterDevice('jwt-alice')).resolves.toBeUndefined();

    expect(serviceWorker.getRegistration).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does nothing in browsers without Web Push', async () => {
    const fetchMock = mockPushApi();

    await expect(pushService.unregisterDevice('jwt-alice')).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never throws, even when the browser fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { serviceWorker } = stubPushEnvironment();
    const failure = new Error('SecurityError');
    serviceWorker.getRegistration.mockRejectedValue(failure);

    await expect(pushService.unregisterDevice('jwt-alice')).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      '[Push] Could not remove this device’s push subscription',
      failure
    );
  });
});

describe('pushService preferences and test notification', () => {
  it('loads the push preferences', async () => {
    const preferences = { push_enabled: true, preferences: { like_received: false } };
    const fetchMock = mockFetch(() => jsonResponse({ success: true, preferences }));

    await expect(pushService.getPreferences()).resolves.toEqual({ success: true, preferences });
    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE_URL}/push/preferences`,
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('saves preference updates', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ success: true }));

    await pushService.updatePreferences({ quiet_hours_enabled: true, quiet_start: '22:00' });

    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE_URL}/push/preferences`,
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ quiet_hours_enabled: true, quiet_start: '22:00' }),
      })
    );
  });

  it('shows a local test notification through the service worker', async () => {
    const { registration } = stubPushEnvironment();

    await pushService.sendTestNotification();

    expect(registration.showNotification).toHaveBeenCalledWith('Test Notification', {
      body: 'Push notifications are working!',
      icon: '/pwa-192x192.png',
      badge: '/badge-96x96.png',
      tag: 'test',
      data: { url: '/' },
    });
  });
});
