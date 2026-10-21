import { act, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { STORAGE_KEYS } from '../../constants/storage';
import { ApiError } from '../../services/api';
import { useAuthStore } from '../../store/useAuthStore';
import { deferred, weekAnalytics } from '../../test/fixtures/settings';
import { renderWithRouter, signIn } from '../../test/utils';
import type { CustomTile } from '../../types';
import { AnalyticsPage } from './index';

const { api, userApi } = vi.hoisted(() => ({
  api: {
    get: vi.fn<(endpoint: string) => Promise<unknown>>(),
    post: vi.fn<(endpoint: string, body?: unknown) => Promise<unknown>>(),
    getWeekAnalytics: vi.fn<(username: string, weekStart: string) => Promise<unknown>>(),
  },
  userApi: {
    autocomplete:
      vi.fn<(query: string, limit?: number, signal?: AbortSignal) => Promise<unknown>>(),
  },
}));

vi.mock('../../services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/api')>()),
  api,
  userApi,
}));

// "Today" is Wednesday 12 March 2025, so this week runs Mon 10 – Sun 16 March
const TODAY = new Date(2025, 2, 12, 10, 0, 0);
const THIS_WEEK = '2025-03-10';
const LAST_WEEK = '2025-03-03';

const parseApiDate = (value: string) => {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
};

/** Mon 8h (sleep 5, study 2, workout 1), Tue 4h (sleep 3, study 1), Wed 3h (study 2, workout 1) */
const thisWeek = (overrides = {}) =>
  weekAnalytics(
    parseApiDate(THIS_WEEK),
    [
      { sleep: 5, study: 2, workout: 1 },
      { sleep: 3, study: 1 },
      { study: 2, workout: 1 },
    ],
    {
      percentage_change: 25,
      streak: { current: 3, longest: 7, longest_start: '2025-03-03', longest_end: '2025-03-09' },
      ...overrides,
    }
  );

/** Mon 2h of sleep, Sun 4h with family */
const lastWeek = () =>
  weekAnalytics(parseApiDate(LAST_WEEK), [{ sleep: 2 }, {}, {}, {}, {}, {}, { family: 4 }], {
    is_current_week: false,
    percentage_change: 10,
    percentage_vs_current: -40,
    streak: { current: 0, longest: 7 },
  });

const emptyWeek = (weekStart: string) =>
  weekAnalytics(parseApiDate(weekStart), [], { is_current_week: weekStart === THIS_WEEK });

interface Backend {
  weeks?: Record<string, unknown>;
  verified?: string[];
  ownTiles?: unknown;
  otherTiles?: unknown;
}

/** Answers the page's requests like the backend would */
function serve({ weeks = {}, verified = [], ownTiles, otherTiles }: Backend = {}) {
  const allWeeks: Record<string, unknown> = {
    [THIS_WEEK]: thisWeek(),
    [LAST_WEEK]: lastWeek(),
    ...weeks,
  };
  // An Error fails the request
  const answer = (value: unknown) => {
    if (value instanceof Error) throw value;
    return value;
  };
  api.getWeekAnalytics.mockImplementation(async (_username, weekStart) =>
    answer(allWeeks[weekStart] ?? emptyWeek(weekStart))
  );
  api.get.mockImplementation(async (endpoint) => {
    if (endpoint === '/tile-config') return answer(ownTiles ?? { success: true, data: {} });
    throw new Error(`Unexpected GET ${endpoint}`);
  });
  api.post.mockImplementation(async (endpoint, body) => {
    const { username } = body as { username: string };
    if (endpoint === '/users') {
      return {
        success: true,
        data: [
          { username: `${username}_fan`, is_verified: true },
          { username, is_verified: verified.includes(username) },
        ],
      };
    }
    if (endpoint === '/tile-config/user') return answer(otherTiles ?? { success: true, data: {} });
    throw new Error(`Unexpected POST ${endpoint}`);
  });
}

function renderInsights(route = '/analytics', path = '/analytics') {
  return renderWithRouter(<AnalyticsPage />, { route, path });
}

/** Renders and waits until the week has loaded */
async function renderLoaded(route?: string, path?: string) {
  const view = renderInsights(route, path);
  await screen.findByRole('region', { name: 'Activity breakdown' });
  return view;
}

const weekSummary = () => screen.getByRole('region', { name: 'Week summary' });
const chart = () => screen.getByRole('region', { name: 'Weekly overview' });
const breakdown = () => screen.getByRole('region', { name: 'Activity breakdown' });
const filterButton = () => screen.getByRole('button', { name: /^Filter chart:/ });
const switcher = () => screen.getByRole('button', { name: /insights/i });
const dayTrack = (title: string) => within(chart()).getByTitle(title);
const barHeight = (title: string) =>
  (dayTrack(title).firstElementChild as HTMLElement).style.height;
const statText = (label: string) => within(weekSummary()).getByText(label).closest('div');
/** The color an activity's breakdown row is drawn in */
const rowColor = (label: string) =>
  (within(breakdown()).getByText(label).closest('li') as HTMLElement).style.getPropertyValue(
    '--row-color'
  );
const location = () => screen.getByTestId('location');

