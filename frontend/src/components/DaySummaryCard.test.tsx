import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api, commentApi, likeApi } from '../services/api';
import { useCompletionStore } from '../store';
import {
  createDeferred,
  dashboardRoutes,
  FIXED_TODAY,
  makeBadge,
  mockQuietSocial,
  routeApi,
  TODAY_KEY,
} from '../test/fixtures/dashboard';
import type { Comment } from '../types/comment';
import { DaySummaryCard } from './DaySummaryCard';

vi.mock('../services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/api')>()),
  api: { get: vi.fn(), post: vi.fn() },
  likeApi: { getLikes: vi.fn(), likeDay: vi.fn(), unlikeDay: vi.fn() },
  commentApi: { getCommentCount: vi.fn(), getComments: vi.fn() },
}));

// The theme store (store barrel) reads matchMedia when its module loads, before the shared
// setup stubs it for each test.
await vi.hoisted(async () => {
  const { createMatchMedia } = await import('../test/browser-mocks');
  vi.stubGlobal('matchMedia', createMatchMedia());
});

type Props = ComponentProps<typeof DaySummaryCard>;

function renderCard(props: Partial<Props> = {}) {
  const handlers = {
    onPrev: vi.fn(),
    onNext: vi.fn(),
    onDateChange: vi.fn(),
    onNewBadges: vi.fn(),
    onBadgesLoaded: vi.fn(),
    onCalendarOpenChange: vi.fn(),
  };
  const allProps: Props = {
    username: 'alice',
    currentDate: FIXED_TODAY,
    isNextDisabled: true,
    activities: { sleep: 8, study: 2.5, eating: 1.5 },
    ...handlers,
    ...props,
  };
  const view = render(<DaySummaryCard {...allProps} />, {
    wrapper: ({ children }) => <MemoryRouter>{children}</MemoryRouter>,
  });
  const rerender = (next: Partial<Props>) =>
    view.rerender(<DaySummaryCard {...allProps} {...next} />);
  return { user: userEvent.setup(), ...view, ...handlers, rerender };
}

/** Renders the card and waits for streak and badges to load. */
async function renderLoadedCard(props: Partial<Props> = {}) {
  const view = renderCard(props);
  await screen.findByRole('region', { name: /summary$/ });
  return view;
}

const progress = () => screen.getByRole('progressbar', { name: 'Hours logged' });
const chip = (label: string) => screen.getByText(label).parentElement!;

function makeComment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: 1,
    day_owner_id: 1,
    day_date: TODAY_KEY,
    author_id: 3,
    author_username: 'carol',
    author_verified: false,
    body: 'Nice day!',
    like_count: 0,
    reply_count: 0,
    is_deleted: false,
    is_edited: false,
    liked_by_me: false,
    mentions: [],
    created_at: '2026-05-15T10:00:00.000Z',
    ...overrides,
  };
}

