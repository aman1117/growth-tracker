import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, makeLiker } from '../../../test/fixtures/ui';
import { renderWithRouter } from '../../../test/utils';
import type { LikeActionResponse, LikesResponse } from '../../../types/api';
import { LikeButton, type LikeButtonProps } from './LikeButton';
import styles from './LikeButton.module.css';

const { likeApi } = vi.hoisted(() => ({
  likeApi: { getLikes: vi.fn(), likeDay: vi.fn(), unlikeDay: vi.fn() },
}));
vi.mock('../../../services/api', () => ({ likeApi }));

const likes = (overrides: Partial<LikesResponse> = {}): LikesResponse => ({
  success: true,
  data: [],
  count: 0,
  user_has_liked: false,
  ...overrides,
});

const action = (liked: boolean, newCount: number, success = true): LikeActionResponse => ({
  success,
  liked,
  new_count: newCount,
});

function renderButton(props: Partial<LikeButtonProps> = {}) {
  return renderWithRouter(
    <LikeButton
      username="alice"
      date="2026-10-20"
      initialCount={2}
      initialLiked={false}
      {...props}
    />
  );
}

const heartOf = (button: HTMLElement) => button.querySelector('svg') as SVGElement;

// jsdom has no AnimationEvent, so React listens for the prefixed `webkitAnimationEnd` instead.
const finishAnimation = (element: Element) =>
  act(() => {
    element.dispatchEvent(new Event('webkitAnimationEnd', { bubbles: true }));
  });

/** Plain render inside a router, so `rerender` keeps the router (and component state). */
const renderInRouter = (ui: ReactElement) => render(ui, { wrapper: MemoryRouter });

