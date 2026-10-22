import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, challengeApi } from '../../services/api';
import { gl } from '../../services/goodlogs';
import { makeInviteCandidate } from '../../test/fixtures/challenges';
import { deferred, renderWithHistory } from '../../test/fixtures/shell';
import type { ChallengeInvitesResponse, InviteCandidatesResponse } from '../../types';
import { COPIED_FEEDBACK_MS, InviteSheet } from './InviteSheet';

vi.mock('../../services/api', async (importOriginal) => {
  const { createChallengeApiMock } = await import('../../test/fixtures/challenges');
  return {
    ...(await importOriginal<typeof import('../../services/api')>()),
    challengeApi: createChallengeApiMock(),
  };
});

const api = vi.mocked(challengeApi);
const dave = makeInviteCandidate({ id: 7, username: 'dave', is_verified: true });
const erin = makeInviteCandidate({ id: 8, username: 'erin' });
const frank = makeInviteCandidate({ id: 9, username: 'frank', invited: true });
const LINK = () => `${window.location.origin}/c/ABCD2345`;

const candidates = (users = [dave, erin, frank]): InviteCandidatesResponse => ({
  success: true,
  users,
});

function renderSheet({ isOpen = true } = {}) {
  const onClose = vi.fn();
  const onInvited = vi.fn();
  const view = renderWithHistory(
    <InviteSheet
      isOpen={isOpen}
      onClose={onClose}
      challengeId={42}
      challengeTitle="Study 2h+ a day"
      inviteCode="ABCD2345"
      onInvited={onInvited}
    />,
    { entries: ['/challenges/42'] }
  );
  return { ...view, onClose, onInvited };
}

const inviteButton = () => screen.getByRole('button', { name: /^Invite/ });
const checkbox = (name: string) => screen.getByRole('checkbox', { name });

