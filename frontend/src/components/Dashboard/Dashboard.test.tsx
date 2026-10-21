import { act, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api, commentApi, likeApi } from '../../services/api';
import { useCompletionStore } from '../../store';
import {
  ALICE,
  createDeferred,
  dashboardRoutes,
  FIXED_TODAY,
  makeActivity,
  makeBadge,
  makePhoto,
  mockQuietSocial,
  resetStoryStubs,
  routeApi,
  storyStubs,
  TODAY_KEY,
  YESTERDAY_KEY,
} from '../../test/fixtures/dashboard';
import { renderWithRouter, signIn } from '../../test/utils';
import { TAB_RESELECT_EVENT } from '../../utils/navigation';
import { playActivitySound, playCompletionSound } from '../../utils/sounds';
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

/** Alice logged 8h of sleep and 2.5h of study (with a note) today. */
const aliceDay = {
  success: true,
  data: [
    makeActivity({ name: 'sleep', hours: 8 }),
    makeActivity({ id: 2, name: 'study', hours: 2.5, note: 'Chapter 4' }),
  ],
};

function renderDashboard(route = '/') {
  return renderWithRouter(<Dashboard />, { route, path: '/' });
}

/** Renders alice's own day and waits for the tiles and the summary. */
async function renderLoadedDay() {
  const view = renderDashboard();
  await screen.findByRole('button', { name: 'Sleep, 8 hours' });
  await screen.findByRole('region', { name: 'Today summary' });
  return view;
}

const pullToRefresh = () => screen.getByRole('button', { name: 'Pull to refresh' });
const hoursField = () => screen.getByRole('textbox', { name: 'Hours' });
/** Lets pending animation timers (150ms + 50ms) run out. */
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 250)));
const activityRequests = () =>
  vi.mocked(api.post).mock.calls.filter(([endpoint]) => endpoint === '/get-activities');

