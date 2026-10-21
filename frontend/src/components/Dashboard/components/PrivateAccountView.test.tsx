import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { makeBadge } from '../../../test/fixtures/dashboard';
import { PrivateAccountView } from './PrivateAccountView';

describe('PrivateAccountView', () => {
  it('explains that the account is private and how to see it', () => {
    render(<PrivateAccountView targetUsername="bob" badges={[]} />);

    const card = screen.getByRole('region', { name: 'This account is private' });
    expect(card).toHaveTextContent('Follow @bob to see their days and stories.');
    expect(screen.queryByText('Badges earned')).not.toBeInTheDocument();
  });

  it('still shows the public badges the user has earned', () => {
    render(
      <PrivateAccountView
        targetUsername="bob"
        badges={[
          makeBadge(),
          makeBadge({ key: 'week', name: 'Week Warrior', threshold: 7 }),
          makeBadge({ key: 'month', name: 'Monthly Master', threshold: 30, earned: false }),
        ]}
      />
    );

    expect(screen.getByText('Badges earned')).toBeInTheDocument();
    const badges = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(badges.map((badge) => badge.textContent)).toEqual(['First Step', 'Week Warrior']);
    expect(badges[1]).toHaveAttribute('title', 'Week Warrior - 7 day streak');
  });

  it('hides the badge list when none are earned yet', () => {
    render(<PrivateAccountView targetUsername="bob" badges={[makeBadge({ earned: false })]} />);

    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });
});
