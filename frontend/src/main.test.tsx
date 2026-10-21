import { act, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EXTERNAL_NAVIGATE_EVENT } from './utils/navigation';

const stores = vi.hoisted(() => ({
  markAsRead: vi.fn(),
  acceptRequest: vi.fn(),
  declineRequest: vi.fn(),
  checkSupport: vi.fn(),
}));

vi.mock('./App', () => ({ default: () => 'App shell' }));
vi.mock('./store/useNotificationStore', () => ({
  useNotificationStore: { getState: () => ({ markAsRead: stores.markAsRead }) },
}));
vi.mock('./store/useFollowStore', () => ({
  useFollowStore: {
    getState: () => ({
      acceptRequest: stores.acceptRequest,
      declineRequest: stores.declineRequest,
    }),
  },
}));
vi.mock('./store/usePushStore', () => ({
  usePushStore: { getState: () => ({ checkSupport: stores.checkSupport }) },
}));

type MessageHandler = (event: { data?: unknown }) => Promise<void>;

let swAddEventListener: ReturnType<typeof vi.fn>;

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  swAddEventListener = vi.fn();
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { addEventListener: swAddEventListener },
  });
});

afterEach(() => {
  Reflect.deleteProperty(navigator, 'serviceWorker');
  document.body.innerHTML = '';
});

/** Runs the entry point (fresh module per test) and lets React render. */
async function startApp() {
  vi.resetModules();
  await act(async () => {
    await import('./main');
  });
}

async function startAppAndGetMessageHandler(): Promise<MessageHandler> {
  await startApp();
  const registration = swAddEventListener.mock.calls.find(([type]) => type === 'message');
  if (!registration) throw new Error('No service worker message listener was registered');
  return registration[1] as MessageHandler;
}

/** Replaces window.location so a full-page navigation can be observed. */
function stubLocation(pathname: string, search = '') {
  const location = { pathname, search, href: `http://localhost:3000${pathname}${search}` };
  vi.stubGlobal('location', location);
  return location;
}

describe('main entry point', () => {
  it('renders the app into #root', async () => {
    await startApp();

    expect(screen.getByText('App shell')).toBeInTheDocument();
    expect(swAddEventListener).toHaveBeenCalledWith('message', expect.any(Function));
  });

  it('still renders the app in browsers without service workers', async () => {
    Reflect.deleteProperty(navigator, 'serviceWorker');

    await startApp();

    expect(screen.getByText('App shell')).toBeInTheDocument();
    expect(swAddEventListener).not.toHaveBeenCalled();
  });
});

