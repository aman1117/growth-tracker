import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api, ApiError } from '../../../services/api';
import {
  ALICE,
  createDeferred,
  FIXED_TODAY,
  makeActivity,
  makeBadge,
  routeApi,
  TODAY_KEY,
  YESTERDAY_KEY,
} from '../../../test/fixtures/dashboard';
import { ACTIVITY_NAMES } from '../../../types';
import { cacheActivities, getCacheKey } from '../Dashboard.constants';
import { useActivityData } from './useActivityData';

vi.mock('../../../services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/api')>()),
  api: { get: vi.fn(), post: vi.fn() },
}));

interface Props {
  targetUsername: string | undefined;
  currentDate: Date;
  isReadOnly: boolean;
}

const YESTERDAY = new Date(2026, 4, 14, 12);
const emptyDay = Object.fromEntries(ACTIVITY_NAMES.map((name) => [name, 0]));

function renderActivityData(props: Partial<Props> = {}) {
  const callbacks = {
    onPrivateAccount: vi.fn(),
    onPrivateAccountBadges: vi.fn(),
    onError: vi.fn(),
  };
  const view = renderHook((p: Props) => useActivityData({ ...p, ...callbacks }), {
    initialProps: {
      targetUsername: ALICE.username,
      currentDate: FIXED_TODAY,
      isReadOnly: false,
      ...props,
    },
  });
  return { ...view, ...callbacks };
}