describe('LikeButton', () => {
  beforeEach(() => {
    likeApi.getLikes.mockResolvedValue(likes());
    likeApi.likeDay.mockResolvedValue(action(true, 3));
    likeApi.unlikeDay.mockResolvedValue(action(false, 1));
  });

  it('shows the provided state without fetching it', () => {
    renderButton({ initialCount: 3, initialLiked: true });
    const button = screen.getByRole('button', { name: 'Unlike this day' });

    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(button).toHaveAttribute('title', 'Unlike this day');
    expect(button).toHaveClass(styles.liked);
    expect(screen.getByRole('button', { name: 'See 3 likes' })).toHaveClass(
      styles.liked,
      styles.clickable
    );
    expect(likeApi.getLikes).not.toHaveBeenCalled();
  });

  it('fetches the like state when it is not provided', async () => {
    likeApi.getLikes.mockResolvedValue(likes({ count: 1, user_has_liked: true }));
    renderButton({ initialCount: undefined, initialLiked: undefined });

    expect(await screen.findByRole('button', { name: 'See 1 like' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unlike this day' })).toBeInTheDocument();
    expect(likeApi.getLikes).toHaveBeenCalledExactlyOnceWith('alice', '2026-10-20');
  });

  it('keeps the empty state when fetching fails', async () => {
    const error = new Error('offline');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    likeApi.getLikes.mockRejectedValue(error);
    renderButton({ initialCount: undefined, initialLiked: undefined });

    await waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith('Failed to fetch like state:', error)
    );
    expect(screen.getByRole('button', { name: 'Like this day' })).toBeInTheDocument();
    expect(screen.getByText('0')).toBeInTheDocument();
    expect(likeApi.getLikes).toHaveBeenCalledTimes(1);
  });

  it('keeps the empty state when the server reports a failure', async () => {
    likeApi.getLikes.mockResolvedValue(likes({ success: false, count: 9 }));
    renderButton({ initialCount: undefined, initialLiked: undefined });

    await waitFor(() => expect(likeApi.getLikes).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.getByText('0')).toBeInTheDocument();
  });

  it('likes optimistically, then applies the server count', async () => {
    const request = createDeferred<LikeActionResponse>();
    likeApi.likeDay.mockReturnValue(request.promise);
    const onLikeChange = vi.fn();
    const { user } = renderButton({ onLikeChange });

    await user.click(screen.getByRole('button', { name: 'Like this day' }));

    const button = screen.getByRole('button', { name: 'Unlike this day' });
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(button).toBeDisabled();
    expect(button).toHaveClass(styles.loading);
    expect(heartOf(button)).toHaveClass(styles.pop);
    expect(heartOf(button)).toHaveAttribute('fill', 'currentColor');
    expect(screen.getByRole('button', { name: 'See 3 likes' })).toBeInTheDocument();
    expect(likeApi.likeDay).toHaveBeenCalledExactlyOnceWith('alice', '2026-10-20');

    await act(async () => request.resolve(action(true, 7)));

    expect(screen.getByRole('button', { name: 'See 7 likes' })).toBeInTheDocument();
    expect(button).toBeEnabled();
    expect(onLikeChange).toHaveBeenCalledExactlyOnceWith(true, 7);
  });

  it('ends the pop animation when it finishes', async () => {
    const { user } = renderButton();

    await user.click(screen.getByRole('button', { name: 'Like this day' }));
    const heart = heartOf(screen.getByRole('button', { name: 'Unlike this day' }));
    expect(heart).toHaveClass(styles.pop);

    finishAnimation(heart);
    expect(heart).not.toHaveClass(styles.pop);
    expect(heart).toHaveClass(styles.icon);
  });

  it('unlikes without letting the count drop below zero', async () => {
    const request = createDeferred<LikeActionResponse>();
    likeApi.unlikeDay.mockReturnValue(request.promise);
    const { user } = renderButton({ initialCount: 0, initialLiked: true });

    await user.click(screen.getByRole('button', { name: 'Unlike this day' }));

    const button = screen.getByRole('button', { name: 'Like this day' });
    expect(heartOf(button)).not.toHaveClass(styles.pop);
    expect(heartOf(button)).toHaveAttribute('fill', 'none');
    expect(screen.getByText('0')).toBeInTheDocument();
    expect(likeApi.unlikeDay).toHaveBeenCalledExactlyOnceWith('alice', '2026-10-20');

    await act(async () => request.resolve(action(false, 0)));
    expect(button).toHaveAttribute('aria-pressed', 'false');
  });

  it('reverts when the server rejects the change', async () => {
    likeApi.likeDay.mockResolvedValue(action(true, 3, false));
    const onLikeChange = vi.fn();
    const { user } = renderButton({ onLikeChange });

    await user.click(screen.getByRole('button', { name: 'Like this day' }));

    expect(await screen.findByRole('button', { name: 'Like this day' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'See 2 likes' })).toBeInTheDocument();
    expect(onLikeChange).not.toHaveBeenCalled();
  });

  it('reverts and logs when the request fails', async () => {
    const error = new Error('500');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    likeApi.unlikeDay.mockRejectedValue(error);
    const { user } = renderButton({ initialCount: 4, initialLiked: true });

    await user.click(screen.getByRole('button', { name: 'Unlike this day' }));

    expect(await screen.findByRole('button', { name: 'Unlike this day' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'See 4 likes' })).toBeInTheDocument();
    expect(consoleError).toHaveBeenCalledWith('Failed to toggle like:', error);
  });

  it('ignores repeated clicks while a request is in flight', async () => {
    const request = createDeferred<LikeActionResponse>();
    likeApi.likeDay.mockReturnValue(request.promise);
    const { user } = renderButton();

    await user.click(screen.getByRole('button', { name: 'Like this day' }));
    fireEvent.click(screen.getByRole('button', { name: 'Unlike this day' }));
    fireEvent.click(screen.getByRole('button', { name: 'Unlike this day' }));

    expect(likeApi.likeDay).toHaveBeenCalledTimes(1);
    expect(likeApi.unlikeDay).not.toHaveBeenCalled();
    await act(async () => request.resolve(action(true, 3)));
  });

  it('does not let clicks reach the card underneath', async () => {
    const onCardClick = vi.fn();
    const { user } = renderWithRouter(
      <div onClick={onCardClick}>
        <LikeButton username="alice" date="2026-10-20" initialCount={2} initialLiked={false} />
      </div>
    );

    await user.click(screen.getByRole('button', { name: 'Like this day' }));
    await user.click(await screen.findByRole('button', { name: 'See 3 likes' }));

    expect(onCardClick).not.toHaveBeenCalled();
    expect(await screen.findByText('No likes yet')).toBeInTheDocument();
  });

  it('opens the likers list from the count and closes it again', async () => {
    likeApi.getLikes.mockResolvedValue(likes({ count: 2, data: [makeLiker()] }));
    const { user } = renderButton();

    await user.click(screen.getByRole('button', { name: 'See 2 likes' }));
    const dialog = await screen.findByRole('dialog', { name: 'Likes' });
    expect(
      await within(dialog).findByRole('button', { name: "Open alice's profile" })
    ).toBeVisible();

    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows a zero count as plain text and singular/plural labels', () => {
    const { rerender } = renderInRouter(
      <LikeButton username="alice" date="2026-10-20" initialCount={0} initialLiked={false} />
    );

    expect(screen.queryByRole('button', { name: /^See/ })).not.toBeInTheDocument();
    expect(screen.getByText('0')).not.toHaveClass(styles.clickable);

    rerender(
      <LikeButton username="alice" date="2026-10-20" initialCount={1} initialLiked={false} />
    );
    expect(screen.getByRole('button', { name: 'See 1 like' })).toBeInTheDocument();
  });

  it('can hide the count', () => {
    renderButton({ showCount: false });

    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.queryByText('2')).not.toBeInTheDocument();
  });

  it.each([
    ['sm', '16'],
    ['md', '20'],
  ] as const)('renders the %s size with a %spx heart', (size, iconSize) => {
    renderButton({ size });
    const button = screen.getByRole('button', { name: 'Like this day' });

    expect(button.parentElement).toHaveClass(styles.container, styles[size]);
    expect(heartOf(button)).toHaveAttribute('width', iconSize);
  });

  it('follows new initial values from the parent', () => {
    const { rerender } = renderInRouter(
      <LikeButton username="alice" date="2026-10-20" initialCount={2} initialLiked={false} />
    );

    rerender(<LikeButton username="alice" date="2026-10-20" initialCount={5} initialLiked />);

    expect(screen.getByRole('button', { name: 'Unlike this day' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'See 5 likes' })).toBeInTheDocument();
  });
});
