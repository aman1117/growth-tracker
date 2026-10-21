import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { LoadingSkeleton } from './LoadingSkeleton';

// The theme store (reached through the ui barrel) reads matchMedia when its module loads,
// before the shared setup stubs it for each test.
await vi.hoisted(async () => {
  const { createMatchMedia } = await import('../../../test/browser-mocks');
  vi.stubGlobal('matchMedia', createMatchMedia());
});

describe('LoadingSkeleton', () => {
  it('marks the tile grid as busy for assistive tech', () => {
    render(<LoadingSkeleton />);

    const grid = screen.getByLabelText('Loading activities');
    expect(grid).toHaveAttribute('aria-busy', 'true');
  });

  it('mirrors the default layout: one large tile, one wide tile, then small tiles', () => {
    render(<LoadingSkeleton />);

    const cells = Array.from(screen.getByLabelText('Loading activities').children);
    expect(cells).toHaveLength(8);
    expect(cells[0]).toHaveStyle({ gridColumn: 'span 2', gridRow: 'span 2' });
    expect(cells[1]).toHaveStyle({ gridColumn: 'span 2', gridRow: 'span 1' });
    cells.slice(2).forEach((cell) => {
      expect(cell).toHaveStyle({ gridColumn: 'span 1', gridRow: 'span 1' });
    });
  });
});
