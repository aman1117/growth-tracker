import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { STORAGE_KEYS } from '../../../constants';
import { gl } from '../../../services/goodlogs';
import { makeCustomTile } from '../../../test/fixtures/dashboard';
import type { ActivityName, CustomTile } from '../../../types';
import type { TileSize } from '../../ActivityTile';
import { useEditMode } from './useEditMode';

interface Config {
  isReadOnly: boolean;
  tileOrder: ActivityName[];
  tileSizes: Record<ActivityName, TileSize>;
  hiddenTiles: ActivityName[];
  customTiles: CustomTile[];
  tileColors: Record<string, string>;
}

const guitar = makeCustomTile();
const initialConfig: Config = {
  isReadOnly: false,
  tileOrder: ['sleep', 'study', 'custom:guitar-1'],
  tileSizes: { sleep: 'medium', study: 'wide' } as Record<ActivityName, TileSize>,
  hiddenTiles: ['eating'],
  customTiles: [guitar],
  tileColors: { sleep: '#123456' },
};

function renderEditMode(config: Partial<Config> = {}) {
  const setters = {
    setTileOrder: vi.fn(),
    setTileSizes: vi.fn(),
    setHiddenTiles: vi.fn(),
    setCustomTiles: vi.fn(),
    setTileColors: vi.fn(),
    saveTileConfigToBackend: vi.fn().mockResolvedValue(undefined),
  };
  const view = renderHook((props: Config) => useEditMode({ ...props, ...setters }), {
    initialProps: { ...initialConfig, ...config },
  });
  return { ...view, ...setters };
}

const toggleFromNavBar = () => act(() => void window.dispatchEvent(new Event('toggleEditMode')));

