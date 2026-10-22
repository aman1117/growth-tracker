import { act, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, challengeApi } from '../../services/api';
import { useChallengeStore } from '../../store';
import { renderChallengeRoutes } from '../../test/fixtures/challengeRoutes';
import {
  CHALLENGE_NOW,
  detailResponse,
  listResponse,
  makeChallengeDetail,
  makeChallengePreview,
  makeChallengeSummary,
  makeUpcomingSummary,
} from '../../test/fixtures/challenges';
import { createNavigator, deferred } from '../../test/fixtures/shell';
import type { ChallengeDetailResponse, ChallengePreview } from '../../types';

vi.mock('../../services/api', async (importOriginal) => {
  const { createChallengeApiMock } = await import('../../test/fixtures/challenges');
  return {
    ...(await importOriginal<typeof import('../../services/api')>()),
    challengeApi: createChallengeApiMock(),
  };
});

const api = vi.mocked(challengeApi);
const LIMIT_MESSAGE = "You're already in 10 challenges – finish one first";

function mockPreview(overrides: Partial<ChallengePreview> = {}) {
  api.getPreview.mockResolvedValue({ success: true, preview: makeChallengePreview(overrides) });
}

const renderJoin = (path = '/c/ABCD2345') => renderChallengeRoutes(['/challenges', path]);
const joinButton = () => screen.getByRole('button', { name: /Join challenge|Joining/ });
const location = () => screen.getByTestId('location');

