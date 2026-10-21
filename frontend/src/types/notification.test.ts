import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  formatLastLogged,
  formatNotificationTime,
  isBadgeMetadata,
  isFollowMetadata,
  isLikeMetadata,
  isStreakMetadata,
  type NotificationMetadata,
} from './notification';

const like = { liker_id: 2, liker_username: 'bob', liked_date: '2026-10-18' };
const storyLike = { liker_id: 2, liker_username: 'bob', photo_id: 9, photo_date: '2026-10-19' };
const badge = { badge_id: 'b1', badge_name: 'Early bird', badge_icon: 'Sun' };
const streak = { activity_type: 'workout', streak_count: 7 };
const follow = { actor_id: 5, actor_username: 'erin' };

describe('notification metadata type guards', () => {
  it.each<[string, NotificationMetadata | null, boolean[]]>([
    ['like', like, [true, false, false, false]],
    ['story like', storyLike, [true, false, false, false]],
    ['badge', badge, [false, true, false, false]],
    ['streak', streak, [false, false, true, false]],
    ['follow', follow, [false, false, false, true]],
    [
      'incomplete',
      { liker_id: 2, badge_id: 'b1', activity_type: 'x', actor_id: 5 },
      [false, false, false, false],
    ],
    ['missing', null, [false, false, false, false]],
  ])('recognises %s metadata', (_label, metadata, [isLike, isBadge, isStreak, isFollow]) => {
    expect(isLikeMetadata(metadata)).toBe(isLike);
    expect(isBadgeMetadata(metadata)).toBe(isBadge);
    expect(isStreakMetadata(metadata)).toBe(isStreak);
    expect(isFollowMetadata(metadata)).toBe(isFollow);
  });
});

describe('formatNotificationTime', () => {
  const NOW = new Date(2026, 9, 21, 12, 0, 0);
  const MINUTE = 60_000;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * MINUTE).toISOString();

  it.each([
    [0, 'Just now'],
    [0.9, 'Just now'],
    [-5, 'Just now'],
    [1, '1m ago'],
    [59, '59m ago'],
    [60, '1h ago'],
    [23 * 60 + 59, '23h ago'],
    [24 * 60, '1d ago'],
    [6 * 24 * 60, '6d ago'],
  ])('%s minutes ago → "%s"', (minutes, text) => {
    expect(formatNotificationTime(minutesAgo(minutes))).toBe(text);
  });

  it('shows the calendar date for anything a week old or older', () => {
    expect(formatNotificationTime(minutesAgo(7 * 24 * 60))).toBe('Oct 14');
    expect(formatNotificationTime(new Date(2025, 11, 31, 12, 0).toISOString())).toBe('Dec 31');
  });
});

describe('formatLastLogged', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 21, 9, 0));
  });

  it.each([
    ['earlier today', new Date(2026, 9, 21, 0, 5), 'today'],
    ['late yesterday (under 24 hours ago)', new Date(2026, 9, 20, 23, 59), 'yesterday'],
    ['two days ago', new Date(2026, 9, 19, 18, 0), '2 days ago'],
    ['seven days ago', new Date(2026, 9, 14, 8, 0), '7 days ago'],
    ['eight days ago', new Date(2026, 9, 13, 8, 0), 'Oct 13'],
    ['last year', new Date(2025, 11, 31, 8, 0), 'Dec 31'],
  ])('%s → "%s"', (_label, date, text) => {
    expect(formatLastLogged(date.toISOString())).toBe(text);
  });
});
