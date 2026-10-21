/**
 * Storage Keys
 *
 * Centralized storage key constants to prevent typos and enable
 * easy refactoring of storage key names.
 */

export const STORAGE_KEYS = {
  // Authentication
  ACCESS_TOKEN: 'access_token',
  USERNAME: 'username',
  USER_ID: 'user_id',
  PROFILE_PIC: 'profile_pic',
  BIO: 'bio',

  // Dashboard Configuration
  TILE_ORDER: 'growth-tracker-tile-order',
  TILE_SIZES: 'growth-tracker-tile-sizes',
  TILE_HIDDEN: 'growth-tracker-tile-hidden',
  TILE_COLORS: 'growth-tracker-tile-colors',
  CUSTOM_TILES: 'growth-tracker-custom-tiles',

  // Theme
  THEME: 'growth-tracker-theme',
} as const;

export type StorageKey = (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS];

/** Prefix of the per-day activity caches, `dashboard_<username>_<date>` (see getCacheKey) */
export const ACTIVITY_CACHE_KEY_PREFIX = 'dashboard_';

/**
 * Keys that hold the signed-in user's own data: their dashboard layout and custom tiles.
 * They are cleared, together with the activity caches, whenever a session ends or a new one
 * starts, so the next person on this browser never sees or uploads them. App-wide keys such
 * as the theme are deliberately not listed.
 */
export const USER_STORAGE_KEYS: readonly StorageKey[] = [
  STORAGE_KEYS.TILE_ORDER,
  STORAGE_KEYS.TILE_SIZES,
  STORAGE_KEYS.TILE_HIDDEN,
  STORAGE_KEYS.TILE_COLORS,
  STORAGE_KEYS.CUSTOM_TILES,
];