describe('DaySummaryCard', () => {
  beforeEach(() => {
    vi.setSystemTime(FIXED_TODAY);
    // Overlay history logs its steps with console.debug in development builds
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    routeApi(api, dashboardRoutes());
    mockQuietSocial({ likeApi, commentApi });
  });

  describe('loading', () => {
    it('shows a busy skeleton until the streak and badges load', async () => {
      const streak = createDeferred<unknown>();
      routeApi(api, dashboardRoutes({ 'POST /get-streak': () => streak.promise }));
      renderCard();

      expect(screen.getByLabelText('Loading day')).toHaveAttribute('aria-busy', 'true');

      streak.resolve({ success: true, data: { current: 1, longest: 2 } });
      expect(await screen.findByRole('region', { name: 'Today summary' })).toBeInTheDocument();
      expect(screen.queryByLabelText('Loading day')).not.toBeInTheDocument();
    });

    it('stays in the skeleton while the day itself is loading', async () => {
      renderCard({ loading: true });

      await waitFor(() => expect(api.post).toHaveBeenCalledWith('/badges/user', expect.anything()));
      expect(screen.getByLabelText('Loading day')).toBeInTheDocument();
    });
  });

  describe('totals', () => {
    it('adds up the hours logged and shows the share of the day', async () => {
      await renderLoadedCard();

      expect(screen.getByRole('region', { name: 'Today summary' })).toHaveTextContent('12/24h');
      expect(progress()).toHaveAttribute('aria-valuenow', '12');
      expect(progress()).toHaveAttribute('aria-valuetext', '12 of 24 hours logged');
      expect(progress().firstElementChild).toHaveStyle({ width: '50%' });
    });

    it('avoids floating point noise in the total', async () => {
      await renderLoadedCard({ activities: { reels: 0.1, rest: 0.2 } });

      expect(progress()).toHaveAttribute('aria-valuenow', '0.3');
      expect(screen.getByText('0.3')).toBeInTheDocument();
    });

    it('starts an empty day at zero', async () => {
      await renderLoadedCard({ activities: {} });

      expect(progress()).toHaveAttribute('aria-valuetext', '0 of 24 hours logged');
      expect(progress().firstElementChild).toHaveStyle({ width: '0%' });
    });

    it.each([
      [24, '24'],
      [25.5, '25.5'],
    ])('marks the day complete at %s hours and caps the bar', async (hours, shown) => {
      await renderLoadedCard({ activities: { sleep: hours } });

      expect(progress()).toHaveAttribute('aria-valuetext', 'Day complete');
      expect(progress()).toHaveAttribute('aria-valuenow', '24');
      expect(progress().firstElementChild).toHaveStyle({ width: '100%' });
      expect(screen.getByText(shown)).toBeInTheDocument();
    });
  });

  describe('date navigation', () => {
    it('moves between days and disables Next on today', async () => {
      const { user, onPrev, onNext } = await renderLoadedCard();

      expect(screen.getByRole('button', { name: 'Next day' })).toBeDisabled();
      expect(screen.queryByRole('button', { name: 'Today' })).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Previous day' }));
      expect(onPrev).toHaveBeenCalledTimes(1);
      expect(onNext).not.toHaveBeenCalled();
    });

    it('names yesterday and lets the user jump back to today', async () => {
      const { user, onNext, onDateChange } = await renderLoadedCard({
        currentDate: new Date(2026, 4, 14, 12),
        isNextDisabled: false,
      });

      expect(screen.getByRole('region', { name: 'Yesterday summary' })).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Next day' }));
      expect(onNext).toHaveBeenCalledTimes(1);

      await user.click(screen.getByRole('button', { name: 'Today' }));
      expect(onDateChange).toHaveBeenCalledWith(FIXED_TODAY);
    });

    it('shows the weekday and date for older days', async () => {
      await renderLoadedCard({ currentDate: new Date(2026, 4, 13, 12), isNextDisabled: false });

      expect(screen.getByRole('button', { name: 'Wed, May 13, open calendar' })).toHaveAttribute(
        'aria-haspopup',
        'dialog'
      );
    });
  });

  describe('streak and badges', () => {
    it('shows the current streak on today and the best streak always', async () => {
      const { rerender } = await renderLoadedCard();

      expect(api.post).toHaveBeenCalledWith('/get-streak', { username: 'alice', date: TODAY_KEY });
      expect(chip('day streak')).toHaveTextContent('3day streak');
      expect(chip('best')).toHaveTextContent('7best');

      rerender({ currentDate: new Date(2026, 4, 10, 12) });
      expect(screen.queryByText('day streak')).not.toBeInTheDocument();
      expect(chip('best')).toHaveTextContent('7best');
    });

    it.each([
      ['answers without data', { success: false }],
      ['fails', new Error('offline')],
    ])('shows zero streaks when the streak request %s', async (_label, response) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      routeApi(api, dashboardRoutes({ 'POST /get-streak': response }));
      await renderLoadedCard();

      expect(chip('day streak')).toHaveTextContent('0day streak');
      expect(chip('best')).toHaveTextContent('0best');
    });

    it('celebrates badges unlocked by the streak', async () => {
      const unlocked = [makeBadge({ key: 'week', name: 'Week Warrior', threshold: 7 })];
      routeApi(
        api,
        dashboardRoutes({
          'POST /get-streak': {
            success: true,
            data: { current: 7, longest: 7, new_badges: unlocked },
          },
        })
      );
      const { onNewBadges } = await renderLoadedCard();

      expect(onNewBadges).toHaveBeenCalledWith(unlocked);
    });

    it('does not celebrate when nothing new was unlocked', async () => {
      routeApi(
        api,
        dashboardRoutes({
          'POST /get-streak': { success: true, data: { current: 2, longest: 7, new_badges: [] } },
        })
      );
      const { onNewBadges } = await renderLoadedCard();

      expect(onNewBadges).not.toHaveBeenCalled();
    });

    it('shows the highest earned badge whatever the order', async () => {
      const badges = [
        makeBadge(),
        makeBadge({ key: 'week', name: 'Week Warrior', icon: 'Flame', threshold: 7 }),
        makeBadge({ key: 'three', name: 'Hat Trick', threshold: 3 }),
        makeBadge({ key: 'month', name: 'Monthly Master', threshold: 30, earned: false }),
      ];
      routeApi(api, dashboardRoutes({ 'POST /badges/user': { success: true, badges } }));
      const { onBadgesLoaded } = await renderLoadedCard();

      expect(api.post).toHaveBeenCalledWith('/badges/user', { username: 'alice' });
      expect(screen.getByTitle('Current badge: Week Warrior')).toHaveTextContent('Week Warrior');
      expect(screen.queryByText('Hat Trick')).not.toBeInTheDocument();
      expect(screen.queryByText('Monthly Master')).not.toBeInTheDocument();
      expect(onBadgesLoaded).toHaveBeenCalledWith(badges);
    });

    it('still renders when badges cannot be loaded', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      routeApi(api, dashboardRoutes({ 'POST /badges/user': new Error('offline') }));
      const { onBadgesLoaded } = await renderLoadedCard();

      expect(screen.queryByTitle(/Current badge/)).not.toBeInTheDocument();
      expect(onBadgesLoaded).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith('Failed to fetch badges:', expect.any(Error));
    });

    it('works without the optional callbacks', async () => {
      routeApi(
        api,
        dashboardRoutes({
          'POST /get-streak': {
            success: true,
            data: { current: 1, longest: 1, new_badges: [makeBadge()] },
          },
          'POST /badges/user': { success: true, badges: [makeBadge()] },
        })
      );
      await renderLoadedCard({
        onNewBadges: undefined,
        onBadgesLoaded: undefined,
        onCalendarOpenChange: undefined,
      });

      expect(screen.getByTitle('Current badge: First Step')).toBeInTheDocument();
    });

    it('reloads streak and badges for another user', async () => {
      const { rerender } = await renderLoadedCard();

      rerender({ username: 'bob' });

      await screen.findByRole('region', { name: 'Today summary' });
      expect(api.post).toHaveBeenCalledWith('/get-streak', { username: 'bob', date: TODAY_KEY });
      expect(api.post).toHaveBeenCalledWith('/badges/user', { username: 'bob' });
    });
  });

  describe('calendar', () => {
    const dayLabel = (date: Date) =>
      new Intl.DateTimeFormat(undefined, {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      }).format(date);

    it('opens a heat-map calendar for the month and picks a day', async () => {
      useCompletionStore.setState({ monthlyData: { 'alice:2026-05': { '2026-05-10': 12 } } });
      const { user, onDateChange, onCalendarOpenChange } = await renderLoadedCard();
      expect(onCalendarOpenChange).toHaveBeenLastCalledWith(false);

      await user.click(screen.getByRole('button', { name: 'Today, open calendar' }));

      const calendar = screen.getByRole('dialog', { name: 'Choose a date' });
      expect(onCalendarOpenChange).toHaveBeenLastCalledWith(true);
      expect(
        within(calendar).getByRole('button', {
          name: `${dayLabel(new Date(2026, 4, 10))}, 12/24 hours logged`,
        })
      ).toBeInTheDocument();

      await user.click(
        within(calendar).getByRole('button', { name: dayLabel(new Date(2026, 4, 12)) })
      );

      expect(onDateChange).toHaveBeenCalledWith(new Date(2026, 4, 12));
      await waitFor(() => expect(onCalendarOpenChange).toHaveBeenLastCalledWith(false));
      expect(screen.queryByRole('dialog', { name: 'Choose a date' })).not.toBeInTheDocument();
    });

    it('reports when the calendar is closed with Escape', async () => {
      const { user, onCalendarOpenChange } = await renderLoadedCard();
      await user.click(screen.getByRole('button', { name: 'Today, open calendar' }));

      await user.keyboard('{Escape}');

      await waitFor(() => expect(onCalendarOpenChange).toHaveBeenLastCalledWith(false));
      expect(screen.queryByRole('dialog', { name: 'Choose a date' })).not.toBeInTheDocument();
    });

    it('loads completion data for each month viewed', async () => {
      const { user } = await renderLoadedCard();

      await user.click(screen.getByRole('button', { name: 'Today, open calendar' }));
      await waitFor(() =>
        expect(api.post).toHaveBeenCalledWith('/get-daily-totals', {
          username: 'alice',
          start_date: '2026-05-01',
          end_date: '2026-05-31',
        })
      );

      await user.click(screen.getByRole('button', { name: 'Previous month' }));
      await waitFor(() =>
        expect(api.post).toHaveBeenCalledWith('/get-daily-totals', {
          username: 'alice',
          start_date: '2026-04-01',
          end_date: '2026-04-30',
        })
      );
    });

    it('skips the heat map without a username', async () => {
      const { user } = await renderLoadedCard({ username: '' });

      await user.click(screen.getByRole('button', { name: 'Today, open calendar' }));

      expect(screen.getByRole('dialog', { name: 'Choose a date' })).toBeInTheDocument();
      expect(api.post).not.toHaveBeenCalledWith('/get-daily-totals', expect.anything());
    });
  });

  describe('likes and comments', () => {
    it('shows the day’s likes and lets the user like it', async () => {
      vi.mocked(likeApi.getLikes).mockResolvedValue({
        success: true,
        data: [],
        count: 3,
        user_has_liked: false,
      });
      vi.mocked(likeApi.likeDay).mockResolvedValue({ success: true, liked: true, new_count: 4 });
      const { user } = await renderLoadedCard();

      expect(await screen.findByRole('button', { name: 'See 3 likes' })).toBeInTheDocument();
      expect(likeApi.getLikes).toHaveBeenCalledWith('alice', TODAY_KEY);

      await user.click(screen.getByRole('button', { name: 'Like this day' }));

      expect(likeApi.likeDay).toHaveBeenCalledWith('alice', TODAY_KEY);
      expect(await screen.findByRole('button', { name: 'Unlike this day' })).toHaveAttribute(
        'aria-pressed',
        'true'
      );
      expect(screen.getByRole('button', { name: 'See 4 likes' })).toBeInTheDocument();
    });

    it('opens the comments and refreshes the previews when they close', async () => {
      vi.mocked(commentApi.getCommentCount).mockResolvedValue({ success: true, count: 2 });
      const { user } = await renderLoadedCard();

      await user.click(await screen.findByRole('button', { name: '2 comments' }));
      const sheet = await screen.findByRole('dialog', { name: 'Comments' });
      expect(commentApi.getComments).toHaveBeenCalledWith('alice', TODAY_KEY, 'top', undefined, 2);
      const previewLoads = () =>
        vi.mocked(commentApi.getComments).mock.calls.filter((call) => call[4] === 2).length;
      const before = previewLoads();

      await user.click(within(sheet).getByRole('button', { name: 'Close comments' }));

      await waitFor(() => expect(previewLoads()).toBe(before + 1));
    });

    it('opens the comments from a comment preview', async () => {
      vi.mocked(commentApi.getComments).mockImplementation(async (...args) => ({
        success: true,
        comments: args[4] === 2 ? [makeComment()] : [],
        has_more: false,
      }));
      const { user } = await renderLoadedCard();

      await user.click(await screen.findByRole('button', { name: 'Comment by carol: Nice day!' }));

      expect(await screen.findByRole('dialog', { name: 'Comments' })).toBeInTheDocument();
    });
  });
});
