import { render } from '@testing-library/react';
import { Crown, Flame, Footprints, Gem, Shield, Star, Zap } from 'lucide-react';
import { describe, expect, it } from 'vitest';

import { badgeIconComponents, getBadgeIconComponent, renderBadgeIcon } from './badgeIcons';

function renderIcon(...args: Parameters<typeof renderBadgeIcon>) {
  const { container } = render(<>{renderBadgeIcon(...args)}</>);
  const svg = container.querySelector('svg');
  if (!svg) throw new Error('No icon rendered');
  return svg;
}

describe('badge icons', () => {
  it('maps every badge icon name to its Lucide icon', () => {
    expect(badgeIconComponents).toEqual({ Footprints, Zap, Flame, Shield, Gem, Crown, Star });
    Object.entries(badgeIconComponents).forEach(([name, Icon]) => {
      expect(getBadgeIconComponent(name)).toBe(Icon);
    });
  });

  it('falls back to the star for unknown icon names', () => {
    expect(getBadgeIconComponent('Unicorn')).toBe(Star);
    expect(getBadgeIconComponent('')).toBe(Star);
  });

  it('renders a filled 18px icon in the badge color by default', () => {
    const svg = renderIcon('Flame', '#f97316');

    expect(svg).toHaveClass('lucide-flame');
    expect(svg).toHaveAttribute('width', '18');
    expect(svg).toHaveAttribute('height', '18');
    expect(svg).toHaveAttribute('fill', '#f97316');
    expect(svg).toHaveAttribute('stroke', '#f97316');
    expect(svg).toHaveStyle({ display: 'block' });
  });

  it('renders an outlined icon at a custom size', () => {
    const svg = renderIcon('Crown', '#eab308', 24, false);

    expect(svg).toHaveClass('lucide-crown');
    expect(svg).toHaveAttribute('width', '24');
    expect(svg).toHaveAttribute('fill', 'none');
    expect(svg).toHaveAttribute('stroke', '#eab308');
  });

  it('renders the fallback star for unknown icon names', () => {
    expect(renderIcon('Unicorn', '#6447f2')).toHaveClass('lucide-star');
  });
});
