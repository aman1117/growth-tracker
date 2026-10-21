import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { getGridColumnCount, getNextRovingIndex, handleRovingKeyDown } from './rovingFocus';

const COLORS = ['Red', 'Green', 'Blue', 'Cyan', 'Magenta', 'Yellow', 'Black'];

function Swatches({ onMove }: { onMove: (index: number) => void }) {
  return (
    <div role="radiogroup" aria-label="Tile color">
      {COLORS.map((name, index) => (
        <button
          key={name}
          type="button"
          role="radio"
          aria-checked={index === 0}
          onKeyDown={(event) => handleRovingKeyDown(event, index, onMove)}
        >
          {name}
        </button>
      ))}
    </div>
  );
}

/** jsdom does no layout: give each child the `offsetTop` of a grid with `columns` columns. */
function layOutGrid(items: HTMLElement[], columns: number) {
  items.forEach((item, index) => {
    Object.defineProperty(item, 'offsetTop', {
      configurable: true,
      value: Math.floor(index / columns) * 40,
    });
  });
}

function renderSwatches(columns = 3) {
  const onMove = vi.fn();
  render(<Swatches onMove={onMove} />);
  const options = screen.getAllByRole('radio');
  layOutGrid(options, columns);
  return { onMove, options };
}

describe('getGridColumnCount', () => {
  const containerWith = (count: number, columns: number) => {
    const container = document.createElement('div');
    const items = Array.from({ length: count }, () =>
      container.appendChild(document.createElement('span'))
    );
    layOutGrid(items, columns);
    return container;
  };

  it('treats an empty container as a single column', () => {
    expect(getGridColumnCount(document.createElement('div'))).toBe(1);
  });

  it('counts the items on the first visual row', () => {
    expect(getGridColumnCount(containerWith(10, 4))).toBe(4);
    expect(getGridColumnCount(containerWith(10, 1))).toBe(1);
  });

  it('uses every item when nothing wraps', () => {
    expect(getGridColumnCount(containerWith(5, 8))).toBe(5);
  });
});

describe('getNextRovingIndex', () => {
  it.each([
    ['ArrowRight', 2, 3],
    ['ArrowRight', 6, 6],
    ['ArrowLeft', 2, 1],
    ['ArrowLeft', 0, 0],
    ['ArrowDown', 1, 4],
    ['ArrowDown', 5, 6],
    ['ArrowUp', 4, 1],
    ['ArrowUp', 1, 0],
    ['Home', 5, 0],
    ['End', 1, 6],
    ['Enter', 1, null],
    ['a', 1, null],
  ])('%s from %i → %s (7 items, 3 columns)', (key, index, next) => {
    expect(getNextRovingIndex(key, index, 7, 3)).toBe(next);
  });

  it('ignores keys in an empty group', () => {
    expect(getNextRovingIndex('ArrowRight', 0, 0, 3)).toBeNull();
  });
});

describe('handleRovingKeyDown', () => {
  it('moves focus and selection with the arrow keys', async () => {
    const user = userEvent.setup();
    const { onMove, options } = renderSwatches();
    options[0].focus();

    await user.keyboard('{ArrowRight}');
    expect(options[1]).toHaveFocus();
    expect(onMove).toHaveBeenLastCalledWith(1);

    await user.keyboard('{ArrowDown}');
    expect(options[4]).toHaveFocus();
    expect(onMove).toHaveBeenLastCalledWith(4);

    await user.keyboard('{ArrowUp}{ArrowLeft}');
    expect(options[0]).toHaveFocus();
    expect(onMove).toHaveBeenLastCalledWith(0);
  });

  it('jumps to the first and last option with Home and End', async () => {
    const user = userEvent.setup();
    const { onMove, options } = renderSwatches();
    options[2].focus();

    await user.keyboard('{End}');
    expect(options[6]).toHaveFocus();
    expect(onMove).toHaveBeenLastCalledWith(6);

    await user.keyboard('{Home}');
    expect(options[0]).toHaveFocus();
    expect(onMove).toHaveBeenLastCalledWith(0);
  });

  it('swallows navigation keys at the edge of the group without moving', () => {
    const { onMove, options } = renderSwatches();
    options[0].focus();

    const notPrevented = fireEvent.keyDown(options[0], { key: 'ArrowLeft' });

    expect(notPrevented).toBe(false);
    expect(onMove).not.toHaveBeenCalled();
    expect(options[0]).toHaveFocus();
  });

  it('leaves other keys to the browser', () => {
    const { onMove, options } = renderSwatches();

    expect(fireEvent.keyDown(options[3], { key: 'Tab' })).toBe(true);
    expect(onMove).not.toHaveBeenCalled();
  });

  it('does nothing for an option that is not inside a group', () => {
    const onMove = vi.fn();
    const preventDefault = vi.fn();
    const event = {
      key: 'ArrowRight',
      currentTarget: document.createElement('button'),
      preventDefault,
    } as unknown as React.KeyboardEvent<HTMLElement>;

    handleRovingKeyDown(event, 0, onMove);

    expect(onMove).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });
});
