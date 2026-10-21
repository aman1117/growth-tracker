import { describe, expect, it } from 'vitest';

import { ACTIVITY_CACHE_KEY_PREFIX, STORAGE_KEYS, USER_STORAGE_KEYS } from './storage';

describe('STORAGE_KEYS', () => {
  it('stores every value under its own key', () => {
    const keys = Object.values(STORAGE_KEYS);

    expect(new Set(keys).size).toBe(keys.length);
  });

  it('namespaces app preferences so they cannot clash with other apps on the origin', () => {
    [
      STORAGE_KEYS.TILE_ORDER,
      STORAGE_KEYS.TILE_SIZES,
      STORAGE_KEYS.TILE_HIDDEN,
      STORAGE_KEYS.TILE_COLORS,
      STORAGE_KEYS.CUSTOM_TILES,
      STORAGE_KEYS.THEME,
    ].forEach((key) => expect(key).toMatch(/^growth-tracker-[a-z-]+$/));
  });

  it('keeps the session keys that existing installs already use', () => {
    expect(STORAGE_KEYS).toMatchObject({
      ACCESS_TOKEN: 'access_token',
      USERNAME: 'username',
      USER_ID: 'user_id',
      PROFILE_PIC: 'profile_pic',
      BIO: 'bio',
    });
  });
});

describe('per-user storage', () => {
  it('declares the dashboard layout keys as the user’s own data, but not the theme', () => {
    expect(USER_STORAGE_KEYS).toEqual([
      STORAGE_KEYS.TILE_ORDER,
      STORAGE_KEYS.TILE_SIZES,
      STORAGE_KEYS.TILE_HIDDEN,
      STORAGE_KEYS.TILE_COLORS,
      STORAGE_KEYS.CUSTOM_TILES,
    ]);
    expect(USER_STORAGE_KEYS).not.toContain(STORAGE_KEYS.THEME);
  });

  it('gives the activity caches a prefix no app-wide key shares, so clearing them is safe', () => {
    expect(ACTIVITY_CACHE_KEY_PREFIX).toBe('dashboard_');
    for (const key of Object.values(STORAGE_KEYS)) {
      expect(key.startsWith(ACTIVITY_CACHE_KEY_PREFIX), key).toBe(false);
    }
  });
});
