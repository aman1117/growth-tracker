import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { STORAGE_KEYS } from '../../../constants';
import { gl } from '../../../services/goodlogs';
import { createDeferred, makeCustomTile } from '../../../test/fixtures/dashboard';
import type { ActivityName, CustomTile } from '../../../types';
import type { TileSize } from '../../ActivityTile';
import { useEditMode } from './useEditMode';
import type { TileConfigLoadResult, TileConfigStatus } from './useTileConfig';

interface Config {
  isReadOnly: boolean;
  tileOrder: ActivityName[];
  tileSizes: Record<ActivityName, TileSize>;
  hiddenTiles: ActivityName[];
  customTiles: CustomTile[];
  tileColors: Record<string, string>;
  configStatus?: TileConfigStatus;
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

function renderEditMode(
  config: Partial<Config> = {},
  extraProps: Partial<Parameters<typeof useEditMode>[0]> = {}
) {
  const setters = {
    setTileOrder: vi.fn(),
    setTileSizes: vi.fn(),
    setHiddenTiles: vi.fn(),
    setCustomTiles: vi.fn(),
    setTileColors: vi.fn(),
    saveTileConfigToBackend: vi.fn().mockResolvedValue(undefined),
  };
  const view = renderHook((props: Config) => useEditMode({ ...props, ...setters, ...extraProps }), {
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

  describe('before the tiles have loaded', () => {
    const defaults: Config = {
      ...initialConfig,
      tileOrder: ['sleep', 'study', 'eating'],
      hiddenTiles: [],
      customTiles: [],
      tileColors: {},
      configStatus: 'loading',
    };

    it('waits for the load before entering edit mode, then snapshots the loaded tiles', () => {
      const { result, rerender } = renderEditMode(defaults);

      toggleFromNavBar();
      toggleFromNavBar();
      expect(result.current.isEditMode).toBe(false);

      rerender({ ...initialConfig, configStatus: 'loaded' });

      expect(result.current.isEditMode).toBe(true);
      expect(result.current.originalTileOrder).toEqual(initialConfig.tileOrder);
      expect(result.current.originalCustomTiles).toEqual([guitar]);
    });

    it('drops the request if the dashboard shown is no longer ours when loading ends', () => {
      const { result, rerender } = renderEditMode(defaults);
      act(() => result.current.enterEditMode());

      rerender({ ...initialConfig, isReadOnly: true, configStatus: 'loaded' });
      rerender({ ...initialConfig, configStatus: 'loaded' });

      expect(result.current.isEditMode).toBe(false);
    });
  });

  describe('after a failed load', () => {
    const failed: Config = {
      ...initialConfig,
      tileOrder: ['sleep', 'study', 'eating'],
      customTiles: [],
      configStatus: 'failed',
    };

    it('loads the tiles again before entering edit mode, then snapshots the fresh tiles', async () => {
      const reload = createDeferred<TileConfigLoadResult>();
      const reloadTileConfig = vi.fn(() => reload.promise);
      const onTilesUnavailable = vi.fn();
      const { result, rerender } = renderEditMode(failed, {
        reloadTileConfig,
        onTilesUnavailable,
      });

      toggleFromNavBar();
      expect(result.current.isEditMode).toBe(false);
      rerender({ ...failed, configStatus: 'loading' });
      // Asking again while the tiles reload does not start another load
      toggleFromNavBar();
      rerender({ ...initialConfig, configStatus: 'loaded' });
      await act(async () => reload.resolve('loaded'));

      expect(reloadTileConfig).toHaveBeenCalledTimes(1);
      expect(gl.debug).toHaveBeenCalledWith('tile_config_reload', {
        metadata: { reason: 'edit_mode_requested' },
      });
      expect(result.current.isEditMode).toBe(true);
      expect(result.current.originalTileOrder).toEqual(initialConfig.tileOrder);
      expect(result.current.originalCustomTiles).toEqual([guitar]);
      expect(onTilesUnavailable).not.toHaveBeenCalled();
    });

    it('stays out of edit mode and says so when the tiles still cannot load; asking again retries', async () => {
      const reloadTileConfig = vi.fn(async (): Promise<TileConfigLoadResult> => 'failed');
      const onTilesUnavailable = vi.fn();
      const { result } = renderEditMode(failed, { reloadTileConfig, onTilesUnavailable });

      await act(async () => result.current.enterEditMode());

      expect(onTilesUnavailable).toHaveBeenCalledTimes(1);
      expect(result.current.isEditMode).toBe(false);

      await act(async () => result.current.enterEditMode());

      expect(reloadTileConfig).toHaveBeenCalledTimes(2);
      expect(onTilesUnavailable).toHaveBeenCalledTimes(2);
      expect(result.current.isEditMode).toBe(false);
    });

    it('loads the tiles again once when the load a request was waiting for fails', () => {
      const reloadTileConfig = vi.fn(async (): Promise<TileConfigLoadResult> => 'loaded');
      const { result, rerender } = renderEditMode(
        { ...failed, configStatus: 'loading' },
        { reloadTileConfig }
      );
      toggleFromNavBar();

      rerender({ ...failed });
      expect(reloadTileConfig).toHaveBeenCalledTimes(1);
      expect(result.current.isEditMode).toBe(false);
      rerender({ ...initialConfig, configStatus: 'loaded' });

      expect(result.current.isEditMode).toBe(true);
      expect(result.current.originalTileOrder).toEqual(initialConfig.tileOrder);
    });

    it('says so when a newer load replaced the reload and failed too; asking again retries', async () => {
      const reloadTileConfig = vi.fn(async (): Promise<TileConfigLoadResult> => 'superseded');
      const onTilesUnavailable = vi.fn();
      const { result, rerender } = renderEditMode(failed, { reloadTileConfig, onTilesUnavailable });

      await act(async () => result.current.enterEditMode());
      rerender({ ...failed, configStatus: 'loading' });
      rerender({ ...failed });

      expect(onTilesUnavailable).toHaveBeenCalledTimes(1);
      expect(result.current.isEditMode).toBe(false);

      await act(async () => result.current.enterEditMode());

      expect(reloadTileConfig).toHaveBeenCalledTimes(2);
    });

    it('ignores a reload that a newer load replaced', async () => {
      const reloadTileConfig = vi.fn(async (): Promise<TileConfigLoadResult> => 'superseded');
      const onTilesUnavailable = vi.fn();
      const { result } = renderEditMode(failed, { reloadTileConfig, onTilesUnavailable });

      await act(async () => result.current.enterEditMode());

      expect(onTilesUnavailable).not.toHaveBeenCalled();
      expect(result.current.isEditMode).toBe(false);

      // Never a dead end: asking again while the tiles are still failed loads them again
      await act(async () => result.current.enterEditMode());

      expect(reloadTileConfig).toHaveBeenCalledTimes(2);
    });

    it('never enters with tiles that did not load when it cannot load them again', async () => {
      const onTilesUnavailable = vi.fn();
      const { result } = renderEditMode(failed, { onTilesUnavailable });

      await act(async () => result.current.enterEditMode());

      expect(result.current.isEditMode).toBe(false);
      expect(onTilesUnavailable).toHaveBeenCalledTimes(1);
    });

    it('treats a reload that throws as a failed load', async () => {
      const reloadTileConfig = vi.fn(() => Promise.reject(new Error('boom')));
      const onTilesUnavailable = vi.fn();
      const { result } = renderEditMode(failed, { reloadTileConfig, onTilesUnavailable });

      await act(async () => result.current.enterEditMode());

      expect(onTilesUnavailable).toHaveBeenCalledTimes(1);
      expect(result.current.isEditMode).toBe(false);
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
