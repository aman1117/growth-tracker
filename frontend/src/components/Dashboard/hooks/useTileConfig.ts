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
  saveTileOrder,
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
    setConfigLoading(true);

    // When returning to own profile, immediately restore from localStorage
    // to prevent flash of other user's config while API loads
    if (!isReadOnly) {
      try {
        const localHidden = localStorage.getItem(HIDDEN_STORAGE_KEY);
        const localColors = localStorage.getItem(COLORS_STORAGE_KEY);
        const localCustomTiles = localStorage.getItem(CUSTOM_TILES_STORAGE_KEY);
        const localOrder = localStorage.getItem(STORAGE_KEY);
        const localSizes = localStorage.getItem(SIZE_STORAGE_KEY);

        if (localHidden) setHiddenTiles(JSON.parse(localHidden));
        else setHiddenTiles([]);
        if (localColors) setTileColors(JSON.parse(localColors));
        else setTileColors({});
        if (localCustomTiles) setCustomTiles(JSON.parse(localCustomTiles));
        else setCustomTiles([]);
        if (localOrder) setTileOrder(JSON.parse(localOrder));
        if (localSizes) setTileSizes(JSON.parse(localSizes));
      } catch (e) {
        console.error('[useTileConfig] Failed to restore from localStorage', e);
      }
    }

    try {
      // Fetch config based on whose profile we're viewing
      const res =
        isReadOnly && targetUsername
          ? await api.post('/tile-config/user', { username: targetUsername })
          : await api.get('/tile-config');
      if (!isLatest()) return 'superseded';

      if (res.success && res.data) {
        const { order, sizes, hidden, colors, customTiles: customTilesData } = res.data;

        // Load custom tiles first (needed for order validation)
        if (customTilesData && Array.isArray(customTilesData)) {
          setCustomTiles(customTilesData);
          if (!isReadOnly) {
            localStorage.setItem(CUSTOM_TILES_STORAGE_KEY, JSON.stringify(customTilesData));
          }
        } else if (isReadOnly) {
          // Viewing other user with no custom tiles - set empty
          setCustomTiles([]);
        }

        // Load hidden tiles
        if (hidden && Array.isArray(hidden)) {
          setHiddenTiles(hidden);
          if (!isReadOnly) {
            localStorage.setItem(HIDDEN_STORAGE_KEY, JSON.stringify(hidden));
          }
        } else if (isReadOnly) {
          // Viewing other user with no hidden tiles - set empty (don't use our own)
          setHiddenTiles([]);
        }

        // Load color overrides
        if (colors && typeof colors === 'object') {
          setTileColors(colors);
          if (!isReadOnly) {
            localStorage.setItem(COLORS_STORAGE_KEY, JSON.stringify(colors));
          }
        } else if (isReadOnly) {
          // Viewing other user with no color overrides - set empty
          setTileColors({});
        }

        // Validate and apply order (including custom tiles)
        if (order && Array.isArray(order)) {
          // For validation, check predefined activities + custom tiles
          const validOrder = order.filter(
            (name: string) =>
              ACTIVITY_NAMES.includes(name as PredefinedActivityName) || isCustomTile(name)
          );
          setTileOrder(validOrder as ActivityName[]);
          if (!isReadOnly) saveTileOrder(validOrder as ActivityName[]);
        } else {
          setTileOrder([...ACTIVITY_NAMES]);
        }

        // Apply sizes
        if (sizes && typeof sizes === 'object') {
          setTileSizes(sizes);
          if (!isReadOnly) saveTileSizes(sizes);
        } else {
          setTileSizes(getDefaultTileSizes());
        }
      } else {
        // No config from backend
        if (isReadOnly) {
          // Viewing other user with no config - use defaults, don't touch localStorage
          setHiddenTiles([]);
          setTileColors({});
          setCustomTiles([]);
          setTileOrder([...ACTIVITY_NAMES]);
          setTileSizes(getDefaultTileSizes());
        } else {
          // Own profile with no backend config - try localStorage first
          try {
            const localHidden = localStorage.getItem(HIDDEN_STORAGE_KEY);
            const localColors = localStorage.getItem(COLORS_STORAGE_KEY);
            const localCustomTiles = localStorage.getItem(CUSTOM_TILES_STORAGE_KEY);

            if (localHidden) setHiddenTiles(JSON.parse(localHidden));
            if (localColors) setTileColors(JSON.parse(localColors));
            if (localCustomTiles) setCustomTiles(JSON.parse(localCustomTiles));
          } catch (e) {
            console.error('[useTileConfig] Failed to load from localStorage', e);
          }

          setTileOrder([...ACTIVITY_NAMES]);
          setTileSizes(getDefaultTileSizes());
        }
      }
      setLastLoad({ profileKey, ok: !!res.success });
      return res.success ? 'loaded' : 'failed';
    } catch (err) {
      if (!isLatest()) return 'superseded';
      console.error('[useTileConfig] Failed to fetch tile config', err);
      setLastLoad({ profileKey, ok: false });
      setTileOrder([...ACTIVITY_NAMES]);
      setTileSizes(getDefaultTileSizes());
      if (isReadOnly) {
        // On error viewing other user, use clean defaults
        setHiddenTiles([]);
        setTileColors({});
        setCustomTiles([]);
      }
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
