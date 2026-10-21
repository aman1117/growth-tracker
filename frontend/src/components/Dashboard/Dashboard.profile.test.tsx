import { act, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api, ApiError, commentApi, likeApi } from '../../services/api';
import {
  ALICE,
  BOB,
  dashboardRoutes,
  FIXED_TODAY,
  makeActivity,
  makeBadge,
  makePhoto,
  makeSearchUser,
  mockQuietSocial,
  resetStoryStubs,
  routeApi,
  storyStubs,
  TODAY_KEY,
} from '../../test/fixtures/dashboard';
import { renderWithRouter, signIn } from '../../test/utils';
import { TAB_RESELECT_EVENT } from '../../utils/navigation';
import { Dashboard } from '.';
import { getCacheKey } from './Dashboard.constants';

vi.mock('../../services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/api')>()),
  api: { get: vi.fn(), post: vi.fn() },
  likeApi: { getLikes: vi.fn(), likeDay: vi.fn(), unlikeDay: vi.fn() },
  commentApi: { getCommentCount: vi.fn(), getComments: vi.fn() },
}));
vi.mock('../story', async () => {
  const { StoryCirclesRowStub, StoryViewerStub } = await import('../../test/fixtures/dashboard');
  return { StoryCirclesRow: StoryCirclesRowStub, StoryViewer: StoryViewerStub };
});
vi.mock('../ui', async (importOriginal) => {
  const { PullToRefreshStub } = await import('../../test/fixtures/dashboard');
  return {
    ...(await importOriginal<typeof import('../ui')>()),
    PullToRefreshWrapper: PullToRefreshStub,
  };
});
vi.mock('../../utils/sounds', () => ({ playActivitySound: vi.fn(), playCompletionSound: vi.fn() }));
vi.mock('canvas-confetti', () => ({ default: vi.fn() }));

// The theme store (store barrel) reads matchMedia when its module loads, before the shared
// setup stubs it for each test.
await vi.hoisted(async () => {
  const { createMatchMedia } = await import('../../test/browser-mocks');
  vi.stubGlobal('matchMedia', createMatchMedia());
});

/** Bob logged a 1.5h workout (with a private note) today and uses his own tile order. */
const bobRoutes = (overrides = {}) =>
  dashboardRoutes({
    'POST /get-activities': (body: unknown) =>
      (body as { start_date: string }).start_date === TODAY_KEY
        ? { success: true, data: [makeActivity({ name: 'workout', hours: 1.5, note: 'Leg day' })] }
        : { success: true, data: [] },
    'POST /tile-config/user': {
      success: true,
      data: { order: ['workout', 'sleep', 'study'], sizes: { workout: 'wide' } },
    },
    [`GET /users/${BOB.id}/profile`]: { success: true, last_logged_at: '2026-05-15T08:00:00' },
    ...overrides,
  });

function renderProfile() {
  return renderWithRouter(<Dashboard />, { route: '/user/bob', path: '/user/:username' });
}

/** Renders bob's day and waits until his tiles and profile have loaded. */
async function renderLoadedProfile() {
  const view = renderProfile();
  await screen.findByRole('button', { name: 'Workout, 1.5 hours' });
  await screen.findByRole('button', { name: "View bob's photo" });
  return view;
}

function LocationState() {
  const { state } = useLocation();
  return <output aria-label="Location state">{JSON.stringify(state)}</output>;
}

const pullToRefresh = () => screen.getByRole('button', { name: 'Pull to refresh' });
const activityRequests = () =>
  vi.mocked(api.post).mock.calls.filter(([endpoint]) => endpoint === '/get-activities');
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 250)));

