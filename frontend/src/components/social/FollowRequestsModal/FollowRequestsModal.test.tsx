import { screen, waitFor, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useFollowStore } from '../../../store';
import { captureIntersectionObservers, deferred, followUser } from '../../../test/fixtures/social';
import { renderWithRouter, signIn } from '../../../test/utils';
import type { FollowUser } from '../../../types/follow';
import FollowRequestsModalDefault, { FollowRequestsModal } from './FollowRequestsModal';

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

const INCOMING_URL = '/me/follow-requests/incoming';
const bob = followUser({ id: 2, username: 'bob' });
const carol = followUser({ id: 3, username: 'carol', is_verified: true });

const requests = (users: FollowUser[], extra: Record<string, unknown> = {}) => ({
  success: true,
  requests: users,
  total_count: users.length,
  ...extra,
});

function renderModal(props: Partial<ComponentProps<typeof FollowRequestsModal>> = {}) {
  const onClose = vi.fn();
  const onRequestHandled = vi.fn();
  const view = renderWithRouter(
    <FollowRequestsModal isOpen onClose={onClose} onRequestHandled={onRequestHandled} {...props} />,
    { route: '/notifications' }
  );
  return { ...view, onClose, onRequestHandled };
}

const dialog = () => screen.getByRole('dialog', { name: 'Follow requests' });
const accept = (username: string) => screen.getByRole('button', { name: `Accept ${username}` });
const decline = (username: string) => screen.getByRole('button', { name: `Decline ${username}` });
const findRequest = (username: string) =>
  screen.findByRole('button', { name: `Accept ${username}` });

