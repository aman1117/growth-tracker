import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ACTIVITY_CACHE_KEY_PREFIX, STORAGE_KEYS } from '../../constants';
import { ACTIVITY_NAMES } from '../../types';
import {
  cacheActivities,
  formatDateForApi,
  getCacheKey,
  getDateFromSearchParams,
  getDefaultTileSizes,
  hasLocalConfig,
  loadCachedActivities,
  loadTileOrder,
  loadTileSizes,
  saveTileOrder,
  saveTileSizes,
} from './Dashboard.constants';

const FIXED_NOW = new Date(2026, 4, 15, 12, 0, 0);

/** Makes every localStorage access throw, like Safari private mode or a full quota. */
function breakLocalStorage() {
  const fail = () => {
    throw new Error('storage unavailable');
  };
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(fail);
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(fail);
}

describe('getDefaultTileSizes', () => {
  it('gives every predefined activity a size, with sleep large and study/eating wide', () => {
    const sizes = getDefaultTileSizes();

    expect(Object.keys(sizes)).toEqual([...ACTIVITY_NAMES]);
    expect(sizes).toMatchObject({ sleep: 'medium', study: 'wide', eating: 'wide', idle: 'small' });
  });
});

describe('tile order and size storage', () => {
  it('reports a local config only when both order and sizes are saved', () => {
    expect(hasLocalConfig()).toBe(false);

    saveTileOrder([...ACTIVITY_NAMES]);
    expect(hasLocalConfig()).toBe(false);

    saveTileSizes(getDefaultTileSizes());
    expect(hasLocalConfig()).toBe(true);
  });

  it('round-trips a complete tile order', () => {
    const reversed = [...ACTIVITY_NAMES].reverse();
    saveTileOrder(reversed);

    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.TILE_ORDER)!)).toEqual(reversed);
    expect(loadTileOrder()).toEqual(reversed);
  });

  it.each([
    ['nothing is saved', null],
    ['an activity is missing', JSON.stringify(ACTIVITY_NAMES.slice(1))],
    [
      'an unknown activity replaces a known one',
      JSON.stringify(['nap', ...ACTIVITY_NAMES.slice(1)]),
    ],
  ])('falls back to the default order when %s', (_label, saved) => {
    if (saved) localStorage.setItem(STORAGE_KEYS.TILE_ORDER, saved);

    expect(loadTileOrder()).toEqual([...ACTIVITY_NAMES]);
  });

  it('falls back to the default order when the saved order is corrupt', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    localStorage.setItem(STORAGE_KEYS.TILE_ORDER, '{not json');

    expect(loadTileOrder()).toEqual([...ACTIVITY_NAMES]);
    expect(error).toHaveBeenCalledWith('[Dashboard] Failed to load tile order', expect.any(Error));
  });

  it('round-trips tile sizes and defaults when none are saved', () => {
    expect(loadTileSizes()).toEqual(getDefaultTileSizes());

    const sizes = { ...getDefaultTileSizes(), idle: 'wide' as const };
    saveTileSizes(sizes);
    expect(loadTileSizes()).toEqual(sizes);
  });

  it('defaults tile sizes when the saved sizes are corrupt', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    localStorage.setItem(STORAGE_KEYS.TILE_SIZES, 'oops');

    expect(loadTileSizes()).toEqual(getDefaultTileSizes());
    expect(error).toHaveBeenCalledWith('[Dashboard] Failed to load tile sizes', expect.any(Error));
  });

  it('survives storage being unavailable', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    breakLocalStorage();

    expect(hasLocalConfig()).toBe(false);
    expect(() => saveTileOrder([...ACTIVITY_NAMES])).not.toThrow();
    expect(() => saveTileSizes(getDefaultTileSizes())).not.toThrow();
    expect(error).toHaveBeenCalledWith('[Dashboard] Failed to save tile order', expect.any(Error));
    expect(error).toHaveBeenCalledWith('[Dashboard] Failed to save tile sizes', expect.any(Error));
  });
});

describe('formatDateForApi', () => {
  it('formats the local calendar day as YYYY-MM-DD with zero padding', () => {
    expect(formatDateForApi(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
    expect(formatDateForApi(new Date(2026, 11, 31, 0, 0))).toBe('2026-12-31');
  });
});

describe('getDateFromSearchParams', () => {
  beforeEach(() => {
    vi.setSystemTime(FIXED_NOW);
  });

  it('returns null when there is no date param', () => {
    expect(getDateFromSearchParams(new URLSearchParams('tab=stories'))).toBeNull();
  });

  it('parses a past date as local midnight', () => {
    const date = getDateFromSearchParams(new URLSearchParams('date=2026-05-10'));

    expect(date).toEqual(new Date(2026, 4, 10));
  });

  it('accepts today', () => {
    expect(getDateFromSearchParams(new URLSearchParams('date=2026-05-15'))).toEqual(
      new Date(2026, 4, 15)
    );
  });

  it.each(['not-a-date', '2026-13-45'])('rejects the invalid date %s', (value) => {
    expect(getDateFromSearchParams(new URLSearchParams({ date: value }))).toBeNull();
  });

  it('rejects future dates', () => {
    expect(getDateFromSearchParams(new URLSearchParams('date=2026-05-16'))).toBeNull();
  });
});

describe('offline activity cache', () => {
  const activities = { sleep: 8, study: 2 };
  const notes = { study: 'Chapter 4' };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('builds a per-user, per-day cache key', () => {
    expect(getCacheKey('alice', '2026-05-15')).toBe('dashboard_alice_2026-05-15');
  });

  it('uses the shared activity-cache prefix, which is cleared when a session ends', () => {
    expect(getCacheKey('alice', '2026-05-15').startsWith(ACTIVITY_CACHE_KEY_PREFIX)).toBe(true);
  });

  it('returns cached activities and notes for the same user and day', () => {
    cacheActivities('alice', '2026-05-15', activities, notes);

    expect(loadCachedActivities('alice', '2026-05-15')).toEqual({
      activities,
      notes,
      timestamp: FIXED_NOW.getTime(),
    });
    expect(loadCachedActivities('alice', '2026-05-14')).toBeNull();
    expect(loadCachedActivities('bob', '2026-05-15')).toBeNull();
  });

  it('expires the cache after 24 hours', () => {
    cacheActivities('alice', '2026-05-15', activities, notes);

    vi.advanceTimersByTime(24 * 60 * 60 * 1000 - 1);
    expect(loadCachedActivities('alice', '2026-05-15')).not.toBeNull();

    vi.advanceTimersByTime(1);
    expect(loadCachedActivities('alice', '2026-05-15')).toBeNull();
  });

  it('ignores a corrupt cache entry', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    localStorage.setItem(getCacheKey('alice', '2026-05-15'), '{broken');

    expect(loadCachedActivities('alice', '2026-05-15')).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      '[Dashboard] Failed to load cached activities:',
      expect.any(Error)
    );
  });

  it('does not throw when the cache cannot be written', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    breakLocalStorage();

    expect(() => cacheActivities('alice', '2026-05-15', activities, notes)).not.toThrow();
    expect(warn).toHaveBeenCalledWith('[Dashboard] Failed to cache activities:', expect.any(Error));
  });
});
