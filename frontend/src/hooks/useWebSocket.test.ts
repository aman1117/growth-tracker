import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { STORAGE_KEYS } from '../constants/storage';
import { makeNotification } from '../test/fixtures/core';

/** Browser-like WebSocket double: tests decide when the socket opens, talks and closes. */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  send = vi.fn();
  /** Like a browser, close() only starts the closing handshake; the event comes later. */
  close = vi.fn(() => {
    this.readyState = FakeWebSocket.CLOSING;
  });

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  receive(message: unknown) {
    const data = typeof message === 'string' ? message : JSON.stringify(message);
    this.onmessage?.(new MessageEvent('message', { data }));
  }

  /** The connection drops (server restart, network change, or the end of close()). */
  closed(code = 1006, reason = '') {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason } as CloseEvent);
  }

  fail() {
    this.onerror?.(new Event('error'));
  }
}

/** Makes the next `new WebSocket()` throw (e.g. blocked by a policy) when `failNext` is set. */
function stubFlakyWebSocket({ failNext = false } = {}) {
  const control = { failNext };
  class FlakyWebSocket extends FakeWebSocket {
    constructor(url: string) {
      if (control.failNext) {
        control.failNext = false;
        throw new Error('Blocked by policy');
      }
      super(url);
    }
  }
  vi.stubGlobal('WebSocket', FlakyWebSocket);
  return control;
}

const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000];
const POLL_MS = 30_000;

let useWebSocket: typeof import('./useWebSocket').useWebSocket;
let useWebSocketDefault: typeof import('./useWebSocket').default;
let useNotificationStore: typeof import('../store/useNotificationStore').useNotificationStore;
let useFollowStore: typeof import('../store/useFollowStore').useFollowStore;
let useNotificationPreviewStore: typeof import('../store/useNotificationPreviewStore').useNotificationPreviewStore;
let fetchUnreadCount: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  // The hook keeps a module-level socket singleton: load a fresh module graph per test.
  vi.resetModules();
  ({ useWebSocket, default: useWebSocketDefault } = await import('./useWebSocket'));
  ({ useNotificationStore } = await import('../store/useNotificationStore'));
  ({ useFollowStore } = await import('../store/useFollowStore'));
  ({ useNotificationPreviewStore } = await import('../store/useNotificationPreviewStore'));
  fetchUnreadCount = vi.fn().mockResolvedValue(undefined);
  useNotificationStore.setState({ fetchUnreadCount });
});

const signIn = (token = 'header.payload.signature') =>
  localStorage.setItem(STORAGE_KEYS.ACCESS_TOKEN, token);

function socket(index = -1) {
  const instance = FakeWebSocket.instances.at(index);
  if (!instance) throw new Error(`No WebSocket at index ${index}`);
  return instance;
}

type Options = Parameters<typeof useWebSocket>[0];

function renderSocket(options?: Options) {
  return renderHook((props?: Options) => useWebSocket(props), { initialProps: options });
}

const receive = (message: unknown, target = socket()) => act(() => target.receive(message));

function handshake(target = socket()) {
  act(() => target.open());
  receive({ type: 'connected', payload: { connection_id: 'conn-1', user_id: 1 } }, target);
}

const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

function goOffline() {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
}