describe('FollowRequestsModal', () => {
  beforeEach(() => {
    signIn({ id: 1, username: 'alice' });
    // Overlay history logs every modal open/close in development builds.
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  it('lists incoming requests with how many are waiting', async () => {
    api.get.mockResolvedValue(requests([bob, carol], { total_count: 1200 }));
    renderModal();

    await findRequest('bob');
    expect(within(dialog()).getByText('1,200 waiting for your answer')).toBeInTheDocument();
    expect(within(dialog()).getAllByText('Wants to follow you')).toHaveLength(2);
    expect(within(dialog()).getByRole('img', { name: 'Verified account' })).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith(`${INCOMING_URL}?limit=20`);
  });

  it('shows skeleton rows and a neutral subtitle while loading', async () => {
    const response = deferred<unknown>();
    api.get.mockReturnValue(response.promise);
    renderModal();

    expect(within(dialog()).getByText('People who want to follow you')).toBeInTheDocument();
    expect(dialog().querySelector('[aria-busy="true"]')).toBeInTheDocument();

    response.resolve(requests([bob]));
    expect(await findRequest('bob')).toBeEnabled();
    expect(within(dialog()).getByText('1 waiting for your answer')).toBeInTheDocument();
  });

  it.each([
    ['there are no requests', requests([])],
    ['the response has no request list', { success: true, total_count: 0 }],
  ])('tells the user when %s', async (_label, response) => {
    api.get.mockResolvedValue(response);
    renderModal();

    expect(await screen.findByRole('heading', { name: "You're all caught up" })).toBeVisible();
    expect(within(dialog()).getByText('People who want to follow you')).toBeInTheDocument();
  });

  it.each([
    ['the request fails', () => api.get.mockRejectedValueOnce(new Error('Network down'))],
    ['the server rejects it', () => api.get.mockResolvedValueOnce({ success: false })],
  ])('offers a retry when %s', async (_label, failOnce) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    failOnce();
    api.get.mockResolvedValue(requests([bob]));
    const { user } = renderModal();

    expect(await screen.findByRole('heading', { name: "Couldn't load requests" })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await findRequest('bob')).toBeInTheDocument();
  });

  it.each([
    ['accept', accept, '/me/follow-requests/2/accept'],
    ['decline', decline, '/me/follow-requests/2/decline'],
  ])('can %s a request', async (_action, button, url) => {
    api.get.mockResolvedValue(requests([bob, carol]));
    api.post.mockResolvedValue({ success: true });
    const { user, onRequestHandled } = renderModal();
    await findRequest('bob');

    await user.click(button('bob'));

    await waitFor(() => expect(screen.queryByText('bob')).not.toBeInTheDocument());
    expect(api.post).toHaveBeenCalledWith(url);
    expect(onRequestHandled).toHaveBeenCalledTimes(1);
    expect(within(dialog()).getByText('1 waiting for your answer')).toBeInTheDocument();
    expect(accept('carol')).toBeEnabled();
  });

  it('disables only the row that is being answered', async () => {
    const response = deferred<unknown>();
    api.get.mockResolvedValue(requests([bob, carol]));
    api.post.mockReturnValue(response.promise);
    const { user } = renderModal();
    await findRequest('bob');

    await user.click(accept('bob'));

    expect(accept('bob')).toBeDisabled();
    expect(decline('bob')).toBeDisabled();
    expect(accept('carol')).toBeEnabled();

    response.resolve({ success: true });
    await waitFor(() => expect(screen.queryByText('bob')).not.toBeInTheDocument());
  });

  it('keeps the request and explains when the server refuses', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    api.get.mockResolvedValue(requests([bob]));
    api.post.mockResolvedValue({ success: false, error: 'Request expired' });
    const { user, onRequestHandled } = renderModal();
    await findRequest('bob');

    await user.click(decline('bob'));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Couldn't decline bob's request. Try again."
    );
    expect(decline('bob')).toBeEnabled();
    expect(onRequestHandled).not.toHaveBeenCalled();
    expect(consoleWarn).toHaveBeenCalledWith('[Social] Follow request response rejected', {
      action: 'decline',
    });
  });

  it.each([
    ['accept', 'acceptRequest', accept],
    ['decline', 'declineRequest', decline],
  ] as const)('explains when trying to %s throws', async (action, storeAction, button) => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = new Error('boom');
    useFollowStore.setState({ [storeAction]: vi.fn().mockRejectedValue(failure) });
    api.get.mockResolvedValue(requests([bob]));
    const { user } = renderModal();
    await findRequest('bob');

    await user.click(button('bob'));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      `Couldn't ${action} bob's request. Try again.`
    );
    expect(consoleError).toHaveBeenCalledWith(
      `[Social] Failed to ${action} follow request`,
      failure
    );
    expect(button('bob')).toBeEnabled();
  });

  it('clears the error when a new answer is attempted', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    api.get.mockResolvedValue(requests([bob]));
    api.post.mockResolvedValueOnce({ success: false }).mockResolvedValueOnce({ success: true });
    const { user } = renderModal();
    await findRequest('bob');

    await user.click(accept('bob'));
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    await user.click(accept('bob'));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('opens the requester’s profile and closes the modal', async () => {
    api.get.mockResolvedValue(requests([bob]));
    const { user, onClose } = renderModal();
    await findRequest('bob');

    await user.click(screen.getByText('bob'));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('location')).toHaveTextContent('/user/bob');
  });

  it('clears any error message when it is closed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    api.get.mockResolvedValue(requests([bob]));
    api.post.mockResolvedValue({ success: false });
    const { user, onClose } = renderModal();
    await findRequest('bob');
    await user.click(accept('bob'));
    await screen.findByRole('alert');

    await user.click(within(dialog()).getByRole('button', { name: 'Close' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('loads more requests when the end of the list scrolls into view', async () => {
    const io = captureIntersectionObservers();
    const nextPage = deferred<unknown>();
    api.get.mockImplementation((url: string) =>
      url.includes('cursor=')
        ? nextPage.promise
        : requests([bob], { total_count: 2, next_cursor: 'n2' })
    );
    renderModal();
    await findRequest('bob');

    await io.intersect();

    expect(api.get).toHaveBeenCalledWith(`${INCOMING_URL}?cursor=n2&limit=20`);
    expect(screen.getByRole('status')).toHaveTextContent('Loading more…');

    nextPage.resolve(requests([carol], { total_count: 2 }));

    expect(await findRequest('carol')).toBeInTheDocument();
    expect(accept('bob')).toBeInTheDocument();
  });

  it('renders nothing and loads nothing while closed', () => {
    renderModal({ isOpen: false });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalled();
  });

  it('is exported as the default export', () => {
    expect(FollowRequestsModalDefault).toBe(FollowRequestsModal);
  });
});
