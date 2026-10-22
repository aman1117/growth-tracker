import { act, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { challengeApi } from '../../services/api';
import { gl } from '../../services/goodlogs';
import { useChallengeStore } from '../../store';
import { renderChallengeRoutes } from '../../test/fixtures/challengeRoutes';
import {
  CHALLENGE_NOW,
  detailResponse,
  listResponse,
  makeChallengeDetail,
  makeChallengeSummary,
  makeEndedSummary,
  makeUpcomingSummary,
} from '../../test/fixtures/challenges';
import { createNavigator, deferred } from '../../test/fixtures/shell';
import type { ChallengesListResponse } from '../../types';
import { TAB_RESELECT_EVENT } from '../../utils/navigation';

vi.mock('../../services/api', async (importOriginal) => {
  const { createChallengeApiMock } = await import('../../test/fixtures/challenges');
  return {
    ...(await importOriginal<typeof import('../../services/api')>()),
    challengeApi: createChallengeApiMock(),
  };
});

const api = vi.mocked(challengeApi);
const active = makeChallengeSummary();
const upcoming = makeUpcomingSummary();
const ended = makeEndedSummary();

const renderPage = (state?: unknown) =>
  renderChallengeRoutes([state ? { pathname: '/challenges', state } : '/challenges']);

const sectionHeadings = () =>
  screen.queryAllByRole('heading', { level: 2 }).map((heading) => heading.textContent);

describe('ChallengesPage', () => {
  beforeEach(() => {
    vi.setSystemTime(CHALLENGE_NOW);
    // Overlay history logs its steps with console.debug in development builds
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    api.list.mockResolvedValue(listResponse([active, upcoming, ended]));
  });

  it('shows skeletons until the list arrives, then the challenges by status', async () => {
    const response = deferred<ChallengesListResponse>();
    api.list.mockReturnValue(response.promise);
    const { container } = renderPage();

    expect(screen.getByRole('heading', { level: 1, name: 'Challenges' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New challenge' })).toBeInTheDocument();
    expect(container.querySelector('[aria-busy="true"]')).toBeInTheDocument();
    expect(sectionHeadings()).toEqual([]);

    await act(async () => response.resolve(listResponse([active, upcoming, ended])));

    expect(sectionHeadings()).toEqual(['Active', 'Upcoming', 'Ended']);
    const [activeSection, upcomingSection, endedSection] = screen.getAllByRole('region');
    expect(within(activeSection).getByRole('link', { name: 'Study 2h+ a day' })).toBeVisible();
    expect(
      within(upcomingSection).getByRole('link', { name: 'Reels under 1h a day' })
    ).toBeVisible();
    expect(within(endedSection).getByRole('link', { name: 'Workout 1h+ a day' })).toBeVisible();
    expect(container.querySelector('[aria-busy="true"]')).not.toBeInTheDocument();
  });

  it('only shows sections that have challenges', async () => {
    api.list.mockResolvedValue(listResponse([ended]));
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Ended' })).toBeInTheDocument();
    expect(sectionHeadings()).toEqual(['Ended']);
  });

  it('invites to start a first challenge when there are none', async () => {
    api.list.mockResolvedValue(listResponse([]));
    const { user } = renderPage();

    expect(await screen.findByText('Challenge your friends')).toBeInTheDocument();
    expect(
      screen.getByText(
        "Pick an activity and a daily goal. Everyone's logged hours count automatically."
      )
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Start a challenge' }));

    expect(screen.getByRole('dialog', { name: 'New challenge' })).toBeInTheDocument();
    expect(gl.track).toHaveBeenCalledWith('challenge_create_opened', {
      properties: { source: 'empty_state' },
    });
  });

  it('opens the create sheet from the header', async () => {
    const { user } = renderPage();
    await screen.findByRole('heading', { name: 'Active' });

    await user.click(screen.getByRole('button', { name: 'New challenge' }));

    expect(screen.getByRole('dialog', { name: 'New challenge' })).toBeInTheDocument();
    expect(gl.track).toHaveBeenCalledWith('challenge_create_opened', {
      properties: { source: 'header' },
    });

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('offers a retry when the list cannot load', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    api.list.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const { user } = renderPage();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't load your challenges");
    expect(alert).toHaveTextContent('Check your connection and try again.');

    await user.click(within(alert).getByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('heading', { name: 'Active' })).toBeInTheDocument();
    expect(api.list).toHaveBeenCalledTimes(2);
  });

  it('shows the cached list at once when coming back', () => {
    useChallengeStore.setState({
      challenges: [active],
      status: 'ready',
      lastFetchedAt: CHALLENGE_NOW.getTime(),
    });
    renderPage();

    expect(screen.getByRole('link', { name: 'Study 2h+ a day' })).toBeInTheDocument();
    expect(api.list).not.toHaveBeenCalled();
  });

  it('moves between the list and a challenge with Back and Forward', async () => {
    api.get.mockResolvedValue(detailResponse(makeChallengeDetail()));
    const navigator = createNavigator();
    const { user } = renderChallengeRoutes(['/challenges'], navigator.element);

    await user.click(await screen.findByRole('link', { name: 'Study 2h+ a day' }));
    expect(await screen.findByRole('heading', { name: 'Your progress' })).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/challenges/42');

    navigator.go(-1);
    // The list comes back at once from the cache, without loading again
    expect(screen.getByRole('heading', { name: 'Active' })).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/challenges$/);

    navigator.go(1);
    expect(await screen.findByRole('heading', { name: 'Your progress' })).toBeInTheDocument();
    expect(api.list).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it('confirms leaving or deleting a challenge once', async () => {
    renderPage({ notice: 'left' });

    expect(await screen.findByRole('status')).toHaveTextContent('You left the challenge');
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveAttribute('data-state', 'null')
    );
  });

  it('confirms a deleted challenge', async () => {
    renderPage({ notice: 'deleted' });

    expect(await screen.findByRole('status')).toHaveTextContent('Challenge deleted');
  });

  it('refreshes the list when its tab is tapped again', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Active' });

    act(() => {
      window.dispatchEvent(new CustomEvent(TAB_RESELECT_EVENT, { detail: { tab: 'home' } }));
      window.dispatchEvent(new Event(TAB_RESELECT_EVENT));
    });
    expect(api.list).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new CustomEvent(TAB_RESELECT_EVENT, { detail: { tab: 'challenges' } }));
    });
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
  });

  it('refreshes a stale list when the app regains focus', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Active' });

    act(() => window.dispatchEvent(new Event('focus')));
    expect(api.list).toHaveBeenCalledTimes(1);

    vi.setSystemTime(CHALLENGE_NOW.getTime() + 60_000);
    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
  });
});
