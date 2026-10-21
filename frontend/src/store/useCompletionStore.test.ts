import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { API_ROUTES } from '../constants';
import { api } from '../services/api';
import { deferred } from '../test/fixtures/shell';
import {
  type MonthCompletionData,
  useCompletionStore,
  useMonthCompletion,
  useMonthCompletionLoading,
} from './useCompletionStore';

vi.mock('../services/api', () => ({ api: { post: vi.fn() } }));

const post = vi.mocked(api.post);
const store = () => useCompletionStore.getState();

// Months are 0-based like Date#getMonth: 1 = February
const FEB = 1;
const FEB_KEY = 'alice:2024-02';

describe('useCompletionStore', () => {
  beforeEach(() => {
    post.mockReset();
  });

  describe('fetchMonthData', () => {
    it('requests the whole month and caches the result per user and month', async () => {
      const data: MonthCompletionData = { '2024-02-01': 6, '2024-02-29': 8.5 };
      post.mockResolvedValue({ success: true, data });

      await expect(store().fetchMonthData('Alice', 2024, FEB)).resolves.toEqual(data);

      // 2024 is a leap year, so the month ends on the 29th
      expect(post).toHaveBeenCalledWith(API_ROUTES.ACTIVITY.DAILY_TOTALS, {
        username: 'Alice',
        start_date: '2024-02-01',
        end_date: '2024-02-29',
      });
      expect(store().monthlyData[FEB_KEY]).toEqual(data);
      expect(store().loadingStates[FEB_KEY]).toBe(false);
      expect(store().errorStates[FEB_KEY]).toBeNull();
    });

    it('pads single-digit months and handles December', async () => {
      post.mockResolvedValue({ success: true, data: {} });

      await store().fetchMonthData('bob', 2023, 11);

      expect(post).toHaveBeenCalledWith(API_ROUTES.ACTIVITY.DAILY_TOTALS, {
        username: 'bob',
        start_date: '2023-12-01',
        end_date: '2023-12-31',
      });
      expect(store().monthlyData['bob:2023-12']).toEqual({});
    });

    it('serves cached months without calling the API again', async () => {
      post.mockResolvedValue({ success: true, data: { '2024-02-03': 2 } });
      await store().fetchMonthData('alice', 2024, FEB);

      await expect(store().fetchMonthData('ALICE', 2024, FEB)).resolves.toEqual({
        '2024-02-03': 2,
      });
      expect(post).toHaveBeenCalledTimes(1);
    });

    it('does not start a second request while one is in flight', async () => {
      const request = deferred<unknown>();
      post.mockReturnValue(request.promise);

      const first = store().fetchMonthData('alice', 2024, FEB);
      expect(store().loadingStates[FEB_KEY]).toBe(true);
      expect(store().isMonthLoading('alice', 2024, FEB)).toBe(true);

      await expect(store().fetchMonthData('alice', 2024, FEB)).resolves.toBeNull();
      expect(post).toHaveBeenCalledTimes(1);

      request.resolve({ success: true, data: { '2024-02-10': 1 } });
      await expect(first).resolves.toEqual({ '2024-02-10': 1 });
      expect(store().isMonthLoading('alice', 2024, FEB)).toBe(false);
    });

    it('records the server error when the response is unsuccessful', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      post.mockResolvedValue({ success: false, error: 'User not found' });

      await expect(store().fetchMonthData('alice', 2024, FEB)).resolves.toBeNull();

      expect(store().errorStates[FEB_KEY]).toBe('User not found');
      expect(store().loadingStates[FEB_KEY]).toBe(false);
      expect(store().monthlyData[FEB_KEY]).toBeUndefined();
      expect(consoleError).toHaveBeenCalledWith(
        `[CompletionStore] Failed to fetch data for ${FEB_KEY}:`,
        'User not found'
      );
    });

    it('uses a default message when the response carries neither data nor an error', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      post.mockResolvedValue({ success: true });

      await store().fetchMonthData('alice', 2024, FEB);

      expect(store().errorStates[FEB_KEY]).toBe('Failed to fetch completion data');
    });

    it('handles network errors and non-Error rejections', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});

      post.mockRejectedValueOnce(new Error('Network down'));
      await expect(store().fetchMonthData('alice', 2024, FEB)).resolves.toBeNull();
      expect(store().errorStates[FEB_KEY]).toBe('Network down');

      post.mockRejectedValueOnce('boom');
      await store().fetchMonthData('alice', 2024, 2);
      expect(store().errorStates['alice:2024-03']).toBe('Unknown error');
    });

    it('clears a previous error when retrying', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      post.mockRejectedValueOnce(new Error('Network down'));
      await store().fetchMonthData('alice', 2024, FEB);

      post.mockResolvedValueOnce({ success: true, data: { '2024-02-02': 3 } });
      await store().fetchMonthData('alice', 2024, FEB);

      expect(store().errorStates[FEB_KEY]).toBeNull();
      expect(store().getMonthData('alice', 2024, FEB)).toEqual({ '2024-02-02': 3 });
    });
  });

  describe('cache helpers', () => {
    it('returns null / false for months that were never fetched', () => {
      expect(store().getMonthData('alice', 2024, FEB)).toBeNull();
      expect(store().isMonthLoading('alice', 2024, FEB)).toBe(false);
    });

    it('updateDay creates the month entry when nothing is cached yet', () => {
      store().updateDay('Alice', new Date(2024, FEB, 5), 7);

      expect(store().getMonthData('alice', 2024, FEB)).toEqual({ '2024-02-05': 7 });
    });

    it('updateDay merges into an already cached month', () => {
      useCompletionStore.setState({ monthlyData: { [FEB_KEY]: { '2024-02-01': 2 } } });

      store().updateDay('alice', new Date(2024, FEB, 1), 4);
      store().updateDay('alice', new Date(2024, FEB, 9), 1.5);

      expect(store().getMonthData('alice', 2024, FEB)).toEqual({
        '2024-02-01': 4,
        '2024-02-09': 1.5,
      });
    });

    it('invalidateMonth drops data, loading and error state for that month only', () => {
      useCompletionStore.setState({
        monthlyData: { [FEB_KEY]: { '2024-02-01': 2 }, 'alice:2024-03': { '2024-03-01': 1 } },
        loadingStates: { [FEB_KEY]: false, 'alice:2024-03': false },
        errorStates: { [FEB_KEY]: 'stale', 'alice:2024-03': null },
      });

      store().invalidateMonth('alice', 2024, FEB);

      expect(store().monthlyData).toEqual({ 'alice:2024-03': { '2024-03-01': 1 } });
      expect(store().loadingStates).toEqual({ 'alice:2024-03': false });
      expect(store().errorStates).toEqual({ 'alice:2024-03': null });
    });

    it('invalidated months are fetched again', async () => {
      post.mockResolvedValue({ success: true, data: {} });
      await store().fetchMonthData('alice', 2024, FEB);

      store().invalidateMonth('alice', 2024, FEB);
      await store().fetchMonthData('alice', 2024, FEB);

      expect(post).toHaveBeenCalledTimes(2);
    });

    it('clearCache empties everything', () => {
      useCompletionStore.setState({
        monthlyData: { [FEB_KEY]: {} },
        loadingStates: { [FEB_KEY]: true },
        errorStates: { [FEB_KEY]: 'x' },
      });

      store().clearCache();

      expect(store()).toMatchObject({ monthlyData: {}, loadingStates: {}, errorStates: {} });
    });
  });

  describe('selector hooks', () => {
    it('useMonthCompletion returns the cached month and follows updates', () => {
      const { result } = renderHook(() => useMonthCompletion('alice', 2024, FEB));
      expect(result.current).toBeNull();

      act(() => store().updateDay('alice', new Date(2024, FEB, 14), 3));
      expect(result.current).toEqual({ '2024-02-14': 3 });
    });

    it('useMonthCompletion returns null without a username', () => {
      useCompletionStore.setState({ monthlyData: { [FEB_KEY]: { '2024-02-01': 1 } } });

      const { result } = renderHook(() => useMonthCompletion(undefined, 2024, FEB));
      expect(result.current).toBeNull();
    });

    it('useMonthCompletionLoading reflects the loading flag', () => {
      const { result, rerender } = renderHook(
        ({ username }: { username?: string }) => useMonthCompletionLoading(username, 2024, FEB),
        { initialProps: { username: 'alice' } as { username?: string } }
      );
      expect(result.current).toBe(false);

      act(() => useCompletionStore.setState({ loadingStates: { [FEB_KEY]: true } }));
      expect(result.current).toBe(true);

      rerender({ username: undefined });
      expect(result.current).toBe(false);
    });
  });
});
