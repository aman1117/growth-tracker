import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { STORAGE_KEYS } from '../../../constants';
import { api } from '../../../services/api';
import { createDeferred, makeCustomTile, routeApi } from '../../../test/fixtures/dashboard';
import { ACTIVITY_NAMES, type ActivityName } from '../../../types';
import type { TileSize } from '../../ActivityTile';
import { getDefaultTileSizes } from '../Dashboard.constants';
import { useTileConfig } from './useTileConfig';

vi.mock('../../../services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/api')>()),
  api: { get: vi.fn(), post: vi.fn() },
}));

interface Props {
  isReadOnly: boolean;
  targetUsername: string | undefined;
}

const guitar = makeCustomTile();
const defaultOrder = [...ACTIVITY_NAMES];
const sizes = { ...getDefaultTileSizes(), idle: 'wide' } as Record<ActivityName, TileSize>;
const own: Props = { isReadOnly: false, targetUsername: 'alice' };
const bobs: Props = { isReadOnly: true, targetUsername: 'bob' };

function renderTileConfig(props: Props = own) {
  const firstLoadingStates: boolean[] = [];
  const view = renderHook(
    (p: Props) => {
      const config = useTileConfig(p);
      firstLoadingStates.push(config.configLoading);
      return config;
    },
    { initialProps: props }
  );
  return { ...view, firstLoadingStates };
}

const stored = (key: string) => JSON.parse(localStorage.getItem(key) ?? 'null');

function saveLocalConfig() {
  localStorage.setItem(STORAGE_KEYS.TILE_ORDER, JSON.stringify(['study', 'sleep']));
  localStorage.setItem(STORAGE_KEYS.TILE_SIZES, JSON.stringify(sizes));
  localStorage.setItem(STORAGE_KEYS.TILE_HIDDEN, JSON.stringify(['eating']));
  localStorage.setItem(STORAGE_KEYS.TILE_COLORS, JSON.stringify({ sleep: '#111111' }));
  localStorage.setItem(STORAGE_KEYS.CUSTOM_TILES, JSON.stringify([guitar]));
}

const fullConfig = {
  order: ['custom:guitar-1', 'nap', ...ACTIVITY_NAMES],
  sizes,
  hidden: ['reels'],
  colors: { study: '#222222' },
  customTiles: [guitar],
};

