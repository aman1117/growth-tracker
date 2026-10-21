import { screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { gl } from '../../../services/goodlogs';
import { useFollowStore } from '../../../store';
import { deferred, relationship } from '../../../test/fixtures/social';
import { renderWithRouter, signIn } from '../../../test/utils';
import FollowButtonDefault, { FollowButton } from './FollowButton';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn() }));
vi.mock('../../../services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/api')>()),
  api,
}));

// useThemeStore reads matchMedia while modules load, before setup.ts stubs it for each test.
await vi.hoisted(async () => {
  const { createMatchMedia } = await import('../../../test/browser-mocks');
  vi.stubGlobal('matchMedia', createMatchMedia());
});

const BOB_ID = 2;

function renderButton(props: Partial<ComponentProps<typeof FollowButton>> = {}) {
  const onStateChange = vi.fn();
  const utils = renderWithRouter(
    <FollowButton
      userId={BOB_ID}
      username="bob"
      isPrivate={false}
      onStateChange={onStateChange}
      {...props}
    />
  );
  return { ...utils, onStateChange };
}

const button = (name: string | RegExp) => screen.getByRole('button', { name });

describe('FollowButton', () => {
  beforeEach(() => {
    signIn({ id: 1, username: 'alice' });
  });

  it('renders nothing on the signed-in user’s own profile', () => {
    signIn({ id: BOB_ID, username: 'bob' });
    renderButton();

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('offers to follow someone you do not follow yet', () => {
    renderButton();

    expect(button('Follow')).toBeEnabled();
  });

  it('follows a public account', async () => {
    api.post.mockResolvedValue({ success: true, action: 'followed', state: 'ACTIVE' });
    const { user, onStateChange } = renderButton();

    await user.click(button('Follow'));

    expect(api.post).toHaveBeenCalledWith(`/users/${BOB_ID}/follow`);
    expect(await screen.findByRole('button', { name: /^Following/ })).toHaveTextContent('Unfollow');
    expect(onStateChange).toHaveBeenCalledWith(relationship({ following: true }));
    expect(gl.track).toHaveBeenCalledWith('follow_sent', {
      properties: { targetUserId: BOB_ID, isPrivate: false },
    });
  });

  it('sends a follow request to a private account', async () => {
    api.post.mockResolvedValue({ success: true, action: 'requested', state: 'PENDING' });
    const { user, onStateChange } = renderButton({ isPrivate: true });

    await user.click(button('Follow'));

    expect(await screen.findByRole('button', { name: /^Requested/ })).toHaveTextContent('Cancel');
    expect(onStateChange).toHaveBeenCalledWith(relationship({ pending: true }));
    expect(gl.track).toHaveBeenCalledWith('follow_sent', {
      properties: { targetUserId: BOB_ID, isPrivate: true },
    });
  });

  it('cancels a pending request', async () => {
    api.post.mockResolvedValue({ success: true, action: 'cancelled' });
    const { user, onStateChange } = renderButton({
      isPrivate: true,
      initialState: relationship({ pending: true }),
    });

    await user.click(button(/^Requested/));

    expect(api.post).toHaveBeenCalledWith(`/follow-requests/${BOB_ID}/cancel`);
    expect(await screen.findByRole('button', { name: 'Follow' })).toBeInTheDocument();
    expect(onStateChange).not.toHaveBeenCalled();
  });

  it('unfollows someone you follow', async () => {
    api.delete.mockResolvedValue({
      success: true,
      action: 'unfollowed',
      new_state: relationship(),
    });
    const { user, onStateChange } = renderButton({
      initialState: relationship({ following: true }),
    });

    await user.click(button(/^Following/));

    expect(api.delete).toHaveBeenCalledWith(`/users/${BOB_ID}/follow`);
    expect(await screen.findByRole('button', { name: 'Follow' })).toBeInTheDocument();
    expect(onStateChange).toHaveBeenCalledWith(relationship());
  });

  it('is disabled while the request is in flight, so double clicks send one request', async () => {
    const response = deferred<unknown>();
    api.post.mockReturnValue(response.promise);
    const { user } = renderButton();

    await user.click(button('Follow'));
    expect(button('Follow')).toBeDisabled();
    await user.click(button('Follow'));
    expect(api.post).toHaveBeenCalledTimes(1);

    response.resolve({ success: true, state: 'ACTIVE' });
    expect(await screen.findByRole('button', { name: /^Following/ })).toBeEnabled();
  });

  it('keeps the current state when the request fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    api.post.mockRejectedValue(new Error('Network down'));
    const { user, onStateChange } = renderButton();

    await user.click(button('Follow'));

    await waitFor(() => expect(button('Follow')).toBeEnabled());
    expect(onStateChange).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith('Failed to follow user:', expect.any(Error));
  });

  it('recovers when the follow action itself throws', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = new Error('boom');
    useFollowStore.setState({ followUser: vi.fn().mockRejectedValue(failure) });
    const { user, onStateChange } = renderButton();

    await user.click(button('Follow'));

    await waitFor(() => expect(button('Follow')).toBeEnabled());
    expect(consoleError).toHaveBeenCalledWith('Follow action failed:', failure);
    expect(onStateChange).not.toHaveBeenCalled();
  });

  describe('relationship cache', () => {
    it('seeds the shared cache with the initial state', () => {
      const initialState = relationship({ following: true, followed_by: true, is_mutual: true });
      renderButton({ initialState });

      expect(useFollowStore.getState().relationships[String(BOB_ID)]).toEqual(initialState);
    });

    it('prefers the cached relationship over a stale initial state', () => {
      const cached = relationship({ following: true });
      useFollowStore.getState().setRelationship(BOB_ID, cached);

      renderButton({ initialState: relationship() });

      expect(button(/^Following/)).toBeInTheDocument();
      expect(useFollowStore.getState().relationships[String(BOB_ID)]).toEqual(cached);
    });

    it('updates when another component changes the cached relationship', async () => {
      renderButton();

      useFollowStore.getState().setRelationship(BOB_ID, relationship({ pending: true }));

      expect(await screen.findByRole('button', { name: /^Requested/ })).toBeInTheDocument();
    });
  });

  describe('incoming follow request', () => {
    const incoming = relationship({ incoming_pending: true, followed_by: false });

    it('offers Follow, Accept and Decline', () => {
      renderButton({ initialState: incoming });

      expect(button('Follow')).toBeEnabled();
      expect(button('Accept')).toBeEnabled();
      expect(button('Decline')).toBeEnabled();
    });

    it('offers only Follow when request actions are hidden', async () => {
      api.post.mockResolvedValue({ success: true, state: 'ACTIVE' });
      const { user } = renderButton({ initialState: incoming, showRequestActions: false });

      expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Decline' })).not.toBeInTheDocument();
      await user.click(button('Follow'));

      expect(api.post).toHaveBeenCalledWith(`/users/${BOB_ID}/follow`);
    });

    it('labels the follow action "Following" when you already follow them', () => {
      renderButton({ initialState: { ...incoming, following: true } });

      expect(button('Following')).toBeInTheDocument();
      expect(button('Accept')).toBeInTheDocument();
    });

    it('accepts the request', async () => {
      const newState = relationship({ followed_by: true });
      api.post.mockResolvedValue({ success: true, action: 'accepted', new_state: newState });
      const { user, onStateChange } = renderButton({ initialState: incoming });

      await user.click(button('Accept'));

      expect(api.post).toHaveBeenCalledWith(`/me/follow-requests/${BOB_ID}/accept`);
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument()
      );
      expect(button('Follow')).toBeInTheDocument();
      expect(onStateChange).toHaveBeenCalledWith(newState);
      expect(gl.track).toHaveBeenCalledWith('follow_accepted', { properties: { userId: BOB_ID } });
    });

    it('declines the request', async () => {
      const newState = relationship();
      api.post.mockResolvedValue({ success: true, action: 'declined', new_state: newState });
      const { user, onStateChange } = renderButton({ initialState: incoming });

      await user.click(button('Decline'));

      expect(api.post).toHaveBeenCalledWith(`/me/follow-requests/${BOB_ID}/decline`);
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: 'Decline' })).not.toBeInTheDocument()
      );
      expect(onStateChange).toHaveBeenCalledWith(newState);
    });

    it('disables every action while a response is pending', async () => {
      const response = deferred<unknown>();
      api.post.mockReturnValue(response.promise);
      const { user } = renderButton({ initialState: incoming });

      await user.click(button('Accept'));

      expect(button('Follow')).toBeDisabled();
      expect(button('Accept')).toBeDisabled();
      expect(button('Decline')).toBeDisabled();

      response.resolve({ success: false, error: 'Request expired' });
      await waitFor(() => expect(button('Accept')).toBeEnabled());
    });

    it('follows back from the request row', async () => {
      api.post.mockResolvedValue({ success: true, state: 'ACTIVE' });
      const { user } = renderButton({ initialState: incoming });

      await user.click(button('Follow'));

      expect(api.post).toHaveBeenCalledWith(`/users/${BOB_ID}/follow`);
    });

    it.each([
      ['Accept', 'acceptRequest', 'Accept request failed:'],
      ['Decline', 'declineRequest', 'Decline request failed:'],
    ] as const)('re-enables the actions when %s throws', async (label, action, logMessage) => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const failure = new Error('boom');
      useFollowStore.setState({ [action]: vi.fn().mockRejectedValue(failure) });
      const { user, onStateChange } = renderButton({ initialState: incoming });

      await user.click(button(label));

      await waitFor(() => expect(button(label)).toBeEnabled());
      expect(consoleError).toHaveBeenCalledWith(logMessage, failure);
      expect(onStateChange).not.toHaveBeenCalled();
    });
  });

  it('is exported as the default export', () => {
    expect(FollowButtonDefault).toBe(FollowButton);
  });
});
