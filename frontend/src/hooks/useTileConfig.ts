/**
 * useTileConfig Hook
 * 
 * Handles tile order and size configuration with localStorage persistence.
 * Supports both local-only storage and server sync for authenticated users.
 */

import { useState, useCallback, useEffect } from 'react';
import { ACTIVITY_NAMES } from '../types';
import type { ActivityName } from '../types';
import { STORAGE_KEYS } from '../constants/storage';
import { api } from '../services/api';

export type TileSize = 'small' | 'medium' | 'wide';

interface TileConfig {
  order: ActivityName[];
  sizes: Record<ActivityName, TileSize>;
}

interface UseTileConfigOptions {
  /** Username for server sync (optional) */
  username?: string;
  /** Whether viewing another user's profile */
  isViewingOther?: boolean;
}

interface UseTileConfigReturn {
  /** Current tile order */
  order: ActivityName[];
  /** Current tile sizes */
  sizes: Record<ActivityName, TileSize>;
  /** Whether config is loading from server */
  loading: boolean;
  /** Update tile order */
  setOrder: (newOrder: ActivityName[]) => void;
  /** Update a single tile's size */
  setTileSize: (name: ActivityName, size: TileSize) => void;
  /** Reset to default configuration */
  resetToDefaults: () => void;
  /** Save current config to server */
  saveToServer: () => Promise<boolean>;
  /** Check if there's a local config saved */
  hasLocalConfig: boolean;
}

/**
 * Get default tile sizes configuration
 */
const getDefaultSizes = (): Record<ActivityName, TileSize> => {
  const defaults: Partial<Record<ActivityName, TileSize>> = {
    sleep: 'medium',
    study: 'wide',
    eating: 'wide',
  };

  return ACTIVITY_NAMES.reduce((acc, name) => {
    acc[name] = defaults[name] || 'small';
    return acc;
  }, {} as Record<ActivityName, TileSize>);
};

/**
 * Get default tile order
 */
const getDefaultOrder = (): ActivityName[] => [...ACTIVITY_NAMES];

/**
 * Load config from localStorage
 */
const loadLocalConfig = (): TileConfig | null => {
  try {
    const orderStr = localStorage.getItem(STORAGE_KEYS.TILE_ORDER);
    const sizesStr = localStorage.getItem(STORAGE_KEYS.TILE_SIZES);

    if (!orderStr || !sizesStr) return null;

    const order = JSON.parse(orderStr) as ActivityName[];
    const sizes = JSON.parse(sizesStr) as Record<ActivityName, TileSize>;

    // Validate order contains all activities
    const isValidOrder =
      order.length === ACTIVITY_NAMES.length &&
      ACTIVITY_NAMES.every((name) => order.includes(name));

    if (!isValidOrder) return null;

    return { order, sizes };
  } catch {
    return null;
  }
};

/**
 * Save config to localStorage
 */
const saveLocalConfig = (config: TileConfig): void => {
  try {
    localStorage.setItem(STORAGE_KEYS.TILE_ORDER, JSON.stringify(config.order));
    localStorage.setItem(STORAGE_KEYS.TILE_SIZES, JSON.stringify(config.sizes));
  } catch (e) {
    console.error('Failed to save tile config:', e);
  }
};

/**
 * Hook for managing tile configuration
 * 
 * @example
 * ```tsx
 * const {
 *   order,
 *   sizes,
 *   setOrder,
 *   setTileSize,
 *   loading,
 * } = useTileConfig({ username: user?.username });
 * ```
 */
export function useTileConfig(
  options: UseTileConfigOptions = {}
): UseTileConfigReturn {
  const { username, isViewingOther = false } = options;

  // Initialize from localStorage or defaults
  const [config, setConfig] = useState<TileConfig>(() => {
    if (isViewingOther) {
      return { order: getDefaultOrder(), sizes: getDefaultSizes() };
    }
    return loadLocalConfig() || { order: getDefaultOrder(), sizes: getDefaultSizes() };
  });

  const [loading, setLoading] = useState(isViewingOther);
  const hasLocalConfig = loadLocalConfig() !== null;

  // Fetch config from server for other users
  useEffect(() => {
    const fetchServerConfig = async () => {
      if (!isViewingOther || !username) return;

      setLoading(true);
      try {
        const res = await api.post<{
          success: boolean;
          data?: { order: string[]; sizes: Record<string, string> };
        }>('/get-tile-config', { username });

        if (res.success && res.data) {
          setConfig({
            order: res.data.order as ActivityName[],
            sizes: res.data.sizes as Record<ActivityName, TileSize>,
          });
        }
      } catch (err) {
        console.error('Failed to fetch tile config:', err);
        // Keep defaults on error
      } finally {
        setLoading(false);
      }
    };

    fetchServerConfig();
  }, [username, isViewingOther]);

  /**
   * Update tile order
   */
  const setOrder = useCallback(
    (newOrder: ActivityName[]) => {
      setConfig((prev) => {
        const newConfig = { ...prev, order: newOrder };
        if (!isViewingOther) {
          saveLocalConfig(newConfig);
        }
        return newConfig;
      });
    },
    [isViewingOther]
  );

  /**
   * Update a single tile's size
   */
  const setTileSize = useCallback(
    (name: ActivityName, size: TileSize) => {
      setConfig((prev) => {
        const newConfig = {
          ...prev,
          sizes: { ...prev.sizes, [name]: size },
        };
        if (!isViewingOther) {
          saveLocalConfig(newConfig);
        }
        return newConfig;
      });
    },
    [isViewingOther]
  );

  /**
   * Reset to default configuration
   */
  const resetToDefaults = useCallback(() => {
    const defaultConfig = { order: getDefaultOrder(), sizes: getDefaultSizes() };
    setConfig(defaultConfig);
    if (!isViewingOther) {
      saveLocalConfig(defaultConfig);
    }
  }, [isViewingOther]);

  /**
   * Save current config to server
   */
  const saveToServer = useCallback(async (): Promise<boolean> => {
    try {
      const res = await api.post<{ success: boolean }>('/save-tile-config', {
        order: config.order,
        sizes: config.sizes,
      });
      return res.success;
    } catch (err) {
      console.error('Failed to save tile config:', err);
      return false;
    }
  }, [config]);

  return {
    order: config.order,
    sizes: config.sizes,
    loading,
    setOrder,
    setTileSize,
    resetToDefaults,
    saveToServer,
    hasLocalConfig,
  };
}
