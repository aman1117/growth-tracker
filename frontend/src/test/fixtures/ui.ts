/**
 * Builders shared by the design-system tests in src/components/ui.
 * Every builder returns a complete, valid object; pass overrides for what a test cares about.
 */
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';

import type { AutocompleteSuggestion, Notification } from '../../types';
import type { Badge, LikerDTO } from '../../types/api';
import type { Comment, CommentsListResponse } from '../../types/comment';

/**
 * Switches the current test to Vitest fake timers and returns a user-event instance that
 * works with them.
 *
 * Testing Library's async helpers (user-event, waitFor, findBy*) wait on a `setTimeout(0)`
 * and only advance fake clocks they recognise as Jest's, so under Vitest they would hang.
 * Exposing Vitest's clock as `jest.advanceTimersByTime` lets them advance it. The shared
 * setup restores real timers and removes the global after each test.
 */
export function enableFakeTimers() {
  vi.useFakeTimers();
  vi.stubGlobal('jest', { advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms) });
  return userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
}

/** A visible top-level comment by `bob` (id 2) on alice's day 2026-10-20. */
export function makeComment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: 1,
    day_owner_id: 1,
    day_date: '2026-10-20',
    author_id: 2,
    author_username: 'bob',
    author_verified: false,
    body: 'Great day!',
    like_count: 0,
    reply_count: 0,
    is_deleted: false,
    is_edited: false,
    liked_by_me: false,
    mentions: [],
    created_at: '2026-10-21T08:00:00.000Z',
    ...overrides,
  };
}

/** A page of comments as returned by the list/replies endpoints. */
export function commentsPage(comments: Comment[], hasMore = false): CommentsListResponse {
  return { success: true, comments, has_more: hasMore };
}

/** An unread "like_received" notification from `alice`. */
export function makeNotification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: 1,
    type: 'like_received',
    title: 'New like',
    body: 'alice liked your day',
    metadata: {
      liker_id: 7,
      liker_username: 'alice',
      liked_date: '2026-10-20',
    },
    read_at: null,
    created_at: '2026-10-21T09:55:00.000Z',
    ...overrides,
  };
}

/** A user suggestion as returned by the autocomplete endpoint. */
export function makeSuggestion(
  text: string,
  meta: AutocompleteSuggestion['meta'] = {}
): AutocompleteSuggestion {
  return { text, kind: 'user', score: 1, meta };
}

/** A locked 7-day streak badge. */
export function makeBadge(overrides: Partial<Badge> = {}): Badge {
  return {
    key: 'week_warrior',
    name: 'Week Warrior',
    icon: 'Flame',
    color: '#f97316',
    threshold: 7,
    earned: false,
    ...overrides,
  };
}

/** Someone who liked a day. */
export function makeLiker(overrides: Partial<LikerDTO> = {}): LikerDTO {
  return {
    id: 7,
    username: 'alice',
    liked_at: '2026-10-21T09:00:00.000Z',
    ...overrides,
  };
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

/** A promise the test settles by hand, to observe pending (loading/optimistic) states. */
export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
