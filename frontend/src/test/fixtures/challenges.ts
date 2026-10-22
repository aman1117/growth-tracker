/**
 * Fixtures for the Challenges feature: API-shaped builders (see src/types/challenge.ts) and a
 * mocked `challengeApi`.
 *
 * This module must not import `services/api` at runtime: test files mock that module and load
 * `createChallengeApiMock` from their `vi.mock` factories.
 */
import { vi } from 'vitest';

import type { challengeApi } from '../../services/api';
import type {
  ChallengeDay,
  ChallengeDayStatus,
  ChallengeDetail,
  ChallengeParticipant,
  ChallengePreview,
  ChallengeProgress,
  ChallengeSummary,
  ChallengeUser,
  InviteCandidate,
} from '../../types';

// ============================================================================
// Time and people
// ============================================================================

/** "Now" in challenge tests: Thursday 22 Oct 2026, 12:00 in India (06:30 UTC) */
export const CHALLENGE_NOW = new Date('2026-10-22T06:30:00.000Z');
/** The IST date of CHALLENGE_NOW */
export const IST_TODAY = '2026-10-22';

/** The signed-in user in challenge tests */
export const ME = { id: 1, username: 'alice' } as const;

export function makeChallengeUser(overrides: Partial<ChallengeUser> = {}): ChallengeUser {
  const id = overrides.id ?? 2;
  return {
    id,
    username: id === ME.id ? ME.username : `user${id}`,
    profile_pic: null,
    profile_pic_thumb: null,
    is_verified: false,
    ...overrides,
  };
}

export const ALICE_USER = makeChallengeUser({ id: ME.id, username: ME.username });
export const BOB_USER = makeChallengeUser({
  id: 2,
  username: 'bob',
  profile_pic: 'https://cdn.test/bob.jpg',
  profile_pic_thumb: 'https://cdn.test/bob-thumb.jpg',
  is_verified: true,
});
export const CAROL_USER = makeChallengeUser({ id: 3, username: 'carol' });

// ============================================================================
// Challenges
// ============================================================================

/** Me in an active challenge: 3 of 4 elapsed days met, 1.5 of 2h logged today */
export function makeProgress(overrides: Partial<ChallengeProgress> = {}): ChallengeProgress {
  return {
    rank: 1,
    days_met: 3,
    days_elapsed: 5,
    days_possible: 21,
    current_streak: 2,
    total_hours: 9.5,
    today_hours: 1.5,
    today_status: 'pending',
    completed: null,
    ...overrides,
  };
}

/** "Study 2h+ a day": active, day 5 of 21 (Oct 18 – Nov 7), 3 people, created by me */
export function makeChallengeSummary(overrides: Partial<ChallengeSummary> = {}): ChallengeSummary {
  return {
    id: 42,
    title: 'Study 2h+ a day',
    activity: 'study',
    goal_type: 'at_least',
    target_hours: 2,
    start_date: '2026-10-18',
    end_date: '2026-11-07',
    duration_days: 21,
    status: 'active',
    finalized: false,
    day_number: 5,
    participant_count: 3,
    is_creator: true,
    me: makeProgress(),
    ...overrides,
  };
}

/** Starts tomorrow (Oct 23 – Nov 12); nobody has a rank or days yet */
export function makeUpcomingSummary(overrides: Partial<ChallengeSummary> = {}): ChallengeSummary {
  return makeChallengeSummary({
    id: 43,
    title: 'Reels under 1h a day',
    activity: 'reels',
    goal_type: 'at_most',
    target_hours: 1,
    start_date: '2026-10-23',
    end_date: '2026-11-12',
    status: 'upcoming',
    day_number: null,
    participant_count: 1,
    me: makeProgress({
      rank: null,
      days_met: 0,
      days_elapsed: 0,
      current_streak: 0,
      total_hours: 0,
      today_hours: null,
      today_status: null,
    }),
    ...overrides,
  });
}

/** Ended Oct 10 and finalized: I finished 2nd and completed it */
export function makeEndedSummary(overrides: Partial<ChallengeSummary> = {}): ChallengeSummary {
  return makeChallengeSummary({
    id: 41,
    title: 'Workout 1h+ a day',
    activity: 'workout',
    target_hours: 1,
    start_date: '2026-09-20',
    end_date: '2026-10-10',
    status: 'ended',
    finalized: true,
    day_number: null,
    participant_count: 4,
    is_creator: false,
    me: makeProgress({
      rank: 2,
      days_met: 18,
      days_elapsed: 21,
      current_streak: 0,
      total_hours: 25,
      today_hours: null,
      today_status: null,
      completed: true,
    }),
    ...overrides,
  });
}

