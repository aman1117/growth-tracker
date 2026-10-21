/**
 * Fixtures for the "settings" scope: the Settings ("You") screen, push notification settings
 * and the Insights screen (AnalyticsPage).
 */
import { onTestFinished, vi } from 'vitest';

import { pushService } from '../../services/pushService';
import { usePushStore } from '../../store/usePushStore';
import type {
  ActivitySummary,
  DayAnalytics,
  PushPermissionState,
  PushPreferences,
  WeekAnalyticsResponse,
} from '../../types';
import { createMatchMedia } from '../browser-mocks';

// ============================================================================
// Async control
// ============================================================================

/** A promise plus its resolve/reject, to hold a request "in flight" during a test. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ============================================================================
// Platform (user agent / installed app)
// ============================================================================

export const IPHONE_SAFARI_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
/** iPadOS 13+ Safari reports a desktop Mac user agent */
export const IPAD_DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
export const ANDROID_CHROME_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
export const DESKTOP_CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * Overrides a `navigator` property for the current test only (jsdom lacks some, such as
 * `maxTouchPoints` and iOS's `standalone`, so they cannot be spied on).
 */
export function stubNavigator(name: string, value: unknown) {
  Object.defineProperty(navigator, name, { configurable: true, get: () => value });
  onTestFinished(() => {
    Reflect.deleteProperty(navigator, name);
  });
}

/** Pretends to run with this user agent and touch support (current test only). */
export function stubUserAgent(userAgent: string, maxTouchPoints = 0) {
  stubNavigator('userAgent', userAgent);
  stubNavigator('maxTouchPoints', maxTouchPoints);
}

/** Pretends the app runs installed from the Home Screen (`display-mode: standalone`). */
export function stubInstalledApp() {
  vi.stubGlobal(
    'matchMedia',
    createMatchMedia((query) => query === '(display-mode: standalone)')
  );
}

// ============================================================================
// Push notifications
// ============================================================================

/** Push preferences as the API returns them: every type on, quiet hours off. */
export function pushPreferences(overrides: Partial<PushPreferences> = {}): PushPreferences {
  return {
    push_enabled: true,
    quiet_hours_enabled: false,
    quiet_start: null,
    quiet_end: null,
    timezone: 'Europe/London',
    ...overrides,
    preferences: {
      like_received: true,
      badge_unlocked: true,
      streak_milestone: true,
      streak_at_risk: true,
      system_announcement: true,
      ...overrides.preferences,
    },
  };
}

interface PushEnvironment {
  supported?: boolean;
  permission?: Exclude<PushPermissionState, 'unsupported'>;
  subscribed?: boolean;
  preferences?: PushPreferences;
}

/**
 * Configures the automocked `pushService` (the test file must call
 * `vi.mock('<path>/services/pushService')`) and seeds `usePushStore` to match, so the
 * screen starts in that state. Subscribe/unsubscribe/update calls start unconfigured.
 */
export function setPushEnvironment({
  supported = true,
  permission = 'default',
  subscribed = false,
  preferences = pushPreferences(),
}: PushEnvironment = {}) {
  [
    pushService.isSupported,
    pushService.getPermissionState,
    pushService.requestPermission,
    pushService.getExistingSubscription,
    pushService.subscribe,
    pushService.unsubscribe,
    pushService.getPreferences,
    pushService.updatePreferences,
  ].forEach((method) => vi.mocked(method).mockReset());
  vi.mocked(pushService.isSupported).mockReturnValue(supported);
  vi.mocked(pushService.getPermissionState).mockReturnValue(supported ? permission : 'unsupported');
  vi.mocked(pushService.getExistingSubscription).mockResolvedValue(
    subscribed ? ({ endpoint: 'https://push.example/sub' } as PushSubscription) : null
  );
  vi.mocked(pushService.getPreferences).mockResolvedValue({ success: true, preferences });

  // reset() also clears the store's "preferences already fetched" flag between tests
  usePushStore.getState().reset();
  usePushStore.setState({
    isSupported: supported,
    permission: supported ? permission : 'unsupported',
    isSubscribed: subscribed,
    preferences: subscribed ? preferences : null,
  });
}

// ============================================================================
// Insights (week analytics)
// ============================================================================

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** Local calendar date as the API expects it (YYYY-MM-DD) */
export const toApiDate = (date: Date): string =>
  [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');

/** A day of the weekly breakdown; the total is the sum of its activities. */
export function dayAnalytics(
  date: string,
  dayName: string,
  activities: Record<string, number> = {}
): DayAnalytics {
  const entries = Object.entries(activities).map(([name, hours]) => ({
    name: name as DayAnalytics['activities'][number]['name'],
    hours,
  }));
  return {
    date,
    day_name: dayName,
    total_hours: entries.reduce((sum, a) => sum + a.hours, 0),
    activities: entries,
  };
}

/**
 * A week of insights. `days` lists each day's activities from Monday on (missing days are
 * empty); the daily breakdown, activity summary and weekly total are derived from it.
 */
export function weekAnalytics(
  weekStart: Date,
  days: Record<string, number>[] = [],
  overrides: Partial<WeekAnalyticsResponse> = {}
): WeekAnalyticsResponse {
  const dailyBreakdown = DAY_NAMES.map((name, index) => {
    const date = new Date(
      weekStart.getFullYear(),
      weekStart.getMonth(),
      weekStart.getDate() + index
    );
    return dayAnalytics(toApiDate(date), name, days[index]);
  });

  const totals = new Map<string, number>();
  dailyBreakdown.forEach((d) =>
    d.activities.forEach((a) => totals.set(a.name, (totals.get(a.name) ?? 0) + a.hours))
  );
  const activitySummary = [...totals.entries()].map(
    ([name, total_hours]) => ({ name, total_hours }) as ActivitySummary
  );

  return {
    success: true,
    total_hours_this_week: dailyBreakdown.reduce((sum, d) => sum + d.total_hours, 0),
    total_hours_prev_week: 0,
    total_hours_current_week: 0,
    percentage_change: 0,
    percentage_vs_current: 0,
    is_current_week: true,
    streak: { current: 0, longest: 0 },
    daily_breakdown: dailyBreakdown,
    activity_summary: activitySummary,
    ...overrides,
  };
}
