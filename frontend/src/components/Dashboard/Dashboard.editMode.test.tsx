import { act, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { STORAGE_KEYS } from '../../constants';
import { api, commentApi, likeApi } from '../../services/api';
import { gl } from '../../services/goodlogs';
import {
  ALICE,
  dashboardRoutes,
  FIXED_TODAY,
  makeActivity,
  makeCustomTile,
  makeCustomTiles,
  mockQuietSocial,
  resetStoryStubs,
  routeApi,
  stubTileLayout,
} from '../../test/fixtures/dashboard';
import { renderWithRouter, signIn } from '../../test/utils';
import type { CustomTile } from '../../types';
import { TAB_RESELECT_EVENT } from '../../utils/navigation';
import { Dashboard } from '.';
import { UNDO_TIMEOUT_DURATION } from './Dashboard.constants';

vi.mock('../../services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/api')>()),
  api: { get: vi.fn(), post: vi.fn() },
  likeApi: { getLikes: vi.fn(), likeDay: vi.fn(), unlikeDay: vi.fn() },
  commentApi: { getCommentCount: vi.fn(), getComments: vi.fn() },
}));
vi.mock('../story', async () => {
  const { StoryCirclesRowStub, StoryViewerStub } = await import('../../test/fixtures/dashboard');
  return { StoryCirclesRow: StoryCirclesRowStub, StoryViewer: StoryViewerStub };
});
vi.mock('../ui', async (importOriginal) => {
  const { PullToRefreshStub } = await import('../../test/fixtures/dashboard');
  return {
    ...(await importOriginal<typeof import('../ui')>()),
    PullToRefreshWrapper: PullToRefreshStub,
  };
});
vi.mock('../../utils/sounds', () => ({ playActivitySound: vi.fn(), playCompletionSound: vi.fn() }));
vi.mock('canvas-confetti', () => ({ default: vi.fn() }));

// The theme store (store barrel) reads matchMedia when its module loads, before the shared
// setup stubs it for each test.
await vi.hoisted(async () => {
  const { createMatchMedia } = await import('../../test/browser-mocks');
  vi.stubGlobal('matchMedia', createMatchMedia());
});

interface SavedConfig {
  order: string[];
  sizes: Record<string, string>;
  hidden?: string[];
  colors?: Record<string, string>;
  customTiles?: CustomTile[];
}

const guitar = makeCustomTile();
const piano = makeCustomTile({ id: 'piano-1', name: 'Piano', icon: 'Music', color: '#0ea5e9' });
const sizes = { sleep: 'medium', study: 'wide', eating: 'small', 'custom:guitar-1': 'small' };
/** Alice's saved layout: three predefined tiles and her Guitar tile. */
const layout = {
  order: ['sleep', 'study', 'eating', 'custom:guitar-1'],
  sizes,
  customTiles: [guitar],
};

function useLayout(config: Partial<SavedConfig> = {}) {
  routeApi(
    api,
    dashboardRoutes({
      'POST /get-activities': { success: true, data: [makeActivity({ name: 'sleep', hours: 8 })] },
      'GET /tile-config': { success: true, data: { ...layout, ...config } },
    })
  );
}

/** Renders alice's day and enters edit mode the way the navigation bar does. */
async function renderEditMode() {
  const view = renderWithRouter(<Dashboard />, { route: '/', path: '/' });
  await screen.findByRole('button', { name: 'Sleep, 8 hours' });
  toggleEditMode();
  screen.getByRole('toolbar', { name: 'Customize tiles' });
  return view;
}

const toggleEditMode = () => act(() => void window.dispatchEvent(new Event('toggleEditMode')));
const button = (name: string | RegExp) => screen.getByRole('button', { name });
const queryButton = (name: string | RegExp) => screen.queryByRole('button', { name });
const toolbar = () => screen.queryByRole('toolbar', { name: 'Customize tiles' });
const undoToast = () => queryButton('Undo')?.closest('[role="status"]') ?? null;
const savedConfigs = () =>
  vi
    .mocked(api.post)
    .mock.calls.filter(([endpoint]) => endpoint === '/tile-config')
    .map(([, body]) => (body as { config: SavedConfig }).config);
