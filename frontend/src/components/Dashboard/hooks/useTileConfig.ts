/**
 * useTileConfig Hook
 *
 * Manages tile configuration including order, sizes, hidden tiles, colors, and custom tiles.
 * Handles both localStorage persistence and backend sync.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../../../services/api';
import { gl } from '../../../services/goodlogs';
import type { ActivityName, CustomTile, PredefinedActivityName } from '../../../types';
import { ACTIVITY_NAMES, isCustomTile } from '../../../types';
import type { TileSize } from '../../ActivityTile';
import {
  COLORS_STORAGE_KEY,
  CUSTOM_TILES_STORAGE_KEY,
  getDefaultTileSizes,
  HIDDEN_STORAGE_KEY,
  loadTileOrder,
  loadTileSizes,
  saveTileSizes,
  SIZE_STORAGE_KEY,
  STORAGE_KEY,
} from '../Dashboard.constants';

interface UseTileConfigProps {
  isReadOnly: boolean;
  targetUsername: string | undefined;
}

/** Where the tiles shown come from: a load still under way, the server's config, or a failed load */
export type TileConfigStatus = 'loading' | 'loaded' | 'failed';

/** How a load ended; 'superseded' when a newer load started first and this one was ignored */
export type TileConfigLoadResult = 'loaded' | 'failed' | 'superseded';

interface UseTileConfigReturn {
  tileOrder: ActivityName[];
  setTileOrder: React.Dispatch<React.SetStateAction<ActivityName[]>>;
  tileSizes: Record<ActivityName, TileSize>;
  setTileSizes: React.Dispatch<React.SetStateAction<Record<ActivityName, TileSize>>>;
  hiddenTiles: ActivityName[];
  setHiddenTiles: React.Dispatch<React.SetStateAction<ActivityName[]>>;
  tileColors: Record<string, string>;
  setTileColors: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  customTiles: CustomTile[];
  setCustomTiles: React.Dispatch<React.SetStateAction<CustomTile[]>>;
  configLoading: boolean;
  /**
   * 'loading' until the tiles shown come from a finished load for the profile on screen (also on
   * the first render after switching profiles, while `configLoading` is still false), then
   * whether that load succeeded
   */
  configStatus: TileConfigStatus;
  /** Loads the config for the profile on screen again */
  reloadTileConfig: () => Promise<TileConfigLoadResult>;
  visibleTiles: ActivityName[];
  /** Saves to the server only once the config has loaded ('loaded'); otherwise does nothing */
  saveTileConfigToBackend: (
    order: ActivityName[],
    sizes: Record<ActivityName, TileSize>,
    hidden: ActivityName[],
    colors: Record<string, string>,
    customTilesList: CustomTile[]
  ) => Promise<void>;
  handleTileResize: (name: ActivityName, size: TileSize) => void;
}

/**
 * Check if localStorage has valid config
 */
const hasLocalConfig = (): boolean => {
  try {
    const order = localStorage.getItem(STORAGE_KEY);
    const sizes = localStorage.getItem(SIZE_STORAGE_KEY);
    return !!(order && sizes);
  } catch {
    return false;
  }
};

/** Identifies whose tile config is on screen */
const getProfileKey = (isReadOnly: boolean, targetUsername: string | undefined): string =>
  `${isReadOnly ? 'other' : 'own'}:${targetUsername ?? ''}`;

/** Everything that makes up a dashboard's tiles */
interface TileLayout {
  order: ActivityName[];
  sizes: Record<ActivityName, TileSize>;
  hidden: ActivityName[];
  colors: Record<string, string>;
  customTiles: CustomTile[];
}

const defaultLayout = (): TileLayout => ({
  order: [...ACTIVITY_NAMES],
  sizes: getDefaultTileSizes(),
  hidden: [],
  colors: {},
  customTiles: [],
});

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The layout a saved config describes. Saving leaves out hidden tiles, colors and custom tiles
 * when there are none, so a missing one means none: it never falls back to what this device
 * has, which made devices show different layouts.
 */
