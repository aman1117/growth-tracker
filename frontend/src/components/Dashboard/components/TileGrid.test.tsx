import { screen, waitFor } from '@testing-library/react';
import { type ComponentProps, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { STORAGE_KEYS } from '../../../constants';
import { makeCustomTile, makeCustomTiles, stubTileLayout } from '../../../test/fixtures/dashboard';
import { renderWithRouter } from '../../../test/utils';
import type { ActivityName } from '../../../types';
import type { TileSize } from '../../ActivityTile';
import { useDragAndDrop } from '../hooks';
import { TileGrid } from './TileGrid';
import styles from './TileGrid.module.css';

// The theme store (reached through the ui barrel) reads matchMedia when its module loads,
// before the shared setup stubs it for each test.
await vi.hoisted(async () => {
  const { createMatchMedia } = await import('../../../test/browser-mocks');
  vi.stubGlobal('matchMedia', createMatchMedia());
});

type GridProps = ComponentProps<typeof TileGrid>;
type HarnessProps = Partial<GridProps> & { initialOrder?: ActivityName[] };

const guitar = makeCustomTile();

/** Owns the tile order and drag state like the dashboard does, so drops really reorder. */
function GridHarness({ initialOrder = ['sleep', 'study', 'eating'], ...props }: HarnessProps) {
  const [order, setOrder] = useState(initialOrder);
  const dnd = useDragAndDrop({ setTileOrder: setOrder });
  return (
    <TileGrid
      visibleTiles={order}
      activities={{ sleep: 8, study: 2.5 }}
      activityNotes={{ study: 'Chapter 4' }}
      customTiles={[]}
      tileColors={{}}
      tileSizes={{ sleep: 'medium', study: 'wide' } as Record<ActivityName, TileSize>}
      isEditMode={false}
      isReadOnly={false}
      selectedTile={null}
      activeDragId={dnd.activeDragId}
      tilesAnimating={false}
      animationDirection="left"
      sensors={dnd.sensors}
      onActivityClick={() => {}}
      onTileResize={() => {}}
      onSelectTile={() => {}}
      onHideTile={() => {}}
      onEditCustomTile={() => {}}
      onAddCustomTile={() => {}}
      {...props}
      onDragStart={(event) => {
        dnd.handleDragStart(event);
        props.onDragStart?.(event);
      }}
      onDragEnd={(event) => {
        dnd.handleDragEnd(event);
        props.onDragEnd?.(event);
      }}
      onDragCancel={(event) => {
        dnd.handleDragCancel();
        props.onDragCancel?.(event);
      }}
    />
  );
}

function renderGrid(props: HarnessProps = {}) {
  const handlers = {
    onActivityClick: vi.fn(),
    onTileResize: vi.fn(),
    onSelectTile: vi.fn(),
    onHideTile: vi.fn(),
    onEditCustomTile: vi.fn(),
    onAddCustomTile: vi.fn(),
    onDragStart: vi.fn(),
    onDragEnd: vi.fn(),
    onDragCancel: vi.fn(),
  };
  const view = renderWithRouter(<GridHarness {...handlers} {...props} />);
  return { ...view, ...handlers };
}

/** Tile buttons in grid order (the ones dnd-kit and users interact with). */
const tileLabels = () =>
  screen
    .getAllByRole('button')
    .map((tile) => tile.getAttribute('aria-label'))
    .filter((label) => label && !label.startsWith('Hide') && !label.startsWith('Add'));

describe('TileGrid', () => {
  it('shows each visible tile with its logged hours and note marker', () => {
    renderGrid();

    expect(tileLabels()).toEqual([
      'Sleep, 8 hours',
      'Study, 2.5 hours, has note',
      'Eating, 0 hours',
    ]);
  });

  it('does not reveal note markers on someone else’s day', () => {
    renderGrid({ isReadOnly: true });

    expect(screen.getByRole('button', { name: 'Study, 2.5 hours' })).toBeInTheDocument();
  });

  it('labels custom tiles and applies color overrides', () => {
    renderGrid({ initialOrder: ['custom:guitar-1'], customTiles: [guitar] });

    expect(screen.getByRole('button', { name: 'Guitar, 0 hours' })).toBeInTheDocument();
  });

  it('opens a tile for logging when tapped', async () => {
    const { user, onActivityClick } = renderGrid();

    await user.click(screen.getByRole('button', { name: 'Study, 2.5 hours, has note' }));

    expect(onActivityClick).toHaveBeenCalledWith('study');
  });

  describe('edit mode', () => {
    it('makes tiles selectable and hideable', async () => {
      const { user, onSelectTile, onHideTile, onActivityClick } = renderGrid({ isEditMode: true });

      await user.click(
        screen.getByRole('button', { name: 'Sleep, large tile. Activate to select' })
      );
      expect(onSelectTile).toHaveBeenCalledWith('sleep');

      await user.click(screen.getByRole('button', { name: 'Hide Eating' }));
      expect(onHideTile).toHaveBeenCalledWith('eating');
      expect(onActivityClick).not.toHaveBeenCalled();
    });

    it('resizes the selected tile', async () => {
      const { user, onTileResize } = renderGrid({ isEditMode: true, selectedTile: 'study' });

      await user.click(
        screen.getByRole('button', { name: 'Study, wide tile, selected. Activate to resize' })
      );

      expect(onTileResize).toHaveBeenCalledWith('study', 'medium');
    });

    it('clears the selection when tapping the grid background', async () => {
      const { user, onSelectTile, container } = renderGrid({
        isEditMode: true,
        selectedTile: 'sleep',
      });

      await user.click(container.querySelector(`.${styles.grid}`)!);

      expect(onSelectTile).toHaveBeenCalledWith(null);
    });

    it.each([
      ['nothing is selected', { isEditMode: true }],
      ['outside edit mode', { isEditMode: false, selectedTile: 'sleep' as const }],
    ])('ignores background taps when %s', async (_label, props) => {
      const { user, onSelectTile, container } = renderGrid(props);

      await user.click(container.querySelector(`.${styles.grid}`)!);

      expect(onSelectTile).not.toHaveBeenCalled();
    });

    it('edits a custom tile from its badge', async () => {
      const { user, onEditCustomTile } = renderGrid({
        isEditMode: true,
        initialOrder: ['sleep', 'custom:guitar-1'],
        customTiles: [guitar],
      });

      expect(screen.queryByRole('button', { name: 'Edit Sleep' })).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Edit Guitar' }));

      expect(onEditCustomTile).toHaveBeenCalledWith(guitar);
    });

    it('offers to add a custom tile without touching the selection', async () => {
      const { user, onAddCustomTile, onSelectTile } = renderGrid({
        isEditMode: true,
        selectedTile: 'sleep',
      });

      await user.click(screen.getByRole('button', { name: 'Add a custom tile' }));

      expect(onAddCustomTile).toHaveBeenCalledTimes(1);
      expect(onSelectTile).not.toHaveBeenCalled();
    });

    it.each([
      ['outside edit mode', { isEditMode: false }],
      ['on someone else’s day', { isEditMode: true, isReadOnly: true }],
      ['at the custom tile limit', { isEditMode: true, customTiles: makeCustomTiles(5) }],
    ])('hides "Add a custom tile" %s', (_label, props) => {
      renderGrid(props);

      expect(screen.queryByRole('button', { name: 'Add a custom tile' })).not.toBeInTheDocument();
    });
  });

  it.each([
    [true, 'left', styles.slideOutLeft],
    [true, 'right', styles.slideOutRight],
    [false, 'left', styles.slideInLeft],
    [false, 'right', styles.slideInRight],
  ] as const)(
    'slides tiles (animating=%s, direction=%s) when the day changes',
    (tilesAnimating, animationDirection, expectedClass) => {
      const { container } = renderGrid({ tilesAnimating, animationDirection });

      expect(container.querySelector(`.${styles.grid}`)).toHaveClass(expectedClass);
    }
  );

  describe('keyboard reordering', () => {
    beforeEach(() => {
      stubTileLayout();
    });

    it('picks up the selected tile with Space, moves it with arrows and drops it with Space', async () => {
      const { user, onDragStart, onDragEnd } = renderGrid({
        isEditMode: true,
        selectedTile: 'sleep',
      });
      screen
        .getByRole('button', { name: 'Sleep, large tile, selected. Activate to resize' })
        .focus();

      await user.keyboard('[Space]');
      expect(onDragStart).toHaveBeenCalledWith(
        expect.objectContaining({ active: expect.objectContaining({ id: 'sleep' }) })
      );
      // The floating copy of the tile shows its name while dragging
      expect(await screen.findByText('Sleep')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Hide Sleep' })).not.toBeInTheDocument();

      await user.keyboard('[ArrowRight]');
      await user.keyboard('[Space]');

      await waitFor(() => expect(onDragEnd).toHaveBeenCalled());
      expect(onDragEnd.mock.calls[0][0]).toMatchObject({
        active: { id: 'sleep' },
        over: { id: 'study' },
      });
      await waitFor(() =>
        expect(tileLabels()).toEqual([
          'Study, wide tile. Activate to select',
          'Sleep, large tile, selected. Activate to resize',
          'Eating, small tile. Activate to select',
        ])
      );
      expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.TILE_ORDER)!)).toEqual([
        'study',
        'sleep',
        'eating',
      ]);
    });

    it('keeps the order when the drag is cancelled with Escape', async () => {
      const { user, onDragEnd } = renderGrid({ isEditMode: true, selectedTile: 'sleep' });
      screen
        .getByRole('button', { name: 'Sleep, large tile, selected. Activate to resize' })
        .focus();

      await user.keyboard('[Space]');
      expect(await screen.findByText('Sleep')).toBeInTheDocument();
      await user.keyboard('[ArrowRight]');
      await user.keyboard('[Escape]');

      await waitFor(() => expect(screen.queryByText('Sleep')).not.toBeInTheDocument());
      expect(onDragEnd).not.toHaveBeenCalled();
      expect(tileLabels()).toEqual([
        'Sleep, large tile, selected. Activate to resize',
        'Study, wide tile. Activate to select',
        'Eating, small tile. Activate to select',
      ]);
    });

    it('returns the tile to normal after a cancelled drag', async () => {
      const { user, onDragCancel, onTileResize } = renderGrid({
        isEditMode: true,
        selectedTile: 'sleep',
      });
      const sleep = screen.getByRole('button', {
        name: 'Sleep, large tile, selected. Activate to resize',
      });
      sleep.focus();

      await user.keyboard('[Space]');
      expect(await screen.findByText('Sleep')).toBeInTheDocument();
      await user.keyboard('[Escape]');

      // The tile is no longer treated as dragged: its badges come back and it responds to taps
      expect(await screen.findByRole('button', { name: 'Hide Sleep' })).toBeInTheDocument();
      expect(onDragCancel).toHaveBeenCalledTimes(1);
      await user.click(sleep);
      expect(onTileResize).toHaveBeenCalledWith('sleep', 'small');
    });
  });
});