describe('service worker messages', () => {
  describe('MARK_NOTIFICATION_READ', () => {
    it.each([42, 0])('marks notification %i as read', async (id) => {
      const handle = await startAppAndGetMessageHandler();

      await handle({ data: { type: 'MARK_NOTIFICATION_READ', notification_id: id } });

      expect(stores.markAsRead).toHaveBeenCalledWith(id);
    });

    it('ignores the message without a notification id', async () => {
      const handle = await startAppAndGetMessageHandler();

      await handle({ data: { type: 'MARK_NOTIFICATION_READ' } });

      expect(stores.markAsRead).not.toHaveBeenCalled();
    });

    it('fails silently so the notification can sync on the next fetch', async () => {
      stores.markAsRead.mockRejectedValueOnce(new Error('offline'));
      const handle = await startAppAndGetMessageHandler();

      await expect(
        handle({ data: { type: 'MARK_NOTIFICATION_READ', notification_id: 42 } })
      ).resolves.toBeUndefined();
    });
  });

  describe('FOLLOW_REQUEST_ACTION', () => {
    it.each([
      ['accept', stores.acceptRequest, stores.declineRequest],
      ['decline', stores.declineRequest, stores.acceptRequest],
    ])('%ss the request and marks its notification read', async (action, expected, other) => {
      const handle = await startAppAndGetMessageHandler();

      await handle({
        data: { type: 'FOLLOW_REQUEST_ACTION', action, actor_id: 7, notification_id: 42 },
      });

      expect(expected).toHaveBeenCalledWith(7);
      expect(other).not.toHaveBeenCalled();
      expect(stores.markAsRead).toHaveBeenCalledWith(42);
    });

    it('leaves the notification alone when it has no id', async () => {
      const handle = await startAppAndGetMessageHandler();

      await handle({ data: { type: 'FOLLOW_REQUEST_ACTION', action: 'accept', actor_id: 7 } });

      expect(stores.acceptRequest).toHaveBeenCalledWith(7);
      expect(stores.markAsRead).not.toHaveBeenCalled();
    });

    it.each([
      ['an actor', { action: 'accept', notification_id: 42 }],
      ['an action', { actor_id: 7, notification_id: 42 }],
    ])('does nothing without %s', async (_label, data) => {
      const handle = await startAppAndGetMessageHandler();

      await handle({ data: { type: 'FOLLOW_REQUEST_ACTION', ...data } });

      expect(stores.acceptRequest).not.toHaveBeenCalled();
      expect(stores.declineRequest).not.toHaveBeenCalled();
      expect(stores.markAsRead).not.toHaveBeenCalled();
    });

    it('fails silently and keeps the notification unread when the action fails', async () => {
      stores.acceptRequest.mockRejectedValueOnce(new Error('Request no longer exists'));
      const handle = await startAppAndGetMessageHandler();

      await expect(
        handle({
          data: {
            type: 'FOLLOW_REQUEST_ACTION',
            action: 'accept',
            actor_id: 7,
            notification_id: 42,
          },
        })
      ).resolves.toBeUndefined();
      expect(stores.markAsRead).not.toHaveBeenCalled();
    });
  });

  describe('NAVIGATE_TO', () => {
    it('asks the router for an in-app navigation', async () => {
      const handle = await startAppAndGetMessageHandler();
      const onNavigate = vi.fn((event: Event) => event.preventDefault());
      window.addEventListener(EXTERNAL_NAVIGATE_EVENT, onNavigate);

      await handle({ data: { type: 'NAVIGATE_TO', url: '/user/bob?date=2026-10-20' } });
      window.removeEventListener(EXTERNAL_NAVIGATE_EVENT, onNavigate);

      expect(onNavigate).toHaveBeenCalledTimes(1);
      const event = onNavigate.mock.calls[0][0] as CustomEvent;
      expect(event.cancelable).toBe(true);
      expect(event.detail).toEqual({ url: '/user/bob?date=2026-10-20' });
      expect(window.location.pathname).toBe('/');
    });

    it('falls back to a full page load when the router is not mounted', async () => {
      const handle = await startAppAndGetMessageHandler();
      const location = stubLocation('/');

      await handle({ data: { type: 'NAVIGATE_TO', url: '/settings' } });

      expect(location.href).toBe('/settings');
    });

    it.each([
      ['the current page', { url: '/user/bob?tab=photos' }],
      ['no url', {}],
    ])('does nothing for %s', async (_label, data) => {
      const handle = await startAppAndGetMessageHandler();
      const location = stubLocation('/user/bob', '?tab=photos');
      const onNavigate = vi.fn();
      window.addEventListener(EXTERNAL_NAVIGATE_EVENT, onNavigate);

      await handle({ data: { type: 'NAVIGATE_TO', ...data } });
      window.removeEventListener(EXTERNAL_NAVIGATE_EVENT, onNavigate);

      expect(onNavigate).not.toHaveBeenCalled();
      expect(location.href).toBe('http://localhost:3000/user/bob?tab=photos');
    });
  });

  describe('PUSH_SUBSCRIPTION_CHANGED', () => {
    it('re-checks push support', async () => {
      const handle = await startAppAndGetMessageHandler();

      await handle({ data: { type: 'PUSH_SUBSCRIPTION_CHANGED' } });

      expect(stores.checkSupport).toHaveBeenCalledTimes(1);
    });

    it('fails silently', async () => {
      stores.checkSupport.mockImplementationOnce(() => {
        throw new Error('Push unavailable');
      });
      const handle = await startAppAndGetMessageHandler();

      await expect(
        handle({ data: { type: 'PUSH_SUBSCRIPTION_CHANGED' } })
      ).resolves.toBeUndefined();
    });
  });

  it.each([
    ['an unknown message type', { data: { type: 'SOMETHING_ELSE', notification_id: 42 } }],
    ['a message without data', {}],
  ])('ignores %s', async (_label, event) => {
    const handle = await startAppAndGetMessageHandler();

    await expect(handle(event)).resolves.toBeUndefined();

    Object.values(stores).forEach((action) => expect(action).not.toHaveBeenCalled());
  });
});
