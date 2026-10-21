/**
 * Fixtures for the app-shell suites: stores, routing shell, layout and auth screens.
 */
import { act, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactElement, useEffect } from 'react';
import {
  type InitialEntry,
  MemoryRouter,
  type NavigateFunction,
  type NavigateOptions,
  type To,
  useLocation,
  useNavigate,
} from 'react-router-dom';

import { useAuthStore } from '../../store/useAuthStore';
import type { Comment } from '../../types/comment';
import type { FollowUser, RelationshipState } from '../../types/follow';
import type { Notification } from '../../types/notification';
import type { PushPreferences } from '../../types/push';

// ==================== Auth ====================

/** Builds an unsigned JWT whose payload is `payload`, base64url-encoded like a real token. */
export function tokenWith(payload: Record<string, unknown>): string {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const base64 = btoa(String.fromCharCode(...bytes));
  const base64url = base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `header.${base64url}.signature`;
}

/** Current time as a JWT `exp`/`iat` value (seconds since the epoch). */
export const nowInSeconds = () => Math.floor(Date.now() / 1000);

/**
 * Marks auth as resolved with nobody signed in. The auth store's initial state is
 * "still loading", which makes route guards render a spinner.
 */
export function signOut(): void {
  useAuthStore.setState({ user: null, isAuthenticated: false, isLoading: false });
}

// ==================== Async control ====================

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

/** A promise that the test settles explicitly, to observe loading/optimistic states. */
export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ==================== Data builders ====================

export function makeComment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: 1,
    day_owner_id: 10,
    day_date: '2024-03-01',
    author_id: 20,
    author_username: 'bob',
    author_verified: false,
    body: 'Nice work!',
    like_count: 0,
    reply_count: 0,
    is_deleted: false,
    is_edited: false,
    liked_by_me: false,
    mentions: [],
    created_at: '2024-03-01T10:00:00Z',
    ...overrides,
  };
}

export function makeNotification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: 1,
    type: 'like_received',
    title: 'New like',
    body: 'bob liked your day',
    metadata: null,
    read_at: null,
    created_at: '2024-03-01T10:00:00Z',
    ...overrides,
  };
}

export function makeRelationship(overrides: Partial<RelationshipState> = {}): RelationshipState {
  return {
    following: false,
    followed_by: false,
    pending: false,
    incoming_pending: false,
    is_mutual: false,
    ...overrides,
  };
}

export function makeFollowUser(overrides: Partial<FollowUser> = {}): FollowUser {
  return {
    id: 2,
    username: 'bob',
    is_verified: false,
    is_private: false,
    ...overrides,
  };
}

export function makePushPreferences(overrides: Partial<PushPreferences> = {}): PushPreferences {
  return {
    push_enabled: true,
    preferences: { like_received: true, badge_unlocked: true },
    quiet_hours_enabled: false,
    quiet_start: null,
    quiet_end: null,
    timezone: 'Europe/Berlin',
    ...overrides,
  };
}

// ==================== Routing ====================

interface RenderWithHistoryOptions {
  /** History entries, e.g. `['/', { pathname: '/login', state: { from: '/settings' } }]` */
  entries: InitialEntry[];
  /** Index of the current entry (defaults to the last one) */
  index?: number;
}

/**
 * Like `renderWithRouter`, but starts from several history entries and/or location state.
 * The hidden `location` probe also exposes `location.state` as JSON in `data-state`.
 */
export function renderWithHistory(
  ui: ReactElement,
  { entries, index = entries.length - 1 }: RenderWithHistoryOptions
) {
  const user = userEvent.setup();
  const result = render(
    <MemoryRouter initialEntries={entries} initialIndex={index}>
      {ui}
      <HistoryProbe />
    </MemoryRouter>
  );
  return { user, ...result };
}

function HistoryProbe() {
  const location = useLocation();
  return (
    <span data-testid="location" data-state={JSON.stringify(location.state ?? null)} hidden>
      {location.pathname + location.search}
    </span>
  );
}

function NavigateCapture({ onReady }: { onReady: (navigate: NavigateFunction) => void }) {
  const navigate = useNavigate();
  useEffect(() => onReady(navigate), [navigate, onReady]);
  return null;
}

/**
 * Programmatic navigation for router tests (push, replace, Back/Forward). Render
 * `navigator.element` inside the router, then call `navigator.go('/path')` or `go(-1)`.
 */
export function createNavigator() {
  let navigate: NavigateFunction | undefined;
  const onReady = (fn: NavigateFunction) => {
    navigate = fn;
  };
  const go = (to: To | number, options?: NavigateOptions) => {
    if (!navigate) throw new Error('Render navigator.element inside the router first');
    const nav = navigate;
    act(() => {
      if (typeof to === 'number') void nav(to);
      else void nav(to, options);
    });
  };
  return { element: <NavigateCapture onReady={onReady} />, go };
}