describe('Dashboard (another user’s day)', () => {
  beforeEach(() => {
    vi.setSystemTime(FIXED_TODAY);
    // Overlay history logs its steps with console.debug in development builds
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    signIn(ALICE);
    routeApi(api, bobRoutes());
    mockQuietSocial({ likeApi, commentApi });
    resetStoryStubs();
  });

  it('shows the day read-only under the user’s profile header', async () => {
    await renderLoadedProfile();

    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent('bob');
    expect(within(heading).getByRole('img', { name: 'Verified account' })).toBeInTheDocument();
    const header = screen.getByRole('region', { name: "bob's profile" });
    expect(header).toHaveTextContent('Runner and reader');
    expect(await within(header).findByText('Last logged today')).toBeInTheDocument();
    expect(await within(header).findByRole('button', { name: /Followers/ })).toHaveTextContent(
      '12'
    );
    expect(await screen.findByRole('region', { name: 'Today summary' })).toBeInTheDocument();
    expect(likeApi.getLikes).toHaveBeenCalledWith('bob', TODAY_KEY);
  });

  it('loads the viewed user’s day and layout without caching them', async () => {
    await renderLoadedProfile();

    expect(api.post).toHaveBeenCalledWith('/get-activities', {
      username: 'bob',
      start_date: TODAY_KEY,
      end_date: TODAY_KEY,
    });
    expect(api.post).toHaveBeenCalledWith('/tile-config/user', { username: 'bob' });
    expect(api.get).not.toHaveBeenCalledWith('/tile-config');
    expect(localStorage.getItem(getCacheKey('bob', TODAY_KEY))).toBeNull();
    expect(
      screen
        .getAllByRole('button', { name: /hours?$/ })
        .map((tile) => tile.getAttribute('aria-label'))
    ).toEqual(['Workout, 1.5 hours', 'Sleep, 0 hours', 'Study, 0 hours']);
  });

  it('does not let the viewer log, customize or see private notes', async () => {
    const { user } = await renderLoadedProfile();

    await user.click(screen.getByRole('button', { name: 'Workout, 1.5 hours' }));
    act(() => void window.dispatchEvent(new Event('toggleEditMode')));

    expect(screen.queryByRole('dialog', { name: 'Log Workout' })).not.toBeInTheDocument();
    expect(screen.queryByRole('toolbar', { name: 'Customize tiles' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /has note/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add a custom tile' })).not.toBeInTheDocument();
  });

  it('wires the story row for the viewed user', async () => {
    await renderLoadedProfile();

    expect(screen.getByRole('region', { name: 'Stories' })).toBeInTheDocument();
    expect(storyStubs.row).toMatchObject({
      targetUserId: BOB.id,
      targetUsername: 'bob',
      isOwnProfile: false,
    });
    expect(storyStubs.row?.onTargetUserPhotos).toEqual(expect.any(Function));
  });

  it('opens the user’s insights', async () => {
    const { user } = await renderLoadedProfile();

    await user.click(screen.getByRole('button', { name: "View bob's insights" }));
    expect(screen.getByTestId('location')).toHaveTextContent('/analytics?user=bob');
  });

  it('goes back when there is no earlier screen in the app', async () => {
    const { user } = await renderLoadedProfile();

    await user.click(screen.getByRole('button', { name: 'Go back' }));

    expect(screen.getByTestId('location')).toHaveTextContent(/^\/$/);
  });

  describe('private account', () => {
    beforeEach(() => {
      routeApi(
        api,
        bobRoutes({
          'POST /get-activities': new ApiError('This account is private', 403, 'ACCOUNT_PRIVATE'),
          'POST /badges/user': {
            success: true,
            badges: [makeBadge({ key: 'week', name: 'Week Warrior', threshold: 7 })],
          },
          'POST /users': {
            success: true,
            data: [makeSearchUser({ is_private: true, is_verified: false, bio: undefined })],
          },
        })
      );
    });

    it('explains the account is private and shows only its public badges', async () => {
      renderProfile();

      const card = await screen.findByRole('region', { name: 'This account is private' });
      expect(card).toHaveTextContent('Follow @bob to see their days and stories.');
      expect(await within(card).findByText('Week Warrior')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^Workout/ })).not.toBeInTheDocument();
      expect(screen.queryByRole('region', { name: /summary$/ })).not.toBeInTheDocument();
      expect(screen.queryByRole('region', { name: 'Stories' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: "View bob's insights" })).not.toBeInTheDocument();
      expect(
        within(screen.getByRole('heading', { level: 1 })).queryByRole('img')
      ).not.toBeInTheDocument();
      // Following is still possible, as a request
      expect(await screen.findByRole('button', { name: 'Follow' })).toBeInTheDocument();
    });

    it('reloads the day once the user accepts the follow request', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      renderProfile();
      await screen.findByRole('region', { name: 'This account is private' });
      routeApi(api, bobRoutes());

      act(() => {
        window.dispatchEvent(
          new CustomEvent('follow-accepted', { detail: { actorId: BOB.id, actorUsername: 'bob' } })
        );
      });

      expect(await screen.findByRole('button', { name: 'Workout, 1.5 hours' })).toBeInTheDocument();
      expect(
        screen.queryByRole('region', { name: 'This account is private' })
      ).not.toBeInTheDocument();
    });
  });

  describe('avatar', () => {
    const earlier = makePhoto({ id: 10, created_at: '2026-05-15T07:00:00Z' });
    const later = makePhoto({ id: 11, created_at: '2026-05-15T18:00:00Z' });

    it('opens the full-size profile photo when there are no stories', async () => {
      const { user } = await renderLoadedProfile();

      await user.click(screen.getByRole('button', { name: "View bob's photo" }));

      const photo = screen.getByRole('dialog', { name: "bob's profile photo" });
      expect(pullToRefresh()).toBeDisabled();
      await user.click(within(photo).getByRole('button', { name: 'Close photo' }));
      expect(screen.queryByRole('dialog', { name: "bob's profile photo" })).not.toBeInTheDocument();
    });

    it('plays the user’s stories oldest first and drops deleted photos', async () => {
      const { user } = await renderLoadedProfile();
      act(() => storyStubs.row!.onTargetUserPhotos!([later, earlier]));

      await user.click(screen.getByRole('button', { name: "View bob's stories" }));

      const viewer = screen.getByRole('dialog', { name: 'bob stories' });
      expect(viewer).toHaveTextContent('Photos: 10, 11');
      expect(storyStubs.viewer).toMatchObject({
        isOwnStory: false,
        startIndex: 0,
        ownerProfilePic: 'https://cdn.test/bob.jpg',
      });
      await user.click(within(viewer).getByRole('button', { name: 'Mark stories viewed' }));
      await user.click(within(viewer).getByRole('button', { name: 'Delete story photo' }));
      await user.click(within(viewer).getByRole('button', { name: 'Close stories' }));

      await user.click(screen.getByRole('button', { name: "View bob's stories" }));

      expect(screen.getByRole('dialog', { name: 'bob stories' })).toHaveTextContent('Photos: 11');
    });

    it('forgets loaded stories when switching days', async () => {
      const { user } = await renderLoadedProfile();
      act(() => storyStubs.row!.onTargetUserPhotos!([earlier]));
      expect(screen.getByRole('button', { name: "View bob's stories" })).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Previous day' }));

      expect(await screen.findByRole('button', { name: "View bob's photo" })).toBeInTheDocument();
    });
  });

  it('ignores a Home tab reselect on someone else’s day', async () => {
    const { user } = await renderLoadedProfile();
    await user.click(await screen.findByRole('button', { name: 'Previous day' }));
    await screen.findByRole('button', { name: 'Workout, 0 hours' });
    const requests = activityRequests().length;

    act(() => {
      window.dispatchEvent(new CustomEvent(TAB_RESELECT_EVENT, { detail: { tab: 'home' } }));
    });
    await settle();

    expect(activityRequests()).toHaveLength(requests);
    expect(screen.getByRole('region', { name: 'Yesterday summary' })).toBeInTheDocument();
  });

  it('clears a "Customize" request without customizing someone else’s day', async () => {
    function OpenBob() {
      const navigate = useNavigate();
      return (
        <button
          type="button"
          onClick={() => navigate('/user/bob', { state: { enterEditMode: true } })}
        >
          Open bob
        </button>
      );
    }
    const { user } = renderWithRouter(
      <>
        <Routes>
          <Route path="/user/:username" element={<Dashboard />} />
          <Route path="/search" element={<OpenBob />} />
        </Routes>
        <LocationState />
      </>,
      { route: '/search' }
    );

    await user.click(screen.getByRole('button', { name: 'Open bob' }));

    expect(await screen.findByRole('button', { name: 'Workout, 1.5 hours' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Location state')).toHaveTextContent('null'));
    expect(screen.queryByRole('toolbar', { name: 'Customize tiles' })).not.toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/user/bob');
  });
});