describe('useTileConfig', () => {
  describe('own dashboard', () => {
    it('shows the loading state first only when nothing is saved locally', () => {
      routeApi(api, { 'GET /tile-config': createDeferred().promise });
      expect(renderTileConfig().firstLoadingStates[0]).toBe(true);

      saveLocalConfig();
      expect(renderTileConfig().firstLoadingStates[0]).toBe(false);
    });

    it('restores the locally saved layout while the backend config loads', () => {
      saveLocalConfig();
      routeApi(api, { 'GET /tile-config': createDeferred().promise });

      const { result } = renderTileConfig();

      expect(api.get).toHaveBeenCalledWith('/tile-config');
      expect(result.current.configLoading).toBe(true);
      expect(result.current.tileOrder).toEqual(['study', 'sleep']);
      expect(result.current.tileSizes).toEqual(sizes);
      expect(result.current.hiddenTiles).toEqual(['eating']);
      expect(result.current.tileColors).toEqual({ sleep: '#111111' });
      expect(result.current.customTiles).toEqual([guitar]);
      expect(result.current.visibleTiles).toEqual(['study', 'sleep']);
    });

    it('applies the backend config, dropping unknown tiles, and saves it locally', async () => {
      routeApi(api, { 'GET /tile-config': { success: true, data: fullConfig } });

      const { result } = renderTileConfig();
      await waitFor(() => expect(result.current.configLoading).toBe(false));

      const validOrder = ['custom:guitar-1', ...ACTIVITY_NAMES];
      expect(result.current.tileOrder).toEqual(validOrder);
      expect(result.current.tileSizes).toEqual(sizes);
      expect(result.current.hiddenTiles).toEqual(['reels']);
      expect(result.current.tileColors).toEqual({ study: '#222222' });
      expect(result.current.customTiles).toEqual([guitar]);
      expect(result.current.visibleTiles).not.toContain('reels');
      expect(stored(STORAGE_KEYS.TILE_ORDER)).toEqual(validOrder);
      expect(stored(STORAGE_KEYS.TILE_SIZES)).toEqual(sizes);
      expect(stored(STORAGE_KEYS.TILE_HIDDEN)).toEqual(['reels']);
      expect(stored(STORAGE_KEYS.TILE_COLORS)).toEqual({ study: '#222222' });
      expect(stored(STORAGE_KEYS.CUSTOM_TILES)).toEqual([guitar]);
    });

    it('uses the default order and sizes when the backend config omits them', async () => {
      saveLocalConfig();
      routeApi(api, { 'GET /tile-config': { success: true, data: {} } });

      const { result } = renderTileConfig();
      await waitFor(() => expect(result.current.configLoading).toBe(false));

      expect(result.current.tileOrder).toEqual(defaultOrder);
      expect(result.current.tileSizes).toEqual(getDefaultTileSizes());
      // Own extras are kept from local storage when the backend has none
      expect(result.current.hiddenTiles).toEqual(['eating']);
      expect(result.current.customTiles).toEqual([guitar]);
    });

    it('falls back to local extras and default layout when the backend has no config', async () => {
      saveLocalConfig();
      routeApi(api, { 'GET /tile-config': { success: false } });

      const { result } = renderTileConfig();
      await waitFor(() => expect(result.current.configLoading).toBe(false));

      expect(result.current.hiddenTiles).toEqual(['eating']);
      expect(result.current.tileColors).toEqual({ sleep: '#111111' });
      expect(result.current.customTiles).toEqual([guitar]);
      expect(result.current.tileOrder).toEqual(defaultOrder);
      expect(result.current.tileSizes).toEqual(getDefaultTileSizes());
    });

    it('starts clean when there is no config anywhere', async () => {
      routeApi(api, { 'GET /tile-config': { success: true, data: null } });

      const { result } = renderTileConfig();
      await waitFor(() => expect(result.current.configLoading).toBe(false));

      expect(result.current.hiddenTiles).toEqual([]);
      expect(result.current.tileColors).toEqual({});
      expect(result.current.customTiles).toEqual([]);
      expect(result.current.tileOrder).toEqual(defaultOrder);
    });

    it('logs corrupt local extras instead of crashing', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      localStorage.setItem(STORAGE_KEYS.TILE_HIDDEN, '{corrupt');
      routeApi(api, { 'GET /tile-config': { success: false } });

      const { result } = renderTileConfig();
      await waitFor(() => expect(result.current.configLoading).toBe(false));

      expect(error).toHaveBeenCalledWith(
        '[useTileConfig] Failed to restore from localStorage',
        expect.any(SyntaxError)
      );
      expect(error).toHaveBeenCalledWith(
        '[useTileConfig] Failed to load from localStorage',
        expect.any(SyntaxError)
      );
      expect(result.current.tileOrder).toEqual(defaultOrder);
    });

    it('shows the loading state and defaults when local storage is unavailable', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('SecurityError');
      });
      routeApi(api, { 'GET /tile-config': { success: false } });

      const { result, firstLoadingStates } = renderTileConfig();

      expect(firstLoadingStates[0]).toBe(true);
      await waitFor(() => expect(result.current.configLoading).toBe(false));
      expect(result.current.tileOrder).toEqual(defaultOrder);
      expect(result.current.tileSizes).toEqual(getDefaultTileSizes());
    });

    it('falls back to the default layout when the config request fails', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      saveLocalConfig();
      routeApi(api, { 'GET /tile-config': new Error('offline') });

      const { result } = renderTileConfig();
      await waitFor(() => expect(result.current.configLoading).toBe(false));

      expect(error).toHaveBeenCalledWith(
        '[useTileConfig] Failed to fetch tile config',
        expect.any(Error)
      );
      expect(result.current.tileOrder).toEqual(defaultOrder);
      expect(result.current.tileSizes).toEqual(getDefaultTileSizes());
      expect(result.current.hiddenTiles).toEqual(['eating']);
    });
  });

  describe('another user’s dashboard', () => {
    it('starts from defaults (not our own saved layout) and loads their config', async () => {
      saveLocalConfig();
      routeApi(api, { 'POST /tile-config/user': { success: true, data: fullConfig } });

      const { result, firstLoadingStates } = renderTileConfig(bobs);

      expect(firstLoadingStates[0]).toBe(true);
      expect(result.current.tileOrder).toEqual(defaultOrder);
      await waitFor(() => expect(result.current.configLoading).toBe(false));

      expect(api.post).toHaveBeenCalledWith('/tile-config/user', { username: 'bob' });
      expect(result.current.tileOrder).toEqual(['custom:guitar-1', ...ACTIVITY_NAMES]);
      expect(result.current.hiddenTiles).toEqual(['reels']);
      expect(result.current.tileColors).toEqual({ study: '#222222' });
      expect(result.current.customTiles).toEqual([guitar]);
      // Our own saved layout is untouched
      expect(stored(STORAGE_KEYS.TILE_ORDER)).toEqual(['study', 'sleep']);
      expect(stored(STORAGE_KEYS.TILE_HIDDEN)).toEqual(['eating']);
    });

    it('clears extras their config does not define', async () => {
      routeApi(api, {
        'POST /tile-config/user': { success: true, data: { order: ['sleep'], sizes } },
      });

      const { result } = renderTileConfig(bobs);
      await waitFor(() => expect(result.current.configLoading).toBe(false));

      expect(result.current.tileOrder).toEqual(['sleep']);
      expect(result.current.hiddenTiles).toEqual([]);
      expect(result.current.tileColors).toEqual({});
      expect(result.current.customTiles).toEqual([]);
    });

    it.each([
      ['has no config', { success: true, data: null }],
      ['cannot be reached', new Error('offline')],
    ])('shows the default layout when their config %s', async (_label, response) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      routeApi(api, { 'POST /tile-config/user': response });

      const { result } = renderTileConfig(bobs);
      await waitFor(() => expect(result.current.configLoading).toBe(false));

      expect(result.current.tileOrder).toEqual(defaultOrder);
      expect(result.current.tileSizes).toEqual(getDefaultTileSizes());
      expect(result.current.hiddenTiles).toEqual([]);
      expect(result.current.tileColors).toEqual({});
      expect(result.current.customTiles).toEqual([]);
    });

    it('restores our own layout when navigating back to our dashboard', async () => {
      saveLocalConfig();
      routeApi(api, {
        'POST /tile-config/user': { success: true, data: fullConfig },
        'GET /tile-config': createDeferred().promise,
      });
      const { result, rerender } = renderTileConfig(bobs);
      await waitFor(() => expect(result.current.configLoading).toBe(false));

      rerender(own);

      expect(result.current.hiddenTiles).toEqual(['eating']);
      expect(result.current.tileOrder).toEqual(['study', 'sleep']);
      expect(result.current.customTiles).toEqual([guitar]);
    });
  });

  describe('saving', () => {
    it('saves the layout, omitting empty extras, and mirrors it locally', async () => {
      routeApi(api, {
        'GET /tile-config': { success: false },
        'POST /tile-config': { success: true },
      });
      const { result } = renderTileConfig();
      await waitFor(() => expect(result.current.configLoading).toBe(false));

      await act(() => result.current.saveTileConfigToBackend(['sleep'], sizes, [], {}, []));

      expect(api.post).toHaveBeenCalledWith('/tile-config', {
        config: {
          order: ['sleep'],
          sizes,
          hidden: undefined,
          colors: undefined,
          customTiles: undefined,
        },
      });
      expect(stored(STORAGE_KEYS.TILE_HIDDEN)).toEqual([]);
      expect(stored(STORAGE_KEYS.TILE_COLORS)).toEqual({});
      expect(stored(STORAGE_KEYS.CUSTOM_TILES)).toEqual([]);
    });

    it('includes hidden tiles, colors and custom tiles when present', async () => {
      routeApi(api, {
        'GET /tile-config': { success: false },
        'POST /tile-config': { success: true },
      });
      const { result } = renderTileConfig();
      await waitFor(() => expect(result.current.configLoading).toBe(false));

      await act(() =>
        result.current.saveTileConfigToBackend(
          ['sleep', 'custom:guitar-1'],
          sizes,
          ['study'],
          { sleep: '#333333' },
          [guitar]
        )
      );

      expect(api.post).toHaveBeenCalledWith('/tile-config', {
        config: {
          order: ['sleep', 'custom:guitar-1'],
          sizes,
          hidden: ['study'],
          colors: { sleep: '#333333' },
          customTiles: [guitar],
        },
      });
      expect(stored(STORAGE_KEYS.CUSTOM_TILES)).toEqual([guitar]);
    });

    it('logs a failed save and leaves local storage alone', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      routeApi(api, {
        'GET /tile-config': { success: false },
        'POST /tile-config': new Error('500'),
      });
      const { result } = renderTileConfig();
      await waitFor(() => expect(result.current.configLoading).toBe(false));

      await act(() => result.current.saveTileConfigToBackend(['sleep'], sizes, ['study'], {}, []));

      expect(error).toHaveBeenCalledWith(
        '[useTileConfig] Failed to save tile config to backend',
        expect.any(Error)
      );
      expect(localStorage.getItem(STORAGE_KEYS.TILE_HIDDEN)).toBeNull();
    });

    it('resizes a tile and remembers the size locally', async () => {
      routeApi(api, { 'GET /tile-config': { success: false } });
      const { result } = renderTileConfig();
      await waitFor(() => expect(result.current.configLoading).toBe(false));

      act(() => result.current.handleTileResize('sleep', 'small'));

      expect(result.current.tileSizes.sleep).toBe('small');
      expect(stored(STORAGE_KEYS.TILE_SIZES).sleep).toBe('small');
    });
  });
});
