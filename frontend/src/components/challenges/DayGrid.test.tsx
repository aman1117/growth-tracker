import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { IST_TODAY, makeDays, MY_DAYS_CODES } from '../../test/fixtures/challenges';
import { DayGrid } from './DayGrid';

const HINT = "You can log or fix a day until the end of the next day. After that it's final.";

describe('DayGrid', () => {
  it('describes every day, rings today and explains when days become final', () => {
    render(
      <DayGrid days={makeDays('2026-10-18', MY_DAYS_CODES, '2026-10-20')} today={IST_TODAY} />
    );

    const grid = screen.getByRole('list', { name: 'Your days' });
    expect(grid).toHaveAccessibleDescription(HINT);
    expect(within(grid).getAllByRole('listitem')).toHaveLength(21);

    expect(screen.getByRole('img', { name: 'Oct 18: met, 2.5 hours' })).toHaveTextContent('18');
    expect(screen.getByRole('img', { name: 'Oct 19: missed, 0.5 hours' })).toBeInTheDocument();
    const today = screen.getByRole('img', { name: 'Oct 22 (today): pending, 1.5 hours' });
    expect(today).toHaveAttribute('aria-current', 'date');
    expect(screen.getByRole('img', { name: 'Nov 7: upcoming' })).toHaveTextContent('7');
    expect(screen.getAllByRole('img').filter((day) => day.hasAttribute('aria-current'))).toEqual([
      today,
    ]);
  });

  it('shows a legend, mentioning days before joining only when there are some', () => {
    const { rerender } = render(
      <DayGrid days={makeDays('2026-10-18', MY_DAYS_CODES)} today={IST_TODAY} />
    );

    const legend = () =>
      within(screen.getByRole('list', { name: 'Legend' }))
        .getAllByRole('listitem')
        .map((item) => item.textContent);
    expect(legend()).toEqual(['Met', 'Missed', 'Pending', 'Upcoming']);

    rerender(<DayGrid days={makeDays('2026-10-18', `---XP${'U'.repeat(16)}`)} today={IST_TODAY} />);
    expect(legend()).toEqual(['Met', 'Missed', 'Pending', 'Upcoming', 'Not taking part']);
    expect(screen.getByRole('img', { name: 'Oct 18: not taking part' })).toBeInTheDocument();
  });

  it('copes with a day it cannot read', () => {
    render(
      <DayGrid
        days={[{ date: 'someday', hours: null, status: 'upcoming', locked: false }]}
        today={IST_TODAY}
      />
    );

    expect(screen.getByRole('img', { name: 'someday: upcoming' })).toHaveTextContent('');
  });

  it('drops the editing hint once the results are final', () => {
    render(<DayGrid days={makeDays('2026-10-18', 'MMX')} today={IST_TODAY} isFinal />);

    expect(screen.queryByText(HINT)).not.toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Your days' })).not.toHaveAttribute('aria-describedby');
  });
});
