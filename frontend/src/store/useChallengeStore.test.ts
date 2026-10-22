import { act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, challengeApi } from '../services/api';
import {
  CHALLENGE_NOW,
  listResponse,
  makeChallengeDetail,
  makeChallengeSummary,
  makeEndedSummary,
  makeUpcomingSummary,
} from '../test/fixtures/challenges';
import { deferred } from '../test/fixtures/shell';
import type { ChallengesListResponse } from '../types';
import { CHALLENGES_FRESH_FOR_MS, useChallengeStore } from './useChallengeStore';

vi.mock('../services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/api')>()),
  challengeApi: { list: vi.fn() },
}));

const list = vi.mocked(challengeApi.list);
const store = () => useChallengeStore.getState();
const fetchChallenges = (options?: { force?: boolean }) =>
  act(() => store().fetchChallenges(options));

const active = makeChallengeSummary();
const upcoming = makeUpcomingSummary();
const ended = makeEndedSummary();

/** Holds list responses until the test settles them, in any order */
function queueResponses() {
  const pending: ReturnType<typeof deferred<ChallengesListResponse>>[] = [];
  list.mockImplementation(() => {
    const response = deferred<ChallengesListResponse>();
    pending.push(response);
    return response.promise;
  });
  return pending;
}

describe('useChallengeStore', () => {
  beforeEach(() => {
    vi.setSystemTime(CHALLENGE_NOW);
    list.mockReset();
    list.mockResolvedValue(listResponse([active, upcoming, ended]));
  });

  it('starts empty and idle', () => {
    expect(store()).toMatchObject({
      challenges: [],
      status: 'idle',
      error: null,
      lastFetchedAt: null,
    });
  });

  describe('fetchChallenges', () => {
    it('loads the list, showing loading only until the first list arrives', async () => {
      const pending = queueResponses();

      const loading = store().fetchChallenges();
      expect(store().status).toBe('loading');

      pending[0].resolve(listResponse([active, upcoming]));
      await act(() => loading);

      expect(store()).toMatchObject({
        challenges: [active, upcoming],
        status: 'ready',
        error: null,
        lastFetchedAt: CHALLENGE_NOW.getTime(),
      });
      expect(list).toHaveBeenCalledTimes(1);
    });

    it('shares a load that is already running', async () => {
      const pending = queueResponses();

      const first = store().fetchChallenges();
      const second = store().fetchChallenges();
      pending[0].resolve(listResponse([active]));
      await act(() => Promise.all([first, second]));

      expect(second).toBe(first);
      expect(list).toHaveBeenCalledTimes(1);
      expect(store().challenges).toEqual([active]);
    });

    it('reuses a list loaded in the last 30 seconds', async () => {
      await fetchChallenges();

      vi.setSystemTime(CHALLENGE_NOW.getTime() + CHALLENGES_FRESH_FOR_MS - 1);
      await fetchChallenges();
      expect(list).toHaveBeenCalledTimes(1);

      vi.setSystemTime(CHALLENGE_NOW.getTime() + CHALLENGES_FRESH_FOR_MS);
      await fetchChallenges();
      expect(list).toHaveBeenCalledTimes(2);
    });

    it('loads again when the clock went backwards', async () => {
      await fetchChallenges();

      vi.setSystemTime(CHALLENGE_NOW.getTime() - 1000);
      await fetchChallenges();

      expect(list).toHaveBeenCalledTimes(2);
    });

    it('keeps the loaded list on screen while refreshing it', async () => {
      await fetchChallenges();
      const pending = queueResponses();

      const refresh = store().fetchChallenges({ force: true });
      expect(store()).toMatchObject({ status: 'ready', challenges: [active, upcoming, ended] });

      pending[0].resolve(listResponse([upcoming]));
      await act(() => refresh);
      expect(store().challenges).toEqual([upcoming]);
    });

    it('lets a forced load replace one in flight, ignoring the older response', async () => {
      const pending = queueResponses();

      const first = store().fetchChallenges();
      const second = store().fetchChallenges({ force: true });
      expect(list).toHaveBeenCalledTimes(2);
      expect(second).not.toBe(first);

      pending[1].resolve(listResponse([upcoming]));
      await act(() => second);
      pending[0].resolve(listResponse([active]));
      await act(() => first);

      expect(store().challenges).toEqual([upcoming]);
    });

    it('ignores an older response that arrives first', async () => {
      const pending = queueResponses();

      const first = store().fetchChallenges();
      const second = store().fetchChallenges({ force: true });
      pending[0].resolve(listResponse([active]));
      await act(() => first);

      expect(store()).toMatchObject({ status: 'loading', challenges: [] });

      pending[1].resolve(listResponse([ended]));
      await act(() => second);
      expect(store()).toMatchObject({ status: 'ready', challenges: [ended] });
    });

    it('treats a response without a list as an empty list', async () => {
      list.mockResolvedValue({ success: true } as ChallengesListResponse);

      await fetchChallenges();

      expect(store()).toMatchObject({ status: 'ready', challenges: [] });
    });
  });

  describe('failures', () => {
    it('shows an error when the first load fails, and recovers on retry', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      list.mockRejectedValueOnce(new TypeError('Failed to fetch'));

      await fetchChallenges();

      expect(store()).toMatchObject({
        status: 'error',
        error: 'Failed to fetch',
        challenges: [],
      });
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        '[Challenges] Could not load the challenge list',
        { errorCode: undefined, status: undefined, recovery: 'show_retry' }
      );

      const retry = store().fetchChallenges({ force: true });
      expect(store().status).toBe('loading');
      await act(() => retry);
      expect(store()).toMatchObject({ status: 'ready', error: null });
    });

    it('keeps the loaded list when a refresh fails', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await fetchChallenges();
      list.mockRejectedValueOnce(new ApiError('Server error', 500, 'INTERNAL_ERROR'));

      await fetchChallenges({ force: true });

      expect(store()).toMatchObject({
        status: 'ready',
        error: 'Server error',
        challenges: [active, upcoming, ended],
      });
      expect(warn).toHaveBeenCalledWith('[Challenges] Could not load the challenge list', {
        errorCode: 'INTERNAL_ERROR',
        status: 500,
        recovery: 'keep_loaded_list',
      });
    });

    it('ignores the failure of a load that was replaced', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const pending = queueResponses();

      const first = store().fetchChallenges();
      const second = store().fetchChallenges({ force: true });
      pending[0].reject('offline');
      await act(() => first);
      pending[1].resolve(listResponse([active]));
      await act(() => second);

      expect(store()).toMatchObject({ status: 'ready', error: null, challenges: [active] });
      expect(warn).not.toHaveBeenCalled();
    });

    it('describes failures that are not errors', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      list.mockRejectedValueOnce('offline');

      await fetchChallenges();

      expect(store().error).toBe('Unknown error');
    });
  });

  describe('local changes', () => {
    it('adds a new challenge in the server order and updates existing ones', async () => {
      await fetchChallenges();
      const created = makeChallengeDetail({
        id: 50,
        title: 'Family time',
        status: 'active',
        end_date: '2026-10-30',
      });

      act(() => store().upsertFromDetail(created));

      expect(store().challenges.map((c) => c.id)).toEqual([50, 42, 43, 41]);
      const summary = store().challenges[0];
      expect(summary).toMatchObject({ id: 50, title: 'Family time' });
      expect(summary).not.toHaveProperty('participants');
      expect(summary).not.toHaveProperty('my_days');

      // The upcoming challenge has started: it moves to the active ones
      act(() =>
        store().upsertFromDetail(
          makeChallengeDetail({ ...upcoming, status: 'active', day_number: 1 })
        )
      );
      expect(store().challenges.map((c) => [c.id, c.status])).toEqual([
        [50, 'active'],
        [42, 'active'],
        [43, 'active'],
        [41, 'ended'],
      ]);
    });

    it('orders upcoming challenges by start and ended ones latest first', () => {
      act(() => {
        store().upsertFromDetail(makeChallengeDetail({ ...ended, id: 1, end_date: '2026-09-01' }));
        store().upsertFromDetail(makeChallengeDetail({ ...ended, id: 2, end_date: '2026-10-01' }));
        store().upsertFromDetail(
          makeChallengeDetail({ ...upcoming, id: 3, start_date: '2026-11-01' })
        );
        store().upsertFromDetail(
          makeChallengeDetail({ ...upcoming, id: 4, start_date: '2026-10-25' })
        );
        store().upsertFromDetail(
          makeChallengeDetail({ ...active, id: 5, status: 'mystery' as 'ended' })
        );
      });

      expect(store().challenges.map((c) => c.id)).toEqual([4, 3, 2, 1, 5]);
    });

    it('removes a challenge the user left or deleted', async () => {
      await fetchChallenges();

      act(() => store().remove(upcoming.id));

      expect(store().challenges).toEqual([active, ended]);
    });

    it('loads again when the list changed while a response was on its way', async () => {
      const pending = queueResponses();
      const loading = store().fetchChallenges();
      const created = makeChallengeDetail({ id: 50 });

      act(() => store().upsertFromDetail(created));
      expect(store().challenges.map((c) => c.id)).toEqual([50]);

      // This response predates the new challenge; applying it would drop it
      pending[0].resolve(listResponse([active]));
      await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
      expect(store().challenges.map((c) => c.id)).toEqual([50]);

      pending[1].resolve(listResponse([makeChallengeSummary({ id: 50 }), active]));
      await act(() => loading);
      expect(store()).toMatchObject({ status: 'ready' });
      expect(store().challenges.map((c) => c.id)).toEqual([50, 42]);
    });
  });

  describe('refreshAfterActivityLogged', () => {
    it.each([
      ['an active challenge', [active]],
      ['an ended challenge whose results are not final', [makeEndedSummary({ finalized: false })]],
    ])('refreshes the list for %s', async (_label, challenges) => {
      list.mockResolvedValue(listResponse(challenges));
      await fetchChallenges();

      await act(() => store().refreshAfterActivityLogged());

      expect(list).toHaveBeenCalledTimes(2);
    });

    it.each([
      ['only upcoming and final challenges', [upcoming, ended]],
      ['no challenges', []],
    ])('does nothing with %s', async (_label, challenges) => {
      list.mockResolvedValue(listResponse(challenges));
      await fetchChallenges();

      await act(() => store().refreshAfterActivityLogged());

      expect(list).toHaveBeenCalledTimes(1);
    });

    it('does nothing before the list has loaded', async () => {
      await act(() => store().refreshAfterActivityLogged());

      expect(list).not.toHaveBeenCalled();
    });
  });

  it('resets to the initial state and ignores a response for the previous session', async () => {
    const pending = queueResponses();
    const loading = store().fetchChallenges();

    act(() => store().reset());
    pending[0].resolve(listResponse([active]));
    await act(() => loading);

    expect(store()).toEqual(useChallengeStore.getInitialState());
  });
});
