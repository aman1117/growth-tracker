/**
 * Dashboard Constants
 *
 * Storage keys, default configurations, and helper functions for tile management.
 */

import { STORAGE_KEYS } from '../../constants';
import type { ActivityName } from '../../types';
import { ACTIVITY_NAMES } from '../../types';
import type { TileSize } from '../ActivityTile';

// ============================================================================
// Storage Keys
// ============================================================================

export const STORAGE_KEY = STORAGE_KEYS.TILE_ORDER;
export const SIZE_STORAGE_KEY = STORAGE_KEYS.TILE_SIZES;
export const HIDDEN_STORAGE_KEY = STORAGE_KEYS.TILE_HIDDEN;
export const COLORS_STORAGE_KEY = STORAGE_KEYS.TILE_COLORS;
export const CUSTOM_TILES_STORAGE_KEY = STORAGE_KEYS.CUSTOM_TILES;

// ============================================================================
// Default Tile Configuration
// ============================================================================

/**
 * Get default tile sizes for all activities
 */
export const getDefaultTileSizes = (): Record<ActivityName, TileSize> => {
  const defaults: Partial<Record<ActivityName, TileSize>> = {
    sleep: 'medium',
    study: 'wide',
    eating: 'wide',
  };
  return ACTIVITY_NAMES.reduce(
    (acc, name) => {
      acc[name] = defaults[name] || 'small';
      return acc;
    },
    {} as Record<ActivityName, TileSize>
  );
};

// ============================================================================
// LocalStorage Helpers
// ============================================================================

/**
 * Check if localStorage has valid tile configuration
 */
export const hasLocalConfig = (): boolean => {
  try {
    const order = localStorage.getItem(STORAGE_KEY);
    const sizes = localStorage.getItem(SIZE_STORAGE_KEY);
    return !!(order && sizes);
  } catch {
    return false;
  }
};

/**
 * Load saved tile order from localStorage
 */
export const loadTileOrder = (): ActivityName[] => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      // Validate that all activities are present
      if (
        parsed.length === ACTIVITY_NAMES.length &&
        ACTIVITY_NAMES.every((name: ActivityName) => parsed.includes(name))
      ) {
        return parsed;
      }
    }
  } catch (e) {
    console.error('[Dashboard] Failed to load tile order', e);
  }
  return [...ACTIVITY_NAMES];
};

/**
 * Save tile order to localStorage
 */
export const saveTileOrder = (order: ActivityName[]): void => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(order));
  } catch (e) {
    console.error('[Dashboard] Failed to save tile order', e);
  }
};

/**
 * Load saved tile sizes from localStorage
 */
export const loadTileSizes = (): Record<ActivityName, TileSize> => {
  try {
    const saved = localStorage.getItem(SIZE_STORAGE_KEY);
    if (saved) {
      return JSON.parse(saved);
    }
  } catch (e) {
    console.error('[Dashboard] Failed to load tile sizes', e);
  }
  return getDefaultTileSizes();
};

/**
 * Save tile sizes to localStorage
 */
export const saveTileSizes = (sizes: Record<ActivityName, TileSize>): void => {
  try {
    localStorage.setItem(SIZE_STORAGE_KEY, JSON.stringify(sizes));
  } catch (e) {
    console.error('[Dashboard] Failed to save tile sizes', e);
  }
};

// ============================================================================
// Date Helpers
// ============================================================================

/**
 * Format a Date object for API calls (YYYY-MM-DD)
 */
export const formatDateForApi = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

/**
 * Parse date from URL search params
 * @returns Date object or null if invalid/not present
 */
export const getDateFromSearchParams = (searchParams: URLSearchParams): Date | null => {
  const dateParam = searchParams.get('date');
  if (!dateParam) return null;

  // Parse YYYY-MM-DD format
  const parsed = new Date(dateParam + 'T00:00:00');
  if (isNaN(parsed.getTime())) return null;

  // Don't allow future dates
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (parsed > today) return null;

  return parsed;
};

// ============================================================================
// Cache Helpers
// ============================================================================

/**
 * Get cache key for offline data
 */
export const getCacheKey = (username: string, date: string): string => {
  return `dashboard_${username}_${date}`;
};

/**
 * Save activities to localStorage for offline access
 */
export const cacheActivities = (
  username: string,
  date: string,
  activities: Record<string, number>,
  notes: Record<string, string>
): void => {
  try {
    const cacheKey = getCacheKey(username, date);
    localStorage.setItem(cacheKey, JSON.stringify({ activities, notes, timestamp: Date.now() }));
  } catch (e) {
    // localStorage might be full or unavailable
    console.warn('[Dashboard] Failed to cache activities:', e);
  }
};

/**
 * Load cached activities from localStorage
 * Cache is valid for 24 hours
 */
export const loadCachedActivities = (
  username: string,
  date: string
): { activities: Record<string, number>; notes: Record<string, string> } | null => {
  try {
    const cacheKey = getCacheKey(username, date);
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      const data = JSON.parse(cached);
      // Cache valid for 24 hours
      if (Date.now() - data.timestamp < 24 * 60 * 60 * 1000) {
        return data;
      }
    }
  } catch (e) {
    console.warn('[Dashboard] Failed to load cached activities:', e);
  }
  return null;
};

// ============================================================================
// Animation Constants
// ============================================================================

export const TILE_ANIMATION_DURATION = 150; // ms for tile slide out
export const TILE_ANIMATION_DELAY = 50; // ms delay before slide in
export const UNDO_TIMEOUT_DURATION = 8000; // ms before undo option disappears