const lastSavedConfig = () => savedConfigs().at(-1);
const storedSizes = () => JSON.parse(localStorage.getItem(STORAGE_KEYS.TILE_SIZES) ?? '{}');
const storedCustomTiles = () => JSON.parse(localStorage.getItem(STORAGE_KEYS.CUSTOM_TILES) ?? '[]');

describe('Dashboard edit mode', () => {
  beforeEach(() => {
    vi.setSystemTime(FIXED_TODAY);
    // Overlay history logs its steps with console.debug in development builds
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    signIn(ALICE);
    useLayout();
    mockQuietSocial({ likeApi, commentApi });
    resetStoryStubs();
  });

  describe('entering and leaving', () => {
    it('swaps logging for customizing, and Cancel returns to the day', async () => {
      const { user } = await renderEditMode();

      // The summary collapses (hidden from assistive tech) and stories step aside
      expect(screen.queryByRole('region', { name: 'Today summary' })).not.toBeInTheDocument();
      expect(screen.queryByRole('region', { name: 'Stories' })).not.toBeInTheDocument();
      expect(button('Pull to refresh')).toBeDisabled();

      await user.click(button('Sleep, large tile. Activate to select'));
      expect(screen.queryByRole('dialog', { name: 'Log Sleep' })).not.toBeInTheDocument();
      expect(button('Sleep, large tile, selected. Activate to resize')).toHaveAttribute(
        'aria-pressed',
        'true'
      );

      await user.click(button('Cancel'));

      expect(toolbar()).not.toBeInTheDocument();
      expect(button('Sleep, 8 hours')).toBeInTheDocument();
      expect(screen.getByRole('region', { name: 'Today summary' })).toBeInTheDocument();
      expect(button('Pull to refresh')).toBeEnabled();
      expect(savedConfigs()).toHaveLength(0);
    });

    it('toggles off again from the navigation bar', async () => {
      await renderEditMode();

      toggleEditMode();

      expect(toolbar()).not.toBeInTheDocument();
      expect(button('Sleep, 8 hours')).toBeInTheDocument();
    });

    it('enters edit mode when "Customize" is chosen on another screen, once', async () => {
      function CustomizeLink() {
        const navigate = useNavigate();
        return (
          <button type="button" onClick={() => navigate('/', { state: { enterEditMode: true } })}>
            Customize
          </button>
        );
      }
      function LocationState() {
        const { state } = useLocation();
        return <output aria-label="Location state">{JSON.stringify(state)}</output>;
      }
      const { user } = renderWithRouter(
        <>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/settings" element={<CustomizeLink />} />
          </Routes>
          <LocationState />
        </>,
        { route: '/settings' }
      );

      await user.click(button('Customize'));

      expect(await screen.findByRole('toolbar', { name: 'Customize tiles' })).toBeInTheDocument();
      // The one-shot request is cleared so Back/refresh does not re-trigger it
      await waitFor(() =>
        expect(screen.getByLabelText('Location state')).toHaveTextContent('null')
      );
      expect(screen.getByTestId('location')).toHaveTextContent(/^\/$/);
      expect(toolbar()).toBeInTheDocument();
    });

    it('ignores a Home tab reselect while customizing', async () => {
      const { user } = renderWithRouter(<Dashboard />, { route: '/', path: '/' });
      await screen.findByRole('button', { name: 'Sleep, 8 hours' });
      routeApi(api, dashboardRoutes({ 'GET /tile-config': { success: true, data: layout } }));
      await user.click(button('Previous day'));
      await screen.findByRole('button', { name: 'Sleep, 0 hours' });
      toggleEditMode();

      act(() => {
        window.dispatchEvent(new CustomEvent(TAB_RESELECT_EVENT, { detail: { tab: 'home' } }));
      });
      await act(() => new Promise((resolve) => setTimeout(resolve, 250)));
      await user.click(button('Cancel'));

      expect(await screen.findByRole('region', { name: 'Yesterday summary' })).toBeInTheDocument();
    });
  });

  describe('resizing', () => {
    it('cycles the selected tile size and saves the layout with Done', async () => {
      const { user } = await renderEditMode();

      await user.click(button('Sleep, large tile. Activate to select'));
      await user.click(button('Sleep, large tile, selected. Activate to resize'));

      expect(button('Sleep, small tile, selected. Activate to resize')).toBeInTheDocument();
      expect(storedSizes().sleep).toBe('small');

      await user.click(button('Done'));

      expect(toolbar()).not.toBeInTheDocument();
      expect(lastSavedConfig()).toEqual({
        order: layout.order,
        sizes: { ...sizes, sleep: 'small' },
        customTiles: [guitar],
      });
    });

    it('restores the original sizes when editing is cancelled', async () => {
      const { user } = await renderEditMode();
      await user.click(button('Sleep, large tile. Activate to select'));
      await user.click(button('Sleep, large tile, selected. Activate to resize'));

      await user.click(button('Cancel'));
      toggleEditMode();

      expect(button('Sleep, large tile. Activate to select')).toBeInTheDocument();
      expect(storedSizes().sleep).toBe('medium');
      expect(savedConfigs()).toHaveLength(0);
    });
  });

  describe('reordering', () => {
    it('moves the selected tile with the keyboard and saves the new order', async () => {
      stubTileLayout();
      const { user } = await renderEditMode();
      await user.click(button('Sleep, large tile. Activate to select'));
      button('Sleep, large tile, selected. Activate to resize').focus();

      await user.keyboard('[Space]');
      // The floating copy of the tile shows its name while dragging
      expect(await screen.findByText('Sleep')).toBeInTheDocument();
      await user.keyboard('[ArrowRight]');
      await user.keyboard('[Space]');

      await waitFor(() =>
        expect(
          screen
            .getAllByRole('button', { name: /tile(, selected)?\. Activate/ })
            .map((tile) => tile.getAttribute('aria-label')!.split(',')[0])
        ).toEqual(['Study', 'Sleep', 'Eating', 'Guitar'])
      );
      await user.click(button('Done'));

      expect(lastSavedConfig()?.order).toEqual(['study', 'sleep', 'eating', 'custom:guitar-1']);
    });

    it('lets the tile be used again after a cancelled drag', async () => {
      stubTileLayout();
      const { user } = await renderEditMode();
      await user.click(button('Sleep, large tile. Activate to select'));
      button('Sleep, large tile, selected. Activate to resize').focus();

      await user.keyboard('[Space]');
      expect(await screen.findByText('Sleep')).toBeInTheDocument();
      await user.keyboard('[Escape]');

      expect(await screen.findByRole('button', { name: 'Hide Sleep' })).toBeInTheDocument();
      await user.click(button('Done'));
      expect(button('Pull to refresh')).toBeEnabled();
      await user.click(button('Sleep, 8 hours'));
      expect(screen.getByRole('dialog', { name: 'Log Sleep' })).toBeInTheDocument();
      expect(lastSavedConfig()?.order).toEqual(layout.order);
    });
  });

  describe('hiding tiles', () => {
    it('hides a tile after confirming and restores it from Manage tiles', async () => {
      const { user } = await renderEditMode();

      await user.click(button('Hide Study'));
      const confirm = screen.getByRole('alertdialog', { name: 'Hide this tile?' });
      expect(confirm).toHaveTextContent('Study will disappear from your grid.');
      await user.click(within(confirm).getByRole('button', { name: 'Hide' }));

      expect(queryButton(/^Study, /)).not.toBeInTheDocument();
      expect(gl.track).toHaveBeenCalledWith('tile_hidden', { properties: { tileName: 'study' } });

      await user.click(button('Manage tiles, 1 hidden'));
      const panel = screen.getByRole('dialog', { name: 'Manage tiles' });
      await user.click(within(panel).getByRole('button', { name: 'Restore Study' }));

      expect(gl.track).toHaveBeenCalledWith('tile_restored', { properties: { tileName: 'study' } });
      expect(lastSavedConfig()).toEqual({
        order: layout.order,
        sizes,
        customTiles: [guitar],
      });
      expect(within(panel).getByRole('heading', { name: 'No hidden tiles' })).toBeInTheDocument();

      await user.click(within(panel).getByRole('button', { name: 'Close' }));
      expect(button('Study, wide tile. Activate to select')).toBeInTheDocument();
      expect(button('Manage tiles')).toBeInTheDocument();
    });

    it('keeps the tile when hiding is cancelled or dismissed with Escape', async () => {
      const { user } = await renderEditMode();

      await user.click(button('Hide Study'));
      await user.click(
        within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' })
      );
      await user.click(button('Hide Study'));
      await user.keyboard('{Escape}');

      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(button('Study, wide tile. Activate to select')).toBeInTheDocument();
      expect(toolbar()).toBeInTheDocument();
      expect(gl.track).not.toHaveBeenCalledWith('tile_hidden', expect.anything());
    });
  });

  describe('custom tiles', () => {
    it('creates a custom tile at the end of the grid', async () => {
      const { user } = await renderEditMode();

      await user.click(button('Add a custom tile'));
      const dialog = screen.getByRole('dialog', { name: 'New custom tile' });
      expect(dialog).toHaveTextContent('Room for 4 more custom tiles');
      await user.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Chess');
      await user.click(within(dialog).getByRole('button', { name: 'Create' }));

      expect(screen.queryByRole('dialog', { name: 'New custom tile' })).not.toBeInTheDocument();
      expect(button('Chess, small tile. Activate to select')).toBeInTheDocument();
      const saved = lastSavedConfig()!;
      const chess = saved.customTiles![1];
      expect(saved.customTiles).toEqual([
        guitar,
        { id: expect.any(String), name: 'Chess', icon: 'Sparkles', color: '#8b5cf6' },
      ]);
      expect(saved.order).toEqual([...layout.order, `custom:${chess.id}`]);
      expect(saved.sizes[`custom:${chess.id}`]).toBe('small');
      expect(storedSizes()[`custom:${chess.id}`]).toBe('small');
      expect(gl.track).toHaveBeenCalledWith('custom_tile_created', {
        properties: { tileId: chess.id, name: 'Chess' },
      });
    });

    it('closes the new tile dialog without creating anything', async () => {
      const { user } = await renderEditMode();

      await user.click(button('Add a custom tile'));
      await user.keyboard('{Escape}');

      expect(screen.queryByRole('dialog', { name: 'New custom tile' })).not.toBeInTheDocument();
      expect(toolbar()).toBeInTheDocument();
      expect(savedConfigs()).toHaveLength(0);
    });

    it('Cancel discards a tile created during the session, on the server too', async () => {
      const { user } = await renderEditMode();
      await user.click(button('Add a custom tile'));
      await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Chess');
      await user.click(button('Create'));
      expect(lastSavedConfig()?.customTiles).toHaveLength(2);

      await user.click(button('Cancel'));

      expect(queryButton(/^Chess, /)).not.toBeInTheDocument();
      expect(lastSavedConfig()).toEqual(layout);
      await waitFor(() => expect(storedCustomTiles()).toEqual([guitar]));
      expect(storedSizes()).toEqual(sizes);
    });

    it('hides "Add a custom tile" at the limit of five', async () => {
      const five = makeCustomTiles(5);
      useLayout({
        order: ['sleep', ...five.map((tile) => `custom:${tile.id}`)],
        customTiles: five,
      });
      await renderEditMode();

      expect(button('Tile 5, small tile. Activate to select')).toBeInTheDocument();
      expect(queryButton('Add a custom tile')).not.toBeInTheDocument();
    });

    it('renames a custom tile from its pencil badge', async () => {
      const { user } = await renderEditMode();

      await user.click(button('Edit Guitar'));
      const dialog = screen.getByRole('dialog', { name: 'Edit tile' });
      const name = within(dialog).getByRole('textbox', { name: 'Name' });
      await user.clear(name);
      await user.type(name, 'Bass');
      await user.click(within(dialog).getByRole('button', { name: 'Save' }));

      expect(button('Bass, small tile. Activate to select')).toBeInTheDocument();
      expect(lastSavedConfig()).toEqual({
        order: layout.order,
        sizes,
        customTiles: [{ ...guitar, name: 'Bass' }],
      });
      expect(gl.track).not.toHaveBeenCalledWith('custom_tile_created', expect.anything());
    });

    it('edits a hidden custom tile from Manage tiles', async () => {
      useLayout({ hidden: ['custom:guitar-1'] });
      const { user } = await renderEditMode();

      await user.click(button('Manage tiles, 1 hidden'));
      await user.click(
        within(screen.getByRole('dialog', { name: 'Manage tiles' })).getByRole('button', {
          name: 'Edit Guitar',
        })
      );

      expect(screen.queryByRole('dialog', { name: 'Manage tiles' })).not.toBeInTheDocument();
      expect(screen.getByRole('dialog', { name: 'Edit tile' })).toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Guitar');
    });

    it('puts a saved custom tile that is missing from the grid back on it', async () => {
      useLayout({ customTiles: [guitar, piano] });
      const { user } = await renderEditMode();

      await user.click(button('Manage tiles'));
      const panel = screen.getByRole('dialog', { name: 'Manage tiles' });
      expect(panel).toHaveTextContent('1 not on dashboard');
      await user.click(within(panel).getByRole('button', { name: 'Add Piano' }));

      expect(lastSavedConfig()?.order).toEqual([...layout.order, 'custom:piano-1']);
      await user.click(within(panel).getByRole('button', { name: 'Close' }));
      expect(button('Piano, small tile. Activate to select')).toBeInTheDocument();
    });
  });

  describe('deleting custom tiles', () => {
    const hiddenGuitar = {
      hidden: ['custom:guitar-1'],
      colors: { 'custom:guitar-1': '#123456' },
    };

    async function deleteGuitar() {
      const view = await renderEditMode();
      await view.user.click(button('Manage tiles, 1 hidden'));
      await view.user.click(button('Delete Guitar permanently'));
      await view.user.click(
        within(screen.getByRole('alertdialog', { name: 'Delete "Guitar"?' })).getByRole('button', {
          name: 'Delete',
        })
      );
      return view;
    }

    beforeEach(() => {
      useLayout(hiddenGuitar);
    });

    it('deletes the tile and offers to undo it', async () => {
      await deleteGuitar();

      expect(undoToast()).toHaveTextContent('Deleted Guitar');
      expect(gl.track).toHaveBeenCalledWith('custom_tile_deleted', {
        properties: { tileId: 'guitar-1', name: 'Guitar' },
      });
      expect(lastSavedConfig()).toEqual({
        order: ['sleep', 'study', 'eating'],
        sizes,
      });
      expect(
        within(screen.getByRole('dialog', { name: 'Manage tiles' })).getByRole('heading', {
          name: 'No hidden tiles',
        })
      ).toBeInTheDocument();
    });

    it('restores the tile, its position, hidden state and color on undo', async () => {
      const { user } = await deleteGuitar();

      await user.click(button('Undo'));

      expect(undoToast()).not.toBeInTheDocument();
      expect(lastSavedConfig()).toEqual({ ...layout, ...hiddenGuitar });
      expect(
        within(screen.getByRole('dialog', { name: 'Manage tiles' })).getByRole('button', {
          name: 'Restore Guitar',
        })
      ).toBeInTheDocument();
    });

    it('keeps the tile deleted when the toast is dismissed', async () => {
      const { user } = await deleteGuitar();
      const saves = savedConfigs().length;

      await user.click(button('Dismiss'));

      expect(undoToast()).not.toBeInTheDocument();
      expect(savedConfigs()).toHaveLength(saves);
    });

    it.each(['Done', 'Cancel'])(
      'drops the undo offer when editing ends with %s',
      async (action) => {
        const { user } = await deleteGuitar();
        await user.click(
          within(screen.getByRole('dialog', { name: 'Manage tiles' })).getByRole('button', {
            name: 'Close',
          })
        );

        await user.click(button(action));

        expect(undoToast()).not.toBeInTheDocument();
        expect(toolbar()).not.toBeInTheDocument();
      }
    );

    it.each([
      ['while the undo offer is showing', false],
      ['after undoing the deletion', true],
    ])(
      'Cancel brings back a tile deleted during the session, on the server too (%s)',
      async (_label, undo) => {
        const { user } = await deleteGuitar();
        if (undo) await user.click(button('Undo'));
        await user.click(
          within(screen.getByRole('dialog', { name: 'Manage tiles' })).getByRole('button', {
            name: 'Close',
          })
        );

        await user.click(button('Cancel'));

        expect(undoToast()).not.toBeInTheDocument();
        expect(lastSavedConfig()).toEqual({ ...layout, ...hiddenGuitar });
        await waitFor(() => expect(storedCustomTiles()).toEqual([guitar]));
        toggleEditMode();
        expect(button('Manage tiles, 1 hidden')).toBeInTheDocument();
      }
    );

    it('drops the undo offer after the undo window', async () => {
      vi.useRealTimers();
      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.setSystemTime(FIXED_TODAY);
      await deleteGuitar();
      expect(undoToast()).toBeInTheDocument();

      act(() => void vi.advanceTimersByTime(UNDO_TIMEOUT_DURATION));

      expect(undoToast()).not.toBeInTheDocument();
    });

    it('cannot undo once the custom tile limit is reached again', async () => {
      const five = makeCustomTiles(5);
      useLayout({
        order: ['sleep', ...five.slice(0, 4).map((tile) => `custom:${tile.id}`)],
        hidden: ['custom:tile-5'],
        customTiles: five,
      });
      const { user } = await renderEditMode();
      await user.click(button('Manage tiles, 1 hidden'));
      await user.click(button('Delete Tile 5 permanently'));
      await user.click(
        within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' })
      );
      await user.click(
        within(screen.getByRole('dialog', { name: 'Manage tiles' })).getByRole('button', {
          name: 'Close',
        })
      );
      await user.click(button('Add a custom tile'));
      await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Chess');
      await user.click(button('Create'));
      const saves = savedConfigs().length;

      await user.click(button('Undo'));

      expect(undoToast()).not.toBeInTheDocument();
      expect(savedConfigs()).toHaveLength(saves);
      expect(lastSavedConfig()?.customTiles?.map((tile) => tile.name)).toEqual([
        'Tile 1',
        'Tile 2',
        'Tile 3',
        'Tile 4',
        'Chess',
      ]);
    });

    it('keeps a restored tile off the grid when it was not on the grid before', async () => {
      useLayout({ customTiles: [guitar, piano] });
      const { user } = await renderEditMode();
      await user.click(button('Manage tiles'));
      await user.click(button('Delete Piano permanently'));
      await user.click(
        within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' })
      );

      await user.click(button('Undo'));

      expect(lastSavedConfig()).toEqual({ ...layout, customTiles: [guitar, piano] });
      const panel = screen.getByRole('dialog', { name: 'Manage tiles' });
      expect(panel).toHaveTextContent('1 not on dashboard');
      expect(within(panel).getByRole('button', { name: 'Add Piano' })).toBeInTheDocument();
      await user.click(within(panel).getByRole('button', { name: 'Close' }));
      expect(queryButton(/^Piano, /)).not.toBeInTheDocument();
    });
  });
});
