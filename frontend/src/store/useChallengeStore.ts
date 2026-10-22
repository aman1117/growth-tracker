/**
 * Challenge Store
 *
 * Caches the signed-in user's challenge list for the Challenges tab and the Home strip.
 *
 * - `fetchChallenges()` shares a load that is already running and reuses a list loaded in the
 *   last 30 seconds; `{ force: true }` always starts a new load, which supersedes older ones.
 * - Responses are applied only if they belong to the newest load, so a slow, older response
 *   can never overwrite newer data (or data of the next user after a sign-out).
 * - Local changes (create, join, leave, delete, a freshly loaded challenge) apply at once. A
 *   list response that was already on its way when one happened may predate it, so it is
 *   fetched again instead of applied.
 *
 * Request bookkeeping lives in the state (not in module variables), so resetting the store
 * also forgets requests that are still in flight. resetUserStores() resets it at sign-in and
 * sign-out; like every store it resets, it must never import the auth store.
 */

import { create } from 'zustand';

import { challengeApi } from '../services/api';
import type { ChallengeDetail, ChallengeStatus, ChallengeSummary } from '../types';
import { getErrorCode, getErrorStatus } from '../utils/challenges';

export type ChallengeListStatus = 'idle' | 'loading' | 'ready' | 'error';

/** A loaded list is reused for this long unless a refresh is forced */
export const CHALLENGES_FRESH_FOR_MS = 30_000;

export interface FetchChallengesOptions {
  /** Load again even if a load is running or the list is fresh */
  force?: boolean;
}

interface ChallengeData {
  /** In the server's order: active (ending first), upcoming (starting first), ended (latest first) */
  challenges: ChallengeSummary[];
  /** `ready` once a list has loaded; a failed refresh keeps the loaded list */
  status: ChallengeListStatus;
  /** Why the last load failed; cleared by the next successful one */
  error: string | null;
  lastFetchedAt: number | null;
  /** Internal: the load that is running, shared by callers that do not force */
  inFlight: Promise<void> | null;
  /** Internal: the only load whose response may still be applied */
  activeRequestId: number | null;
  /** Internal: bumped on every local change */
  revision: number;
}

interface ChallengeActions {
  fetchChallenges: (options?: FetchChallengesOptions) => Promise<void>;
  /** After hours are logged: refreshes when a listed challenge can still change */
  refreshAfterActivityLogged: () => Promise<void>;
  /** Adds or updates a challenge from its detail (after create, join or a detail load) */
  upsertFromDetail: (detail: ChallengeDetail) => void;
  /** Drops a challenge the user left or deleted */
  remove: (id: number) => void;
  reset: () => void;
}

export type ChallengeStore = ChallengeData & ChallengeActions;

const initialData: ChallengeData = {
  challenges: [],
  status: 'idle',
  error: null,
  lastFetchedAt: null,
  inFlight: null,
  activeRequestId: null,
  revision: 0,
};

// Never reset, so a request id is never reused after the store is reset
let requestCounter = 0;

const STATUS_ORDER: Record<ChallengeStatus, number> = { active: 0, upcoming: 1, ended: 2 };

/** The server's order: active by end date, upcoming by start date, ended latest first */
const compareChallenges = (a: ChallengeSummary, b: ChallengeSummary): number => {
  const byStatus = (STATUS_ORDER[a.status] ?? 3) - (STATUS_ORDER[b.status] ?? 3);
  if (byStatus !== 0) return byStatus;
  if (a.status === 'active') return a.end_date.localeCompare(b.end_date);
  if (a.status === 'upcoming') return a.start_date.localeCompare(b.start_date);
  return b.end_date.localeCompare(a.end_date);
};

/** The list entry for a challenge (the detail without its leaderboard and days) */
const toSummary = (detail: ChallengeDetail): ChallengeSummary => ({
  id: detail.id,
  title: detail.title,
  activity: detail.activity,
  goal_type: detail.goal_type,
  target_hours: detail.target_hours,
  start_date: detail.start_date,
  end_date: detail.end_date,
  duration_days: detail.duration_days,
  status: detail.status,
  finalized: detail.finalized,
  day_number: detail.day_number,
  participant_count: detail.participant_count,
  is_creator: detail.is_creator,
  me: detail.me,
});

const isFresh = (lastFetchedAt: number | null): boolean => {
  if (lastFetchedAt === null) return false;
  const age = Date.now() - lastFetchedAt;
  return age >= 0 && age < CHALLENGES_FRESH_FOR_MS;
};

export const useChallengeStore = create<ChallengeStore>((set, get) => {
  const load = (): Promise<void> => {
    const requestId = ++requestCounter;
    const revisionAtStart = get().revision;
    const isCurrent = () => get().activeRequestId === requestId;

    const promise = (async () => {
      try {
        const res = await challengeApi.list();
        if (!isCurrent()) return;
        if (get().revision !== revisionAtStart) {
          // The list changed here while this response was on its way and may predate that
          await load();
          return;
        }
        set({
          challenges: Array.isArray(res.challenges) ? res.challenges : [],
          status: 'ready',
          error: null,
          lastFetchedAt: Date.now(),
          inFlight: null,
          activeRequestId: null,
        });
      } catch (error) {
        if (!isCurrent()) return;
        const keepList = get().status === 'ready';
        console.warn('[Challenges] Could not load the challenge list', {
          errorCode: getErrorCode(error),
          status: getErrorStatus(error),
          recovery: keepList ? 'keep_loaded_list' : 'show_retry',
        });
        set({
          status: keepList ? 'ready' : 'error',
          error: error instanceof Error ? error.message : 'Unknown error',
          inFlight: null,
          activeRequestId: null,
        });
      }
    })();

    set((state) => ({
      inFlight: promise,
      activeRequestId: requestId,
      status: state.status === 'ready' ? 'ready' : 'loading',
    }));
    return promise;
  };

  return {
    ...initialData,

    fetchChallenges: ({ force = false } = {}) => {
      const { inFlight, status, lastFetchedAt } = get();
      if (!force && inFlight) return inFlight;
      if (!force && status === 'ready' && isFresh(lastFetchedAt)) return Promise.resolve();
      return load();
    },

    refreshAfterActivityLogged: () => {
      const { status, challenges, fetchChallenges } = get();
      const canChange = challenges.some(
        (challenge) =>
          challenge.status === 'active' || (challenge.status === 'ended' && !challenge.finalized)
      );
      return status === 'ready' && canChange ? fetchChallenges({ force: true }) : Promise.resolve();
    },

    upsertFromDetail: (detail) =>
      set((state) => {
        const summary = toSummary(detail);
        const exists = state.challenges.some((challenge) => challenge.id === detail.id);
        const challenges = exists
          ? state.challenges.map((challenge) => (challenge.id === detail.id ? summary : challenge))
          : [...state.challenges, summary];
        return { challenges: challenges.sort(compareChallenges), revision: state.revision + 1 };
      }),

    remove: (id) =>
      set((state) => ({
        challenges: state.challenges.filter((challenge) => challenge.id !== id),
        revision: state.revision + 1,
      })),

    reset: () => set({ ...initialData }),
  };
});
