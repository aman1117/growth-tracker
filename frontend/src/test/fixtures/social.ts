/**
 * Fixtures for the social scope: follow lists and buttons, stories, user search and badges.
 * Factories return realistic API shapes (see src/types) with overridable fields.
 */
import { act, waitFor } from '@testing-library/react';
import { vi } from 'vitest';

import type { Badge } from '../../types/api';
import type { SearchSuggestionUser } from '../../types/autocomplete';
import type { FollowUser, RelationshipState } from '../../types/follow';
import type { ActivityPhoto, PhotoInteraction, UserStoryGroup } from '../../types/story';
import { MockIntersectionObserver } from '../browser-mocks';

export function relationship(overrides: Partial<RelationshipState> = {}): RelationshipState {
  return {
    following: false,
    followed_by: false,
    pending: false,
    incoming_pending: false,
    is_mutual: false,
    ...overrides,
  };
}

export function followUser(overrides: Partial<FollowUser> = {}): FollowUser {
  const id = overrides.id ?? 2;
  return {
    id,
    username: `user${id}`,
    display_name: null,
    profile_pic: null,
    profile_pic_thumb: null,
    is_verified: false,
    is_private: false,
    ...overrides,
  };
}

export function activityPhoto(overrides: Partial<ActivityPhoto> = {}): ActivityPhoto {
  const id = overrides.id ?? 101;
  return {
    id,
    user_id: 2,
    activity_name: 'sleep',
    photo_date: '2026-10-21',
    photo_url: `https://cdn.test/photos/${id}.jpg`,
    thumbnail_url: `https://cdn.test/photos/${id}-thumb.jpg`,
    created_at: '2026-10-21T08:00:00Z',
    ...overrides,
  };
}

export function storyGroup(overrides: Partial<UserStoryGroup> = {}): UserStoryGroup {
  return {
    user_id: 2,
    username: 'bob',
    photos: [activityPhoto({ user_id: overrides.user_id ?? 2 })],
    has_unseen: true,
    ...overrides,
  };
}

export function photoInteraction(overrides: Partial<PhotoInteraction> = {}): PhotoInteraction {
  return {
    user_id: 3,
    username: 'carol',
    interaction_type: 'view',
    viewed_at: '2026-10-21T09:00:00Z',
    ...overrides,
  };
}

export function badge(overrides: Partial<Badge> = {}): Badge {
  return {
    key: 'streak_7',
    name: 'Week Warrior',
    icon: 'Flame',
    color: '#f97316',
    threshold: 7,
    earned: false,
    ...overrides,
  };
}

export function suggestionUser(
  overrides: Partial<SearchSuggestionUser> = {}
): SearchSuggestionUser {
  const id = overrides.id ?? 10;
  return {
    id,
    username: `user${id}`,
    isVerified: false,
    followersCount: 0,
    ...overrides,
  };
}

/** A promise whose settlement the test controls, for asserting in-flight (loading) UI. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Records every IntersectionObserver the code under test creates, so infinite-scroll
 * sentinels can be "scrolled into view" with `intersect()`. Requires real timers.
 */
export function captureIntersectionObservers() {
  const observers: MockIntersectionObserver[] = [];

  class CapturingIntersectionObserver extends MockIntersectionObserver {
    constructor(callback: IntersectionObserverCallback) {
      super(callback);
      observers.push(this);
    }
  }
  vi.stubGlobal('IntersectionObserver', CapturingIntersectionObserver);

  const connected = () => observers.filter((observer) => !observer.disconnect.mock.calls.length);

  return {
    observers,
    /** Fires the callback of the most recent, still connected observer. */
    async intersect(isIntersecting = true) {
      // findBy* resolves as soon as the DOM changes; give React a macrotask to run the
      // effects that (re)create observers so we never trigger a stale one.
      await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
      const observer = await waitFor(() => {
        const latest = connected().at(-1);
        if (!latest) throw new Error('No connected IntersectionObserver');
        return latest;
      });
      await act(async () => {
        observer.callback([{ isIntersecting } as IntersectionObserverEntry], observer);
      });
    },
  };
}
