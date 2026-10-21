import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../../../services/api';
import {
  ALICE,
  BOB,
  dashboardRoutes,
  FIXED_TODAY,
  makePhoto,
  routeApi,
} from '../../../test/fixtures/dashboard';
import { signIn } from '../../../test/utils';
import { UserProfileHeader } from './UserProfileHeader';

vi.mock('../../../services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/api')>()),
  api: { get: vi.fn(), post: vi.fn() },
}));

// The theme store (store barrel) reads matchMedia when its module loads, before the shared
// setup stubs it for each test.
await vi.hoisted(async () => {
  const { createMatchMedia } = await import('../../../test/browser-mocks');
  vi.stubGlobal('matchMedia', createMatchMedia());
});

type Props = ComponentProps<typeof UserProfileHeader>;

function renderHeader(props: Partial<Props> = {}) {
  const onAvatarClick = vi.fn();
  const onAnalyticsClick = vi.fn();
  render(
    <MemoryRouter>
      <UserProfileHeader
        targetUsername="bob"
        targetUserId={BOB.id}
        targetProfilePic={null}
        targetProfilePicThumb={null}
        targetBio="Runner and reader"
        targetIsVerified={false}
        targetIsPrivate={false}
        targetLastLoggedAt={null}
        isPrivateAccount={false}
        targetUserPhotos={[]}
        targetUserPhotosOwnerId={null}
        onAvatarClick={onAvatarClick}
        onAnalyticsClick={onAnalyticsClick}
        {...props}
      />
    </MemoryRouter>
  );
  return { user: userEvent.setup(), onAvatarClick, onAnalyticsClick };
}

describe('UserProfileHeader', () => {
  beforeEach(() => {
    vi.setSystemTime(FIXED_TODAY);
    signIn(ALICE);
    routeApi(api, dashboardRoutes());
  });

  it('labels the header with the username and shows the bio', () => {
    renderHeader();

    const header = screen.getByRole('region', { name: "bob's profile" });
    expect(header).toHaveTextContent('bob');
    expect(screen.getByText('Runner and reader')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Verified account' })).not.toBeInTheDocument();
  });

  it('shows the verified badge for verified users', () => {
    renderHeader({ targetIsVerified: true });

    expect(screen.getByRole('img', { name: 'Verified account' })).toBeInTheDocument();
  });

  describe('avatar', () => {
    it('shows initials and is not interactive without a photo or stories', () => {
      renderHeader();

      expect(screen.getByText('B')).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /View bob's (photo|stories)/ })
      ).not.toBeInTheDocument();
    });

    it('opens the profile photo, preferring the thumbnail for display', async () => {
      const { user, onAvatarClick } = renderHeader({
        targetProfilePic: 'https://cdn.test/bob.jpg',
        targetProfilePicThumb: 'https://cdn.test/bob-thumb.jpg',
      });

      const avatar = screen.getByRole('button', { name: "View bob's photo" });
      expect(within(avatar).getByRole('img', { name: 'bob' })).toHaveAttribute(
        'src',
        'https://cdn.test/bob-thumb.jpg'
      );

      await user.click(avatar);
      expect(onAvatarClick).toHaveBeenCalledTimes(1);
    });

    it('opens stories when the loaded photos belong to this user', async () => {
      const { user, onAvatarClick } = renderHeader({
        targetUserPhotos: [makePhoto()],
        targetUserPhotosOwnerId: BOB.id,
      });

      await user.click(screen.getByRole('button', { name: "View bob's stories" }));

      expect(onAvatarClick).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['still belong to the previous profile', { targetUserPhotosOwnerId: 99 }],
      ['belong to a private account', { isPrivateAccount: true, targetUserPhotosOwnerId: BOB.id }],
    ])('ignores stories that %s', (_label, props) => {
      renderHeader({
        targetProfilePic: 'https://cdn.test/bob.jpg',
        targetUserPhotos: [makePhoto()],
        ...props,
      });

      expect(screen.queryByRole('button', { name: "View bob's stories" })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: "View bob's photo" })).toBeInTheDocument();
    });
  });

  it('shows when the user last logged activity', () => {
    renderHeader({ targetLastLoggedAt: '2026-05-14T09:00:00' });

    expect(screen.getByText('Last logged yesterday')).toBeInTheDocument();
  });

  it('loads follower counts, mutual followers and the follow button', async () => {
    routeApi(
      api,
      dashboardRoutes({
        [`GET /users/${BOB.id}/mutuals`]: {
          success: true,
          users: [{ id: 3, username: 'carol', is_verified: false, is_private: false }],
          has_more: false,
        },
      })
    );
    renderHeader();

    const followers = await screen.findByRole('button', { name: /Followers/ });
    await waitFor(() => expect(followers).toHaveTextContent('12'));
    expect(screen.getByRole('button', { name: /Following/ })).toHaveTextContent('4');
    expect(await screen.findByText(/Followed by/)).toHaveTextContent('Followed by carol');
    expect(screen.getByRole('button', { name: 'Follow' })).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith(`/users/${BOB.id}/follow-counts`);
  });

  it('leaves out social actions until the user id is known', () => {
    renderHeader({ targetUserId: null });

    expect(screen.queryByRole('button', { name: /Followers/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Follow' })).not.toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalled();
  });

  it('links to the user’s insights', async () => {
    const { user, onAnalyticsClick } = renderHeader();

    await user.click(screen.getByRole('button', { name: "View bob's insights" }));

    expect(onAnalyticsClick).toHaveBeenCalledTimes(1);
  });

  it('hides the bio, insights and follower lists of a private account', async () => {
    renderHeader({ isPrivateAccount: true, targetIsPrivate: true });

    expect(screen.queryByText('Runner and reader')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: "View bob's insights" })).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /Followers/ })).toBeDisabled();
    // Following is still possible, as a request
    expect(screen.getByRole('button', { name: 'Follow' })).toBeEnabled();
  });
});