describe('AnalyticsPage (Insights)', () => {
  beforeEach(() => {
    api.get.mockReset();
    api.post.mockReset();
    api.getWeekAnalytics.mockReset();
    userApi.autocomplete.mockReset();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(TODAY);
    signIn({ id: 1, username: 'testuser' });
    serve();
  });

  it('sends signed-out visitors to the login screen', () => {
    act(() => useAuthStore.setState({ user: null, isAuthenticated: false }));

    renderInsights();

    expect(location()).toHaveTextContent('/login');
    expect(api.getWeekAnalytics).not.toHaveBeenCalled();
  });

  describe('your insights this week', () => {
    it('shows skeletons while the week loads', async () => {
      const request = deferred<unknown>();
      api.getWeekAnalytics.mockReturnValue(request.promise);
      const { container } = renderInsights();

      expect(container.querySelector('[aria-busy="true"]')).toBeInTheDocument();
      expect(screen.queryByRole('region', { name: 'Weekly overview' })).not.toBeInTheDocument();
      expect(within(weekSummary()).getByText('Mar 10 – 16, 2025')).toBeInTheDocument();

      request.resolve(thisWeek());

      expect(await screen.findByRole('region', { name: 'Weekly overview' })).toBeInTheDocument();
      expect(container.querySelector('[aria-busy="false"]')).toBeInTheDocument();
    });

    it('loads the current week for the signed-in user', async () => {
      await renderLoaded();

      expect(api.getWeekAnalytics).toHaveBeenCalledWith('testuser', THIS_WEEK);
      expect(screen.getByRole('heading', { level: 1, name: 'Insights' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Go back' })).not.toBeInTheDocument();
      expect(switcher()).toHaveAccessibleName(/^Your insights\s*testuser\s*Switch$/);
      expect(within(weekSummary()).getByText('This week')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Next week' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Previous week' })).toBeEnabled();
    });

    it('summarises the hours, the trend and the streaks', async () => {
      await renderLoaded();

      expect(statText('Logged this week')).toHaveTextContent(/^15\.0h\s*Logged this week$/);
      expect(within(weekSummary()).getByText('vs last week').parentElement).toHaveTextContent(
        /^\+25%\s*vs last week$/
      );
      expect(statText('Current streak')).toHaveTextContent(/^3\s*days\s*Current streak$/);
      expect(statText('Best streak')).toHaveTextContent(/^7\s*days\s*Best streak\s*Mar 3 – 9$/);
    });

    it.each([
      ['a single day', '2025-03-12', '2025-03-12', 'Mar 12'],
      ['days in one month', '2025-03-03', '2025-03-09', 'Mar 3 – 9'],
      ['a month boundary', '2025-02-27', '2025-03-04', 'Feb 27 – Mar 4'],
      ['the same month of different years', '2024-03-30', '2025-03-02', 'Mar 30 – Mar 2'],
      ['timestamps', '2025-03-03T00:00:00Z', '2025-03-05T23:00:00Z', 'Mar 3 – 5'],
      ['other parseable dates', '2025/03/03', '2025/03/04', 'Mar 3 – 4'],
    ])('shows the best streak range for %s as calendar dates', async (_label, start, end, text) => {
      serve({
        weeks: {
          [THIS_WEEK]: thisWeek({
            streak: { current: 1, longest: 1, longest_start: start, longest_end: end },
          }),
        },
      });
      await renderLoaded();

      expect(statText('Best streak')).toHaveTextContent(
        new RegExp(`^1\\s*day\\s*Best streak\\s*${text}$`)
      );
      expect(statText('Current streak')).toHaveTextContent(/^1\s*day\s*Current streak$/);
    });

    it.each([
      ['missing', {}],
      ['unreadable', { longest_start: 'soon', longest_end: '2025-03-09' }],
    ])('leaves out the best streak range when the dates are %s', async (_label, dates) => {
      serve({ weeks: { [THIS_WEEK]: thisWeek({ streak: { current: 0, longest: 7, ...dates } }) } });
      await renderLoaded();

      expect(statText('Best streak')).toHaveTextContent(/^7\s*days\s*Best streak$/);
    });

    it('reads streak dates as calendar days west of UTC too', async () => {
      const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      vi.stubEnv('TZ', 'America/Los_Angeles');
      // Removing TZ again does not reset Node's cached zone, so set the original back
      onTestFinished(() => {
        vi.stubEnv('TZ', localZone);
      });
      vi.setSystemTime(new Date(2025, 2, 12, 10, 0, 0));
      // Parsed as UTC, the API date would land on the previous local day here
      expect(new Date('2025-03-03').getDate()).toBe(2);
      await renderLoaded();

      expect(statText('Best streak')).toHaveTextContent(/Best streak\s*Mar 3 – 9$/);
      expect(within(chart()).getByText('Wednesday (today): 3.0 hours')).toBeInTheDocument();
    });

    it.each([
      ['a drop', { percentage_change: -12.6 }, /^-13%\s*vs last week$/],
      ['no change', { percentage_change: 0 }, /^0%\s*vs last week$/],
      [
        'a missing comparison',
        { percentage_change: undefined, is_current_week: undefined },
        /^0%\s*vs last week$/,
      ],
    ])('shows %s against last week', async (_label, overrides, trend) => {
      serve({ weeks: { [THIS_WEEK]: { ...thisWeek(), ...overrides } } });
      await renderLoaded();

      expect(within(weekSummary()).getByText('vs last week').parentElement).toHaveTextContent(
        trend
      );
    });

    it('draws each weekday, marks today and scales the bars to the busiest day', async () => {
      await renderLoaded();

      expect(
        within(chart())
          .getAllByText(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/)
          .map((label) => label.textContent)
      ).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
      expect(within(chart()).getByText('Wednesday (today): 3.0 hours')).toBeInTheDocument();
      expect(within(chart()).getByText('Thursday: nothing logged')).toBeInTheDocument();

      // The busiest day (8h) sets an 8h scale, so it fills the chart
      ['8h', '6h', '4h', '2h', '0h'].forEach((tick) =>
        expect(within(chart()).getByText(tick)).toBeInTheDocument()
      );
      await waitFor(() => expect(barHeight('Monday: 8.0h')).toBe('100%'));
      expect(barHeight('Tuesday: 4.0h')).toBe('50%');
      expect(barHeight('Wednesday: 3.0h')).toBe('37.5%');
    });

    it('averages over the days elapsed so far this week', async () => {
      await renderLoaded();

      // 15 hours over Monday–Wednesday
      expect(within(chart()).getByText('Daily average: 5.0 hours')).toBeInTheDocument();
    });

    it('treats Sunday as the last day of the current week', async () => {
      vi.setSystemTime(new Date(2025, 2, 16, 20, 0, 0));
      await renderLoaded();

      expect(api.getWeekAnalytics).toHaveBeenCalledWith('testuser', THIS_WEEK);
      expect(within(weekSummary()).getByText('This week')).toBeInTheDocument();
      expect(within(chart()).getByText('Sunday (today): nothing logged')).toBeInTheDocument();
      // All seven days have passed: 15h / 7
      expect(within(chart()).getByText('Daily average: 2.1 hours')).toBeInTheDocument();
    });

    it('ranks activities by hours and can flip the order', async () => {
      const { user } = await renderLoaded();
      const rows = () =>
        within(breakdown())
          .getAllByRole('listitem')
          .map((row) => row.textContent);

      expect(rows()).toEqual(['Sleep53%8.0h', 'Study33%5.0h', 'Workout13%2.0h']);
      expect(screen.getByRole('button', { name: 'Most' })).toHaveAttribute('aria-pressed', 'true');

      await user.click(screen.getByRole('button', { name: 'Least' }));
      expect(rows()).toEqual(['Workout13%2.0h', 'Study33%5.0h', 'Sleep53%8.0h']);
      expect(screen.getByRole('button', { name: 'Least' })).toHaveAttribute('aria-pressed', 'true');

      await user.click(screen.getByRole('button', { name: 'Most' }));
      expect(rows()[0]).toBe('Sleep53%8.0h');
    });

    it('hides the sort control when there is only one activity', async () => {
      serve({ weeks: { [THIS_WEEK]: weekAnalytics(parseApiDate(THIS_WEEK), [{ sleep: 7 }]) } });
      await renderLoaded();

      expect(within(breakdown()).getAllByRole('listitem')).toHaveLength(1);
      expect(screen.queryByRole('group', { name: 'Sort activities' })).not.toBeInTheDocument();
    });

    it('invites you to log something when the week is empty', async () => {
      serve({ weeks: { [THIS_WEEK]: emptyWeek(THIS_WEEK) } });
      const { user } = await renderLoaded();

      expect(
        within(breakdown()).getByRole('heading', { name: 'Nothing logged this week' })
      ).toBeInTheDocument();
      expect(
        within(breakdown()).getByText('Activities you log on your dashboard will show up here.')
      ).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^Filter chart/ })).not.toBeInTheDocument();
      expect(within(chart()).queryByText(/Daily average/)).not.toBeInTheDocument();
      // An empty week still gets a readable 2-hour scale
      ['2h', '1.5h', '1h', '0.5h', '0h'].forEach((tick) =>
        expect(within(chart()).getByText(tick)).toBeInTheDocument()
      );

      await user.click(screen.getByRole('button', { name: 'Log an activity' }));
      expect(location()).toHaveTextContent(/^\/$/);
    });
  });

  describe('week navigation', () => {
    it('steps back to last week and forward again', async () => {
      const { user } = await renderLoaded();

      await user.click(screen.getByRole('button', { name: 'Previous week' }));

      expect(await within(weekSummary()).findByText('Logged that week')).toBeInTheDocument();
      expect(api.getWeekAnalytics).toHaveBeenLastCalledWith('testuser', LAST_WEEK);
      expect(within(weekSummary()).getByText('Mar 3 – 9, 2025')).toBeInTheDocument();
      expect(within(weekSummary()).getByText('Last week')).toBeInTheDocument();
      expect(within(weekSummary()).getByText('vs this week').parentElement).toHaveTextContent(
        /^-40%\s*vs this week$/
      );
      // A past week is averaged over all seven days: 6h / 7
      expect(within(chart()).getByText('Daily average: 0.9 hours')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Next week' })).toBeEnabled();

      await user.click(screen.getByRole('button', { name: 'Next week' }));

      expect(await within(weekSummary()).findByText('Logged this week')).toBeInTheDocument();
      expect(within(weekSummary()).getByText('Mar 10 – 16, 2025')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Next week' })).toBeDisabled();
    });

    it('labels older weeks and ranges that span two months', async () => {
      const { user } = await renderLoaded();
      const previous = screen.getByRole('button', { name: 'Previous week' });

      await user.click(previous);
      await user.click(previous);
      expect(await within(weekSummary()).findByText('Feb 24 – Mar 2, 2025')).toBeInTheDocument();
      expect(within(weekSummary()).getByText('2 weeks ago')).toBeInTheDocument();

      await user.click(previous);
      expect(await within(weekSummary()).findByText('Feb 17 – 23, 2025')).toBeInTheDocument();
      expect(within(weekSummary()).getByText('3 weeks ago')).toBeInTheDocument();
      expect(api.getWeekAnalytics).toHaveBeenLastCalledWith('testuser', '2025-02-17');
    });

    it('says when nothing was logged in a past week, without the log action', async () => {
      const { user } = await renderLoaded();

      await user.click(screen.getByRole('button', { name: 'Previous week' }));
      await user.click(screen.getByRole('button', { name: 'Previous week' }));

      expect(
        await within(breakdown()).findByRole('heading', { name: 'Nothing logged that week' })
      ).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Log an activity' })).not.toBeInTheDocument();
    });

    it('ignores a slow response for a week the user already left', async () => {
      const slowThisWeek = deferred<unknown>();
      api.getWeekAnalytics.mockImplementation(async (_username, weekStart) =>
        weekStart === THIS_WEEK ? slowThisWeek.promise : lastWeek()
      );
      const { user } = renderInsights();

      await user.click(screen.getByRole('button', { name: 'Previous week' }));
      expect(await within(weekSummary()).findByText('Logged that week')).toBeInTheDocument();

      await act(async () => slowThisWeek.resolve(thisWeek()));

      expect(within(weekSummary()).getByText('Mar 3 – 9, 2025')).toBeInTheDocument();
      expect(within(weekSummary()).getByText('Logged that week')).toBeInTheDocument();
    });

    it('ignores a late failure for a week the user already left', async () => {
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
      const slowThisWeek = deferred<unknown>();
      api.getWeekAnalytics.mockImplementation(async (_username, weekStart) =>
        weekStart === THIS_WEEK ? slowThisWeek.promise : lastWeek()
      );
      const { user } = renderInsights();

      await user.click(screen.getByRole('button', { name: 'Previous week' }));
      await within(weekSummary()).findByText('Logged that week');

      await act(async () => slowThisWeek.reject(new TypeError('Failed to fetch')));

      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(errorLog).not.toHaveBeenCalled();
    });
  });

  describe('activity filter', () => {
    it('limits the chart to the chosen activities', async () => {
      const { user } = await renderLoaded();
      expect(filterButton()).toHaveAttribute('aria-expanded', 'false');

      await user.click(filterButton());

      const menu = screen.getByRole('group', { name: 'Activities shown in the chart' });
      expect(filterButton()).toHaveAttribute('aria-expanded', 'true');
      expect(filterButton()).toHaveAttribute('aria-controls', menu.id);
      expect(within(menu).getByRole('button', { name: 'All activities' })).toHaveAttribute(
        'aria-pressed',
        'true'
      );

      await user.click(within(menu).getByRole('button', { name: 'Sleep' }));

      expect(within(menu).getByRole('button', { name: 'Sleep' })).toHaveAttribute(
        'aria-pressed',
        'true'
      );
      expect(filterButton()).toHaveAccessibleName('Filter chart: Sleep');
      expect(within(chart()).getByText('Monday: 5.0 hours')).toBeInTheDocument();
      expect(within(chart()).getByText('Wednesday (today): nothing logged')).toBeInTheDocument();
      expect(within(dayTrack('Monday: 5.0h')).queryByTitle('Study: 2.0h')).not.toBeInTheDocument();
      expect(within(chart()).getByText('Daily average: 2.7 hours')).toBeInTheDocument();

      await user.click(within(menu).getByRole('button', { name: 'Workout' }));

      expect(filterButton()).toHaveAccessibleName('Filter chart: 2 activities');
      expect(within(chart()).getByText('Monday: 6.0 hours')).toBeInTheDocument();
      expect(within(chart()).getByText('Wednesday (today): 1.0 hours')).toBeInTheDocument();
      // The breakdown keeps listing every activity
      expect(within(breakdown()).getAllByRole('listitem')).toHaveLength(3);

      await user.click(within(menu).getByRole('button', { name: 'Clear selection (2)' }));

      expect(filterButton()).toHaveAccessibleName('Filter chart: All activities');
      expect(within(chart()).getByText('Monday: 8.0 hours')).toBeInTheDocument();
    });

    it('rescales the chart to the filtered hours', async () => {
      const { user } = await renderLoaded();

      await user.click(filterButton());
      await user.click(screen.getByRole('button', { name: 'Workout' }));

      // At most 1h of workout a day fits a 2h scale
      ['2h', '1.5h', '1h', '0.5h', '0h'].forEach((tick) =>
        expect(within(chart()).getByText(tick)).toBeInTheDocument()
      );
      await waitFor(() => expect(barHeight('Monday: 1.0h')).toBe('50%'));
    });

    it('turns an activity off again and goes back to everything from "All activities"', async () => {
      const { user } = await renderLoaded();
      await user.click(filterButton());
      const menu = screen.getByRole('group', { name: 'Activities shown in the chart' });

      await user.click(within(menu).getByRole('button', { name: 'Study' }));
      await user.click(within(menu).getByRole('button', { name: 'Sleep' }));
      await user.click(within(menu).getByRole('button', { name: 'Study' }));
      expect(filterButton()).toHaveAccessibleName('Filter chart: Sleep');

      await user.click(within(menu).getByRole('button', { name: 'All activities' }));
      expect(filterButton()).toHaveAccessibleName('Filter chart: All activities');
      expect(
        within(menu).queryByRole('button', { name: /Clear selection/ })
      ).not.toBeInTheDocument();
    });

    it('can be used with the keyboard and returns focus on Escape', async () => {
      const { user } = await renderLoaded();

      filterButton().focus();
      await user.keyboard('{Enter}');
      expect(filterButton()).toHaveAttribute('aria-expanded', 'true');

      await user.tab();
      expect(screen.getByRole('button', { name: 'All activities' })).toHaveFocus();
      await user.tab();
      expect(screen.getByRole('button', { name: 'Sleep' })).toHaveFocus();
      await user.keyboard(' ');
      expect(screen.getByRole('button', { name: 'Sleep' })).toHaveAttribute('aria-pressed', 'true');

      await user.keyboard('{Escape}');

      expect(filterButton()).toHaveAttribute('aria-expanded', 'false');
      expect(filterButton()).toHaveFocus();
      expect(filterButton()).toHaveAccessibleName('Filter chart: Sleep');
    });

    it('closes when focus leaves the menu', async () => {
      const { user } = await renderLoaded();
      await user.click(filterButton());

      screen.getByRole('button', { name: 'Workout' }).focus();
      await user.tab();

      expect(filterButton()).toHaveAttribute('aria-expanded', 'false');
      expect(screen.getByRole('button', { name: 'Most' })).toHaveFocus();
    });

    it('closes when the user clicks elsewhere', async () => {
      const { user } = await renderLoaded();
      await user.click(filterButton());

      await user.click(screen.getByRole('heading', { level: 1, name: 'Insights' }));

      expect(filterButton()).toHaveAttribute('aria-expanded', 'false');
    });

    it('keeps only the chosen activities that the next week also has', async () => {
      const { user } = await renderLoaded();
      await user.click(filterButton());
      await user.click(screen.getByRole('button', { name: 'Sleep' }));
      await user.click(screen.getByRole('button', { name: 'Study' }));

      await user.click(screen.getByRole('button', { name: 'Previous week' }));
      await within(weekSummary()).findByText('Logged that week');

      expect(filterButton()).toHaveAccessibleName('Filter chart: Sleep');
    });
  });

  describe("another user's insights", () => {
    it('opens them from the ?user= link with a Back button', async () => {
      serve({ verified: ['alice'] });
      const { user } = await renderLoaded('/analytics?user=alice');

      expect(api.getWeekAnalytics).toHaveBeenCalledWith('alice', THIS_WEEK);
      expect(switcher()).toHaveAccessibleName(
        /^Viewing insights for\s*alice\s*Verified account\s*Switch$/
      );

      await user.click(screen.getByRole('button', { name: 'Go back' }));
      expect(location()).toHaveTextContent(/^\/analytics$/);
    });

    it('opens them from the /analytics/:username path', async () => {
      await renderLoaded('/analytics/alice', '/analytics/:username');

      expect(api.getWeekAnalytics).toHaveBeenCalledWith('alice', THIS_WEEK);
      expect(switcher()).toHaveAccessibleName(/^Viewing insights for\s*alice\s*Switch$/);
    });

    it("uses that user's own tile names", async () => {
      serve({
        weeks: {
          [THIS_WEEK]: weekAnalytics(parseApiDate(THIS_WEEK), [{ 'custom:g1': 2, sleep: 1 }]),
        },
        otherTiles: {
          success: true,
          data: {
            customTiles: [{ id: 'g1', name: 'Guitar', icon: 'Music', color: '#ff00aa' }],
            colors: { sleep: '#000000' },
          },
        },
      });
      await renderLoaded('/analytics?user=alice');

      expect(api.post).toHaveBeenCalledWith('/tile-config/user', { username: 'alice' });
      expect(await within(breakdown()).findByText('Guitar')).toBeInTheDocument();
    });

    it.each([
      [
        'the request fails',
        new Error('offline'),
        '[Insights] Failed to fetch tile config; keeping the tile names shown',
        { own: false, error: expect.any(Error) },
      ],
      [
        'the response is unsuccessful',
        { success: false, error_code: 'INTERNAL' },
        '[Insights] Tile config request failed; keeping the tile names shown',
        { own: false, code: 'INTERNAL' },
      ],
    ])('falls back to default tile names when %s', async (_label, response, message, context) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      serve({
        weeks: { [THIS_WEEK]: weekAnalytics(parseApiDate(THIS_WEEK), [{ 'custom:g1': 2 }]) },
        otherTiles: response,
      });
      await renderLoaded('/analytics?user=alice');

      expect(within(breakdown()).getByText('Custom')).toBeInTheDocument();
      await waitFor(() => expect(warn).toHaveBeenCalledWith(message, context));
    });

    it('falls back to default tile names when the config is malformed', async () => {
      serve({
        weeks: { [THIS_WEEK]: weekAnalytics(parseApiDate(THIS_WEEK), [{ 'custom:g1': 2 }]) },
        otherTiles: { success: true, data: { customTiles: 'oops', colors: null } },
      });
      await renderLoaded('/analytics?user=alice');

      await waitFor(() =>
        expect(api.post).toHaveBeenCalledWith('/tile-config/user', { username: 'alice' })
      );
      expect(within(breakdown()).getByText('Custom')).toBeInTheDocument();
    });

    it('explains that a private account hides its insights', async () => {
      serve({ weeks: { [THIS_WEEK]: { success: false, error_code: 'ACCOUNT_PRIVATE' } } });
      const { user } = renderInsights('/analytics?user=alice');

      expect(
        await screen.findByRole('heading', { name: 'This account is private' })
      ).toBeInTheDocument();
      expect(
        screen.getByText("Only approved followers can see @alice's insights.")
      ).toBeInTheDocument();
      expect(screen.queryByRole('region', { name: 'Week summary' })).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'View profile' }));
      expect(location()).toHaveTextContent('/user/alice');
    });

    it('treats a private-account API error the same way', async () => {
      const warn = vi.spyOn(console, 'warn');
      const privateAccount = new ApiError('Private', 403, 'ACCOUNT_PRIVATE');
      serve({ weeks: { [THIS_WEEK]: privateAccount }, otherTiles: privateAccount });
      renderInsights('/analytics?user=alice');

      expect(
        await screen.findByRole('heading', { name: 'This account is private' })
      ).toBeInTheDocument();
      // The page explains it, so failing to get their tile names is not worth a warning
      expect(api.post).toHaveBeenCalledWith('/tile-config/user', { username: 'alice' });
      expect(warn).not.toHaveBeenCalled();
    });

    it.each([
      ['an unsuccessful response', { success: false, error_code: 'USER_NOT_FOUND' }],
      ['an API error', new ApiError('Not found', 404, 'USER_NOT_FOUND')],
    ])('explains when the user does not exist (%s)', async (_label, response) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      serve({ weeks: { [THIS_WEEK]: response } });
      const { user } = renderInsights('/analytics?user=ghost');

      expect(await screen.findByRole('heading', { name: 'User not found' })).toBeInTheDocument();
      expect(
        screen.getByText("We couldn't find @ghost. They may have changed their username.")
      ).toBeInTheDocument();
      expect(warn).toHaveBeenCalled();

      await user.click(screen.getByRole('button', { name: 'Back to my insights' }));
      expect(location()).toHaveTextContent(/^\/analytics$/);
    });

    it('offers no way back when your own account cannot be found', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      serve({ weeks: { [THIS_WEEK]: { success: false, error_code: 'USER_NOT_FOUND' } } });
      renderInsights();

      expect(await screen.findByRole('heading', { name: 'User not found' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Back to my insights' })).not.toBeInTheDocument();
    });

    it('says when they logged nothing this week', async () => {
      serve({ weeks: { [THIS_WEEK]: emptyWeek(THIS_WEEK) } });
      await renderLoaded('/analytics?user=alice');

      expect(
        within(breakdown()).getByText("@alice didn't log any activities this week.")
      ).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Log an activity' })).not.toBeInTheDocument();
    });

    it('drops the verified badge if the lookup fails', async () => {
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
      serve();
      api.post.mockImplementation(async (endpoint) => {
        if (endpoint === '/users') throw new Error('offline');
        return { success: true, data: {} };
      });
      await renderLoaded('/analytics?user=alice');

      await waitFor(() =>
        expect(errorLog).toHaveBeenCalledWith(
          'Failed to fetch target user verification',
          expect.any(Error)
        )
      );
      expect(within(switcher()).queryByRole('img', { name: 'Verified account' })).toBeNull();
    });

    it('shows no verified badge when the lookup is unsuccessful', async () => {
      serve();
      api.post.mockImplementation(async (endpoint) =>
        endpoint === '/users' ? { success: false } : { success: true, data: {} }
      );
      await renderLoaded('/analytics?user=alice');

      await waitFor(() => expect(api.post).toHaveBeenCalledWith('/users', { username: 'alice' }));
      expect(within(switcher()).queryByRole('img', { name: 'Verified account' })).toBeNull();
    });
  });

  describe('errors', () => {
    it('offers a retry when the week fails to load', async () => {
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
      serve({ weeks: { [THIS_WEEK]: new TypeError('Failed to fetch') } });
      const { user } = renderInsights();

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent("Couldn't load insights");
      expect(alert).toHaveTextContent('Check your connection and try again.');
      // The week stays navigable
      expect(within(weekSummary()).getByText('Mar 10 – 16, 2025')).toBeInTheDocument();
      expect(errorLog).toHaveBeenCalledWith(
        '[Insights] Failed to fetch week analytics; showing retry',
        { week: THIS_WEEK, error: expect.any(TypeError) }
      );

      serve();
      await user.click(within(alert).getByRole('button', { name: 'Try again' }));

      expect(await screen.findByRole('region', { name: 'Weekly overview' })).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(api.getWeekAnalytics).toHaveBeenCalledTimes(2);
    });

    it('treats an unexpected unsuccessful response as a failed load', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      serve({ weeks: { [THIS_WEEK]: { success: false, error_code: 'INTERNAL' } } });
      renderInsights();

      expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load insights");
      expect(warn).toHaveBeenCalledWith('[Insights] Week analytics request failed', {
        week: THIS_WEEK,
        code: 'INTERNAL',
      });
    });
  });

  describe('your tile names and colors', () => {
    const guitar: CustomTile = { id: 'g1', name: 'Guitar', icon: 'Music', color: '#ff00aa' };
    const guitarWeek = () => weekAnalytics(parseApiDate(THIS_WEEK), [{ 'custom:g1': 2, sleep: 1 }]);

    it('keeps the tiles saved on this device when the server answers unsuccessfully', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      localStorage.setItem(STORAGE_KEYS.CUSTOM_TILES, JSON.stringify([guitar]));
      localStorage.setItem(STORAGE_KEYS.TILE_COLORS, JSON.stringify({ sleep: '#000000' }));
      serve({ weeks: { [THIS_WEEK]: guitarWeek() }, ownTiles: { success: false } });
      await renderLoaded();

      await waitFor(() =>
        expect(warn).toHaveBeenCalledWith(
          '[Insights] Tile config request failed; keeping the tile names shown',
          { own: true, code: undefined }
        )
      );
      expect(within(breakdown()).getByText('Guitar')).toBeInTheDocument();
      expect(rowColor('Sleep')).toBe('#000000');
      expect(api.get).toHaveBeenCalledWith('/tile-config');
      expect(api.post).not.toHaveBeenCalledWith('/tile-config/user', expect.anything());
    });

    it('prefers the tiles from the server', async () => {
      localStorage.setItem(STORAGE_KEYS.CUSTOM_TILES, JSON.stringify([guitar]));
      serve({
        weeks: { [THIS_WEEK]: guitarWeek() },
        ownTiles: {
          success: true,
          data: { customTiles: [{ ...guitar, name: 'Bass' }], colors: { sleep: '#111111' } },
        },
      });
      await renderLoaded();

      expect(await within(breakdown()).findByText('Bass')).toBeInTheDocument();
      expect(rowColor('Sleep')).toBe('#111111');
    });

    it.each([
      ['saved without them', { success: true, data: { order: ['custom:g1', 'sleep'] } }],
      ['nothing saved', { success: true, data: null }],
    ])(
      'drops tiles and colors only this device still has when the server has %s',
      async (_label, ownTiles) => {
        // Saving leaves out custom tiles and colors when there are none, so another device that
        // deleted the last ones saved a config without them
        localStorage.setItem(STORAGE_KEYS.CUSTOM_TILES, JSON.stringify([guitar]));
        localStorage.setItem(STORAGE_KEYS.TILE_COLORS, JSON.stringify({ sleep: '#000000' }));
        serve({ weeks: { [THIS_WEEK]: guitarWeek() }, ownTiles });
        await renderLoaded();

        expect(await within(breakdown()).findByText('Custom')).toBeInTheDocument();
        expect(within(breakdown()).queryByText('Guitar')).not.toBeInTheDocument();
        expect(rowColor('Sleep')).toBe('#6366f1');
      }
    );

    it('keeps the device tiles when the server cannot be reached', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      localStorage.setItem(STORAGE_KEYS.CUSTOM_TILES, JSON.stringify([guitar]));
      serve({ weeks: { [THIS_WEEK]: guitarWeek() }, ownTiles: new Error('offline') });
      await renderLoaded();

      await waitFor(() =>
        expect(warn).toHaveBeenCalledWith(
          '[Insights] Failed to fetch tile config; keeping the tile names shown',
          { own: true, error: expect.any(Error) }
        )
      );
      expect(within(breakdown()).getByText('Guitar')).toBeInTheDocument();
    });

    it('ignores unreadable saved tiles', async () => {
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
      localStorage.setItem(STORAGE_KEYS.CUSTOM_TILES, '{not json');
      serve({ weeks: { [THIS_WEEK]: guitarWeek() } });
      await renderLoaded();

      expect(within(breakdown()).getByText('Custom')).toBeInTheDocument();
      expect(errorLog).toHaveBeenCalledWith(
        'Failed to load tile config from localStorage',
        expect.any(SyntaxError)
      );
    });
  });

  describe('switching people', () => {
    const suggestion = (text: string) => ({ text, kind: 'user', score: 1 });

    it("searches people and opens the chosen person's insights", async () => {
      userApi.autocomplete.mockResolvedValue({ suggestions: [suggestion('bob')] });
      const { user } = await renderLoaded();

      await user.click(switcher());
      const search = screen.getByRole('combobox');
      expect(search).toHaveFocus();
      expect(search).toHaveAttribute('placeholder', 'Search people…');

      await user.type(search, 'bo');
      await user.click(await screen.findByRole('option', { name: /bob/ }));

      expect(userApi.autocomplete).toHaveBeenCalledWith('bo', 12, expect.any(AbortSignal));
      expect(location()).toHaveTextContent('/analytics?user=bob');
      await waitFor(() => expect(api.getWeekAnalytics).toHaveBeenLastCalledWith('bob', THIS_WEEK));
      expect(switcher()).toHaveAccessibleName(/^Viewing insights for\s*bob\s*Switch$/);
    });

    it("never shows your tile names or colors on someone else's insights", async () => {
      const guitar: CustomTile = { id: 'g1', name: 'Guitar', icon: 'Music', color: '#ff00aa' };
      const yourTiles = { customTiles: [guitar], colors: { sleep: '#000000' } };
      localStorage.setItem(STORAGE_KEYS.CUSTOM_TILES, JSON.stringify(yourTiles.customTiles));
      localStorage.setItem(STORAGE_KEYS.TILE_COLORS, JSON.stringify(yourTiles.colors));
      const yourConfig = deferred<unknown>();
      const bobsConfig = deferred<unknown>();
      serve({
        weeks: {
          [THIS_WEEK]: weekAnalytics(parseApiDate(THIS_WEEK), [{ 'custom:g1': 2, sleep: 1 }]),
        },
        ownTiles: yourConfig.promise,
        otherTiles: bobsConfig.promise,
      });
      userApi.autocomplete.mockResolvedValue({ suggestions: [suggestion('bob')] });
      const { user } = await renderLoaded();
      expect(within(breakdown()).getByText('Guitar')).toBeInTheDocument();

      await user.click(switcher());
      await user.type(screen.getByRole('combobox'), 'bo');
      await user.click(await screen.findByRole('option', { name: /bob/ }));

      // While bob's names load, his week shows the default ones, not yours
      await waitFor(() => expect(within(breakdown()).getByText('Custom')).toBeInTheDocument());
      expect(rowColor('Sleep')).toBe('#6366f1');

      // Your config answering late changes nothing
      await act(async () => yourConfig.resolve({ success: true, data: yourTiles }));
      expect(within(breakdown()).queryByText('Guitar')).not.toBeInTheDocument();
      expect(rowColor('Sleep')).toBe('#6366f1');

      await act(async () =>
        bobsConfig.resolve({ success: true, data: { customTiles: [{ ...guitar, name: 'Drums' }] } })
      );
      expect(within(breakdown()).getByText('Drums')).toBeInTheDocument();
    });

    it('goes back to your own insights when you pick yourself', async () => {
      userApi.autocomplete.mockResolvedValue({ suggestions: [suggestion('TestUser')] });
      const { user } = await renderLoaded('/analytics?user=alice');

      await user.click(switcher());
      await user.type(screen.getByRole('combobox'), 'test');
      await user.click(await screen.findByRole('option', { name: /TestUser/ }));

      expect(location()).toHaveTextContent(/^\/analytics$/);
    });

    it('closes the search with Escape and puts focus back on the switcher', async () => {
      userApi.autocomplete.mockResolvedValue({ suggestions: [suggestion('bob')] });
      const { user } = await renderLoaded();

      await user.click(switcher());
      await user.type(screen.getByRole('combobox'), 'bo');
      await screen.findByRole('option', { name: /bob/ });
      await user.keyboard('{Escape}');

      await waitFor(() => expect(switcher()).toHaveFocus());
      expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    });

    it('closes the search without stealing focus when the user moves on', async () => {
      const { user } = await renderLoaded();

      await user.click(switcher());
      await user.click(screen.getByRole('button', { name: 'Most' }));

      await waitFor(() => expect(screen.queryByRole('combobox')).not.toBeInTheDocument());
      expect(screen.getByRole('button', { name: 'Most' })).toHaveFocus();
    });

    it('closes an empty search with Escape and returns focus to the switcher', async () => {
      const { user } = await renderLoaded();

      await user.click(switcher());
      await user.keyboard('{Escape}');

      // Right away, not on some later blur
      expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
      expect(switcher()).toHaveFocus();

      // Escape on the switcher itself changes nothing
      await user.keyboard('{Escape}');
      expect(switcher()).toHaveFocus();

      // Moving on afterwards is not undone by a delayed close or focus jump
      await user.tab();
      await act(() => new Promise((resolve) => setTimeout(resolve, 200)));
      expect(screen.getByRole('button', { name: 'Previous week' })).toHaveFocus();
    });

    it('keeps focus where the user moved it while a dismissed search closes', async () => {
      userApi.autocomplete.mockResolvedValue({ suggestions: [suggestion('bob')] });
      const { user } = await renderLoaded();
      await user.click(switcher());
      await user.type(screen.getByRole('combobox'), 'bo');
      await screen.findByRole('option', { name: /bob/ });

      // Escape dismisses the suggestions and the search; the user moves on at once
      await user.keyboard('{Escape}');
      await user.tab({ shift: true });
      const least = screen.getByRole('button', { name: 'Least' });
      expect(least).toHaveFocus();

      await waitFor(() => expect(screen.queryByRole('combobox')).not.toBeInTheDocument());
      await act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
      expect(least).toHaveFocus();
    });

    it('shows no suggestions when the search fails', async () => {
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
      userApi.autocomplete.mockRejectedValue(new Error('offline'));
      const { user } = await renderLoaded();

      await user.click(switcher());
      await user.type(screen.getByRole('combobox'), 'bo');

      await waitFor(() =>
        expect(errorLog).toHaveBeenCalledWith('Autocomplete failed:', expect.any(Error))
      );
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    });

    it('drops a search that was superseded by more typing', async () => {
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
      userApi.autocomplete.mockImplementation((query, _limit, signal) =>
        query === 'b'
          ? new Promise((_resolve, reject) =>
              signal?.addEventListener('abort', () =>
                reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }))
              )
            )
          : Promise.resolve({})
      );
      const { user } = await renderLoaded();

      await user.click(switcher());
      await user.type(screen.getByRole('combobox'), 'b');
      await waitFor(() => expect(userApi.autocomplete).toHaveBeenCalledTimes(1));
      await user.type(screen.getByRole('combobox'), 'o');

      await waitFor(() => expect(userApi.autocomplete).toHaveBeenCalledTimes(2));
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
      expect(errorLog).not.toHaveBeenCalled();
    });

    it.each([
      [
        'resolves',
        (lookup: ReturnType<typeof deferred<unknown>>) =>
          lookup.resolve({ success: true, data: [{ username: 'alice', is_verified: true }] }),
      ],
      [
        'fails',
        (lookup: ReturnType<typeof deferred<unknown>>) => lookup.reject(new Error('offline')),
      ],
    ])("ignores a previous person's verification lookup that %s late", async (_label, settle) => {
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
      const aliceLookup = deferred<unknown>();
      userApi.autocomplete.mockResolvedValue({ suggestions: [suggestion('bob')] });
      serve();
      const answer = api.post.getMockImplementation()!;
      api.post.mockImplementation((endpoint, body) =>
        endpoint === '/users' && (body as { username: string }).username === 'alice'
          ? aliceLookup.promise
          : answer(endpoint, body)
      );
      const { user } = await renderLoaded('/analytics?user=alice');

      await user.click(switcher());
      await user.type(screen.getByRole('combobox'), 'bo');
      await user.click(await screen.findByRole('option', { name: /bob/ }));
      await waitFor(() => expect(switcher()).toHaveAccessibleName(/bob/));

      await act(async () => settle(aliceLookup));

      expect(within(switcher()).queryByRole('img', { name: 'Verified account' })).toBeNull();
      expect(errorLog).not.toHaveBeenCalled();
    });
  });
});