describe('JoinChallengePage', () => {
  beforeEach(() => {
    vi.setSystemTime(CHALLENGE_NOW);
    mockPreview();
    api.join.mockResolvedValue(detailResponse(makeChallengeDetail()));
    api.get.mockResolvedValue(detailResponse(makeChallengeDetail()));
    api.list.mockResolvedValue(listResponse([]));
  });

  it('shows what the invite is for, loading first', async () => {
    const response = deferred<{ success: boolean; preview: ChallengePreview }>();
    api.getPreview.mockReturnValue(response.promise);
    const { container } = renderJoin();

    expect(screen.getByRole('heading', { level: 1, name: 'Join challenge' })).toBeInTheDocument();
    expect(container.querySelector('[aria-busy="true"]')).toBeInTheDocument();
    expect(api.getPreview).toHaveBeenCalledWith('ABCD2345');

    await act(async () => response.resolve({ success: true, preview: makeChallengePreview() }));

    const card = screen.getByRole('region', { name: 'Study 2h+ a day' });
    expect(card).toHaveTextContent('At least 2h of Study a day');
    expect(card).toHaveTextContent('Oct 18 – Nov 7 · Day 5 of 21');
    expect(card).toHaveTextContent('Started by bob');
    expect(within(card).getByRole('img', { name: 'Verified account' })).toBeInTheDocument();
    expect(within(card).getByRole('img', { name: 'bob, carol and user4' })).toBeInTheDocument();
    expect(card).toHaveTextContent('3 people');
    expect(joinButton()).toBeEnabled();
  });

  it('joins once, adds the challenge and opens it in place of the invite', async () => {
    const response = deferred<ChallengeDetailResponse>();
    api.join.mockReturnValue(response.promise);
    const navigator = createNavigator();
    const { user } = renderChallengeRoutes(['/challenges', '/c/ABCD2345'], navigator.element);

    await user.dblClick(await screen.findByRole('button', { name: 'Join challenge' }));
    expect(joinButton()).toHaveTextContent('Joining…');
    expect(joinButton()).toBeDisabled();
    expect(api.join).toHaveBeenCalledExactlyOnceWith('ABCD2345');

    await act(async () => response.resolve(detailResponse(makeChallengeDetail())));

    await waitFor(() => expect(location()).toHaveTextContent('/challenges/42'));
    expect(await screen.findByText("You're in! Hours you log count automatically.")).toBeVisible();
    expect(useChallengeStore.getState().challenges.map((challenge) => challenge.id)).toEqual([42]);

    navigator.go(-1);
    expect(location()).toHaveTextContent(/^\/challenges$/);
  });

  it('lets someone who left join again', async () => {
    useChallengeStore.setState({ challenges: [makeChallengeSummary()], status: 'ready' });
    useChallengeStore.getState().remove(42);
    const { user } = renderJoin();

    await user.click(await screen.findByRole('button', { name: 'Join challenge' }));

    await waitFor(() => expect(location()).toHaveTextContent('/challenges/42'));
    expect(useChallengeStore.getState().challenges.map((challenge) => challenge.id)).toEqual([42]);
  });

  it('opens the challenge for someone already taking part', async () => {
    mockPreview({ is_participant: true, can_join: false });
    const { user } = renderJoin();

    await user.click(await screen.findByRole('button', { name: 'Open challenge' }));

    expect(location()).toHaveTextContent('/challenges/42');
    expect(api.join).not.toHaveBeenCalled();
  });

  it('can join a challenge that has not started yet', async () => {
    const upcoming = makeUpcomingSummary();
    mockPreview({ ...upcoming, title: upcoming.title });
    renderJoin();

    const card = await screen.findByRole('region', { name: 'Reels under 1h a day' });
    expect(card).toHaveTextContent('Oct 23 – Nov 12 · Starts tomorrow');
    expect(joinButton()).toBeEnabled();
  });

  it.each([
    ['ended', 'This challenge has ended'],
    ['full', 'This challenge is full'],
    ['limit', LIMIT_MESSAGE],
    [null, "You can't join this challenge"],
  ] as const)('explains why joining is not possible (%s)', async (reason, message) => {
    mockPreview({ can_join: false, join_blocked_reason: reason });
    renderJoin();

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(joinButton()).toBeDisabled();
    expect(joinButton()).toHaveAccessibleDescription(message);
  });

  it.each([
    ['CHALLENGE_FULL', 'This challenge is full'],
    ['CHALLENGE_ENDED', 'This challenge has ended'],
    ['CHALLENGE_LIMIT_REACHED', LIMIT_MESSAGE],
  ])('turns a refused join (%s) into the reason', async (code, message) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    api.join.mockRejectedValue(new ApiError('Conflict', 409, code));
    const { user } = renderJoin();

    await user.click(await screen.findByRole('button', { name: 'Join challenge' }));

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(joinButton()).toBeDisabled();
    expect(location()).toHaveTextContent('/c/ABCD2345');
  });

  it('lets the user try again after a failed join', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    api.join.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const { user } = renderJoin();

    await user.click(await screen.findByRole('button', { name: 'Join challenge' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      "Couldn't join the challenge. Check your connection and try again."
    );
    expect(joinButton()).toHaveAccessibleDescription(alert.textContent!);
    expect(warn).toHaveBeenCalledWith('[Challenges] join_failed', {
      recovery: 'show_error',
      challengeId: 42,
      errorCode: undefined,
      status: undefined,
    });

    await user.click(joinButton());
    await waitFor(() => expect(location()).toHaveTextContent('/challenges/42'));
  });

  it('says when an invite link is not valid', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    api.getPreview.mockRejectedValue(new ApiError('Not found', 404, 'CHALLENGE_NOT_FOUND'));
    const { user } = renderJoin('/c/NOPE');

    expect(await screen.findByText("This invite link isn't valid")).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Go to your challenges' }));
    expect(location()).toHaveTextContent(/^\/challenges$/);
  });

  it('treats a malformed code (rejected as a bad request) as an invalid link, not a retry', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    api.getPreview.mockRejectedValue(new ApiError('Invalid invite code', 400, 'INVALID_REQUEST'));
    renderJoin('/c/abc');

    expect(await screen.findByText("This invite link isn't valid")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(warn).toHaveBeenCalledWith('[Challenges] invite_link_invalid', {
      recovery: 'show_invalid_link',
      errorCode: 'INVALID_REQUEST',
      status: 400,
    });
  });

  it('does not ask the server about a blank code', () => {
    renderJoin('/c/%20');

    expect(screen.getByText("This invite link isn't valid")).toBeInTheDocument();
    expect(api.getPreview).not.toHaveBeenCalled();
  });

  it('offers a retry when the invite cannot be loaded', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    api.getPreview.mockRejectedValueOnce(new ApiError('Server error', 500, 'INTERNAL_ERROR'));
    const { user } = renderJoin();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't open this invite");
    expect(alert).toHaveTextContent("Couldn't load the challenge. Try again.");

    await user.click(within(alert).getByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('button', { name: 'Join challenge' })).toBeInTheDocument();
  });

  it('goes back', async () => {
    const { user } = renderJoin();
    await screen.findByRole('button', { name: 'Join challenge' });

    await user.click(screen.getByRole('button', { name: 'Go back' }));

    expect(location()).toHaveTextContent(/^\/challenges$/);
  });
});