describe('useEditMode', () => {
  it('starts outside edit mode with no selection', () => {
    const { result } = renderEditMode();

    expect(result.current.isEditMode).toBe(false);
    expect(result.current.selectedTile).toBeNull();
  });

  it('snapshots the current layout when entering edit mode', () => {
    const { result } = renderEditMode();

    act(() => result.current.setSelectedTile('sleep'));
    act(() => result.current.enterEditMode());

    expect(result.current.isEditMode).toBe(true);
    expect(result.current.selectedTile).toBeNull();
    expect(result.current.originalTileOrder).toEqual(initialConfig.tileOrder);
    expect(result.current.originalTileSizes).toEqual(initialConfig.tileSizes);
    expect(result.current.originalHiddenTiles).toEqual(initialConfig.hiddenTiles);
    expect(result.current.originalCustomTiles).toEqual([guitar]);
  });

  it('keeps the first snapshot if edit mode is requested again', () => {
    const { result, rerender } = renderEditMode();

    act(() => result.current.enterEditMode());
    rerender({ ...initialConfig, tileOrder: ['study', 'sleep'] });
    act(() => result.current.enterEditMode());

    expect(result.current.originalTileOrder).toEqual(initialConfig.tileOrder);
  });

  it('never enters edit mode on another user’s dashboard', () => {
    const { result } = renderEditMode({ isReadOnly: true });

    act(() => result.current.enterEditMode());
    toggleFromNavBar();

    expect(result.current.isEditMode).toBe(false);
  });

  it('restores the snapshot (and local storage) without touching the server when nothing was saved', () => {
    const { result, rerender, ...setters } = renderEditMode();

    act(() => result.current.enterEditMode());
    rerender({ ...initialConfig, tileOrder: ['study', 'sleep'], hiddenTiles: [] });
    act(() => result.current.setSelectedTile('study'));
    act(() => result.current.cancelEditMode());

    expect(setters.setTileOrder).toHaveBeenCalledWith(initialConfig.tileOrder);
    expect(setters.setTileSizes).toHaveBeenCalledWith(initialConfig.tileSizes);
    expect(setters.setHiddenTiles).toHaveBeenCalledWith(['eating']);
    expect(setters.setCustomTiles).toHaveBeenCalledWith([guitar]);
    expect(setters.setTileColors).toHaveBeenCalledWith({ sleep: '#123456' });
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.TILE_ORDER)!)).toEqual(
      initialConfig.tileOrder
    );
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.TILE_SIZES)!)).toEqual(
      initialConfig.tileSizes
    );
    expect(setters.saveTileConfigToBackend).not.toHaveBeenCalled();
    expect(result.current.isEditMode).toBe(false);
    expect(result.current.selectedTile).toBeNull();
  });

  it('saves the current layout to the backend when editing is done', () => {
    const { result, rerender, saveTileConfigToBackend } = renderEditMode();
    const edited = { ...initialConfig, tileOrder: ['study', 'sleep'] as ActivityName[] };

    act(() => result.current.enterEditMode());
    rerender(edited);
    act(() => result.current.saveEditMode());

    expect(saveTileConfigToBackend).toHaveBeenCalledWith(
      edited.tileOrder,
      edited.tileSizes,
      edited.hiddenTiles,
      edited.tileColors,
      edited.customTiles
    );
    expect(result.current.isEditMode).toBe(false);
  });

  describe('changes saved to the server while editing', () => {
    const piano = makeCustomTile({ id: 'piano-1', name: 'Piano' });
    const withPiano: Config = {
      ...initialConfig,
      tileOrder: [...initialConfig.tileOrder, 'custom:piano-1'],
      customTiles: [guitar, piano],
    };
    const saveWithPiano = (persist: ReturnType<typeof useEditMode>['persistTileConfig']) =>
      persist(
        withPiano.tileOrder,
        withPiano.tileSizes,
        withPiano.hiddenTiles,
        withPiano.tileColors,
        withPiano.customTiles
      );

    it('are passed straight to the backend', async () => {
      const { result, saveTileConfigToBackend } = renderEditMode();
      act(() => result.current.enterEditMode());

      await expect(saveWithPiano(result.current.persistTileConfig)).resolves.toBeUndefined();

      expect(saveTileConfigToBackend).toHaveBeenCalledTimes(1);
      expect(saveTileConfigToBackend).toHaveBeenCalledWith(
        withPiano.tileOrder,
        withPiano.tileSizes,
        withPiano.hiddenTiles,
        withPiano.tileColors,
        withPiano.customTiles
      );
    });

    it('are reverted on the server when editing is cancelled', () => {
      const { result, rerender, saveTileConfigToBackend } = renderEditMode();
      act(() => result.current.enterEditMode());
      act(() => void saveWithPiano(result.current.persistTileConfig));
      rerender(withPiano);

      act(() => result.current.cancelEditMode());

      expect(saveTileConfigToBackend).toHaveBeenCalledTimes(2);
      expect(saveTileConfigToBackend).toHaveBeenLastCalledWith(
        initialConfig.tileOrder,
        initialConfig.tileSizes,
        initialConfig.hiddenTiles,
        initialConfig.tileColors,
        initialConfig.customTiles
      );
      expect(gl.debug).toHaveBeenCalledWith('tile_config_reverted', {
        metadata: { trigger: 'edit_cancelled' },
      });
      expect(result.current.isEditMode).toBe(false);
    });

    it('are not reverted again by a later editing session', () => {
      const { result, rerender, saveTileConfigToBackend } = renderEditMode();
      act(() => result.current.enterEditMode());
      act(() => void saveWithPiano(result.current.persistTileConfig));
      rerender(withPiano);
      act(() => result.current.saveEditMode());
      expect(saveTileConfigToBackend).toHaveBeenCalledTimes(2);

      act(() => result.current.enterEditMode());
      act(() => result.current.cancelEditMode());
      act(() => result.current.enterEditMode());
      act(() => result.current.cancelEditMode());

      expect(saveTileConfigToBackend).toHaveBeenCalledTimes(2);
      expect(gl.debug).not.toHaveBeenCalled();
    });
  });

  it('toggles edit mode from the navigation bar event', () => {
    const { result } = renderEditMode();

    toggleFromNavBar();
    expect(result.current.isEditMode).toBe(true);

    act(() => result.current.setSelectedTile('sleep'));
    toggleFromNavBar();
    expect(result.current.isEditMode).toBe(false);
    expect(result.current.selectedTile).toBeNull();
  });

  it('stops listening for the navigation bar event after unmount', () => {
    const { result, unmount } = renderEditMode();
    unmount();

    toggleFromNavBar();

    expect(result.current.isEditMode).toBe(false);
  });
});
