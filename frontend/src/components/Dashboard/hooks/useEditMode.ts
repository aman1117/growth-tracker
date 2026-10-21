/**
 * useEditMode Hook
 *
 * Manages edit mode state for tile customization including
 * entering, canceling, and saving edit mode changes.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { gl } from '../../../services/goodlogs';
import type { ActivityName, CustomTile } from '../../../types';
import type { TileSize } from '../../ActivityTile';
import { saveTileOrder, saveTileSizes } from '../Dashboard.constants';
import type { TileConfigLoadResult, TileConfigStatus } from './useTileConfig';

type SaveTileConfig = (
  order: ActivityName[],
  sizes: Record<ActivityName, TileSize>,
  hidden: ActivityName[],
  colors: Record<string, string>,
  customTilesList: CustomTile[]
) => Promise<void>;

/** A request to enter edit mode that waits for the tiles: their load, or a reload after a failure */
type EntryRequest = 'none' | 'waiting' | 'reloading';

/** Without a way to reload, tiles that failed to load stay failed */
const noReload = async (): Promise<TileConfigLoadResult> => 'failed';

interface UseEditModeProps {
  isReadOnly: boolean;
  tileOrder: ActivityName[];
  tileSizes: Record<ActivityName, TileSize>;
  hiddenTiles: ActivityName[];
  customTiles: CustomTile[];
  tileColors: Record<string, string>;
  setTileOrder: React.Dispatch<React.SetStateAction<ActivityName[]>>;
  setTileSizes: React.Dispatch<React.SetStateAction<Record<ActivityName, TileSize>>>;
  setHiddenTiles: React.Dispatch<React.SetStateAction<ActivityName[]>>;
  setCustomTiles: React.Dispatch<React.SetStateAction<CustomTile[]>>;
  setTileColors: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  saveTileConfigToBackend: SaveTileConfig;
  /**
   * Whether the tiles shown are the loaded server config. Edit mode is only entered on 'loaded'
   * tiles: a request made while 'loading' waits, and one made after 'failed' reloads them first.
   */
  configStatus?: TileConfigStatus;
  /** Loads the tiles again; used once per request when they failed to load */
  reloadTileConfig?: () => Promise<TileConfigLoadResult>;
  /** Edit mode was requested but the tiles could not be loaded, even after reloading them */
  onTilesUnavailable?: () => void;
}

interface UseEditModeReturn {
  isEditMode: boolean;
  setIsEditMode: React.Dispatch<React.SetStateAction<boolean>>;
  selectedTile: ActivityName | null;
  setSelectedTile: React.Dispatch<React.SetStateAction<ActivityName | null>>;
  originalTileOrder: ActivityName[];
  originalTileSizes: Record<ActivityName, TileSize>;
  originalHiddenTiles: ActivityName[];
  originalCustomTiles: CustomTile[];
  enterEditMode: () => void;
  cancelEditMode: () => void;
  saveEditMode: () => void;
  /**
   * Saves the tile config to the server right away (custom tile, restore and delete changes),
   * remembering it so that Cancel can put the original config back.
   */
  persistTileConfig: SaveTileConfig;
}

