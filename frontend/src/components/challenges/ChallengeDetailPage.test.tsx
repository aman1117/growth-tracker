import { act, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, challengeApi } from '../../services/api';
import { gl } from '../../services/goodlogs';
import { useChallengeStore } from '../../store';
import { renderChallengeRoutes } from '../../test/fixtures/challengeRoutes';
import {
  ALICE_USER,
  CHALLENGE_NOW,
  detailResponse,
  listResponse,
  makeChallengeDetail,
  makeChallengeSummary,
  makeChallengeUser,
  makeDays,
  makeParticipant,
  makeProgress,
  makeUpcomingSummary,
} from '../../test/fixtures/challenges';
import { createNavigator, deferred } from '../../test/fixtures/shell';
import type { ChallengeDetail, ChallengeDetailResponse } from '../../types';

vi.mock('../../services/api', async (importOriginal) => {
  const { createChallengeApiMock } = await import('../../test/fixtures/challenges');
  return {
    ...(await importOriginal<typeof import('../../services/api')>()),
    challengeApi: createChallengeApiMock(),
  };
});

const api = vi.mocked(challengeApi);

const renderDetail = (
  entry: Parameters<typeof renderChallengeRoutes>[0][number] = '/challenges/42'
) => renderChallengeRoutes([entry]);

const header = () => screen.getByRole('heading', { level: 1 });
const location = () => screen.getByTestId('location');
const loaded = () => screen.findByRole('heading', { name: 'Your progress' });

function mockDetail(overrides: Partial<ChallengeDetail> = {}) {
  const challenge = makeChallengeDetail(overrides);
  api.get.mockResolvedValue(detailResponse(challenge));
  return challenge;
}