const DAY_CODES: Record<string, ChallengeDayStatus> = {
  M: 'met',
  X: 'missed',
  P: 'pending',
  U: 'upcoming',
  '-': 'none',
};
const DAY_HOURS: Record<ChallengeDayStatus, number | null> = {
  met: 2.5,
  missed: 0.5,
  pending: 1.5,
  upcoming: null,
  none: null,
};

/** One day per code from `startDate` (codes as in `ChallengeParticipant.days`) */
export function makeDays(startDate: string, codes: string, lockedThrough?: string): ChallengeDay[] {
  const [year, month, day] = startDate.split('-').map(Number);
  return Array.from(codes, (code, index) => {
    const date = new Date(year, month - 1, day + index);
    const key = [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0'),
    ].join('-');
    const status = DAY_CODES[code];
    return {
      date: key,
      hours: DAY_HOURS[status],
      status,
      locked: !!lockedThrough && key <= lockedThrough && status !== 'none',
    };
  });
}

/** My days in the default challenge: met, missed, met, met, pending today, then upcoming */
export const MY_DAYS_CODES = `MXMMP${'U'.repeat(16)}`;

export function makeParticipant(
  overrides: Partial<ChallengeParticipant> = {}
): ChallengeParticipant {
  return {
    ...makeProgress(),
    user: BOB_USER,
    joined_on: '2026-10-17',
    is_me: false,
    cheered_today: false,
    days: MY_DAYS_CODES,
    ...overrides,
  };
}

/** The default challenge as its detail: me (#1), bob (#2, verified) and carol (#3) */
export function makeChallengeDetail(overrides: Partial<ChallengeDetail> = {}): ChallengeDetail {
  const summary = makeChallengeSummary();
  return {
    ...summary,
    invite_code: 'ABCD2345',
    today: IST_TODAY,
    locked_through: '2026-10-20',
    results_date: '2026-11-09',
    completion_days: 17,
    max_participants: 50,
    creator: ALICE_USER,
    can_invite: true,
    can_leave: false,
    can_delete: false,
    participants: [
      makeParticipant({ ...summary.me, user: ALICE_USER, is_me: true }),
      makeParticipant({
        user: BOB_USER,
        rank: 2,
        days_met: 2,
        current_streak: 1,
        today_hours: 2,
        today_status: 'met',
        days: `XMXMM${'U'.repeat(16)}`,
      }),
      makeParticipant({
        user: CAROL_USER,
        rank: 3,
        days_met: 0,
        current_streak: 0,
        today_hours: 0,
        today_status: 'pending',
        joined_on: '2026-10-21',
        days: `---XP${'U'.repeat(16)}`,
      }),
    ],
    my_days: makeDays(summary.start_date, MY_DAYS_CODES, '2026-10-20'),
    ...overrides,
  };
}

export function makeInviteCandidate(overrides: Partial<InviteCandidate> = {}): InviteCandidate {
  return { ...makeChallengeUser(overrides), invited: false, ...overrides };
}

/** What bob's invite link to the default challenge shows me (not taking part yet) */
export function makeChallengePreview(overrides: Partial<ChallengePreview> = {}): ChallengePreview {
  const summary = makeChallengeSummary();
  return {
    id: summary.id,
    title: summary.title,
    activity: summary.activity,
    goal_type: summary.goal_type,
    target_hours: summary.target_hours,
    start_date: summary.start_date,
    end_date: summary.end_date,
    duration_days: summary.duration_days,
    status: summary.status,
    finalized: summary.finalized,
    participant_count: 3,
    max_participants: 50,
    creator: BOB_USER,
    participants_preview: [BOB_USER, CAROL_USER, makeChallengeUser({ id: 4 })],
    is_participant: false,
    can_join: true,
    join_blocked_reason: null,
    ...overrides,
  };
}

// ============================================================================
// Mocked API
// ============================================================================

type ChallengeApiMock = {
  [K in keyof typeof challengeApi]: ReturnType<typeof vi.fn>;
};

/** A `challengeApi` whose methods are all unconfigured spies (for `vi.mock` factories) */
export function createChallengeApiMock(): ChallengeApiMock {
  return {
    list: vi.fn(),
    create: vi.fn(),
    get: vi.fn(),
    remove: vi.fn(),
    leave: vi.fn(),
    cheer: vi.fn(),
    getInviteCandidates: vi.fn(),
    invite: vi.fn(),
    getPreview: vi.fn(),
    join: vi.fn(),
  };
}

export const listResponse = (challenges: ChallengeSummary[]) => ({ success: true, challenges });
export const detailResponse = (challenge: ChallengeDetail) => ({ success: true, challenge });
