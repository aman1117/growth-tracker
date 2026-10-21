import { render, screen } from '@testing-library/react';
import { Star } from 'lucide-react';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';

import { ALL_ICONS } from '../constants/icons';
import DynamicIconDefault, { DynamicIcon } from './DynamicIcon';

const renderIcon = (ui: ReactElement) => render(ui).container.querySelector('svg');

describe('DynamicIcon', () => {
  it('renders the lucide icon registered under the given name', () => {
    render(<DynamicIcon name="Bike" aria-label="Cycling" />);

    expect(screen.getByLabelText('Cycling')).toHaveClass('lucide-bike');
  });

  it('forwards icon props such as size, color and stroke width', () => {
    const svg = renderIcon(<DynamicIcon name="Dumbbell" size={20} color="red" strokeWidth={3} />);

    expect(svg).toHaveAttribute('width', '20');
    expect(svg).toHaveAttribute('height', '20');
    expect(svg).toHaveAttribute('stroke', 'red');
    expect(svg).toHaveAttribute('stroke-width', '3');
  });

  it('falls back to the Sparkles icon for an unknown name', () => {
    expect(renderIcon(<DynamicIcon name="NotARealIcon" />)).toHaveClass('lucide-sparkles');
  });

  it('uses a custom fallback icon when one is provided', () => {
    expect(renderIcon(<DynamicIcon name="NotARealIcon" fallback={Star} />)).toHaveClass(
      'lucide-star'
    );
  });

  it('is decorative unless it is given an accessible label', () => {
    expect(renderIcon(<DynamicIcon name="Bike" />)).toHaveAttribute('aria-hidden', 'true');
  });

  it('can render every icon offered by the icon picker', () => {
    for (const name of ALL_ICONS) {
      const svg = renderIcon(<DynamicIcon name={name} />);
      expect(svg, name).not.toHaveClass('lucide-sparkles');
    }
  });

  it('is exported as the default export with a readable display name', () => {
    expect(DynamicIconDefault).toBe(DynamicIcon);
    expect(DynamicIcon.displayName).toBe('DynamicIcon');
  });
});
