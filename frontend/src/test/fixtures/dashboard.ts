/**
 * Fixtures shared by the dashboard (home / day screen) tests: data builders, a router for the
 * mocked `api` client, stand-ins for heavy out-of-scope children and a fake tile layout for
 * dnd-kit keyboard dragging.
 *
 * This module must not import `services/api` at runtime: test files mock that module and load
 * the stubs below from their `vi.mock` factories.
 */
import { createElement, useEffect } from 'react';
import { vi } from 'vitest';

import type { StoryCirclesRowProps, StoryViewerProps } from '../../components/story';
import type { PullToRefreshWrapperProps } from '../../components/ui';
import type { challengeApi, commentApi, likeApi } from '../../services/api';
import type { Activity, ActivityPhoto, ChallengeSummary, CustomTile } from '../../types';
import type { Badge, UserSearchResult } from '../../types/api';

// ============================================================================
// Time and users
// ============================================================================

/** "Today" in every dashboard test: Friday 15 May 2026, local noon. */
export const FIXED_TODAY = new Date(2026, 4, 15, 12, 0, 0);
export const TODAY_KEY = '2026-05-15';
export const YESTERDAY_KEY = '2026-05-14';

/** The signed-in user and another user whose day can be viewed. */
export const ALICE = { id: 1, username: 'alice' } as const;
export const BOB = { id: 2, username: 'bob' } as const;

// ============================================================================
// Builders
// ============================================================================

export function makeActivity(overrides: Partial<Activity> = {}): Activity {
  return { id: 1, name: 'sleep', hours: 8, ...overrides };
}

/** An earned 1-day badge. */
export function makeBadge(overrides: Partial<Badge> = {}): Badge {
  return {
    key: 'first_step',
    name: 'First Step',
    icon: 'Footprints',
    color: '#22c55e',
    threshold: 1,
    earned: true,
    earned_at: '2026-05-01',
    ...overrides,
  };
}

export function makeCustomTile(overrides: Partial<CustomTile> = {}): CustomTile {
  return { id: 'guitar-1', name: 'Guitar', icon: 'Guitar', color: '#f97316', ...overrides };
}

/** `count` custom tiles named "Tile 1".."Tile n" with ids "tile-1".."tile-n". */
export function makeCustomTiles(count: number): CustomTile[] {
  return Array.from({ length: count }, (_, i) =>
    makeCustomTile({ id: `tile-${i + 1}`, name: `Tile ${i + 1}`, icon: 'Star' })
  );
}

export function makePhoto(overrides: Partial<ActivityPhoto> = {}): ActivityPhoto {
  return {
    id: 1,
    user_id: BOB.id,
    activity_name: 'workout',
    photo_date: '2026-05-15',
    photo_url: 'https://cdn.test/photos/1.jpg',
    thumbnail_url: 'https://cdn.test/photos/1-thumb.jpg',
    created_at: '2026-05-15T08:00:00.000Z',
    ...overrides,
  };
}

