import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useFollowStore } from '../../../store';
import { deferred, followUser } from '../../../test/fixtures/social';
import { renderWithRouter, signIn } from '../../../test/utils';
import MutualFollowersDefault, { MutualFollowers } from './MutualFollowers';

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
const [ann, ben, cat] = [
  followUser({ id: 11, username: 'ann', profile_pic_thumb: 'https://cdn.test/ann.jpg' }),
  followUser({ id: 12, username: 'ben' }),
  followUser({ id: 13, username: 'cat' }),
];

function renderMutuals(onShowAll = vi.fn()) {
  const utils = renderWithRouter(
    <MutualFollowers userId={PROFILE_ID} username="erin" onShowAll={onShowAll} />,
    { route: '/user/erin' }
  );
  return { ...utils, onShowAll };
}

const summary = () => screen.findByText(/Followed by/);

describe('MutualFollowers', () => {
  beforeEach(() => {
    signIn({ id: 1, username: 'alice' });
  });

  it('asks for the first three mutual followers', async () => {
    api.get.mockResolvedValue({ success: true, users: [ann], has_more: false });
    renderMutuals();

    await summary();
    expect(api.get).toHaveBeenCalledWith(`/users/${PROFILE_ID}/mutuals?limit=3`);
  });

  it.each([
    ['one mutual follower', [ann], false, 'Followed by ann'],
    ['two mutual followers', [ann, ben], false, 'Followed by ann, ben'],
    ['three mutual followers', [ann, ben, cat], false, 'Followed by ann, ben and 1 other'],
    ['more mutual followers', [ann, ben, cat], true, 'Followed by ann, ben and 2 others'],
  ])('summarises %s', async (_label, users, hasMore, text) => {
    api.get.mockResolvedValue({ success: true, users, has_more: hasMore });
    renderMutuals();

    expect(await summary()).toHaveTextContent(new RegExp(`^${text}$`));
  });

  it('stacks up to three avatars', async () => {
    api.get.mockResolvedValue({ success: true, users: [ann, ben, cat], has_more: true });
    renderMutuals();

    await summary();
    expect(screen.getByRole('img', { name: 'ann' })).toHaveAttribute(
      'src',
      'https://cdn.test/ann.jpg'
    );
    expect(screen.getByText('B')).toBeInTheDocument();
    expect(screen.getByText('C')).toBeInTheDocument();
  });

  it('opens a mutual follower’s profile from their name or avatar', async () => {
    api.get.mockResolvedValue({ success: true, users: [ann, ben], has_more: false });
    const { user, onShowAll } = renderMutuals();
    await summary();

    await user.click(screen.getByText('ben'));
    expect(screen.getByTestId('location')).toHaveTextContent('/user/ben');

    await user.click(screen.getByRole('img', { name: 'ann' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/user/ann');
    expect(onShowAll).not.toHaveBeenCalled();
  });

  it('shows all mutual followers when the summary is clicked', async () => {
    api.get.mockResolvedValue({ success: true, users: [ann, ben, cat], has_more: true });
    const { user, onShowAll } = renderMutuals();

    await user.click(await screen.findByText(/2 others/));

    expect(onShowAll).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('location')).toHaveTextContent('/user/erin');
  });

  it('renders nothing while loading', () => {
    api.get.mockReturnValue(deferred().promise);
    renderMutuals();

    expect(screen.queryByText(/Followed by/)).not.toBeInTheDocument();
  });

  it('renders nothing and does not fetch on your own profile', () => {
    signIn({ id: PROFILE_ID, username: 'erin' });
    renderMutuals();

    expect(screen.queryByText(/Followed by/)).not.toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalled();
  });

  it.each([
    ['there are no mutual followers', { success: true, users: [], has_more: false }],
    ['the response has no user list', { success: true, has_more: false }],
    ['the request is rejected', { success: false, users: [], has_more: false, error: 'Nope' }],
  ])('renders nothing when %s', async (_label, response) => {
    api.get.mockResolvedValue(response);
    renderMutuals();

    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(screen.queryByText(/Followed by/)).not.toBeInTheDocument();
  });

  it('logs and renders nothing when loading mutual followers throws', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = new Error('boom');
    useFollowStore.setState({ getMutuals: vi.fn().mockRejectedValue(failure) });
    renderMutuals();

    await waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith('Failed to fetch mutuals:', failure)
    );
    expect(screen.queryByText(/Followed by/)).not.toBeInTheDocument();
  });

  it('is exported as the default export', () => {
    expect(MutualFollowersDefault).toBe(MutualFollowers);
  });
});