export const useEditMode = ({
  isReadOnly,
  tileOrder,
  tileSizes,
  hiddenTiles,
  customTiles,
  tileColors,
  setTileOrder,
  setTileSizes,
  setHiddenTiles,
  setCustomTiles,
  setTileColors,
  saveTileConfigToBackend,
  configStatus = 'loaded',
  reloadTileConfig = noReload,
  onTilesUnavailable,
}: UseEditModeProps): UseEditModeReturn => {
  const [isEditMode, setIsEditMode] = useState(false);
  const [selectedTile, setSelectedTile] = useState<ActivityName | null>(null);

  // Store original values when entering edit mode (for cancel)
  const [originalTileOrder, setOriginalTileOrder] = useState<ActivityName[]>([]);
  const [originalTileSizes, setOriginalTileSizes] = useState<Record<ActivityName, TileSize>>(
    {} as Record<ActivityName, TileSize>
  );
  const [originalHiddenTiles, setOriginalHiddenTiles] = useState<ActivityName[]>([]);
  const [originalCustomTiles, setOriginalCustomTiles] = useState<CustomTile[]>([]);
  const [originalTileColors, setOriginalTileColors] = useState<Record<string, string>>({});
  // Whether this editing session already saved changes to the server (Cancel must undo them)
  const savedDuringEditRef = useRef(false);
  // Edit mode requested before the tiles were loaded: entered once they are
  const entryRequestRef = useRef<EntryRequest>('none');

  // Tiles that failed to load are loaded again once per request; edit mode opens if they arrive
  const reloadThenEnter = useCallback(() => {
    entryRequestRef.current = 'reloading';
    gl.debug('tile_config_reload', { metadata: { reason: 'edit_mode_requested' } });
    reloadTileConfig()
      .catch((): TileConfigLoadResult => 'failed')
      .then((result) => {
        if (result !== 'failed' || entryRequestRef.current !== 'reloading') return;
        entryRequestRef.current = 'none';
        onTilesUnavailable?.();
      });
  }, [reloadTileConfig, onTilesUnavailable]);

  const enterEditMode = useCallback(() => {
    if (isReadOnly || isEditMode) return;
    // A snapshot now would hold defaults, another profile's tiles or a failed load's tiles
    if (configStatus === 'loading') {
      // The load under way decides (a request that is reloading keeps its single retry)
      if (entryRequestRef.current === 'none') entryRequestRef.current = 'waiting';
      return;
    }
    if (configStatus === 'failed') {
      reloadThenEnter();
      return;
    }
    entryRequestRef.current = 'none';
    setOriginalTileOrder([...tileOrder]);
    setOriginalTileSizes({ ...tileSizes });
    setOriginalHiddenTiles([...hiddenTiles]);
    setOriginalCustomTiles([...customTiles]);
    setOriginalTileColors({ ...tileColors });
    savedDuringEditRef.current = false;
    setIsEditMode(true);
    setSelectedTile(null);
  }, [
    isReadOnly,
    isEditMode,
    configStatus,
    reloadThenEnter,
    tileOrder,
    tileSizes,
    hiddenTiles,
    customTiles,
    tileColors,
  ]);

  // Once loading ends, a waiting request enters on loaded tiles or reloads failed ones once
  useEffect(() => {
    const request = entryRequestRef.current;
    if (request === 'none' || configStatus === 'loading') return;
    if (configStatus === 'loaded' || isReadOnly) {
      entryRequestRef.current = 'none';
      enterEditMode();
    } else if (request === 'waiting') {
      reloadThenEnter();
    } else {
      // The reload failed, or a newer load that replaced it did
      entryRequestRef.current = 'none';
      onTilesUnavailable?.();
    }
  }, [configStatus, isReadOnly, enterEditMode, reloadThenEnter, onTilesUnavailable]);

  const persistTileConfig = useCallback<SaveTileConfig>(
    (order, sizes, hidden, colors, customTilesList) => {
      savedDuringEditRef.current = true;
      return saveTileConfigToBackend(order, sizes, hidden, colors, customTilesList);
    },
    [saveTileConfigToBackend]
  );

  const cancelEditMode = useCallback(() => {
    // Restore original state
    setTileOrder(originalTileOrder);
    setTileSizes(originalTileSizes);
    setHiddenTiles(originalHiddenTiles);
    setCustomTiles(originalCustomTiles);
    setTileColors(originalTileColors);
    saveTileOrder(originalTileOrder);
    saveTileSizes(originalTileSizes);
    // Put the original config back on the server if this session already saved changes there
    if (savedDuringEditRef.current) {
      savedDuringEditRef.current = false;
      gl.debug('tile_config_reverted', { metadata: { trigger: 'edit_cancelled' } });
      saveTileConfigToBackend(
        originalTileOrder,
        originalTileSizes,
        originalHiddenTiles,
        originalTileColors,
        originalCustomTiles
      );
    }
    setIsEditMode(false);
    setSelectedTile(null);
  }, [
    originalTileOrder,
    originalTileSizes,
    originalHiddenTiles,
    originalCustomTiles,
    originalTileColors,
    setTileOrder,
    setTileSizes,
    setHiddenTiles,
    setCustomTiles,
    setTileColors,
    saveTileConfigToBackend,
  ]);

  const saveEditMode = useCallback(() => {
    saveTileConfigToBackend(tileOrder, tileSizes, hiddenTiles, tileColors, customTiles);
    setIsEditMode(false);
    setSelectedTile(null);
  }, [tileOrder, tileSizes, hiddenTiles, tileColors, customTiles, saveTileConfigToBackend]);

  // Listen for edit mode toggle from nav bar
  useEffect(() => {
    const handleToggleEditMode = () => {
      if (!isReadOnly) {
        if (!isEditMode) {
          enterEditMode();
        } else {
          setIsEditMode(false);
          setSelectedTile(null);
        }
      }
    };

    window.addEventListener('toggleEditMode', handleToggleEditMode);
    return () => window.removeEventListener('toggleEditMode', handleToggleEditMode);
  }, [isEditMode, isReadOnly, enterEditMode]);

  return {
    isEditMode,
    setIsEditMode,
    selectedTile,
    setSelectedTile,
    originalTileOrder,
    originalTileSizes,
    originalHiddenTiles,
    originalCustomTiles,
    enterEditMode,
    cancelEditMode,
    saveEditMode,
    persistTileConfig,
  };
};