const layoutFromConfig = (config: Record<string, unknown>): TileLayout => {
  const { order, sizes, hidden, colors, customTiles } = config;
  return {
    // Unknown tiles are dropped; custom tiles are kept
    order: Array.isArray(order)
      ? order.filter(
          (name): name is ActivityName =>
            typeof name === 'string' &&
            (ACTIVITY_NAMES.includes(name as PredefinedActivityName) || isCustomTile(name))
        )
      : [...ACTIVITY_NAMES],
    sizes: isObject(sizes) ? (sizes as Record<ActivityName, TileSize>) : getDefaultTileSizes(),
    hidden: Array.isArray(hidden) ? hidden : [],
    colors: isObject(colors) ? (colors as Record<string, string>) : {},
    customTiles: Array.isArray(customTiles) ? customTiles : [],
  };
};

/** One part of the layout cached on this device, or `fallback` when it is missing or unreadable */
const readCached = <T>(key: string, isValid: (value: unknown) => boolean, fallback: T): T => {
  try {
    const saved = localStorage.getItem(key);
    if (saved === null) return fallback;
    const value: unknown = JSON.parse(saved);
    return isValid(value) ? (value as T) : fallback;
  } catch (e) {
    console.error('[useTileConfig] Failed to restore from localStorage', e);
    return fallback;
  }
};

/** The layout this device last loaded or saved, with defaults for any part it lacks */
const readCachedLayout = (): TileLayout => {
  const defaults = defaultLayout();
  return {
    order: readCached(STORAGE_KEY, Array.isArray, defaults.order),
    sizes: readCached(SIZE_STORAGE_KEY, isObject, defaults.sizes),
    hidden: readCached(HIDDEN_STORAGE_KEY, Array.isArray, defaults.hidden),
    colors: readCached(COLORS_STORAGE_KEY, isObject, defaults.colors),
    customTiles: readCached(CUSTOM_TILES_STORAGE_KEY, Array.isArray, defaults.customTiles),
  };
};

/** Keeps a copy of our layout on this device, so it shows at once next time */
const cacheLayout = (layout: TileLayout): void => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout.order));
    localStorage.setItem(SIZE_STORAGE_KEY, JSON.stringify(layout.sizes));
    localStorage.setItem(HIDDEN_STORAGE_KEY, JSON.stringify(layout.hidden));
    localStorage.setItem(COLORS_STORAGE_KEY, JSON.stringify(layout.colors));
    localStorage.setItem(CUSTOM_TILES_STORAGE_KEY, JSON.stringify(layout.customTiles));
  } catch (e) {
    console.error('[useTileConfig] Failed to save the layout locally', e);
  }
};

