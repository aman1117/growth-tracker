import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { makeBadge } from '../../../test/fixtures/ui';
import { StreakBadge } from './StreakBadge';
import styles from './StreakBadge.module.css';

const renderBadge = (...args: Parameters<typeof makeBadge>) =>
  render(<StreakBadge badge={makeBadge(...args)} />).container.firstElementChild as HTMLElement;

describe('StreakBadge', () => {
  it('shows a locked badge with the unlock threshold', () => {
    const badge = renderBadge();

    expect(badge).toHaveClass(styles.badge, styles.md, styles.locked);
    expect(badge).toHaveAttribute('title', 'Week Warrior - Reach 7 days to unlock');
    expect(screen.getByText('7d')).toBeInTheDocument();
    expect(badge.querySelector('.lucide-lock')).toBeInTheDocument();
  });

  it('uses the singular "day" for a 1-day threshold', () => {
    const badge = renderBadge({ name: 'First Step', threshold: 1 });
    expect(badge).toHaveAttribute('title', 'First Step - Reach 1 day to unlock');
  });

  it('shows an earned badge with its earned date and filled icon', () => {
    const badge = renderBadge({ earned: true, earned_at: '2026-10-05T12:00:00Z' });

    expect(badge).toHaveClass(styles.earned);
    expect(badge).not.toHaveClass(styles.locked);
    expect(badge).toHaveAttribute('title', 'Week Warrior - Earned Oct 5, 2026');
    expect(badge.querySelector('.lucide-lock')).not.toBeInTheDocument();

    const icon = badge.querySelector('.lucide-flame');
    expect(icon).toHaveAttribute('fill', '#f97316');
    expect(icon).toHaveAttribute('fill-opacity', '0.25');
  });

  it('draws a hollow icon while locked', () => {
    const icon = renderBadge().querySelector('.lucide-flame');

    expect(icon).toHaveAttribute('fill', 'none');
    expect(icon).not.toHaveAttribute('fill-opacity');
  });

  it('exposes the badge color as a CSS variable', () => {
    expect(renderBadge({ color: '#22c55e' }).style.getPropertyValue('--badge-color')).toBe(
      '#22c55e'
    );
  });

  it('falls back to a star for unknown icons', () => {
    expect(renderBadge({ icon: 'NotAnIcon' }).querySelector('.lucide-star')).toBeInTheDocument();
  });

  it('can hide the tooltip', () => {
    render(<StreakBadge badge={makeBadge()} showTooltip={false} />);
    expect(screen.getByText('7d').parentElement).not.toHaveAttribute('title');
  });

  it('can show the badge name instead of the threshold', () => {
    render(<StreakBadge badge={makeBadge()} showName />);

    expect(screen.getByText('Week Warrior')).toBeInTheDocument();
    expect(screen.queryByText('7d')).not.toBeInTheDocument();
  });

  it.each([
    ['sm', '16'],
    ['md', '22'],
    ['lg', '28'],
  ] as const)('renders the %s size with a %spx icon', (size, iconSize) => {
    const { container } = render(<StreakBadge badge={makeBadge()} size={size} />);
    const badge = container.firstElementChild as HTMLElement;

    expect(badge).toHaveClass(styles[size]);
    expect(badge.querySelector('.lucide-flame')).toHaveAttribute('width', iconSize);
  });
});
