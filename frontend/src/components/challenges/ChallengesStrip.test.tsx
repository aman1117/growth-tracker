import { screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { challengeApi } from '../../services/api';
import { gl } from '../../services/goodlogs';
import {
  CHALLENGE_NOW,
  listResponse,
  makeChallengeSummary,
  makeEndedSummary,
  makeProgress,
  makeUpcomingSummary,
} from '../../test/fixtures/challenges';
import { renderWithRouter } from '../../test/utils';
import { ChallengesStrip } from './ChallengesStrip';

vi.mock('../../services/api', async (importOriginal) => {
  const { createChallengeApiMock } = await import('../../test/fixtures/challenges');
  return {
    ...(await importOriginal<typeof import('../../services/api')>()),
    challengeApi: createChallengeApiMock(),
  };
});

const api = vi.mocked(challengeApi);

const reels = makeChallengeSummary({
  id: 44,
  title: 'Reels under 1h a day',
  activity: 'reels',
  goal_type: 'at_most',
  target_hours: 1,
  day_number: 12,
  me: makeProgress({ today_hours: null, today_status: 'pending' }),
});

describe('ChallengesStrip', () => {
  beforeEach(() => {
    vi.setSystemTime(CHALLENGE_NOW);
    api.list.mockResolvedValue(
      listResponse([makeChallengeSummary(), reels, makeUpcomingSummary(), makeEndedSummary()])
    );
  });

  it('shows the active challenges with the day and today’s progress', async () => {
    renderWithRouter(<ChallengesStrip />);

    const strip = await screen.findByRole('region', { name: 'Challenges' });
    expect(api.list).toHaveBeenCalledTimes(1);

    const links = within(strip).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual([
      'See all',
      'Study 2h+ a dayDay 5/21Day 5 of 21Not done yet today: 1.5 / 2h today',
      'Reels under 1h a dayDay 12/21Day 12 of 21Not logged yet',
    ]);
    expect(within(strip).getByRole('link', { name: 'See all' })).toHaveAttribute(
      'href',
      '/challenges'
    );
  });

  it('opens a challenge', async () => {
    const { user } = renderWithRouter(<ChallengesStrip />);

    await user.click(await screen.findByRole('link', { name: /^Study 2h\+ a day/ }));

    expect(screen.getByTestId('location')).toHaveTextContent('/challenges/42');
  });

  it.each([
    ['met', 0.5, 'Within the limit today: 0.5 / 1h today'],
    ['missed', 1.5, 'Over the limit today: 1.5 / 1h today'],
  ] as const)('shows an "at most" day that is %s', async (status, hours, text) => {
    api.list.mockResolvedValue(
      listResponse([{ ...reels, me: makeProgress({ today_hours: hours, today_status: status }) }])
    );
    renderWithRouter(<ChallengesStrip />);

    expect(await screen.findByRole('link', { name: /Reels under 1h a day/ })).toHaveTextContent(
      text
    );
  });

  it('starts at day 1 when the day is unknown, and leaves out a day that does not count', async () => {
    api.list.mockResolvedValue(
      listResponse([
        makeChallengeSummary({
          day_number: null,
          me: makeProgress({ today_hours: null, today_status: null }),
        }),
      ])
    );
    renderWithRouter(<ChallengesStrip />);

    const link = await screen.findByRole('link', { name: /Study 2h\+ a day/ });
    expect(link).toHaveTextContent('Day 1/21');
    expect(link).not.toHaveTextContent('today');
  });

  it('stays hidden without active challenges', async () => {
    api.list.mockResolvedValue(listResponse([makeUpcomingSummary(), makeEndedSummary()]));
    renderWithRouter(<ChallengesStrip />);

    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });

  it('stays hidden when the list cannot load, reporting it once', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    api.list.mockRejectedValue(new TypeError('Failed to fetch'));
    const { rerender } = renderWithRouter(<ChallengesStrip />);

    await waitFor(() => expect(gl.warn).toHaveBeenCalledTimes(1));
    expect(gl.warn).toHaveBeenCalledWith('challenge_strip_hidden', {
      metadata: { reason: 'list_failed' },
    });
    expect(screen.queryByRole('region')).not.toBeInTheDocument();

    rerender(
      <MemoryRouter>
        <ChallengesStrip />
      </MemoryRouter>
    );
    expect(gl.warn).toHaveBeenCalledTimes(1);
  });
});
