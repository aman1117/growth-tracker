/**
 * Roving focus helpers
 *
 * Keyboard support for single-select groups laid out as a wrapping grid
 * (color swatches, icon grids): one Tab stop for the whole group, arrows move
 * between options, Home/End jump to the ends.
 */

import type React from 'react';

/** Number of items on the first visual row of a wrapping grid/flex container */
export const getGridColumnCount = (container: HTMLElement): number => {
  const items = Array.from(container.children) as HTMLElement[];
  if (items.length === 0) return 1;
  const firstTop = items[0].offsetTop;
  const firstWrapped = items.findIndex((item) => item.offsetTop !== firstTop);
  return firstWrapped === -1 ? items.length : Math.max(1, firstWrapped);
};

/** Returns the next index for a navigation key, or null if the key isn't handled */
export const getNextRovingIndex = (
  key: string,
  index: number,
  count: number,
  columns: number
): number | null => {
  if (count <= 0) return null;
  switch (key) {
    case 'ArrowRight':
      return Math.min(count - 1, index + 1);
    case 'ArrowLeft':
      return Math.max(0, index - 1);
    case 'ArrowDown':
      return Math.min(count - 1, index + columns);
    case 'ArrowUp':
      return Math.max(0, index - columns);
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
};

/**
 * Keydown handler for an option inside a roving group. Moves focus to the
 * target option and lets the caller select it (radio-style "selection follows focus").
 */
export const handleRovingKeyDown = (
  event: React.KeyboardEvent<HTMLElement>,
  index: number,
  onMove: (nextIndex: number) => void
): void => {
  const container = event.currentTarget.parentElement;
  if (!container) return;
  const count = container.children.length;
  const next = getNextRovingIndex(event.key, index, count, getGridColumnCount(container));
  if (next === null || next === index) {
    if (next === index) event.preventDefault();
    return;
  }
  event.preventDefault();
  (container.children[next] as HTMLElement | undefined)?.focus();
  onMove(next);
};
