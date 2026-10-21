import { screen, waitFor, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useFollowStore } from '../../../store';
import { deferred } from '../../../test/fixtures/social';
import { renderWithRouter, signIn } from '../../../test/utils';
import FollowStatsDefault, { FollowStats } from './FollowStats';

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

const PROFILE_ID = 5;

function renderStats(props: Partial<ComponentProps<typeof FollowStats>> = {}) {
  const view = renderWithRouter(<FollowStats userId={PROFILE_ID} username="erin" {...props} />);
  // Re-rendering inside the same router element updates FollowStats in place.
  const rerender = (next: Partial<ComponentProps<typeof FollowStats>>) =>
    view.rerender(
      <MemoryRouter>
        <FollowStats userId={PROFILE_ID} username="erin" {...props} {...next} />
      </MemoryRouter>
    );
  return { ...view, rerender };
}

const followersStat = () => screen.getByRole('button', { name: /Followers/ });
const followingStat = () => screen.getByRole('button', { name: /Following/ });

/** Answers the counts endpoint and the (empty) follow lists. */
function answerApi(counts = { followers_count: 12, following_count: 3 }) {
  api.get.mockImplementation(async (url: string) => {
    if (url.includes('/follow-counts')) return { success: true, counts };
    return { success: true, users: [], total_count: 0 };
  });
}

describe('FollowStats', () => {
  beforeEach(() => {
    signIn({ id: 1, username: 'alice' });
    // Overlay history logs every modal open/close in development builds.
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  it.each([
    [999, 0, '999', '0'],
    [1500, 12_000, '1.5K', '12.0K'],
    [2_500_000, 1_000_000, '2.5M', '1.0M'],
  ])('formats %i followers and %i following', (followers, following, shown, shownFollowing) => {
    renderStats({ initialCounts: { followers, following } });

    expect(followersStat()).toHaveTextContent(`${shown}Followers`);
    expect(followingStat()).toHaveTextContent(`${shownFollowing}Following`);
    expect(api.get).not.toHaveBeenCalled();
  });

  it('shares the initial counts through the follow store', () => {
    renderStats({ initialCounts: { followers: 4, following: 2 } });

    expect(useFollowStore.getState().counts[String(PROFILE_ID)]).toEqual({
      followers: 4,
      following: 2,
    });
  });

  it('prefers counts already cached in the store', () => {
    useFollowStore.getState().setCounts(PROFILE_ID, { followers: 40, following: 20 });
    renderStats({ initialCounts: { followers: 4, following: 2 } });

    expect(followersStat()).toHaveTextContent('40');
    expect(followingStat()).toHaveTextContent('20');
  });

  it('loads the counts when none are known', async () => {
    const counts = deferred<unknown>();
    api.get.mockReturnValue(counts.promise);
    renderStats();

    expect(followersStat()).toHaveTextContent('—');
    expect(followersStat()).toBeDisabled();
    expect(followingStat()).toBeDisabled();
    expect(api.get).toHaveBeenCalledWith(`/users/${PROFILE_ID}/follow-counts`);

    counts.resolve({ success: true, counts: { followers_count: 12, following_count: 3 } });

    await waitFor(() => expect(followersStat()).toHaveTextContent('12Followers'));
    expect(followingStat()).toHaveTextContent('3Following');
    expect(followersStat()).toBeEnabled();
  });

  it('falls back to zero without retrying when the counts cannot be loaded', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    api.get.mockRejectedValue(new Error('Network down'));
    renderStats();

    await waitFor(() => expect(followersStat()).toHaveTextContent('0Followers'));
    expect(followingStat()).toHaveTextContent('0Following');
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('loads the counts again for a different profile', async () => {
    answerApi();
    const { rerender } = renderStats();
    await waitFor(() => expect(followersStat()).toHaveTextContent('12'));

    rerender({ userId: 6, username: 'finn' });

    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/users/6/follow-counts'));
  });

  it.each([
    ['followers', followersStat, 'Followers', `/users/${PROFILE_ID}/followers?limit=20`],
    ['following', followingStat, 'Following', `/users/${PROFILE_ID}/following?limit=20`],
  ])('opens the %s list and closes it again', async (_type, stat, title, url) => {
    answerApi();
    const { user } = renderStats({ initialCounts: { followers: 1, following: 1 } });

    await user.click(stat());

    const dialog = await screen.findByRole('dialog', { name: title });
    expect(within(dialog).getByText('@erin')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith(url);

    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps the lists closed for a private account the viewer cannot see', async () => {
    const { user } = renderStats({
      initialCounts: { followers: 8, following: 9 },
      isPrivate: true,
      canView: false,
    });

    expect(followersStat()).toBeDisabled();
    expect(followingStat()).toBeDisabled();
    await user.click(followersStat());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens the lists of a private account the viewer follows', async () => {
    answerApi();
    const { user } = renderStats({
      initialCounts: { followers: 8, following: 9 },
      isPrivate: true,
      canView: true,
    });

    await user.click(followersStat());

    expect(await screen.findByRole('dialog', { name: 'Followers' })).toBeInTheDocument();
  });

  it('is exported as the default export', () => {
    expect(FollowStatsDefault).toBe(FollowStats);
  });
});
