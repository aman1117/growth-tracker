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

  // Theme
  THEME: 'growth-tracker-theme',
} as const;

export type StorageKey = (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS];
