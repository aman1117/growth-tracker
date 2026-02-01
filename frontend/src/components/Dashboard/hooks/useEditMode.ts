/**
 * useEditMode Hook
 *
 * Manages edit mode state for tile customization including
 * entering, canceling, and saving edit mode changes.
 */

import { useCallback, useEffect, useState } from 'react';

import type { ActivityName, CustomTile } from '../../../types';
import type { TileSize } from '../../ActivityTile';
import { saveTileOrder, saveTileSizes } from '../Dashboard.constants';

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
  saveTileConfigToBackend: (
    order: ActivityName[],
    sizes: Record<ActivityName, TileSize>,
    hidden: ActivityName[],
    colors: Record<string, string>,
    customTilesList: CustomTile[]
  ) => Promise<void>;
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

  const enterEditMode = useCallback(() => {
    if (!isReadOnly && !isEditMode) {
      setOriginalTileOrder([...tileOrder]);
      setOriginalTileSizes({ ...tileSizes });
      setOriginalHiddenTiles([...hiddenTiles]);
      setOriginalCustomTiles([...customTiles]);
      setOriginalTileColors({ ...tileColors });
      setIsEditMode(true);
      setSelectedTile(null);
    }
  }, [isReadOnly, isEditMode, tileOrder, tileSizes, hiddenTiles, customTiles, tileColors]);

  const cancelEditMode = useCallback(() => {
    // Restore original state
    setTileOrder(originalTileOrder);
    setTileSizes(originalTileSizes);
    setHiddenTiles(originalHiddenTiles);
    setCustomTiles(originalCustomTiles);
    setTileColors(originalTileColors);
    saveTileOrder(originalTileOrder);
    saveTileSizes(originalTileSizes);
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
  };
};