describe('useWebSocket', () => {
  describe('connecting', () => {
    it('opens the notification socket with the access token', () => {
      signIn('a token/with+chars');

      const { result } = renderSocket();

      expect(FakeWebSocket.instances).toHaveLength(1);
      expect(socket().url).toBe(
        'ws://localhost:8000/api/ws/notifications?token=a%20token%2Fwith%2Bchars'
      );
      expect(result.current).toMatchObject({
        status: 'connecting',
        isConnecting: true,
        isConnected: false,
        isReconnecting: false,
      });
      expect(fetchUnreadCount).toHaveBeenCalledTimes(1);
    });

    it('reports connected after the server handshake, not when the socket opens', () => {
      signIn();
      const { result } = renderSocket();

      act(() => socket().open());
      expect(result.current.status).toBe('connecting');

      receive({ type: 'connected', payload: { connection_id: 'conn-1', user_id: 1 } });
      expect(result.current).toMatchObject({ status: 'connected', isConnected: true });
      expect(useNotificationStore.getState().wsStatus).toBe('connected');
    });

    it('does not connect without an access token', () => {
      const { result } = renderSocket();

      expect(FakeWebSocket.instances).toHaveLength(0);
      expect(result.current.status).toBe('disconnected');
      expect(console.log).toHaveBeenCalledWith('[WS] No auth token, skipping connection');
    });

    it('does nothing while disabled', () => {
      signIn();

      renderSocket({ enabled: false });

      expect(FakeWebSocket.instances).toHaveLength(0);
      expect(fetchUnreadCount).not.toHaveBeenCalled();
    });

    it('shares one connection between hook instances', () => {
      signIn();
      renderSocket();
      handshake();

      const second = renderSocket();

      expect(FakeWebSocket.instances).toHaveLength(1);
      expect(second.result.current.isConnected).toBe(true);
      expect(console.log).toHaveBeenCalledWith('[WS] Using existing global connection');
    });

    it('does not start a second attempt while one is still in progress', () => {
      signIn();
      renderSocket();
      // The first socket failed before reporting anything: the attempt is still "in progress".
      socket().readyState = FakeWebSocket.CLOSED;

      renderSocket();

      expect(FakeWebSocket.instances).toHaveLength(1);
      expect(console.log).toHaveBeenCalledWith('[WS] Connection already in progress, skipping');
    });

    it('replaces a dead global socket and ignores its late close event', () => {
      vi.useFakeTimers();
      signIn();
      renderSocket();
      const stale = socket();
      act(() => stale.open());
      stale.readyState = FakeWebSocket.CLOSED;

      const { result } = renderSocket();
      act(() => stale.closed());
      advance(30_000);

      expect(stale.close).toHaveBeenCalledTimes(1);
      expect(FakeWebSocket.instances).toHaveLength(2);
      expect(result.current.status).toBe('connecting');
    });

    it('logs socket errors', () => {
      signIn();
      renderSocket();

      act(() => socket().fail());

      expect(console.error).toHaveBeenCalledWith('[WS] Connection error:', expect.any(Event));
    });

    it('is also the default export', () => {
      expect(useWebSocketDefault).toBe(useWebSocket);
    });
  });

  describe('messages', () => {
    beforeEach(() => {
      signIn();
      renderSocket();
    });

    it('adds new notifications to the store and shows a preview', () => {
      const notification = makeNotification({ id: 7 });

      receive({ type: 'notification', payload: notification });

      expect(useNotificationStore.getState()).toMatchObject({
        notifications: [notification],
        unreadCount: 1,
      });
      expect(useNotificationPreviewStore.getState().preview).toEqual(notification);
    });

    it.each([
      ['a numeric', 42],
      ['a string', '42'],
    ])('marks the actor of an accepted follow request (%s id) as followed', (_kind, actorId) => {
      const onFollowAccepted = vi.fn();
      window.addEventListener('follow-accepted', onFollowAccepted);

      receive({
        type: 'notification',
        payload: makeNotification({
          type: 'follow_accepted',
          metadata: { actor_id: actorId, actor_username: 'bob' },
        }),
      });

      expect(useFollowStore.getState().relationships['42']).toEqual({
        following: true,
        followed_by: true,
        pending: false,
        incoming_pending: false,
        is_mutual: true,
      });
      expect(onFollowAccepted).toHaveBeenCalledTimes(1);
      expect(onFollowAccepted.mock.calls[0][0].detail).toEqual({
        actorId: 42,
        actorUsername: 'bob',
      });
      window.removeEventListener('follow-accepted', onFollowAccepted);
    });

    it.each([
      ['an unparsable actor id', { actor_id: 'not-a-number', actor_username: 'bob' }],
      ['no actor metadata', null],
    ])('ignores follow acceptances with %s', (_label, metadata) => {
      const onFollowAccepted = vi.fn();
      window.addEventListener('follow-accepted', onFollowAccepted);

      receive({
        type: 'notification',
        payload: makeNotification({ type: 'follow_accepted', metadata }),
      });

      expect(useFollowStore.getState().relationships).toEqual({});
      expect(onFollowAccepted).not.toHaveBeenCalled();
      expect(useNotificationStore.getState().unreadCount).toBe(1);
      window.removeEventListener('follow-accepted', onFollowAccepted);
    });

    it('merges notifications delivered while offline, newest first', () => {
      const older = makeNotification({ id: 1, created_at: '2026-10-19T08:00:00.000Z' });
      const newer = makeNotification({ id: 2, created_at: '2026-10-20T08:00:00.000Z' });

      receive({ type: 'pending_delivery', payload: [older, newer] });

      expect(useNotificationStore.getState().notifications.map((n) => n.id)).toEqual([2, 1]);
      expect(useNotificationStore.getState().unreadCount).toBe(2);
    });

    it('answers heartbeats once the socket is open', () => {
      receive({ type: 'ping' });
      expect(socket().send).not.toHaveBeenCalled();

      act(() => socket().open());
      receive({ type: 'ping' });

      expect(socket().send).toHaveBeenCalledWith(JSON.stringify({ type: 'pong' }));
    });

    it('logs server errors, unknown types and malformed messages without crashing', () => {
      receive({ type: 'error', payload: { message: 'rate limited' } });
      receive({ type: 'mystery' });
      receive('not json');

      expect(console.error).toHaveBeenCalledWith('[WS] Server error:', { message: 'rate limited' });
      expect(console.log).toHaveBeenCalledWith('[WS] Unknown message type:', 'mystery');
      expect(console.error).toHaveBeenCalledWith(
        '[WS] Failed to parse message:',
        expect.any(SyntaxError)
      );
    });
  });

  describe('reconnecting', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      signIn();
    });

    it('reconnects with exponential backoff capped at 30 seconds', () => {
      const { result } = renderSocket();

      BACKOFF_MS.slice(0, 7).forEach((delay, attempt) => {
        act(() => socket().closed());
        expect(result.current.isReconnecting).toBe(true);

        advance(delay - 1);
        expect(FakeWebSocket.instances).toHaveLength(attempt + 1);

        advance(1);
        expect(FakeWebSocket.instances).toHaveLength(attempt + 2);
        expect(socket().url).toBe(socket(0).url);
      });
    });

    it('starts the backoff over after a successful handshake', () => {
      renderSocket();
      act(() => socket().closed());
      advance(1000);
      act(() => socket().closed());
      advance(2000);
      handshake();

      act(() => socket().closed());
      advance(1000);

      expect(FakeWebSocket.instances).toHaveLength(4);
    });

    it('falls back to polling the unread count after 10 failed attempts', () => {
      renderSocket();
      BACKOFF_MS.forEach((delay) => {
        act(() => socket().closed());
        advance(delay);
      });
      expect(FakeWebSocket.instances).toHaveLength(11);
      fetchUnreadCount.mockClear();

      act(() => socket().closed());

      expect(console.log).toHaveBeenCalledWith(
        '[WS] Max reconnection attempts reached, switching to polling'
      );
      expect(fetchUnreadCount).toHaveBeenCalledTimes(1);
      advance(POLL_MS);
      expect(fetchUnreadCount).toHaveBeenCalledTimes(2);
    });

    it('stays on polling after the last retry instead of starting over', () => {
      renderSocket();
      BACKOFF_MS.forEach((delay) => {
        act(() => socket().closed());
        advance(delay);
      });

      act(() => socket().closed());
      advance(60_000);

      expect(FakeWebSocket.instances).toHaveLength(11);
      expect(useNotificationStore.getState().wsStatus).toBe('disconnected');
    });

    it('backs off and retries when a socket cannot even be created', () => {
      const flaky = stubFlakyWebSocket();
      const { result } = renderSocket();

      flaky.failNext = true;
      act(() => socket().closed());
      advance(1000);

      expect(console.error).toHaveBeenCalledWith(
        '[WS] Failed to create connection:',
        expect.any(Error)
      );
      expect(result.current.status).toBe('reconnecting');
      expect(FakeWebSocket.instances).toHaveLength(1);

      advance(2000);
      expect(FakeWebSocket.instances).toHaveLength(2);
    });

    it('waits for the backoff when the very first socket cannot be created', () => {
      stubFlakyWebSocket({ failNext: true });

      const { result } = renderSocket();

      expect(result.current.status).toBe('reconnecting');
      expect(FakeWebSocket.instances).toHaveLength(0);
      advance(1000);
      expect(FakeWebSocket.instances).toHaveLength(1);
    });
  });

  describe('offline', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      signIn();
    });

    it('polls the unread count instead of connecting', () => {
      goOffline();

      const { result } = renderSocket();

      expect(FakeWebSocket.instances).toHaveLength(0);
      expect(result.current.status).toBe('disconnected');
      // Once on mount and once when polling starts.
      expect(fetchUnreadCount).toHaveBeenCalledTimes(2);
      advance(POLL_MS);
      expect(fetchUnreadCount).toHaveBeenCalledTimes(3);
    });

    it('does not poll when the fallback is disabled', () => {
      goOffline();

      renderSocket({ enableFallbackPolling: false });
      advance(POLL_MS);

      expect(fetchUnreadCount).toHaveBeenCalledTimes(1);
    });

    it('connects and stops polling when the network comes back', () => {
      goOffline();
      renderSocket();
      const callsWhileOffline = fetchUnreadCount.mock.calls.length;

      vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
      act(() => {
        window.dispatchEvent(new Event('online'));
      });

      expect(FakeWebSocket.instances).toHaveLength(1);
      advance(POLL_MS);
      expect(fetchUnreadCount).toHaveBeenCalledTimes(callsWhileOffline);
    });

    it('does not open new sockets while offline', () => {
      renderSocket();
      goOffline();
      act(() => {
        window.dispatchEvent(new Event('offline'));
      });

      act(() => socket().closed());
      advance(60_000);

      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    it('reports disconnected, not reconnecting, while offline and reconnects when back online', () => {
      const { result } = renderSocket();
      handshake();
      goOffline();
      act(() => {
        window.dispatchEvent(new Event('offline'));
      });

      // Browsers often notice the dropped socket only after announcing that they are offline.
      act(() => socket().closed());
      advance(60_000);

      expect(result.current).toMatchObject({ status: 'disconnected', isReconnecting: false });
      expect(FakeWebSocket.instances).toHaveLength(1);

      vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
      act(() => {
        window.dispatchEvent(new Event('online'));
      });
      expect(result.current.status).toBe('connecting');
      handshake();
      expect(result.current.status).toBe('connected');
    });

    it('also settles on disconnected when the drop is noticed before the offline event', () => {
      const { result } = renderSocket();
      handshake();

      act(() => socket().closed());
      expect(result.current.status).toBe('reconnecting');
      goOffline();
      act(() => {
        window.dispatchEvent(new Event('offline'));
      });
      advance(60_000);

      expect(result.current.status).toBe('disconnected');
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    it('reconnects right away and restarts the backoff when the network comes back', () => {
      renderSocket();
      act(() => socket().closed());
      advance(1000);
      act(() => socket().closed());
      goOffline();
      act(() => {
        window.dispatchEvent(new Event('offline'));
      });
      // The pending 2s retry fires while offline and is skipped.
      advance(2000);
      expect(FakeWebSocket.instances).toHaveLength(2);

      vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
      act(() => {
        window.dispatchEvent(new Event('online'));
      });

      expect(console.log).toHaveBeenCalledWith('[WS] Network restored, reconnecting...');
      expect(FakeWebSocket.instances).toHaveLength(3);
      act(() => socket().closed());
      advance(1000);
      expect(FakeWebSocket.instances).toHaveLength(4);
    });
  });

  describe('lifecycle', () => {
    it('keeps the shared connection open when unmounted while signed in (StrictMode, hidden bell)', () => {
      signIn();
      const { unmount } = renderSocket();

      unmount();

      expect(socket().close).not.toHaveBeenCalled();
    });

    it('closes the socket when sign-out unmounts the notification bell', () => {
      signIn('first-user-token');
      const { unmount } = renderSocket();
      const firstUserSocket = socket();
      handshake(firstUserSocket);

      // logout() clears the token, then the header drops the bell in the same commit.
      localStorage.removeItem(STORAGE_KEYS.ACCESS_TOKEN);
      unmount();

      expect(firstUserSocket.close).toHaveBeenCalledTimes(1);
      expect(useNotificationStore.getState().wsStatus).toBe('disconnected');

      signIn('second-user-token');
      renderSocket();
      expect(FakeWebSocket.instances).toHaveLength(2);
      expect(socket().url).toContain('token=second-user-token');
    });

    it('closes the socket when disabled (sign-out) and connects the next user with their own token', () => {
      vi.useFakeTimers();
      signIn('first-user-token');
      const { rerender } = renderSocket({ enabled: true });
      const firstUserSocket = socket();
      handshake(firstUserSocket);

      localStorage.removeItem(STORAGE_KEYS.ACCESS_TOKEN);
      rerender({ enabled: false });
      expect(firstUserSocket.close).toHaveBeenCalledTimes(1);
      expect(useNotificationStore.getState().wsStatus).toBe('disconnected');

      signIn('second-user-token');
      rerender({ enabled: true });
      // The first user's socket finishes closing only now.
      act(() => firstUserSocket.closed(1000));
      advance(30_000);

      expect(FakeWebSocket.instances).toHaveLength(2);
      expect(socket().url).toContain('token=second-user-token');
      expect(useNotificationStore.getState().wsStatus).toBe('connecting');
    });

    it('stops polling on unmount', () => {
      vi.useFakeTimers();
      signIn();
      goOffline();
      const { unmount } = renderSocket();
      const calls = fetchUnreadCount.mock.calls.length;

      unmount();
      advance(POLL_MS * 2);

      expect(fetchUnreadCount).toHaveBeenCalledTimes(calls);
    });

    it('disconnect() closes the socket', () => {
      signIn();
      const { result } = renderSocket();
      const current = socket();
      handshake(current);

      act(() => result.current.disconnect());

      expect(current.close).toHaveBeenCalledTimes(1);
    });

    it('disconnect() stops fallback polling', () => {
      vi.useFakeTimers();
      signIn();
      goOffline();
      const { result } = renderSocket();
      const calls = fetchUnreadCount.mock.calls.length;

      act(() => result.current.disconnect());
      advance(POLL_MS * 2);

      expect(fetchUnreadCount).toHaveBeenCalledTimes(calls);
      expect(result.current.status).toBe('disconnected');
    });

    it('stays disconnected after disconnect()', () => {
      signIn();
      const { result } = renderSocket();
      handshake();

      act(() => result.current.disconnect());

      expect(FakeWebSocket.instances).toHaveLength(1);
      expect(result.current.status).toBe('disconnected');
    });

    it('cancels a pending reconnect on disconnect()', () => {
      vi.useFakeTimers();
      signIn();
      const { result } = renderSocket();
      act(() => socket().closed());

      act(() => result.current.disconnect());
      advance(30_000);

      expect(FakeWebSocket.instances).toHaveLength(1);
      expect(result.current.status).toBe('disconnected');
    });

    it('treats the close event that follows disconnect() as final', () => {
      vi.useFakeTimers();
      signIn();
      const { result } = renderSocket();
      const current = socket();
      handshake(current);
      act(() => result.current.disconnect());

      act(() => current.closed(1000));
      advance(30_000);

      expect(FakeWebSocket.instances).toHaveLength(1);
      expect(result.current.status).toBe('disconnected');
    });

    it('reconnect() replaces the socket with a fresh one', () => {
      signIn();
      const { result } = renderSocket();
      const previous = socket();
      handshake(previous);

      act(() => result.current.reconnect());

      expect(previous.close).toHaveBeenCalledTimes(1);
      expect(FakeWebSocket.instances).toHaveLength(2);
      expect(socket().url).toBe(previous.url);
      expect(result.current.status).toBe('connecting');
    });

    it('ignores the close event of the socket that reconnect() replaced', () => {
      vi.useFakeTimers();
      signIn();
      const { result } = renderSocket();
      const previous = socket();
      handshake(previous);
      act(() => result.current.reconnect());

      act(() => previous.closed(1000));
      advance(30_000);

      expect(FakeWebSocket.instances).toHaveLength(2);
      expect(result.current.status).toBe('connecting');
    });
  });
});