describe('Dashboard (own day)', () => {
  beforeEach(() => {
    vi.setSystemTime(FIXED_TODAY);
    // Overlay history logs its steps with console.debug in development builds
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    signIn(ALICE);
    routeApi(api, dashboardRoutes({ 'POST /get-activities': aliceDay }));
    mockQuietSocial({ likeApi, commentApi });
    resetStoryStubs();
  });

  describe('loading the day', () => {
    it('shows skeletons, then the tiles and the day summary', async () => {
      const day = createDeferred<unknown>();
      routeApi(api, dashboardRoutes({ 'POST /get-activities': () => day.promise }));
      renderDashboard();

      expect(screen.getByLabelText('Loading activities')).toHaveAttribute('aria-busy', 'true');
      expect(screen.getByLabelText('Loading day')).toBeInTheDocument();

      day.resolve(aliceDay);

      expect(await screen.findByRole('button', { name: 'Sleep, 8 hours' })).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Study, 2.5 hours, has note' })
      ).toBeInTheDocument();
      expect(screen.queryByLabelText('Loading activities')).not.toBeInTheDocument();
      expect(await screen.findByRole('progressbar', { name: 'Hours logged' })).toHaveAttribute(
        'aria-valuenow',
        '10.5'
      );
    });

    it('loads the signed-in user’s day, layout and month heat map', async () => {
      await renderLoadedDay();

      expect(api.post).toHaveBeenCalledWith('/get-activities', {
        username: 'alice',
        start_date: TODAY_KEY,
        end_date: TODAY_KEY,
      });
      expect(api.get).toHaveBeenCalledWith('/tile-config');
      expect(api.post).toHaveBeenCalledWith('/get-daily-totals', {
        username: 'alice',
        start_date: '2026-05-01',
        end_date: '2026-05-31',
      });
      expect(localStorage.getItem(getCacheKey('alice', TODAY_KEY))).not.toBeNull();
    });

    it('shows the own-profile layout: no back button or profile header, own stories', async () => {
      await renderLoadedDay();

      expect(screen.queryByRole('button', { name: 'Go back' })).not.toBeInTheDocument();
      expect(screen.queryByRole('region', { name: "alice's profile" })).not.toBeInTheDocument();
      expect(screen.getByRole('region', { name: 'Stories' })).toBeInTheDocument();
      expect(storyStubs.row).toMatchObject({
        targetUserId: ALICE.id,
        targetUsername: 'alice',
        isOwnProfile: true,
        isEditMode: false,
        onTargetUserPhotos: undefined,
      });
    });

    it('shows an empty day with every tile at zero hours', async () => {
      routeApi(api, dashboardRoutes({ 'POST /get-activities': { success: true, data: [] } }));
      renderDashboard();

      expect(await screen.findByRole('button', { name: 'Sleep, 0 hours' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Office, 0 hours' })).toBeInTheDocument();
      expect(await screen.findByRole('progressbar', { name: 'Hours logged' })).toHaveAttribute(
        'aria-valuetext',
        '0 of 24 hours logged'
      );
    });

    it('reports a failed load and recovers with pull to refresh', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      routeApi(api, dashboardRoutes({ 'POST /get-activities': new TypeError('Failed to fetch') }));
      const { user } = renderDashboard();

      expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load activities');
      expect(await screen.findByRole('button', { name: 'Sleep, 0 hours' })).toBeInTheDocument();
      expect(storyStubs.rowMounted).toHaveBeenCalledTimes(1);

      routeApi(api, dashboardRoutes({ 'POST /get-activities': aliceDay }));
      await user.click(pullToRefresh());

      expect(await screen.findByRole('button', { name: 'Sleep, 8 hours' })).toBeInTheDocument();
      // Stories are re-fetched by remounting the story row
      await waitFor(() => expect(storyStubs.rowMounted).toHaveBeenCalledTimes(2));
    });

    it('tells the user when a refresh fails', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const { user } = await renderLoadedDay();
      const fetchMonthData = vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockRejectedValueOnce(new Error('offline'));
      act(() => useCompletionStore.setState({ fetchMonthData }));

      await user.click(pullToRefresh());

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Failed to refresh. Please try again.'
      );
    });
  });

  describe('date navigation', () => {
    /** Each day answers with different activities, so a loaded day is easy to tell apart. */
    const daysByDate: Record<string, unknown> = {
      [TODAY_KEY]: aliceDay,
      [YESTERDAY_KEY]: { success: true, data: [makeActivity({ name: 'workout', hours: 1 })] },
      '2026-05-10': { success: true, data: [makeActivity({ name: 'reels', hours: 2 })] },
    };

    beforeEach(() => {
      routeApi(
        api,
        dashboardRoutes({
          'POST /get-activities': (body: unknown) =>
            daysByDate[(body as { start_date: string }).start_date],
        })
      );
    });

    it('steps back a day, forward again, and never past today', async () => {
      const { user } = await renderLoadedDay();
      expect(screen.getByRole('button', { name: 'Next day' })).toBeDisabled();

      await user.click(screen.getByRole('button', { name: 'Previous day' }));

      expect(await screen.findByRole('button', { name: 'Workout, 1 hour' })).toBeInTheDocument();
      expect(screen.getByRole('region', { name: 'Yesterday summary' })).toBeInTheDocument();
      expect(api.post).toHaveBeenCalledWith('/get-activities', {
        username: 'alice',
        start_date: YESTERDAY_KEY,
        end_date: YESTERDAY_KEY,
      });

      await user.click(screen.getByRole('button', { name: 'Next day' }));

      expect(await screen.findByRole('button', { name: 'Sleep, 8 hours' })).toBeInTheDocument();
      expect(screen.getByRole('region', { name: 'Today summary' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Next day' })).toBeDisabled();
    });

    it('opens the day from a ?date= link and jumps back with "Today"', async () => {
      const { user } = renderDashboard('/?date=2026-05-10');

      expect(await screen.findByRole('button', { name: 'Reels, 2 hours' })).toBeInTheDocument();
      const summary = await screen.findByRole('region', { name: 'Sun, May 10 summary' });

      await user.click(within(summary).getByRole('button', { name: 'Today' }));

      expect(await screen.findByRole('button', { name: 'Sleep, 8 hours' })).toBeInTheDocument();
      expect(screen.getByRole('region', { name: 'Today summary' })).toBeInTheDocument();
    });

    it('jumps back to today when the Home tab is tapped again', async () => {
      const { user } = await renderLoadedDay();
      await user.click(screen.getByRole('button', { name: 'Previous day' }));
      await screen.findByRole('button', { name: 'Workout, 1 hour' });
      const requests = activityRequests().length;

      act(() => {
        window.dispatchEvent(new Event(TAB_RESELECT_EVENT));
        window.dispatchEvent(new CustomEvent(TAB_RESELECT_EVENT, { detail: { tab: 'analytics' } }));
      });
      await settle();
      expect(activityRequests()).toHaveLength(requests);

      act(() => {
        window.dispatchEvent(new CustomEvent(TAB_RESELECT_EVENT, { detail: { tab: 'home' } }));
      });

      expect(await screen.findByRole('button', { name: 'Sleep, 8 hours' })).toBeInTheDocument();
      expect(screen.getByRole('region', { name: 'Today summary' })).toBeInTheDocument();
    });

    it('ignores a Home tab reselect when already on today', async () => {
      await renderLoadedDay();
      const requests = activityRequests().length;

      act(() => {
        window.dispatchEvent(new CustomEvent(TAB_RESELECT_EVENT, { detail: { tab: 'home' } }));
      });
      await settle();

      expect(activityRequests()).toHaveLength(requests);
    });
  });
  describe('logging hours', () => {
    it('saves hours for a tile and updates the tile, summary and heat map', async () => {
      const { user } = await renderLoadedDay();

      await user.click(screen.getByRole('button', { name: 'Sleep, 8 hours' }));
      const dialog = screen.getByRole('dialog', { name: 'Log Sleep' });
      expect(hoursField()).toHaveValue('8');
      expect(screen.getByRole('button', { name: 'Pull to refresh' })).toBeDisabled();

      await user.clear(hoursField());
      expect(hoursField()).toHaveAccessibleDescription('21h 30m left to log for this day');
      await user.type(hoursField(), '7.5');
      await user.click(within(dialog).getByRole('button', { name: 'Save' }));

      expect(api.post).toHaveBeenCalledWith('/create-activity', {
        username: 'alice',
        activity: 'sleep',
        hours: 7.5,
        date: TODAY_KEY,
        note: null,
      });
      expect(await screen.findByText('Activity saved successfully')).toBeInTheDocument();
      expect(playActivitySound).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('dialog', { name: 'Log Sleep' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Sleep, 7.5 hours' })).toBeInTheDocument();
      expect(screen.getByRole('progressbar', { name: 'Hours logged' })).toHaveAttribute(
        'aria-valuenow',
        '10'
      );
      expect(useCompletionStore.getState().getMonthData('alice', 2026, 4)).toEqual({
        [TODAY_KEY]: 10,
      });
      expect(pullToRefresh()).toBeEnabled();
    });

    it('celebrates when the day reaches 24 hours', async () => {
      const { user } = await renderLoadedDay();

      await user.click(screen.getByRole('button', { name: 'Office, 0 hours' }));
      await user.type(hoursField(), '13.5');
      await user.click(screen.getByRole('button', { name: 'Save' }));

      expect(await screen.findByText('🎉 Day fully logged! Great job!')).toBeInTheDocument();
      expect(playCompletionSound).toHaveBeenCalledTimes(1);
      expect(playActivitySound).not.toHaveBeenCalled();
      expect(screen.getByRole('progressbar', { name: 'Hours logged' })).toHaveAttribute(
        'aria-valuetext',
        'Day complete'
      );
    });

    it('adds and removes notes', async () => {
      const { user } = await renderLoadedDay();

      await user.click(screen.getByRole('button', { name: 'Study, 2.5 hours, has note' }));
      expect(screen.getByRole('textbox', { name: /Note/ })).toHaveValue('Chapter 4');
      await user.clear(screen.getByRole('textbox', { name: /Note/ }));
      await user.click(screen.getByRole('button', { name: 'Save' }));

      expect(await screen.findByRole('button', { name: 'Study, 2.5 hours' })).toBeInTheDocument();
      expect(api.post).toHaveBeenLastCalledWith(
        '/create-activity',
        expect.objectContaining({ note: null })
      );

      await user.click(screen.getByRole('button', { name: 'Sleep, 8 hours' }));
      await user.type(screen.getByRole('textbox', { name: /Note/ }), 'Slept like a log');
      await user.click(screen.getByRole('button', { name: 'Save' }));

      expect(
        await screen.findByRole('button', { name: 'Sleep, 8 hours, has note' })
      ).toBeInTheDocument();
      expect(api.post).toHaveBeenLastCalledWith(
        '/create-activity',
        expect.objectContaining({ activity: 'sleep', note: 'Slept like a log' })
      );
    });

    it.each([
      [
        'rejects the entry',
        { success: false, error: 'Daily limit reached' },
        'Daily limit reached',
      ],
      ['is unreachable', new TypeError('Failed to fetch'), 'Failed to fetch'],
    ])('keeps the dialog open with an error when the API %s', async (_label, response, message) => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      routeApi(
        api,
        dashboardRoutes({ 'POST /get-activities': aliceDay, 'POST /create-activity': response })
      );
      const { user } = await renderLoadedDay();

      await user.click(screen.getByRole('button', { name: 'Sleep, 8 hours' }));
      await user.clear(hoursField());
      await user.type(hoursField(), '6');
      await user.click(screen.getByRole('button', { name: 'Save' }));

      const dialog = screen.getByRole('dialog', { name: 'Log Sleep' });
      expect(await within(dialog).findByRole('alert')).toHaveTextContent(message);
      expect(await screen.findByText('Failed to save activity')).toBeInTheDocument();
      expect(error).toHaveBeenCalledWith('[Dashboard] Failed to save activity', expect.any(Error));
      expect(screen.getByRole('button', { name: 'Sleep, 8 hours' })).toBeInTheDocument();

      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('dialog', { name: 'Log Sleep' })).not.toBeInTheDocument();
    });

    it('does not open a day that is in the future (device clock moved back)', async () => {
      const { user } = await renderLoadedDay();
      vi.setSystemTime(new Date(2026, 4, 14, 12));

      await user.click(screen.getByRole('button', { name: 'Sleep, 8 hours' }));

      expect(screen.queryByRole('dialog', { name: 'Log Sleep' })).not.toBeInTheDocument();
    });
  });

  describe('badges', () => {
    it('celebrates badges unlocked by the current streak', async () => {
      routeApi(
        api,
        dashboardRoutes({
          'POST /get-activities': aliceDay,
          'POST /get-streak': {
            success: true,
            data: { current: 7, longest: 7, new_badges: [makeBadge({ name: 'Week Warrior' })] },
          },
        })
      );
      const { user } = renderDashboard();

      const dialog = await screen.findByRole('dialog', { name: 'Badge unlocked!' });
      expect(dialog).toHaveTextContent('Week Warrior');
      expect(pullToRefresh()).toBeDisabled();

      await user.click(within(dialog).getByRole('button', { name: 'Awesome!' }));

      expect(screen.queryByRole('dialog', { name: 'Badge unlocked!' })).not.toBeInTheDocument();
    });

    it('can show the celebration on demand for testing confetti', async () => {
      await renderLoadedDay();

      act(() => void window.dispatchEvent(new Event('test-badge-unlock')));

      expect(screen.getByRole('dialog', { name: 'Badge unlocked!' })).toHaveTextContent(
        'First Step'
      );
    });
  });

  describe('stories', () => {
    const photo = makePhoto({ id: 5, user_id: ALICE.id });

    it('opens own stories and links "Your Story" back to the own profile', async () => {
      const { user } = await renderLoadedDay();
      const handlers = { onPhotoDeleted: vi.fn(), onPhotosViewed: vi.fn() };

      act(() => storyStubs.row!.onPhotoClick([photo], 0, 'Your Story', undefined, true, handlers));

      const viewer = screen.getByRole('dialog', { name: 'Your Story stories' });
      expect(pullToRefresh()).toBeDisabled();
      expect(storyStubs.viewer).toMatchObject({ isOwnStory: true, startIndex: 0 });

      await user.click(within(viewer).getByRole('button', { name: 'Mark stories viewed' }));
      await user.click(within(viewer).getByRole('button', { name: 'Delete story photo' }));
      expect(handlers.onPhotosViewed).toHaveBeenCalledWith([5]);
      expect(handlers.onPhotoDeleted).toHaveBeenCalledWith(5);

      await user.click(within(viewer).getByRole('button', { name: 'Open story profile' }));

      expect(screen.getByTestId('location')).toHaveTextContent('/user/alice');
    });

    it('opens a friend’s story and their profile', async () => {
      const { user } = await renderLoadedDay();

      act(() => storyStubs.row!.onPhotoClick([photo], 0, 'carol', 'https://cdn.test/carol.jpg'));

      const viewer = screen.getByRole('dialog', { name: 'carol stories' });
      expect(storyStubs.viewer).toMatchObject({
        isOwnStory: false,
        ownerProfilePic: 'https://cdn.test/carol.jpg',
      });
      // No per-story handlers were supplied; the callbacks are safe no-ops
      await user.click(within(viewer).getByRole('button', { name: 'Mark stories viewed' }));
      await user.click(within(viewer).getByRole('button', { name: 'Delete story photo' }));

      await user.click(within(viewer).getByRole('button', { name: 'Open story profile' }));

      expect(screen.getByTestId('location')).toHaveTextContent('/user/carol');
    });

    it('closes the story viewer', async () => {
      const { user } = await renderLoadedDay();
      act(() => storyStubs.row!.onPhotoClick([photo], 0, 'carol'));

      await user.click(screen.getByRole('button', { name: 'Close stories' }));

      expect(screen.queryByRole('dialog', { name: 'carol stories' })).not.toBeInTheDocument();
      expect(pullToRefresh()).toBeEnabled();
    });
  });
});