describe('ChallengeDetailPage', () => {
  beforeEach(() => {
    vi.setSystemTime(CHALLENGE_NOW);
    // Overlay history logs its steps with console.debug in development builds
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    mockDetail();
    api.list.mockResolvedValue(listResponse([]));
  });

  describe('showing a challenge', () => {
    it('shows the goal, the people, my progress, my days and the leaderboard', async () => {
      renderDetail();
      await loaded();

      expect(api.get).toHaveBeenCalledWith(42);
      expect(header()).toHaveTextContent('Study 2h+ a day');

      const hero = screen.getByRole('region', { name: 'Challenge details' });
      expect(hero).toHaveTextContent('At least 2h of Study a day');
      expect(hero).toHaveTextContent('Oct 18 – Nov 7 · Day 5 of 21');
      expect(hero).toHaveTextContent('3 people');
      expect(hero).toHaveTextContent('Started by alice');
      expect(within(hero).getByRole('img', { name: 'alice, bob and carol' })).toBeInTheDocument();
      expect(within(hero).getByRole('button', { name: 'Invite' })).toBeInTheDocument();
      expect(within(hero).getByRole('button', { name: 'Share link' })).toBeInTheDocument();

      const progress = screen.getByRole('region', { name: 'Your progress' });
      expect(within(progress).getByRole('progressbar', { name: 'Days met' })).toHaveAttribute(
        'aria-valuetext',
        '3 of 21 days met'
      );
      expect(progress).toHaveTextContent('1.5 / 2h today – 0.5h to go');
      expect(progress).toHaveTextContent('2-day streak');
      expect(progress).toHaveTextContent('Meet the goal on 17 of 21 days to complete it');
      expect(within(progress).getByRole('list', { name: 'Your days' })).toBeInTheDocument();
      expect(
        within(progress).getByRole('img', { name: 'Oct 22 (today): pending, 1.5 hours' })
      ).toBeInTheDocument();

      expect(screen.getByRole('heading', { name: 'Leaderboard' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'More options' })).not.toBeInTheDocument();
      expect(useChallengeStore.getState().challenges.map((challenge) => challenge.id)).toEqual([
        42,
      ]);
    });

    it('fills the header from the list while the challenge loads', async () => {
      const response = deferred<ChallengeDetailResponse>();
      api.get.mockReturnValue(response.promise);
      useChallengeStore.setState({ challenges: [makeChallengeSummary()], status: 'ready' });
      const { container } = renderDetail();

      expect(header()).toHaveTextContent('Study 2h+ a day');
      expect(container.querySelector('[aria-busy="true"]')).toBeInTheDocument();

      await act(async () => response.resolve(detailResponse(makeChallengeDetail())));
      expect(container.querySelector('[aria-busy="true"]')).not.toBeInTheDocument();
    });

    it('calls it "Challenge" until it loads when it is not in the list', () => {
      api.get.mockReturnValue(new Promise(() => {}));
      renderDetail();

      expect(header()).toHaveTextContent('Challenge');
    });

    it('opens Home to log today', async () => {
      const { user } = renderDetail();
      await loaded();

      await user.click(screen.getByRole('button', { name: 'Log today' }));

      expect(location()).toHaveTextContent(/^\/$/);
      expect(gl.track).toHaveBeenCalledWith('challenge_log_today_clicked', {
        properties: { challengeId: 42 },
      });
    });

    it('goes back to the list from a deep link', async () => {
      const { user } = renderDetail();
      await loaded();

      await user.click(screen.getByRole('button', { name: 'Go back' }));

      expect(location()).toHaveTextContent(/^\/challenges$/);
    });

    it('shows an upcoming challenge: when it starts, and who is in', async () => {
      const upcoming = makeUpcomingSummary();
      mockDetail({
        ...upcoming,
        my_days: makeDays(upcoming.start_date, 'U'.repeat(21)),
        participants: [
          makeParticipant({ ...upcoming.me, user: ALICE_USER, is_me: true, days: 'U'.repeat(21) }),
        ],
        participant_count: 1,
      });
      renderDetail('/challenges/43');
      await loaded();

      const progress = screen.getByRole('region', { name: 'Your progress' });
      expect(progress).toHaveTextContent('Starts tomorrow');
      expect(progress).not.toHaveTextContent('streak');
      expect(within(progress).queryByRole('button')).not.toBeInTheDocument();
      expect(screen.getByRole('heading', { name: "Who's in" })).toBeInTheDocument();
      expect(screen.queryByText(/Rank/)).not.toBeInTheDocument();
      expect(screen.getByText('Starts tomorrow', { selector: 'p' })).toBeInTheDocument();
    });

    it('announces when the results of an ended challenge become final', async () => {
      mockDetail({ status: 'ended', day_number: null, me: makeProgress({ today_status: null }) });
      renderDetail();
      await loaded();

      const banner = screen
        .getAllByRole('status')
        .find((element) => element.textContent?.includes('Final results on Nov 9'));
      expect(banner).toHaveTextContent('Days can still be logged or fixed until then.');
      expect(screen.getByRole('region', { name: 'Your progress' })).toHaveTextContent(
        'Final results on Nov 9'
      );
      expect(screen.queryByRole('button', { name: /Cheer/ })).not.toBeInTheDocument();
    });

    it('shows my final result', async () => {
      mockDetail({
        status: 'ended',
        finalized: true,
        day_number: null,
        me: makeProgress({ rank: 1, completed: true, today_status: null }),
      });
      renderDetail();
      await loaded();

      const progress = screen.getByRole('region', { name: 'Your progress' });
      expect(progress).toHaveTextContent('You finished 1st · Completed');
      expect(progress).not.toHaveTextContent('to complete it');
    });

    it('says how far a result that was not completed fell short', async () => {
      mockDetail({
        status: 'ended',
        finalized: true,
        day_number: null,
        me: makeProgress({ rank: 3, days_met: 10, completed: false, today_status: null }),
      });
      renderDetail();
      await loaded();

      const progress = screen.getByRole('region', { name: 'Your progress' });
      expect(progress).toHaveTextContent('You finished 3rd');
      expect(progress).toHaveTextContent('10 of the 17 days needed to complete it');
    });

    it('describes a "none at all" goal', async () => {
      mockDetail({
        activity: 'reels',
        goal_type: 'at_most',
        target_hours: 0,
        title: 'Reels-free days',
        me: makeProgress({ today_hours: 0, today_status: 'met' }),
      });
      renderDetail();
      await loaded();

      expect(screen.getByRole('region', { name: 'Challenge details' })).toHaveTextContent(
        'No Reels at all'
      );
      expect(screen.getByRole('region', { name: 'Your progress' })).toHaveTextContent(
        'Reels-free so far today'
      );
    });

    it('shows an "at most" day over the limit', async () => {
      mockDetail({
        activity: 'reels',
        goal_type: 'at_most',
        target_hours: 1,
        me: makeProgress({ today_hours: 2, today_status: 'missed' }),
      });
      renderDetail();
      await loaded();

      expect(screen.getByRole('region', { name: 'Your progress' })).toHaveTextContent(
        'Over the limit today'
      );
    });

    it('copes with long titles, long usernames and missing pictures', async () => {
      const title = 'Read every single day until the very end of this long year!!';
      mockDetail({
        title,
        creator: makeChallengeUser({ id: 9, username: 'a_really_long_username_for_testing_1' }),
        participants: [
          makeParticipant({ user: ALICE_USER, is_me: true }),
          makeParticipant({
            user: makeChallengeUser({ id: 9, username: 'a_really_long_username_for_testing_1' }),
          }),
        ],
      });
      renderDetail();
      await loaded();

      expect(header()).toHaveTextContent(title);
      expect(screen.getByText('Started by a_really_long_username_for_testing_1')).toBeVisible();
      expect(screen.getAllByText('A').length).toBeGreaterThan(0);
    });
  });

  describe('arriving', () => {
    it('suggests inviting friends to a challenge just created, once', async () => {
      api.getInviteCandidates.mockResolvedValue({ success: true, users: [] });
      const { user } = renderDetail({ pathname: '/challenges/42', state: { created: true } });
      await loaded();

      const prompt = screen.getByText('Invite friends to join').closest('[role="status"]')!;
      await waitFor(() => expect(location()).toHaveAttribute('data-state', 'null'));

      await user.click(within(prompt as HTMLElement).getByRole('button', { name: 'Invite' }));
      expect(screen.getByRole('dialog', { name: 'Invite friends' })).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Done' }));
      // The prompt stays until the user dismisses it or invites someone
      await user.click(screen.getByRole('button', { name: 'Dismiss' }));
      expect(screen.queryByText('Invite friends to join')).not.toBeInTheDocument();
    });

    it('does not suggest inviting when the user may not invite', async () => {
      mockDetail({ status: 'ended', can_invite: false, day_number: null });
      renderDetail({ pathname: '/challenges/42', state: { created: true } });
      await loaded();

      expect(screen.queryByText('Invite friends to join')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Invite' })).not.toBeInTheDocument();
    });

    it('welcomes someone who just joined', async () => {
      renderDetail({ pathname: '/challenges/42', state: { joined: true } });

      expect(
        await screen.findByText("You're in! Hours you log count automatically.")
      ).toBeVisible();
    });
  });

  describe('when it cannot be shown', () => {
    beforeEach(() => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    it('says the challenge was not found, and forgets it', async () => {
      api.get.mockRejectedValue(new ApiError('Challenge not found', 404, 'CHALLENGE_NOT_FOUND'));
      useChallengeStore.setState({ challenges: [makeChallengeSummary()], status: 'ready' });
      const { user } = renderDetail();

      expect(await screen.findByText('Challenge not found')).toBeInTheDocument();
      expect(
        screen.getByText("It may have been deleted, or you're not taking part.")
      ).toBeInTheDocument();
      expect(useChallengeStore.getState().challenges).toEqual([]);
      expect(console.warn).toHaveBeenCalledWith('[Challenges] detail_not_found', {
        recovery: 'show_not_found',
        challengeId: 42,
        errorCode: 'CHALLENGE_NOT_FOUND',
        status: 404,
      });

      await user.click(screen.getByRole('button', { name: 'See your challenges' }));
      expect(location()).toHaveTextContent(/^\/challenges$/);
    });

    it.each([
      '/challenges/abc',
      '/challenges/0',
      '/challenges/1.5',
      // Beyond the API's unsigned 32-bit ids, which it rejects as a bad request
      '/challenges/4294967296',
      '/challenges/99999999999',
    ])('treats %s as not found without asking the server', (path) => {
      renderDetail(path);

      expect(screen.getByText('Challenge not found')).toBeInTheDocument();
      expect(api.get).not.toHaveBeenCalled();
    });

    it('asks the server about the largest id the API accepts', async () => {
      api.get.mockRejectedValue(new ApiError('Challenge not found', 404, 'CHALLENGE_NOT_FOUND'));
      renderDetail('/challenges/4294967295');

      expect(await screen.findByText('Challenge not found')).toBeInTheDocument();
      expect(api.get).toHaveBeenCalledWith(4294967295);
    });

    it('offers a retry when loading fails', async () => {
      api.get.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      const { user } = renderDetail();

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent("Couldn't load this challenge");
      expect(alert).toHaveTextContent(
        "Couldn't load the challenge. Check your connection and try again."
      );

      await user.click(within(alert).getByRole('button', { name: 'Try again' }));

      await loaded();
      expect(api.get).toHaveBeenCalledTimes(2);
    });
  });

  describe('staying fresh', () => {
    it('ignores the answer for a challenge the user already left', async () => {
      const first = deferred<ChallengeDetailResponse>();
      const second = deferred<ChallengeDetailResponse>();
      api.get.mockImplementation((id: number) => (id === 42 ? first.promise : second.promise));
      const navigator = createNavigator();
      renderChallengeRoutes(['/challenges/42'], navigator.element);

      navigator.go('/challenges/43');
      await act(async () =>
        second.resolve(
          detailResponse(makeChallengeDetail({ ...makeUpcomingSummary(), title: 'Reels plan' }))
        )
      );
      await act(async () => first.resolve(detailResponse(makeChallengeDetail())));

      expect(header()).toHaveTextContent('Reels plan');
      expect(screen.queryByText('Study 2h+ a day')).not.toBeInTheDocument();
    });

    it('reloads quietly when the app regains focus', async () => {
      renderDetail();
      await loaded();
      expect(screen.getByRole('button', { name: 'Cheer bob' })).toBeEnabled();

      const challenge = makeChallengeDetail();
      challenge.participants[1] = { ...challenge.participants[1], cheered_today: true };
      api.get.mockResolvedValue(detailResponse(challenge));
      act(() => window.dispatchEvent(new Event('focus')));

      await waitFor(() => expect(screen.getByRole('button', { name: 'Cheer bob' })).toBeDisabled());
      expect(api.get).toHaveBeenCalledTimes(2);
    });

    it('keeps showing the challenge when a quiet reload fails', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      renderDetail();
      await loaded();

      api.get.mockRejectedValue(new TypeError('Failed to fetch'));
      act(() => window.dispatchEvent(new Event('focus')));

      await waitFor(() =>
        expect(warn).toHaveBeenCalledWith(
          '[Challenges] detail_load_failed',
          expect.objectContaining({ recovery: 'keep_loaded_detail' })
        )
      );
      expect(screen.getByRole('heading', { name: 'Your progress' })).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });
});
