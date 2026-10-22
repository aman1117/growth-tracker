import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  IST_TODAY,
  makeChallengeSummary,
  makeEndedSummary,
  makeProgress,
  makeUpcomingSummary,
} from '../../test/fixtures/challenges';
import { renderWithRouter } from '../../test/utils';
import type { ChallengeSummary } from '../../types';
import { ChallengeCard } from './ChallengeCard';

const renderCard = (challenge: ChallengeSummary) =>
  renderWithRouter(
    <ul>
      <li>
        <ChallengeCard challenge={challenge} today={IST_TODAY} />
      </li>
    </ul>
  );

const card = () => screen.getByRole('article');

describe('ChallengeCard', () => {
  it('shows an active challenge with my progress and today', () => {
    renderCard(makeChallengeSummary());

    expect(screen.getByRole('heading', { level: 3, name: 'Study 2h+ a day' })).toBeInTheDocument();
    expect(screen.getByText('At least 2h of Study a day')).toBeInTheDocument();
    expect(screen.getByText('Day 5 of 21 · 3 people')).toBeInTheDocument();

    const progress = screen.getByRole('progressbar', { name: 'Days met' });
    expect(progress).toHaveAttribute('aria-valuenow', '3');
    expect(progress).toHaveAttribute('aria-valuemax', '21');
    expect(progress).toHaveAttribute('aria-valuetext', '3 of 21 days met');
    expect(screen.getByText('3/21 days')).toBeInTheDocument();

    const today = screen.getByText('1.5 / 2h today').parentElement!;
    expect(today).toHaveTextContent('Not done yet today: 1.5 / 2h today');
    expect(card()).not.toHaveTextContent('Completed');
    expect(card()).not.toHaveTextContent('Final rank');
  });

  it('opens the challenge from its title link', async () => {
    const { user } = renderCard(makeChallengeSummary());

    await user.click(screen.getByRole('link', { name: 'Study 2h+ a day' }));

    expect(screen.getByTestId('location')).toHaveTextContent('/challenges/42');
  });

  it.each([
    ['met', makeProgress({ today_hours: 2.5, today_status: 'met' }), 'Done today: 2.5 / 2h today'],
    [
      'pending',
      makeProgress({ today_hours: 0, today_status: 'pending' }),
      'Not done yet today: 0 / 2h today',
    ],
  ])('colours today by status (%s)', (_label, me, text) => {
    renderCard(makeChallengeSummary({ me }));

    expect(card()).toHaveTextContent(text);
  });

  it('describes an "at most" goal, including a day that is not logged yet', () => {
    renderCard(
      makeChallengeSummary({
        activity: 'reels',
        goal_type: 'at_most',
        target_hours: 1,
        me: makeProgress({ today_hours: null, today_status: 'pending' }),
      })
    );

    expect(screen.getByText('At most 1h of Reels a day')).toBeInTheDocument();
    expect(screen.getByText('Not logged yet')).toBeInTheDocument();
    expect(card()).not.toHaveTextContent('Not logged yet today');
  });

  it('flags an "at most" day over the limit', () => {
    renderCard(
      makeChallengeSummary({
        activity: 'reels',
        goal_type: 'at_most',
        target_hours: 0,
        me: makeProgress({ today_hours: 0.5, today_status: 'missed' }),
      })
    );

    expect(screen.getByText('No Reels at all')).toBeInTheDocument();
    expect(card()).toHaveTextContent('Over the limit today: 0.5h today');
  });

  it('shows no today chip for an upcoming challenge', () => {
    renderCard(makeUpcomingSummary());

    expect(screen.getByText('Starts tomorrow · 1 person')).toBeInTheDocument();
    expect(screen.queryByText(/today/)).not.toBeInTheDocument();
    expect(screen.getByText('0/21 days')).toBeInTheDocument();
  });

  it('shows my final rank and completion once the results are final', () => {
    renderCard(makeEndedSummary());

    expect(screen.getByText('Ended Oct 10 · 4 people')).toBeInTheDocument();
    expect(within(card()).getByText(/#2/)).toHaveTextContent('Final rank #2');
    expect(screen.getByText('Completed')).toBeInTheDocument();
  });

  it.each([1, 3, 7])('shows rank %i without a completion mark when not completed', (rank) => {
    renderCard(makeEndedSummary({ me: makeProgress({ rank, completed: false }) }));

    expect(within(card()).getByText(new RegExp(`#${rank}`))).toBeInTheDocument();
    expect(screen.queryByText('Completed')).not.toBeInTheDocument();
  });

  it('waits for final results before showing a rank', () => {
    renderCard(makeEndedSummary({ finalized: false, me: makeProgress({ rank: 1 }) }));

    expect(screen.getByText('Ended · final results on Oct 12 · 4 people')).toBeInTheDocument();
    expect(card()).not.toHaveTextContent('#1');
  });

  it('copes with a late joiner who has no days yet', () => {
    renderCard(
      makeChallengeSummary({
        me: makeProgress({ days_met: 0, days_possible: 0, today_status: null, today_hours: null }),
      })
    );

    const progress = screen.getByRole('progressbar', { name: 'Days met' });
    expect(progress).toHaveAttribute('aria-valuemax', '1');
    expect(progress).toHaveAttribute('aria-valuetext', '0 of 0 days met');
    expect(screen.queryByText(/today/)).not.toBeInTheDocument();
  });

  it('keeps a long title in one piece for assistive technology', () => {
    const title = 'A very long challenge title that goes on and on until sixty!';
    renderCard(makeChallengeSummary({ title }));

    expect(screen.getByRole('link', { name: title })).toBeInTheDocument();
  });
});
