import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { badge } from '../test/fixtures/social';
import BadgeShowcaseDefault, { BadgeShowcase } from './BadgeShowcase';

const BADGES = [
  badge({
    key: 'streak_3',
    name: 'Getting Started',
    icon: 'Footprints',
    threshold: 3,
    earned: true,
    earned_at: '2026-10-01T00:00:00Z',
  }),
  badge({
    key: 'streak_7',
    name: 'Week Warrior',
    threshold: 7,
    earned: true,
    earned_at: '2026-10-05T00:00:00Z',
  }),
  badge({ key: 'streak_30', name: 'Monthly Master', icon: 'Shield', threshold: 30 }),
  badge({ key: 'streak_100', name: 'Centurion', icon: 'Crown', threshold: 100 }),
];

const allEarned = BADGES.map((b) => ({ ...b, earned: true, earned_at: '2026-10-10T00:00:00Z' }));

describe('BadgeShowcase', () => {
  it('shows how many badges are earned and lists every badge', () => {
    render(<BadgeShowcase badges={BADGES} longestStreak={12} />);

    expect(screen.getByRole('heading', { name: 'Streak badges' })).toBeInTheDocument();
    expect(screen.getByLabelText('2 of 4 earned')).toHaveTextContent('2/4');
    expect(screen.getByTitle(/^Getting Started - Earned/)).toBeInTheDocument();
    expect(screen.getByTitle(/^Week Warrior - Earned/)).toBeInTheDocument();
    expect(screen.getByTitle('Monthly Master - Reach 30 days to unlock')).toBeInTheDocument();
    expect(screen.getByTitle('Centurion - Reach 100 days to unlock')).toBeInTheDocument();
  });

  it('shows progress toward the next badge to earn', () => {
    render(<BadgeShowcase badges={BADGES} longestStreak={12} />);

    expect(screen.getByText('Monthly Master', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByText('12/30 days')).toBeInTheDocument();
    const progress = screen.getByRole('progressbar', { name: 'Progress to Monthly Master' });
    expect(progress).toHaveAttribute('aria-valuemin', '0');
    expect(progress).toHaveAttribute('aria-valuemax', '30');
    expect(progress).toHaveAttribute('aria-valuenow', '12');
    expect(progress.firstElementChild).toHaveStyle({ width: '40%' });
  });

  it('caps the progress at the next threshold', () => {
    render(<BadgeShowcase badges={BADGES} longestStreak={45} />);

    const progress = screen.getByRole('progressbar');
    expect(progress).toHaveAttribute('aria-valuenow', '30');
    expect(progress.firstElementChild).toHaveStyle({ width: '100%' });
  });

  it('can hide the progress section', () => {
    render(<BadgeShowcase badges={BADGES} longestStreak={12} showProgress={false} />);

    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.queryByText(/Next:/)).not.toBeInTheDocument();
  });

  it('celebrates once every badge is earned', () => {
    render(<BadgeShowcase badges={allEarned} longestStreak={120} size="lg" />);

    expect(screen.getByLabelText('4 of 4 earned')).toBeInTheDocument();
    expect(screen.getByText('Legendary status achieved!')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('does not celebrate while badges are still locked', () => {
    render(<BadgeShowcase badges={BADGES} longestStreak={12} showProgress={false} />);

    expect(screen.queryByText('Legendary status achieved!')).not.toBeInTheDocument();
  });

  it('does not claim legendary status when there are no badges', () => {
    render(<BadgeShowcase badges={[]} longestStreak={0} />);

    expect(screen.queryByText('Legendary status achieved!')).not.toBeInTheDocument();
  });

  it('is exported as the default export', () => {
    expect(BadgeShowcaseDefault).toBe(BadgeShowcase);
  });
});