export const useTileConfig = ({
  isReadOnly,
  targetUsername,
}: UseTileConfigProps): UseTileConfigReturn => {
  // Always show loading for other users, or check localStorage for own profile
  const [configLoading, setConfigLoading] = useState(isReadOnly ? true : !hasLocalConfig());

  const [tileOrder, setTileOrder] = useState<ActivityName[]>(
    isReadOnly ? [...ACTIVITY_NAMES] : loadTileOrder
  );
  const [tileSizes, setTileSizes] = useState<Record<ActivityName, TileSize>>(
    isReadOnly ? getDefaultTileSizes() : loadTileSizes
  );
  const [hiddenTiles, setHiddenTiles] = useState<ActivityName[]>([]);
  const [tileColors, setTileColors] = useState<Record<string, string>>({});
  const [customTiles, setCustomTiles] = useState<CustomTile[]>([]);
  // The profile whose config load finished last, and whether it succeeded
  const [lastLoad, setLastLoad] = useState<{ profileKey: string; ok: boolean } | null>(null);
  // Numbers each load, so only the latest one may apply its response
  const latestLoadRef = useRef(0);

  const configStatus: TileConfigStatus =
    configLoading || lastLoad?.profileKey !== getProfileKey(isReadOnly, targetUsername)
      ? 'loading'
      : lastLoad.ok
        ? 'loaded'
        : 'failed';

  // Save tile config to backend (includes custom tiles, hidden, colors)
  const saveTileConfigToBackend = useCallback(
    async (
      order: ActivityName[],
      sizes: Record<ActivityName, TileSize>,
      hidden: ActivityName[],
      colors: Record<string, string>,
      customTilesList: CustomTile[]
    ) => {
      if (configStatus !== 'loaded') {
        // The tiles shown are not the user's saved config: saving would overwrite it
        gl.warn('tile_config_save_blocked', { metadata: { status: configStatus } });
        return;
      }
      try {
        await api.post('/tile-config', {
          config: {
            order,
            sizes,
            hidden: hidden.length > 0 ? hidden : undefined,
            colors: Object.keys(colors).length > 0 ? colors : undefined,
            customTiles: customTilesList.length > 0 ? customTilesList : undefined,
          },
        });

        // Also save to localStorage for quick loading
        localStorage.setItem(HIDDEN_STORAGE_KEY, JSON.stringify(hidden));
        localStorage.setItem(COLORS_STORAGE_KEY, JSON.stringify(colors));
        localStorage.setItem(CUSTOM_TILES_STORAGE_KEY, JSON.stringify(customTilesList));
      } catch (err) {
        console.error('[useTileConfig] Failed to save tile config to backend', err);
      }
    },
    [configStatus]
  );

  // Handle tile resize
  const handleTileResize = useCallback((name: ActivityName, size: TileSize) => {
    setTileSizes((prev) => {
      const newSizes = { ...prev, [name]: size };
      saveTileSizes(newSizes);
      return newSizes;
    });
  }, []);

  // Load the config for the profile on screen (when it changes, and on request)
  const loadTileConfig = useCallback(async (): Promise<TileConfigLoadResult> => {
    const loadId = ++latestLoadRef.current;
    // Once a newer load has started (another profile, or a reload), this one changes nothing
    const isLatest = () => loadId === latestLoadRef.current;
    const profileKey = getProfileKey(isReadOnly, targetUsername);
    const showLayout = (layout: TileLayout) => {
      setTileOrder(layout.order);
      setTileSizes(layout.sizes);
      setHiddenTiles(layout.hidden);
      setTileColors(layout.colors);
      setCustomTiles(layout.customTiles);
    };
    setConfigLoading(true);

    // Our own dashboard shows the layout cached on this device until the server answers, and
    // keeps showing it if the server can't be reached (never another profile's tiles)
    if (!isReadOnly) showLayout(readCachedLayout());

    try {
      // Fetch config based on whose profile we're viewing
      const res =
        isReadOnly && targetUsername
          ? await api.post('/tile-config/user', { username: targetUsername })
          : await api.get('/tile-config');
      if (!isLatest()) return 'superseded';

      if (res.success) {
        // The saved layout, or the default one when nothing is saved, so every device shows the
        // same tiles
        const layout = isObject(res.data) ? layoutFromConfig(res.data) : defaultLayout();
        showLayout(layout);
        if (!isReadOnly) cacheLayout(layout);
        setLastLoad({ profileKey, ok: true });
        return 'loaded';
      }
      setLastLoad({ profileKey, ok: false });
      if (isReadOnly) showLayout(defaultLayout());
      return 'failed';
    } catch (err) {
      if (!isLatest()) return 'superseded';
      console.error('[useTileConfig] Failed to fetch tile config', err);
      setLastLoad({ profileKey, ok: false });
      // On error viewing other user, use clean defaults
      if (isReadOnly) showLayout(defaultLayout());
    } finally {
      if (isLatest()) setConfigLoading(false);
    }
    return 'failed';
  }, [isReadOnly, targetUsername]);

  // Fetch tile config from backend - always fetch
  useEffect(() => {
    loadTileConfig();
  }, [loadTileConfig]);

  // Get visible tiles (filtering out hidden ones)
  const visibleTiles = tileOrder.filter((name) => !hiddenTiles.includes(name));

  return {
    tileOrder,
    setTileOrder,
    tileSizes,
    setTileSizes,
    hiddenTiles,
    setHiddenTiles,
    tileColors,
    setTileColors,
    customTiles,
    setCustomTiles,
    configLoading,
    configStatus,
    reloadTileConfig: loadTileConfig,
    visibleTiles,
    saveTileConfigToBackend,
    handleTileResize,
  };
};
