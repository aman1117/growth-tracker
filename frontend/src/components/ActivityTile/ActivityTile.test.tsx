import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Moon } from 'lucide-react';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';

import DefaultActivityTile, { ActivityTile } from '.';
import styles from './ActivityTile.module.css';

type Props = ComponentProps<typeof ActivityTile>;

function renderTile(props: Partial<Props> = {}) {
  const handlers = {
    onClick: vi.fn(),
    onResize: vi.fn(),
    onSelect: vi.fn(),
    onHide: vi.fn(),
  };
  const onParentClick = vi.fn();
  const view = render(
    <div onClick={onParentClick}>
      <ActivityTile name="sleep" hours={8} color="#6366f1" {...handlers} {...props} />
    </div>
  );
  return { user: userEvent.setup(), onParentClick, ...handlers, ...view };
}

describe('ActivityTile', () => {
  it('is exported as the default export too', () => {
    expect(DefaultActivityTile).toBe(ActivityTile);
  });

  describe('logging mode', () => {
    it('names the activity and its hours', () => {
      renderTile({ displayLabel: 'Sleep' });

      const tile = screen.getByRole('button', { name: 'Sleep, 8 hours' });
      expect(tile).toHaveTextContent('Sleep8h');
      expect(tile).not.toHaveAttribute('aria-pressed');
    });

    it('uses the singular for one hour and mentions notes', () => {
      renderTile({ displayLabel: 'Sleep', hours: 1, hasNote: true });

      expect(screen.getByRole('button', { name: 'Sleep, 1 hour, has note' })).toBeInTheDocument();
      expect(screen.getByTitle('Has note')).toBeInTheDocument();
    });

    it('formats the activity id when there is no display label', () => {
      renderTile({ name: 'book_reading', hours: 0 });

      expect(screen.getByRole('button', { name: 'Book Reading, 0 hours' })).toBeInTheDocument();
    });

    it('opens the activity on click, Enter or Space', async () => {
      const { user, onClick } = renderTile({ displayLabel: 'Sleep' });
      const tile = screen.getByRole('button', { name: 'Sleep, 8 hours' });

      await user.click(tile);
      tile.focus();
      await user.keyboard('{Enter}');
      await user.keyboard(' ');

      expect(onClick).toHaveBeenCalledTimes(3);
    });

    it('ignores other keys and key presses from inner elements', () => {
      const { onClick } = renderTile({ displayLabel: 'Sleep' });
      const tile = screen.getByRole('button', { name: 'Sleep, 8 hours' });

      fireEvent.keyDown(tile, { key: 'a' });
      fireEvent.keyDown(tile.firstElementChild!, { key: 'Enter' });

      expect(onClick).not.toHaveBeenCalled();
    });

    it('ignores clicks while the tile is being dragged', async () => {
      const { user, onClick } = renderTile({ displayLabel: 'Sleep', isDragging: true });

      await user.click(screen.getByRole('button', { name: 'Sleep, 8 hours' }));

      expect(onClick).not.toHaveBeenCalled();
    });

    it.each([
      ['a named (custom) icon', { iconName: 'Guitar' }, 'lucide-guitar'],
      ['an icon component', { icon: Moon }, 'lucide-moon'],
    ])('renders %s', (_label, props, iconClass) => {
      const { container } = renderTile(props);

      expect(container.querySelector(`svg.${iconClass}`)).toBeInTheDocument();
    });

    it('renders no icon when none is given', () => {
      const { container } = renderTile();

      expect(container.querySelector('svg')).not.toBeInTheDocument();
    });

    it.each([
      ['white text on a deep color', '#6366f1', styles.onLight, styles.onDark],
      ['ink text on a bright color', '#facc15', styles.onDark, styles.onLight],
    ])('picks %s once hours are logged', (_label, color, expected, unexpected) => {
      renderTile({ displayLabel: 'Sleep', color });

      const tile = screen.getByRole('button', { name: 'Sleep, 8 hours' });
      expect(tile).toHaveClass(styles.active, expected);
      expect(tile).not.toHaveClass(unexpected);
    });

    it('keeps the calm glass look while nothing is logged', () => {
      renderTile({ displayLabel: 'Sleep', hours: 0, color: '#facc15' });

      const tile = screen.getByRole('button', { name: 'Sleep, 0 hours' });
      expect(tile).not.toHaveClass(styles.active);
      expect(tile).not.toHaveClass(styles.onDark);
    });
  });

  describe('edit mode', () => {
    const editProps = { displayLabel: 'Sleep', isDraggable: true, isEditMode: true };

    it('selects the tile instead of opening it, without bubbling to the grid', async () => {
      const { user, onSelect, onClick, onParentClick } = renderTile(editProps);

      const tile = screen.getByRole('button', { name: 'Sleep, small tile. Activate to select' });
      expect(tile).toHaveAttribute('aria-pressed', 'false');

      await user.click(tile);

      expect(onSelect).toHaveBeenCalledWith('sleep');
      expect(onClick).not.toHaveBeenCalled();
      expect(onParentClick).not.toHaveBeenCalled();
    });

    it.each([
      ['small', 'Small', 'wide'],
      ['wide', 'Wide', 'medium'],
      ['medium', 'Large', 'small'],
    ] as const)('cycles a selected %s tile to the next size', async (size, label, next) => {
      const { user, onResize } = renderTile({ ...editProps, size, isSelected: true });

      const tile = screen.getByRole('button', {
        name: `Sleep, ${label.toLowerCase()} tile, selected. Activate to resize`,
      });
      expect(tile).toHaveAttribute('aria-pressed', 'true');
      expect(tile).toHaveTextContent(label);

      await user.click(tile);

      expect(onResize).toHaveBeenCalledWith('sleep', next);
    });

    it.each([
      ['small', false],
      ['wide', true],
      ['medium', true],
    ] as const)('hints at resizing a selected %s tile: %s', (size, showsHint) => {
      renderTile({ ...editProps, size, isSelected: true });

      expect(screen.queryByText('Tap to resize · drag') !== null).toBe(showsHint);
    });

    it('resizes the selected tile from the keyboard', async () => {
      const { user, onResize } = renderTile({ ...editProps, isSelected: true });

      screen.getByRole('button', { name: /selected/ }).focus();
      await user.keyboard('{Enter}');

      expect(onResize).toHaveBeenCalledWith('sleep', 'wide');
    });

    it('hides the tile from its badge without opening it', async () => {
      const { user, onHide, onSelect, onParentClick } = renderTile(editProps);

      await user.click(screen.getByRole('button', { name: 'Hide Sleep' }));

      expect(onHide).toHaveBeenCalledWith('sleep');
      expect(onSelect).not.toHaveBeenCalled();
      expect(onParentClick).not.toHaveBeenCalled();
    });

    it('hides the note marker and badges while dragging', () => {
      renderTile({ ...editProps, hasNote: true, isDragging: true });

      expect(screen.queryByTitle('Has note')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Hide Sleep' })).not.toBeInTheDocument();
    });

    it('edits custom tiles from their pencil badge', async () => {
      const onEditCustomTile = vi.fn();
      const { user, onParentClick } = renderTile({
        ...editProps,
        name: 'custom:guitar-1',
        displayLabel: 'Guitar',
        onEditCustomTile,
      });

      await user.click(screen.getByRole('button', { name: 'Edit Guitar' }));

      expect(onEditCustomTile).toHaveBeenCalledTimes(1);
      expect(onParentClick).not.toHaveBeenCalled();
    });

    it('offers no pencil badge for predefined tiles', () => {
      renderTile({ ...editProps, onEditCustomTile: vi.fn() });

      expect(screen.queryByRole('button', { name: 'Edit Sleep' })).not.toBeInTheDocument();
    });

    it('works without optional callbacks', async () => {
      const user = userEvent.setup();
      render(
        <ActivityTile
          name="sleep"
          hours={0}
          color="#6366f1"
          onClick={() => {}}
          isDraggable
          isEditMode
        />
      );
      await user.click(screen.getByRole('button', { name: /Activate to select/ }));

      render(
        <ActivityTile
          name="study"
          hours={0}
          color="#3b82f6"
          onClick={() => {}}
          isDraggable
          isSelected
        />
      );
      await user.click(screen.getByRole('button', { name: /Activate to resize/ }));

      expect(screen.queryByRole('button', { name: /^Hide/ })).not.toBeInTheDocument();
    });
  });
});
