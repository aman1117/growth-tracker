import { act, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, makeLiker } from '../../../test/fixtures/ui';
import { renderWithRouter } from '../../../test/utils';
import type { LikesResponse } from '../../../types/api';
import { LikersModal, type LikersModalProps } from './LikersModal';

const { likeApi } = vi.hoisted(() => ({ likeApi: { getLikes: vi.fn() } }));
vi.mock('../../../services/api', () => ({ likeApi }));

const likes = (data: LikesResponse['data'], success = true): LikesResponse => ({
  success,
  data,
  count: data.length,
  user_has_liked: false,
});

function renderModal(props: Partial<LikersModalProps> = {}) {
  const onClose = vi.fn();
  const utils = renderWithRouter(
    <LikersModal username="alice" date="2026-10-20" isOpen onClose={onClose} {...props} />,
    { route: '/user/alice?date=2026-10-20' }
  );
  return { onClose, ...utils };
}

describe('LikersModal', () => {
  beforeEach(() => {
    likeApi.getLikes.mockResolvedValue(likes([]));
  });

  it('renders and fetches nothing while closed', () => {
    renderModal({ isOpen: false });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(likeApi.getLikes).not.toHaveBeenCalled();
  });

  it('shows placeholder rows while the likes load', async () => {
    const request = createDeferred<LikesResponse>();
    likeApi.getLikes.mockReturnValue(request.promise);
    renderModal();

    const dialog = screen.getByRole('dialog', { name: 'Likes' });
    expect(within(dialog).getByLabelText('Loading likes')).toHaveAttribute('aria-busy', 'true');
    expect(likeApi.getLikes).toHaveBeenCalledExactlyOnceWith('alice', '2026-10-20');

    await act(async () => request.resolve(likes([makeLiker()])));
    expect(within(dialog).queryByLabelText('Loading likes')).not.toBeInTheDocument();
  });

  it('lists everyone who liked the day', async () => {
    likeApi.getLikes.mockResolvedValue(
      likes([
        makeLiker({
          id: 7,
          username: 'alice',
          is_verified: true,
          profile_pic: 'https://cdn.test/alice.jpg',
          profile_pic_thumb: 'https://cdn.test/alice-thumb.jpg',
        }),
        makeLiker({ id: 8, username: 'bob' }),
      ])
    );
    renderModal();

    const alice = await screen.findByRole('button', { name: "Open alice's profile" });
    const bob = screen.getByRole('button', { name: "Open bob's profile" });

    expect(within(alice).getByRole('img', { name: 'alice' })).toHaveAttribute(
      'src',
      'https://cdn.test/alice-thumb.jpg'
    );
    expect(within(alice).getByRole('img', { name: 'Verified account' })).toBeInTheDocument();
    expect(within(bob).queryByRole('img', { name: 'Verified account' })).not.toBeInTheDocument();
    expect(within(bob).getByText('B')).toBeInTheDocument();
  });

  it('opens a liker profile and closes', async () => {
    likeApi.getLikes.mockResolvedValue(likes([makeLiker({ username: 'carol' })]));
    const { user, onClose } = renderModal();

    await user.click(await screen.findByRole('button', { name: "Open carol's profile" }));

    expect(screen.getByTestId('location')).toHaveTextContent('/user/carol');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows an empty state when nobody liked the day', async () => {
    renderModal();

    expect(await screen.findByText('No likes yet')).toBeInTheDocument();
    expect(screen.getByText('Likes on this day will show up here.')).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('shows a retryable error when loading fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    likeApi.getLikes.mockRejectedValueOnce(new Error('offline'));
    likeApi.getLikes.mockResolvedValueOnce(likes([makeLiker()]));
    const { user } = renderModal();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't load likes");
    expect(consoleError).toHaveBeenCalledWith(
      '[LikersModal] Failed to fetch likers; showing retry',
      expect.objectContaining({ date: '2026-10-20' })
    );

    await user.click(within(alert).getByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('button', { name: "Open alice's profile" })).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(likeApi.getLikes).toHaveBeenCalledTimes(2);
  });

  it('shows the error state when the server reports a failure', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    likeApi.getLikes.mockResolvedValue(likes([], false));
    renderModal();

    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load likes");
    expect(consoleWarn).toHaveBeenCalledWith(
      '[LikersModal] getLikes returned unsuccessful response',
      { date: '2026-10-20' }
    );
  });

  it('ignores responses for a day that is no longer shown', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const first = createDeferred<LikesResponse>();
    const second = createDeferred<LikesResponse>();
    const third = createDeferred<LikesResponse>();
    likeApi.getLikes
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise);
    const onClose = vi.fn();
    const modal = (date: string) => (
      <LikersModal username="alice" date={date} isOpen onClose={onClose} />
    );
    const { rerender } = render(modal('2026-10-18'), { wrapper: MemoryRouter });

    rerender(modal('2026-10-19'));
    rerender(modal('2026-10-20'));
    await act(async () => third.resolve(likes([makeLiker({ username: 'bob' })])));
    await act(async () => first.resolve(likes([makeLiker({ username: 'zed' })])));
    await act(async () => second.reject(new Error('late failure')));

    expect(screen.getByRole('button', { name: "Open bob's profile" })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: "Open zed's profile" })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('is a small "Likes" modal that can be closed', async () => {
    const { user, onClose } = renderModal();
    await screen.findByText('No likes yet');

    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
