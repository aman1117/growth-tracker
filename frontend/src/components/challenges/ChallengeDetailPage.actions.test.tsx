import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, challengeApi } from '../../services/api';
import { gl } from '../../services/goodlogs';
import { useChallengeStore } from '../../store';
import { renderChallengeRoutes } from '../../test/fixtures/challengeRoutes';
import {
  BOB_USER,
  CHALLENGE_NOW,
  detailResponse,
  listResponse,
  makeChallengeDetail,
  makeChallengeSummary,
  makeInviteCandidate,
} from '../../test/fixtures/challenges';
import { deferred } from '../../test/fixtures/shell';
import type {
  ChallengeActionResponse,
  ChallengeCheerResponse,
  ChallengeDetail,
  ChallengeInvitesResponse,
} from '../../types';

vi.mock('../../services/api', async (importOriginal) => {
  const { createChallengeApiMock } = await import('../../test/fixtures/challenges');
  return {
    ...(await importOriginal<typeof import('../../services/api')>()),
    challengeApi: createChallengeApiMock(),
  };
});

const api = vi.mocked(challengeApi);

function mockDetail(overrides: Partial<ChallengeDetail> = {}) {
  const challenge = makeChallengeDetail(overrides);
  api.get.mockResolvedValue(detailResponse(challenge));
  return challenge;
}

async function renderLoaded() {
  const view = renderChallengeRoutes(['/challenges/42']);
  await screen.findByRole('heading', { name: 'Your progress' });
  return view;
}

const cheerBob = () => screen.getByRole('button', { name: 'Cheer bob' });
const location = () => screen.getByTestId('location');