describe('useActivityData', () => {
  beforeEach(() => {
    vi.setSystemTime(FIXED_TODAY);
  });

  it('waits for a username before loading', () => {
    const { result } = renderActivityData({ targetUsername: undefined });

    expect(result.current.loading).toBe(true);
    expect(api.post).not.toHaveBeenCalled();
  });

  it('loads the day, filling activities without entries with 0 hours', async () => {
    routeApi(api, {
      'POST /get-activities': {
        success: true,
        data: [
          makeActivity({ name: 'sleep', hours: 7.5 }),
          makeActivity({ id: 2, name: 'study', hours: 2, note: 'Chapter 4' }),
          makeActivity({ id: 3, name: 'custom:guitar-1', hours: 1 }),
        ],
      },
    });
    const { result, onPrivateAccount, onError } = renderActivityData();

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(api.post).toHaveBeenCalledWith('/get-activities', {
      username: 'alice',
      start_date: TODAY_KEY,
      end_date: TODAY_KEY,
    });
    expect(result.current.activities).toEqual({
      ...emptyDay,
      sleep: 7.5,
      study: 2,
      'custom:guitar-1': 1,
    });
    expect(result.current.activityNotes).toEqual({ study: 'Chapter 4' });
    expect(onPrivateAccount).toHaveBeenCalledWith(false);
    expect(onError).not.toHaveBeenCalled();
  });

  it('caches the signed-in user’s own day for offline use', async () => {
    routeApi(api, { 'POST /get-activities': { success: true, data: [makeActivity()] } });
    const { result } = renderActivityData();
    await waitFor(() => expect(result.current.loading).toBe(false));

    const cached = JSON.parse(localStorage.getItem(getCacheKey('alice', TODAY_KEY))!);
    expect(cached).toMatchObject({ activities: { sleep: 8 }, notes: {} });
  });

  it('does not cache someone else’s day', async () => {
    routeApi(api, { 'POST /get-activities': { success: true, data: [makeActivity()] } });
    const { result } = renderActivityData({ targetUsername: 'bob', isReadOnly: true });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(localStorage.getItem(getCacheKey('bob', TODAY_KEY))).toBeNull();
  });

  describe('private accounts', () => {
    const badges = [makeBadge(), makeBadge({ key: 'week', earned: false })];

    it.each([
      ['answers with the ACCOUNT_PRIVATE code', { success: false, error_code: 'ACCOUNT_PRIVATE' }],
      ['rejects with an ACCOUNT_PRIVATE error', new ApiError('Private', 403, 'ACCOUNT_PRIVATE')],
    ])('reports a private account and loads its public badges when the API %s', async (_l, res) => {
      routeApi(api, {
        'POST /get-activities': res,
        'POST /badges/user': { success: true, badges },
      });
      const { result, onPrivateAccount, onPrivateAccountBadges, onError } = renderActivityData({
        targetUsername: 'bob',
        isReadOnly: true,
      });

      await waitFor(() => expect(onPrivateAccountBadges).toHaveBeenCalledWith(badges));
      expect(api.post).toHaveBeenCalledWith('/badges/user', { username: 'bob' });
      expect(onPrivateAccount).toHaveBeenCalledWith(true);
      expect(onError).not.toHaveBeenCalled();
      expect(result.current.loading).toBe(false);
    });

    it('skips badges the API does not return', async () => {
      routeApi(api, {
        'POST /get-activities': { success: false, error_code: 'ACCOUNT_PRIVATE' },
        'POST /badges/user': { success: false },
      });
      const { result, onPrivateAccountBadges } = renderActivityData({ targetUsername: 'bob' });
      await waitFor(() => expect(result.current.loading).toBe(false));
      await waitFor(() => expect(api.post).toHaveBeenCalledWith('/badges/user', expect.anything()));

      expect(onPrivateAccountBadges).not.toHaveBeenCalled();
    });

    it('logs and carries on when the badges cannot be loaded', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      routeApi(api, {
        'POST /get-activities': { success: false, error_code: 'ACCOUNT_PRIVATE' },
        'POST /badges/user': new Error('offline'),
      });
      const { onPrivateAccount, onPrivateAccountBadges } = renderActivityData({
        targetUsername: 'bob',
      });

      await waitFor(() =>
        expect(error).toHaveBeenCalledWith(
          '[useActivityData] Failed to fetch badges for private account:',
          expect.any(Error)
        )
      );
      expect(onPrivateAccount).toHaveBeenCalledWith(true);
      expect(onPrivateAccountBadges).not.toHaveBeenCalled();
    });
  });

  it('leaves the day untouched when the API answers with another failure', async () => {
    routeApi(api, { 'POST /get-activities': { success: false, error_code: 'RATE_LIMITED' } });
    const { result, onPrivateAccount, onError } = renderActivityData();

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.activities).toEqual({});
    expect(onPrivateAccount).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  describe('when the request fails', () => {
    beforeEach(() => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      routeApi(api, { 'POST /get-activities': new TypeError('Failed to fetch') });
    });

    it('shows the cached day while offline', async () => {
      cacheActivities('alice', TODAY_KEY, { sleep: 6 }, { sleep: 'Napped too' });
      const { result, onError } = renderActivityData();

      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.activities).toEqual({ sleep: 6 });
      expect(result.current.activityNotes).toEqual({ sleep: 'Napped too' });
      expect(onError).not.toHaveBeenCalled();
    });

    it('reports an error when nothing is cached', async () => {
      const { result, onError } = renderActivityData();

      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(onError).toHaveBeenCalledWith('Failed to load activities');
      expect(result.current.activities).toEqual({});
    });
  });

  it('reloads when asked (pull to refresh, follow accepted)', async () => {
    routeApi(api, { 'POST /get-activities': { success: true, data: [] } });
    const { result } = renderActivityData();
    await waitFor(() => expect(result.current.loading).toBe(false));

    routeApi(api, { 'POST /get-activities': { success: true, data: [makeActivity()] } });
    await act(() => result.current.fetchActivities());

    expect(api.post).toHaveBeenCalledTimes(2);
    expect(result.current.activities.sleep).toBe(8);
  });

  it('only applies the latest request when the day changes quickly', async () => {
    const today = createDeferred<unknown>();
    const yesterday = createDeferred<unknown>();
    routeApi(api, {
      'POST /get-activities': (body: unknown) =>
        (body as { start_date: string }).start_date === TODAY_KEY
          ? today.promise
          : yesterday.promise,
    });
    const { result, rerender } = renderActivityData();

    rerender({ targetUsername: 'alice', currentDate: YESTERDAY, isReadOnly: false });
    await act(async () => {
      yesterday.resolve({ success: true, data: [makeActivity({ hours: 5 })] });
    });
    expect(result.current.activities.sleep).toBe(5);
    expect(result.current.loading).toBe(false);

    await act(async () => {
      today.resolve({ success: true, data: [makeActivity({ hours: 9 })] });
    });
    expect(result.current.activities.sleep).toBe(5);
    expect(localStorage.getItem(getCacheKey('alice', YESTERDAY_KEY))).not.toBeNull();
    expect(localStorage.getItem(getCacheKey('alice', TODAY_KEY))).toBeNull();
  });

  it('ignores a late failure from a superseded request', async () => {
    const today = createDeferred<unknown>();
    routeApi(api, {
      'POST /get-activities': (body: unknown) =>
        (body as { start_date: string }).start_date === TODAY_KEY
          ? today.promise
          : { success: true, data: [makeActivity({ hours: 4 })] },
    });
    const { result, rerender, onError } = renderActivityData();

    rerender({ targetUsername: 'alice', currentDate: YESTERDAY, isReadOnly: false });
    await waitFor(() => expect(result.current.activities.sleep).toBe(4));
    await act(async () => today.reject(new Error('timeout')));

    expect(onError).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
    expect(result.current.activities.sleep).toBe(4);
  });
});