describe('InviteSheet', () => {
  beforeEach(() => {
    // Overlay history logs its steps with console.debug in development builds
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    api.getInviteCandidates.mockResolvedValue(candidates());
    api.invite.mockResolvedValue({ success: true, invited: 1, skipped: 0 });
  });

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'share');
  });

  it('renders nothing while closed', () => {
    renderSheet({ isOpen: false });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.getInviteCandidates).not.toHaveBeenCalled();
  });

  describe('the invite link', () => {
    it('shows the link and copies it', async () => {
      const { user } = renderSheet();

      expect(screen.getByRole('dialog', { name: 'Invite friends' })).toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: 'Invite link' })).toHaveValue(LINK());

      await user.click(screen.getByRole('button', { name: 'Copy link' }));

      expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
      expect(screen.getByText('Link copied')).toBeInTheDocument();
      await expect(navigator.clipboard.readText()).resolves.toBe(LINK());
      expect(gl.track).toHaveBeenCalledWith('challenge_link_shared', {
        properties: { challengeId: 42, method: 'copy', source: 'invite' },
      });
    });

    it('selects the whole link when it is focused, to copy it by hand', async () => {
      const { user } = renderSheet();
      const field = screen.getByRole<HTMLInputElement>('textbox', { name: 'Invite link' });

      await user.click(field);

      expect(field).toHaveFocus();
      expect(field).toHaveAttribute('readonly');
      expect(field.selectionStart).toBe(0);
      expect(field.selectionEnd).toBe(LINK().length);
    });

    it('shows "Copied" only for a moment', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
      renderSheet();

      fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
      expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();

      act(() => vi.advanceTimersByTime(COPIED_FEEDBACK_MS / 2));
      expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();

      act(() => vi.advanceTimersByTime(COPIED_FEEDBACK_MS));
      expect(screen.getByRole('button', { name: 'Copy link' })).toBeInTheDocument();
      expect(screen.queryByText('Link copied')).not.toBeInTheDocument();
    });

    it('restarts the "Copied" countdown when the link is copied again', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
      renderSheet();

      fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
      const copiedButton = await screen.findByRole('button', { name: 'Copied' });
      act(() => vi.advanceTimersByTime(COPIED_FEEDBACK_MS * 0.75));

      fireEvent.click(copiedButton);
      await waitFor(() => expect(gl.track).toHaveBeenCalledTimes(2));
      act(() => vi.advanceTimersByTime(COPIED_FEEDBACK_MS * 0.5));
      expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();

      act(() => vi.advanceTimersByTime(COPIED_FEEDBACK_MS));
      expect(screen.getByRole('button', { name: 'Copy link' })).toBeInTheDocument();
    });

    it('explains when the link cannot be copied', async () => {
      const { user } = renderSheet();
      vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));

      await user.click(screen.getByRole('button', { name: 'Copy link' }));

      expect(
        screen.getByText("Couldn't copy the link. Select it and copy it yourself.")
      ).toBeInTheDocument();
      expect(gl.track).not.toHaveBeenCalled();
    });

    it('opens the share sheet where there is one', async () => {
      const share = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'share', { value: share, configurable: true });
      const { user } = renderSheet();

      await user.click(screen.getByRole('button', { name: 'Share' }));

      expect(share).toHaveBeenCalledWith({
        url: LINK(),
        title: 'Study 2h+ a day',
        text: 'Join my challenge “Study 2h+ a day” on Growth Tracker',
      });
      expect(gl.track).toHaveBeenCalledWith('challenge_link_shared', {
        properties: { challengeId: 42, method: 'share', source: 'invite' },
      });
    });

    it('does nothing when the share sheet is dismissed', async () => {
      const share = vi.fn().mockRejectedValue(new DOMException('Cancelled', 'AbortError'));
      Object.defineProperty(navigator, 'share', { value: share, configurable: true });
      const { user } = renderSheet();

      await user.click(screen.getByRole('button', { name: 'Share' }));

      expect(gl.track).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Copy link' })).toBeInTheDocument();
    });

    it('copies the link where the browser cannot share', async () => {
      const { user } = renderSheet();

      await user.click(screen.getByRole('button', { name: 'Share' }));

      expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
      expect(gl.track).toHaveBeenCalledWith('challenge_link_shared', {
        properties: { challengeId: 42, method: 'copy', source: 'invite' },
      });
    });

    it('explains when the link can be neither shared nor copied', async () => {
      const { user } = renderSheet();
      vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));

      await user.click(screen.getByRole('button', { name: 'Share' }));

      expect(
        screen.getByText("Couldn't share the link. Select it and copy it yourself.")
      ).toBeInTheDocument();
    });
  });

  describe('people to invite', () => {
    it('lists people with their state, loading first', async () => {
      const response = deferred<InviteCandidatesResponse>();
      api.getInviteCandidates.mockReturnValue(response.promise);
      renderSheet();

      expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
      expect(api.getInviteCandidates).toHaveBeenCalledWith(42, { q: '', limit: 50 });

      await act(async () => response.resolve(candidates()));

      const list = screen.getByRole('list', { name: 'People you can invite' });
      expect(within(list).getAllByRole('checkbox')).toHaveLength(3);
      expect(checkbox('dave')).toBeEnabled();
      expect(within(list).getByRole('img', { name: 'Verified account' })).toBeInTheDocument();
      expect(checkbox('frank')).toBeDisabled();
      expect(checkbox('frank')).toHaveAccessibleDescription('Invited');
      expect(inviteButton()).toHaveTextContent('Invite');
      expect(inviteButton()).toBeDisabled();
    });

    it('suggests sharing the link when there is no one to invite', async () => {
      api.getInviteCandidates.mockResolvedValue(candidates([]));
      renderSheet();

      expect(
        await screen.findByText('No one to invite yet – share the link instead.')
      ).toBeInTheDocument();
    });

    it('searches by username after a short pause, ignoring older answers', async () => {
      const older = deferred<InviteCandidatesResponse>();
      const newer = deferred<InviteCandidatesResponse>();
      const { user } = renderSheet();
      await screen.findByRole('checkbox', { name: 'dave' });

      api.getInviteCandidates.mockReturnValueOnce(older.promise);
      await user.type(screen.getByRole('searchbox', { name: 'Find people to invite' }), 'da');
      await waitFor(() =>
        expect(api.getInviteCandidates).toHaveBeenLastCalledWith(42, { q: 'da', limit: 50 })
      );
      expect(screen.getByRole('list', { name: 'People you can invite' })).toHaveAttribute(
        'aria-busy',
        'true'
      );

      api.getInviteCandidates.mockReturnValueOnce(newer.promise);
      await user.type(screen.getByRole('searchbox'), 'x');
      await waitFor(() =>
        expect(api.getInviteCandidates).toHaveBeenLastCalledWith(42, { q: 'dax', limit: 50 })
      );

      await act(async () => newer.resolve(candidates([])));
      await act(async () => older.resolve(candidates([dave])));

      expect(screen.getByText('No one called “dax” to invite.')).toBeInTheDocument();
      expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    });

    it('offers a retry when people cannot be loaded', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      api.getInviteCandidates.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      const { user } = renderSheet();

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent("Couldn't load people to invite.");
      expect(warn).toHaveBeenCalledWith('[Challenges] invite_candidates_failed', {
        recovery: 'show_retry',
        challengeId: 42,
        errorCode: undefined,
        status: undefined,
      });

      await user.click(within(alert).getByRole('button', { name: 'Try again' }));

      expect(await screen.findByRole('checkbox', { name: 'dave' })).toBeInTheDocument();
    });

    it('treats a reply without people as nobody to invite', async () => {
      api.getInviteCandidates.mockResolvedValue({ success: true } as InviteCandidatesResponse);
      renderSheet();

      expect(
        await screen.findByText('No one to invite yet – share the link instead.')
      ).toBeInTheDocument();
    });
  });

  describe('inviting', () => {
    it('counts the people picked', async () => {
      const { user } = renderSheet();

      await user.click(await screen.findByRole('checkbox', { name: 'dave' }));
      await user.click(checkbox('erin'));
      expect(inviteButton()).toHaveTextContent('Invite 2');

      await user.click(checkbox('dave'));
      expect(inviteButton()).toHaveTextContent('Invite 1');
      expect(checkbox('dave')).not.toBeChecked();
    });

    it('invites up to 20 people at a time', async () => {
      const many = Array.from({ length: 21 }, (_, index) =>
        makeInviteCandidate({ id: 100 + index, username: `friend${index + 1}` })
      );
      api.getInviteCandidates.mockResolvedValue(candidates(many));
      const { user } = renderSheet();
      await screen.findByRole('checkbox', { name: 'friend1' });

      for (let index = 1; index <= 20; index += 1) await user.click(checkbox(`friend${index}`));

      expect(inviteButton()).toHaveTextContent('Invite 20');
      expect(checkbox('friend21')).toBeDisabled();
      expect(screen.getByText('You can invite up to 20 people at a time')).toBeInTheDocument();
    });

    it('sends the invites once and reports the result', async () => {
      const response = deferred<ChallengeInvitesResponse>();
      api.invite.mockReturnValue(response.promise);
      const { user, onInvited } = renderSheet();

      await user.click(await screen.findByRole('checkbox', { name: 'erin' }));
      await user.click(checkbox('dave'));
      await user.dblClick(inviteButton());

      expect(inviteButton()).toBeDisabled();
      expect(checkbox('dave')).toBeDisabled();
      expect(api.invite).toHaveBeenCalledExactlyOnceWith(42, [8, 7]);

      await act(async () => response.resolve({ success: true, invited: 2, skipped: 0 }));

      expect(onInvited).toHaveBeenCalledWith({ success: true, invited: 2, skipped: 0 });
      expect(checkbox('dave')).toBeDisabled();
      expect(checkbox('dave')).toHaveAccessibleDescription('Invited');
      expect(inviteButton()).toHaveTextContent('Invite');
    });

    it('keeps the selection when sending fails', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      api.invite.mockRejectedValue(new ApiError('Ended', 409, 'CHALLENGE_ENDED'));
      const { user, onInvited } = renderSheet();

      await user.click(await screen.findByRole('checkbox', { name: 'dave' }));
      await user.click(inviteButton());

      expect(await screen.findByRole('alert')).toHaveTextContent('This challenge has ended');
      expect(checkbox('dave')).toBeChecked();
      expect(inviteButton()).toBeEnabled();
      expect(onInvited).not.toHaveBeenCalled();

      await user.click(checkbox('erin'));
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('closes with Done', async () => {
      const { user, onClose } = renderSheet();

      await user.click(screen.getByRole('button', { name: 'Done' }));

      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });
});