describe('ChallengeDetailPage actions', () => {
  beforeEach(() => {
    vi.setSystemTime(CHALLENGE_NOW);
    // Overlay history logs its steps with console.debug in development builds
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    mockDetail();
    api.list.mockResolvedValue(listResponse([]));
  });

  describe('cheering', () => {
    it('shows the cheer at once and confirms it once sent', async () => {
      const response = deferred<ChallengeCheerResponse>();
      api.cheer.mockReturnValue(response.promise);
      const { user } = await renderLoaded();

      await user.click(cheerBob());

      expect(cheerBob()).toBeDisabled();
      expect(cheerBob()).toHaveTextContent('Cheered');
      expect(api.cheer).toHaveBeenCalledExactlyOnceWith(42, BOB_USER.id);

      await act(async () => response.resolve({ success: true, already_cheered: false }));
      expect(screen.getByRole('status')).toHaveTextContent('You cheered bob');
      expect(cheerBob()).toBeDisabled();
    });

    it('sends one cheer however often the button is pressed', async () => {
      api.cheer.mockReturnValue(new Promise(() => {}));
      const { user } = await renderLoaded();

      await user.dblClick(cheerBob());
      await user.click(cheerBob());

      expect(api.cheer).toHaveBeenCalledTimes(1);
    });

    it('takes the cheer back when it fails, and reloads a challenge that stopped', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      api.cheer.mockRejectedValue(new ApiError('Not active', 409, 'CHALLENGE_NOT_ACTIVE'));
      const { user } = await renderLoaded();

      await user.click(cheerBob());

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Cheers are only possible while a challenge is running'
      );
      await waitFor(() => expect(cheerBob()).toBeEnabled());
      expect(cheerBob()).toHaveTextContent('Cheer');
      await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
      expect(warn).toHaveBeenCalledWith('[Challenges] cheer_failed', {
        recovery: 'rollback',
        challengeId: 42,
        toUserId: BOB_USER.id,
        errorCode: 'CHALLENGE_NOT_ACTIVE',
        status: 409,
      });
    });

    it('takes the cheer back after a connection problem without reloading', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      api.cheer.mockRejectedValue(new TypeError('Failed to fetch'));
      const { user } = await renderLoaded();

      await user.click(cheerBob());

      expect(await screen.findByRole('alert')).toHaveTextContent(
        "Couldn't send your cheer. Check your connection and try again."
      );
      expect(cheerBob()).toBeEnabled();
      expect(api.get).toHaveBeenCalledTimes(1);
    });

    it('keeps a cheer that is on its way when fresh data arrives', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const response = deferred<ChallengeCheerResponse>();
      api.cheer.mockReturnValue(response.promise);
      const { user } = await renderLoaded();

      await user.click(cheerBob());
      act(() => window.dispatchEvent(new Event('focus')));
      await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
      expect(cheerBob()).toHaveTextContent('Cheered');

      await act(async () => response.reject(new TypeError('Failed to fetch')));
      expect(cheerBob()).toHaveTextContent('Cheer');
    });
  });

  describe('sharing the invite link', () => {
    afterEach(() => {
      Reflect.deleteProperty(navigator, 'share');
    });

    it('copies the link where the browser cannot share', async () => {
      const { user } = await renderLoaded();

      await user.click(screen.getByRole('button', { name: 'Share link' }));

      expect(await screen.findByRole('status')).toHaveTextContent('Invite link copied');
      await expect(navigator.clipboard.readText()).resolves.toBe(
        `${window.location.origin}/c/ABCD2345`
      );
      expect(gl.track).toHaveBeenCalledWith('challenge_link_shared', {
        properties: { challengeId: 42, method: 'copy', source: 'detail' },
      });
    });

    it('opens the share sheet where there is one, once at a time', async () => {
      const shared = deferred<void>();
      const share = vi.fn(() => shared.promise);
      Object.defineProperty(navigator, 'share', { value: share, configurable: true });
      const { user } = await renderLoaded();

      await user.click(screen.getByRole('button', { name: 'Share link' }));
      expect(screen.getByRole('button', { name: 'Share link' })).toBeDisabled();
      await user.click(screen.getByRole('button', { name: 'Share link' }));

      await act(async () => shared.resolve());
      expect(share).toHaveBeenCalledExactlyOnceWith({
        url: `${window.location.origin}/c/ABCD2345`,
        title: 'Study 2h+ a day',
        text: 'Join my challenge “Study 2h+ a day” on Growth Tracker',
      });
      expect(gl.track).toHaveBeenCalledWith('challenge_link_shared', {
        properties: { challengeId: 42, method: 'share', source: 'detail' },
      });
      expect(screen.getByRole('button', { name: 'Share link' })).toBeEnabled();
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    it('says so when the link can be neither shared nor copied', async () => {
      const { user } = await renderLoaded();
      vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));

      await user.click(screen.getByRole('button', { name: 'Share link' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(
        "Couldn't share the link. Try Invite instead."
      );
      expect(gl.track).not.toHaveBeenCalledWith('challenge_link_shared', expect.anything());
    });
  });

  describe('inviting', () => {
    it.each<[ChallengeInvitesResponse, string]>([
      [{ success: true, invited: 1, skipped: 0 }, 'Invited 1 friend'],
      [{ success: true, invited: 2, skipped: 1 }, "Invited 2 friends (1 couldn't be invited)"],
      [{ success: true, invited: 0, skipped: 1 }, 'No invites sent – they may already be invited'],
    ])('confirms the result %o', async (result, message) => {
      api.getInviteCandidates.mockResolvedValue({
        success: true,
        users: [makeInviteCandidate({ id: 7, username: 'dave' })],
      });
      api.invite.mockResolvedValue(result);
      const { user } = await renderLoaded();

      await user.click(screen.getByRole('button', { name: 'Invite' }));
      expect(gl.track).toHaveBeenCalledWith('challenge_invite_opened', {
        properties: { challengeId: 42 },
      });
      await user.click(await screen.findByRole('checkbox', { name: 'dave' }));
      await user.click(screen.getByRole('button', { name: 'Invite 1' }));

      expect(await screen.findByText(message)).toBeInTheDocument();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(api.invite).toHaveBeenCalledWith(42, [7]);
    });

    it('closes the invite sheet without inviting anyone', async () => {
      api.getInviteCandidates.mockResolvedValue({ success: true, users: [] });
      const { user } = await renderLoaded();

      await user.click(screen.getByRole('button', { name: 'Invite' }));
      const sheet = await screen.findByRole('dialog', { name: 'Invite friends' });
      await user.click(within(sheet).getByRole('button', { name: 'Done' }));

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(api.invite).not.toHaveBeenCalled();
      expect(location()).toHaveTextContent('/challenges/42');
    });
  });

  describe('leaving and deleting', () => {
    const openOptions = async (user: Awaited<ReturnType<typeof renderLoaded>>['user']) => {
      await user.click(screen.getByRole('button', { name: 'More options' }));
      return screen.getByRole('dialog', { name: 'Challenge options' });
    };

    beforeEach(() => {
      useChallengeStore.setState({
        challenges: [makeChallengeSummary()],
        status: 'ready',
        lastFetchedAt: CHALLENGE_NOW.getTime(),
      });
    });

    it('leaves after confirming, then shows the list without it', async () => {
      mockDetail({ is_creator: false, can_leave: true, creator: BOB_USER });
      const response = deferred<ChallengeActionResponse>();
      api.leave.mockReturnValue(response.promise);
      const { user } = await renderLoaded();

      const options = await openOptions(user);
      expect(within(options).queryByRole('button', { name: 'Delete challenge' })).toBeNull();
      await user.click(within(options).getByRole('button', { name: 'Leave challenge' }));

      const confirm = await screen.findByRole('alertdialog', { name: 'Leave this challenge?' });
      expect(confirm).toHaveTextContent(
        "You can join again with the invite link, but you'll start fresh."
      );
      await user.click(within(confirm).getByRole('button', { name: 'Leave' }));
      expect(within(confirm).getByRole('button', { name: 'Leave' })).toBeDisabled();
      await user.click(within(confirm).getByRole('button', { name: 'Leave' }));
      expect(api.leave).toHaveBeenCalledExactlyOnceWith(42);

      await act(async () => response.resolve({ success: true }));

      await waitFor(() => expect(location()).toHaveTextContent(/^\/challenges$/));
      expect(await screen.findByText('You left the challenge')).toBeInTheDocument();
      expect(screen.getByText('Challenge your friends')).toBeInTheDocument();
      expect(useChallengeStore.getState().challenges).toEqual([]);
    });

    it('deletes after confirming', async () => {
      mockDetail({ status: 'upcoming', day_number: null, can_delete: true });
      api.remove.mockResolvedValue({ success: true });
      const { user } = await renderLoaded();

      const options = await openOptions(user);
      expect(within(options).queryByRole('button', { name: 'Leave challenge' })).toBeNull();
      await user.click(within(options).getByRole('button', { name: 'Delete challenge' }));
      const confirm = await screen.findByRole('alertdialog', { name: 'Delete this challenge?' });
      await user.click(within(confirm).getByRole('button', { name: 'Delete' }));

      await waitFor(() => expect(location()).toHaveTextContent(/^\/challenges$/));
      expect(api.remove).toHaveBeenCalledExactlyOnceWith(42);
      expect(await screen.findByText('Challenge deleted')).toBeInTheDocument();
    });

    it('keeps the challenge when the user changes their mind', async () => {
      mockDetail({ can_delete: true });
      const { user } = await renderLoaded();

      await user.click(
        within(await openOptions(user)).getByRole('button', { name: 'Delete challenge' })
      );
      await user.click(
        within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' })
      );

      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(api.remove).not.toHaveBeenCalled();
      expect(location()).toHaveTextContent('/challenges/42');
    });

    it('closes the options with Escape', async () => {
      mockDetail({ can_delete: true });
      const { user } = await renderLoaded();

      await openOptions(user);
      await user.keyboard('{Escape}');

      await waitFor(() =>
        expect(screen.queryByRole('dialog', { name: 'Challenge options' })).not.toBeInTheDocument()
      );
      expect(screen.getByRole('button', { name: 'More options' })).toBeInTheDocument();
      expect(location()).toHaveTextContent('/challenges/42');
    });

    it('explains why leaving is not possible and refreshes the permissions', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockDetail({ can_leave: true });
      api.leave.mockRejectedValue(
        new ApiError('Creator cannot leave', 409, 'CREATOR_CANNOT_LEAVE')
      );
      const { user } = await renderLoaded();

      await user.click(
        within(await openOptions(user)).getByRole('button', { name: 'Leave challenge' })
      );
      await user.click(
        within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Leave' })
      );

      expect(await screen.findByRole('alert')).toHaveTextContent(
        "You started this challenge, so you can't leave it"
      );
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
      expect(location()).toHaveTextContent('/challenges/42');
      expect(warn).toHaveBeenCalledWith(
        '[Challenges] leave_failed',
        expect.objectContaining({ recovery: 'show_error', errorCode: 'CREATOR_CANNOT_LEAVE' })
      );
    });

    it('explains why deleting is not possible', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockDetail({ can_delete: true });
      api.remove.mockRejectedValue(new TypeError('Failed to fetch'));
      const { user } = await renderLoaded();

      await user.click(
        within(await openOptions(user)).getByRole('button', { name: 'Delete challenge' })
      );
      await user.click(
        within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' })
      );

      expect(await screen.findByRole('alert')).toHaveTextContent(
        "Couldn't delete the challenge. Check your connection and try again."
      );
      expect(api.get).toHaveBeenCalledTimes(1);
    });

    it('treats a challenge that is already gone as deleted', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockDetail({ can_delete: true });
      api.remove.mockRejectedValue(new ApiError('Not found', 404, 'CHALLENGE_NOT_FOUND'));
      const { user } = await renderLoaded();

      await user.click(
        within(await openOptions(user)).getByRole('button', { name: 'Delete challenge' })
      );
      await user.click(
        within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' })
      );

      await waitFor(() => expect(location()).toHaveTextContent(/^\/challenges$/));
      expect(useChallengeStore.getState().challenges).toEqual([]);
    });
  });
});
