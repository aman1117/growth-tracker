import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeCustomTile } from '../test/fixtures/dashboard';
import HiddenTilesPanelDefault, { HiddenTilesPanel } from './HiddenTilesPanel';

// The theme store (reached through the ui barrel) reads matchMedia when its module loads,
// before the shared setup stubs it for each test.
await vi.hoisted(async () => {
  const { createMatchMedia } = await import('../test/browser-mocks');
  vi.stubGlobal('matchMedia', createMatchMedia());
});

type Props = ComponentProps<typeof HiddenTilesPanel>;

const guitar = makeCustomTile();
const piano = makeCustomTile({ id: 'piano-1', name: 'Piano', icon: 'Music', color: '#0ea5e9' });

function renderPanel(props: Partial<Props> = {}) {
  const handlers = {
    onClose: vi.fn(),
    onRestoreTile: vi.fn(),
    onDeleteCustomTile: vi.fn(),
    onEditCustomTile: vi.fn(),
  };
  render(
    <HiddenTilesPanel
      isOpen
      hiddenTiles={[]}
      customTiles={[]}
      tileOrder={['sleep', 'study']}
      {...handlers}
      {...props}
    />
  );
  return { user: userEvent.setup(), ...handlers };
}

const panel = () => screen.getByRole('dialog', { name: 'Manage tiles' });
const section = (title: string) =>
  screen.getByRole('heading', { name: title }).closest('section') as HTMLElement;

describe('HiddenTilesPanel', () => {
  beforeEach(() => {
    // Overlay history logs its steps with console.debug in development builds
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  it('is also the default export', () => {
    expect(HiddenTilesPanelDefault).toBe(HiddenTilesPanel);
  });

  it('renders nothing while closed', () => {
    renderPanel({ isOpen: false, hiddenTiles: ['sleep'] });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('explains how to hide tiles when everything is visible', () => {
    renderPanel();

    expect(panel()).toHaveTextContent('Everything is on your dashboard');
    expect(screen.getByRole('heading', { name: 'No hidden tiles' })).toBeInTheDocument();
  });

  it('restores a hidden default tile', async () => {
    const { user, onRestoreTile } = renderPanel({ hiddenTiles: ['study'], tileOrder: ['sleep'] });

    expect(panel()).toHaveTextContent('1 hidden');
    const defaults = section('Default tiles');
    expect(within(defaults).queryByRole('button', { name: /Delete/ })).not.toBeInTheDocument();

    await user.click(within(defaults).getByRole('button', { name: 'Restore Study' }));

    expect(onRestoreTile).toHaveBeenCalledWith('study');
  });

  describe('hidden custom tiles', () => {
    const props = {
      hiddenTiles: ['custom:guitar-1'] as Props['hiddenTiles'],
      customTiles: [guitar],
    };

    it('can be restored or edited', async () => {
      const { user, onRestoreTile, onEditCustomTile } = renderPanel(props);

      const custom = section('Custom tiles');
      expect(custom).toHaveTextContent('Custom tile');
      await user.click(within(custom).getByRole('button', { name: 'Restore Guitar' }));
      await user.click(within(custom).getByRole('button', { name: 'Edit Guitar' }));

      expect(onRestoreTile).toHaveBeenCalledWith('custom:guitar-1');
      expect(onEditCustomTile).toHaveBeenCalledWith(guitar);
    });

    it('asks before deleting permanently, starting on Cancel', async () => {
      const { user, onDeleteCustomTile } = renderPanel(props);

      await user.click(screen.getByRole('button', { name: 'Delete Guitar permanently' }));

      const confirm = screen.getByRole('alertdialog', { name: 'Delete "Guitar"?' });
      expect(confirm).toHaveAccessibleDescription(
        'This permanently deletes the tile and all the activity logged with it.'
      );
      expect(within(confirm).getByRole('button', { name: 'Cancel' })).toHaveFocus();

      await user.click(within(confirm).getByRole('button', { name: 'Delete' }));

      expect(onDeleteCustomTile).toHaveBeenCalledWith('guitar-1');
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });

    it('keeps the tile when the delete is cancelled, and Escape only closes the confirmation', async () => {
      const { user, onDeleteCustomTile, onClose } = renderPanel(props);

      await user.click(screen.getByRole('button', { name: 'Delete Guitar permanently' }));
      await user.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Delete Guitar permanently' }));
      await user.keyboard('{Escape}');

      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(panel()).toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
      expect(onDeleteCustomTile).not.toHaveBeenCalled();
    });

    it('offers only the actions the dashboard supports', () => {
      renderPanel({ ...props, onEditCustomTile: undefined, onDeleteCustomTile: undefined });

      expect(screen.getByRole('button', { name: 'Restore Guitar' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Edit Guitar' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Delete/ })).not.toBeInTheDocument();
    });

    it('can still delete a hidden tile whose definition is missing', async () => {
      const { user, onDeleteCustomTile } = renderPanel({ ...props, customTiles: [] });

      expect(screen.queryByRole('button', { name: 'Edit Custom' })).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Delete Custom permanently' }));
      await user.click(screen.getByRole('button', { name: 'Delete' }));

      expect(onDeleteCustomTile).toHaveBeenCalledWith('guitar-1');
    });
  });

  describe('custom tiles missing from the dashboard', () => {
    const props = {
      hiddenTiles: ['reels'] as Props['hiddenTiles'],
      customTiles: [guitar, piano],
      tileOrder: ['sleep', 'custom:guitar-1'] as Props['tileOrder'],
    };

    it('lists them separately with a warning', () => {
      renderPanel(props);

      expect(panel()).toHaveTextContent('1 hidden · 1 not on dashboard');
      const orphans = section('Not on your dashboard');
      expect(orphans).toHaveTextContent(
        "These custom tiles are saved to your account but aren't on your dashboard."
      );
      expect(within(orphans).getAllByRole('listitem')).toHaveLength(1);
      expect(orphans).toHaveTextContent('Piano');
    });

    it('can add, edit or delete them', async () => {
      const { user, onRestoreTile, onEditCustomTile, onDeleteCustomTile } = renderPanel(props);

      await user.click(screen.getByRole('button', { name: 'Add Piano' }));
      expect(onRestoreTile).toHaveBeenCalledWith('custom:piano-1');

      await user.click(screen.getByRole('button', { name: 'Edit Piano' }));
      expect(onEditCustomTile).toHaveBeenCalledWith(piano);

      await user.click(screen.getByRole('button', { name: 'Delete Piano permanently' }));
      await user.click(screen.getByRole('button', { name: 'Delete' }));
      expect(onDeleteCustomTile).toHaveBeenCalledWith('piano-1');
    });

    it('omits edit and delete without handlers', () => {
      renderPanel({ ...props, onEditCustomTile: undefined, onDeleteCustomTile: undefined });

      expect(screen.getByRole('button', { name: 'Add Piano' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Edit Piano' })).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Delete Piano permanently' })
      ).not.toBeInTheDocument();
    });

    it('summarizes only missing tiles when nothing is hidden', () => {
      renderPanel({ ...props, hiddenTiles: [] });

      expect(panel()).toHaveTextContent('1 not on dashboard');
      expect(panel()).not.toHaveTextContent('hidden');
    });
  });

  it('closes from the Close button or Escape', async () => {
    const { user, onClose } = renderPanel({ hiddenTiles: ['sleep'] });

    await user.click(screen.getByRole('button', { name: 'Close' }));
    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