/** A user as returned by the `/users` search endpoint. */
export function makeSearchUser(overrides: Partial<UserSearchResult> = {}): UserSearchResult {
  return {
    id: BOB.id,
    username: BOB.username,
    email: 'bob@example.com',
    profile_pic: 'https://cdn.test/bob.jpg',
    profile_pic_thumb: 'https://cdn.test/bob-thumb.jpg',
    bio: 'Runner and reader',
    is_private: false,
    is_verified: true,
    ...overrides,
  };
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

/** A promise settled by the test, to observe loading/busy states. */
export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ============================================================================
// Mocked `api` client router
// ============================================================================

type RouteHandler = (body: unknown, endpoint: string) => unknown;

/**
 * Answers for the mocked `api.get` / `api.post`, keyed by "METHOD /path" (query strings are
 * ignored). A value is returned as the response; an `Error` value (or a handler that returns or
 * throws one) rejects; a function receives the request body and endpoint.
 */
export type ApiRoutes = Record<string, unknown>;

export function createApiRouter(routes: ApiRoutes) {
  const respond = async (method: 'GET' | 'POST', endpoint: string, body?: unknown) => {
    const key = `${method} ${endpoint.split('?')[0]}`;
    if (!(key in routes)) throw new Error(`Unhandled api call: ${key}`);
    const route = routes[key];
    const value =
      typeof route === 'function' ? await (route as RouteHandler)(body, endpoint) : route;
    if (value instanceof Error) throw value;
    return value;
  };
  return {
    get: (endpoint: string) => respond('GET', endpoint),
    post: (endpoint: string, body?: unknown) => respond('POST', endpoint, body),
  };
}

interface ApiClientLike {
  get: (endpoint: string) => Promise<unknown>;
  post: (endpoint: string, body?: unknown) => Promise<unknown>;
}

/** Points the mocked `api` client at `routes`. */
export function routeApi(client: ApiClientLike, routes: ApiRoutes) {
  const router = createApiRouter(routes);
  vi.mocked(client.get).mockImplementation(router.get);
  vi.mocked(client.post).mockImplementation(router.post);
}

/** Every endpoint the dashboard screen touches, answered for a quiet, empty day. */
export function dashboardRoutes(overrides: ApiRoutes = {}): ApiRoutes {
  return {
    'POST /get-activities': { success: true, data: [] },
    'GET /tile-config': { success: true, data: null },
    'POST /tile-config': { success: true },
    'POST /tile-config/user': { success: true, data: null },
    'POST /create-activity': { success: true },
    'POST /get-daily-totals': { success: true, data: {} },
    'POST /get-streak': { success: true, data: { current: 3, longest: 7 } },
    'POST /badges/user': { success: true, badges: [] },
    'POST /users': { success: true, data: [makeSearchUser()] },
    'POST /relationships/lookup': { success: true, relationships: {} },
    [`GET /users/${BOB.id}/profile`]: { success: true },
    [`GET /users/${BOB.id}/follow-counts`]: {
      success: true,
      counts: { followers_count: 12, following_count: 4 },
    },
    [`GET /users/${BOB.id}/mutuals`]: { success: true, users: [], has_more: false },
    ...overrides,
  };
}

/** Like and comment widgets on the day summary: no likes and no comments yet. */
export function mockQuietSocial(apis: { likeApi: typeof likeApi; commentApi: typeof commentApi }) {
  vi.mocked(apis.likeApi.getLikes).mockResolvedValue({
    success: true,
    data: [],
    count: 0,
    user_has_liked: false,
  });
  vi.mocked(apis.commentApi.getCommentCount).mockResolvedValue({ success: true, count: 0 });
  vi.mocked(apis.commentApi.getComments).mockResolvedValue({
    success: true,
    comments: [],
    has_more: false,
  });
}

/** The challenges strip on the own day: the user's challenge list (none by default). */
export function mockChallengeList(
  api: { list: typeof challengeApi.list },
  challenges: ChallengeSummary[] = []
) {
  vi.mocked(api.list).mockResolvedValue({ success: true, challenges });
}

// ============================================================================
// Stand-ins for heavy children (story feature, pull-to-refresh gesture)
// ============================================================================

const storyRowRendered = vi.fn<(props: StoryCirclesRowProps) => void>();
const storyViewerRendered = vi.fn<(props: StoryViewerProps) => void>();

/** Latest props received by the story stubs, plus a spy counting story-row mounts. */
export const storyStubs = {
  get row(): StoryCirclesRowProps | null {
    return storyRowRendered.mock.lastCall?.[0] ?? null;
  },
  get viewer(): StoryViewerProps | null {
    return storyViewerRendered.mock.lastCall?.[0] ?? null;
  },
  rowMounted: vi.fn(),
};

export function resetStoryStubs() {
  storyRowRendered.mockClear();
  storyViewerRendered.mockClear();
}

/** Replaces StoryCirclesRow (network + camera heavy) with a labelled placeholder. */
export function StoryCirclesRowStub(props: StoryCirclesRowProps) {
  storyRowRendered(props);
  useEffect(() => {
    storyStubs.rowMounted();
  }, []);
  return createElement('div', { role: 'region', 'aria-label': 'Stories' });
}

/** Replaces StoryViewer with a dialog whose buttons fire the viewer callbacks. */
export function StoryViewerStub(props: StoryViewerProps) {
  storyViewerRendered(props);
  const first = props.photos[props.startIndex ?? 0];
  const button = (label: string, onClick: () => void) =>
    createElement('button', { type: 'button', onClick }, label);
  return createElement(
    'div',
    { role: 'dialog', 'aria-label': `${props.ownerUsername} stories` },
    createElement('p', null, `Photos: ${props.photos.map((p) => p.id).join(', ')}`),
    button('Close stories', props.onClose),
    button('Mark stories viewed', () => props.onPhotosViewed?.(props.photos.map((p) => p.id))),
    button('Delete story photo', () => first && props.onPhotoDeleted?.(first.id)),
    button('Open story profile', () => props.onProfileClick?.(props.ownerUsername))
  );
}

/** Replaces the pull gesture with a button; `disabled` mirrors whether pulling is allowed. */
export function PullToRefreshStub({ children, onRefresh, disabled }: PullToRefreshWrapperProps) {
  return createElement(
    'div',
    null,
    createElement(
      'button',
      { type: 'button', disabled, onClick: () => void onRefresh() },
      'Pull to refresh'
    ),
    children
  );
}

// ============================================================================
// Layout for dnd-kit
// ============================================================================

/**
 * jsdom has no layout, so every element measures 0×0 and dnd-kit cannot tell tiles apart.
 * Lays tile cells (elements whose first child is the `role="button"` tile) out on one row in
 * DOM order, 100px wide with 20px gaps.
 */
export function stubTileLayout() {
  return vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: Element
  ) {
    const isTileCell = this.firstElementChild?.getAttribute('role') === 'button';
    const index =
      isTileCell && this.parentElement ? Array.from(this.parentElement.children).indexOf(this) : -1;
    const left = index >= 0 ? 100 + index * 120 : 0;
    const top = index >= 0 ? 100 : 0;
    const size = index >= 0 ? 100 : 0;
    return {
      x: left,
      y: top,
      left,
      top,
      width: size,
      height: size,
      right: left + size,
      bottom: top + size,
      toJSON: () => ({}),
    } as DOMRect;
  });
}
