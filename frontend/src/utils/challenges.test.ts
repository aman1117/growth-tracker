import { BookOpen, Moon, Sparkles } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../services/api';
import { ACTIVITY_NAMES, type ChallengeDay, type ChallengeSummary } from '../types';
import {
  addDays,
  buildInviteLink,
  CHALLENGE_LIMIT_MESSAGE,
  clampTarget,
  daysBetween,
  describeChallengeDay,
  describeTodayStatus,
  formatDateRange,
  formatDayCount,
  formatHours,
  formatHoursSpoken,
  formatHoursValue,
  formatOrdinal,
  formatPeopleCount,
  formatRuleText,
  formatShortDate,
  formatStartsIn,
  formatStatusText,
  formatStreak,
  formatTodayChip,
  formatTodayProgress,
  getChallengeActivityLabel,
  getChallengeActivityVisual,
  getChallengeErrorMessage,
  getErrorCode,
  getErrorStatus,
  getIstToday,
  getJoinBlockedMessage,
  getJoinBlockedReason,
  getRatio,
  getRecentDays,
  getStartDateBounds,
  getTargetError,
  getTargetRange,
  getTodayRatio,
  groupChallengesByStatus,
  isChallengeNotFound,
  parseDateKey,
  parseDayCodes,
  parseHoursInput,
  suggestChallengeTitle,
  summarizeDays,
  toDateKey,
} from './challenges';

describe('calendar dates', () => {
  it('parses YYYY-MM-DD as a local calendar date, not UTC midnight', () => {
    const date = parseDateKey('2026-10-23');

    expect(date).not.toBeNull();
    expect([date!.getFullYear(), date!.getMonth(), date!.getDate(), date!.getHours()]).toEqual([
      2026, 9, 23, 0,
    ]);
  });

  it.each([
    '',
    'nope',
    '2026-2-3',
    '2026-02-31',
    '2026-13-01',
    '2026-10-23T00:00:00',
    '0099-01-01',
  ])('rejects %o', (value) => {
    expect(parseDateKey(value)).toBeNull();
  });

  it('formats local dates as keys', () => {
    expect(toDateKey(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });

  it.each([
    ['2026-10-23', 20, '2026-11-12'],
    ['2026-12-31', 1, '2027-01-01'],
    ['2026-03-01', -1, '2026-02-28'],
    ['2028-02-28', 1, '2028-02-29'],
    ['not-a-date', 3, 'not-a-date'],
  ])('addDays(%s, %i) → %s', (key, days, expected) => {
    expect(addDays(key, days)).toBe(expected);
  });

  it.each([
    ['2026-10-22', '2026-10-23', 1],
    ['2026-10-23', '2026-10-22', -1],
    ['2026-10-22', '2026-10-22', 0],
    ['2026-03-01', '2026-04-01', 31],
    ['2026-10-25', '2026-11-02', 8],
    ['bad', '2026-10-22', 0],
  ])('daysBetween(%s, %s) → %i', (from, to, expected) => {
    expect(daysBetween(from, to)).toBe(expected);
  });

  it.each([
    ['2026-10-22T18:29:59.000Z', '2026-10-22'],
    ['2026-10-22T18:30:00.000Z', '2026-10-23'],
    ['2026-12-31T20:00:00.000Z', '2027-01-01'],
  ])('uses the India date for "today" at %s → %s', (instant, expected) => {
    expect(getIstToday(new Date(instant))).toBe(expected);
  });

  it('reads the current time by default', () => {
    vi.setSystemTime(new Date('2026-10-22T20:00:00.000Z'));

    expect(getIstToday()).toBe('2026-10-23');
  });

  it.each([
    ['2026-10-23', 'Oct 23'],
    ['2026-01-05', 'Jan 5'],
    ['garbage', 'garbage'],
  ])('formatShortDate(%s) → %s', (key, expected) => {
    expect(formatShortDate(key)).toBe(expected);
  });

  it.each([
    ['2026-10-23', '2026-11-12', 'Oct 23 – Nov 12'],
    ['2026-10-03', '2026-10-09', 'Oct 3 – 9'],
    ['2026-10-03', '2026-10-03', 'Oct 3'],
    ['2026-12-28', '2027-01-17', 'Dec 28 – Jan 17'],
    ['2026-10-03', '2027-10-09', 'Oct 3 – Oct 9'],
    ['soon', 'later', 'soon – later'],
  ])('formatDateRange(%s, %s) → %s', (start, end, expected) => {
    expect(formatDateRange(start, end)).toBe(expected);
  });

  it('lets a challenge start from today up to 30 days ahead', () => {
    expect(getStartDateBounds('2026-10-22')).toEqual({ min: '2026-10-22', max: '2026-11-21' });
  });
});

describe('numbers and counts', () => {
  it.each([
    [2, '2', '2h', '2 hours'],
    [1.5, '1.5', '1.5h', '1.5 hours'],
    [0.25, '0.25', '0.25h', '0.25 hours'],
    [23.75, '23.75', '23.75h', '23.75 hours'],
    [0, '0', '0h', '0 hours'],
    [1, '1', '1h', '1 hour'],
    [0.1 + 0.2, '0.3', '0.3h', '0.3 hours'],
  ])('formats %d hours', (hours, value, short, spoken) => {
    expect(formatHoursValue(hours)).toBe(value);
    expect(formatHours(hours)).toBe(short);
    expect(formatHoursSpoken(hours)).toBe(spoken);
  });

  it('counts people, days and streaks', () => {
    expect(formatPeopleCount(1)).toBe('1 person');
    expect(formatPeopleCount(4)).toBe('4 people');
    expect(formatPeopleCount(0)).toBe('0 people');
    expect(formatDayCount(1)).toBe('1 day');
    expect(formatDayCount(21)).toBe('21 days');
    expect(formatStreak(0)).toBeNull();
    expect(formatStreak(3)).toBe('3-day streak');
  });

  it.each([
    [5, 20, 0.25],
    [0, 0, 0],
    [30, 21, 1],
    [-1, 5, 0],
  ])('getRatio(%d, %d) → %d', (value, max, expected) => {
    expect(getRatio(value, max)).toBe(expected);
  });

  it.each([
    [1, '1st'],
    [2, '2nd'],
    [3, '3rd'],
    [4, '4th'],
    [11, '11th'],
    [12, '12th'],
    [13, '13th'],
    [21, '21st'],
    [22, '22nd'],
    [23, '23rd'],
    [50, '50th'],
    [111, '111th'],
  ])('formatOrdinal(%d) → %s', (value, expected) => {
    expect(formatOrdinal(value)).toBe(expected);
  });
});

describe('goals and titles', () => {
  it('names activities with the default labels', () => {
    expect(getChallengeActivityLabel('study')).toBe('Study');
    expect(getChallengeActivityLabel('book_reading')).toBe('Reading');
    expect(getChallengeActivityLabel('night_owling')).toBe('Night Owling');
  });

  it('gives every activity its default colour and icon, ignoring personal tile settings', () => {
    expect(getChallengeActivityVisual('study')).toEqual({
      label: 'Study',
      color: '#3b82f6',
      Icon: BookOpen,
    });
    expect(getChallengeActivityVisual('sleep').Icon).toBe(Moon);
    expect(getChallengeActivityVisual('night_owling')).toMatchObject({ color: '#64748b' });
  });

  it('falls back to a generic icon for activities named by icon (custom tiles)', () => {
    expect(getChallengeActivityVisual('custom:1234')).toEqual({
      label: 'Custom',
      color: '#64748b',
      Icon: Sparkles,
    });
  });

  it.each([
    [{ activity: 'study', goal_type: 'at_least', target_hours: 2 }, 'At least 2h of Study a day'],
    [{ activity: 'reels', goal_type: 'at_most', target_hours: 1 }, 'At most 1h of Reels a day'],
    [{ activity: 'reels', goal_type: 'at_most', target_hours: 0 }, 'No Reels at all'],
    [
      { activity: 'workout', goal_type: 'at_least', target_hours: 0.25 },
      'At least 0.25h of Workout a day',
    ],
  ] as const)('rule for %o → %s', (goal, text) => {
    expect(formatRuleText(goal)).toBe(text);
  });

  it.each([
    [{ activity: 'study', goal_type: 'at_least', target_hours: 2 }, 'Study 2h+ a day'],
    [{ activity: 'study', goal_type: 'at_least', target_hours: 1.5 }, 'Study 1.5h+ a day'],
    [{ activity: 'reels', goal_type: 'at_most', target_hours: 1 }, 'Reels under 1h a day'],
    [{ activity: 'reels', goal_type: 'at_most', target_hours: 0 }, 'Reels-free days'],
  ] as const)('suggests a title for %o → %s', (goal, title) => {
    expect(suggestChallengeTitle(goal)).toBe(title);
  });

  it('keeps every suggested title within the 60-character limit', () => {
    for (const activity of ACTIVITY_NAMES) {
      for (const goal of [
        { goal_type: 'at_least', target_hours: 23.75 },
        { goal_type: 'at_most', target_hours: 23.75 },
        { goal_type: 'at_most', target_hours: 0 },
      ] as const) {
        const title = suggestChallengeTitle({ activity, ...goal });
        expect(title.length).toBeGreaterThan(0);
        expect(Array.from(title).length).toBeLessThanOrEqual(60);
      }
    }
  });
});

const summary = (overrides: Partial<ChallengeSummary> = {}) => ({
  status: 'active' as ChallengeSummary['status'],
  finalized: false,
  start_date: '2026-10-23',
  end_date: '2026-11-12',
  duration_days: 21,
  day_number: 5 as number | null,
  ...overrides,
});

describe('formatStatusText', () => {
  it.each([
    ['today', '2026-10-23', 'Starts today'],
    ['after the server already started it', '2026-10-24', 'Starts today'],
    ['tomorrow', '2026-10-22', 'Starts tomorrow'],
    ['later', '2026-10-20', 'Starts Oct 23'],
  ])('announces an upcoming challenge that starts %s', (_label, today, text) => {
    expect(formatStatusText(summary({ status: 'upcoming', day_number: null }), today)).toBe(text);
  });

  it('counts the days of an active challenge', () => {
    expect(formatStatusText(summary(), '2026-10-27')).toBe('Day 5 of 21');
    expect(formatStatusText(summary({ day_number: null }), '2026-10-29')).toBe('Day 7 of 21');
    expect(formatStatusText(summary({ day_number: 0 }), '2026-10-23')).toBe('Day 1 of 21');
  });

  it('calls out the last day', () => {
    expect(formatStatusText(summary({ day_number: 21 }), '2026-11-12')).toBe('Last day');
    expect(formatStatusText(summary({ day_number: 22 }), '2026-11-13')).toBe('Last day');
  });

  it('tells when the results of an ended challenge become final', () => {
    const ended = summary({ status: 'ended', day_number: null });

    expect(formatStatusText(ended, '2026-11-13')).toBe('Ended · final results on Nov 14');
    expect(formatStatusText({ ...ended, results_date: '2026-11-15' }, '2026-11-13')).toBe(
      'Ended · final results on Nov 15'
    );
    expect(formatStatusText({ ...ended, finalized: true }, '2026-11-20')).toBe('Ended Nov 12');
  });

  it.each([
    ['2026-10-23', 'Starts today'],
    ['2026-10-25', 'Starts today'],
    ['2026-10-22', 'Starts tomorrow'],
    ['2026-10-18', 'Starts in 5 days'],
  ])('formatStartsIn on %s → %s', (today, text) => {
    expect(formatStartsIn('2026-10-23', today)).toBe(text);
  });
});

it('groups challenges by status, keeping their order', () => {
  const challenges = [
    { id: 1, status: 'active' },
    { id: 2, status: 'upcoming' },
    { id: 3, status: 'ended' },
    { id: 4, status: 'active' },
  ] as ChallengeSummary[];

  expect(groupChallengesByStatus(challenges)).toEqual({
    active: [challenges[0], challenges[3]],
    upcoming: [challenges[1]],
    ended: [challenges[2]],
  });
});

it('builds invite links on the app origin', () => {
  expect(buildInviteLink('https://trackgrowth.in', 'ABCD2345')).toBe(
    'https://trackgrowth.in/c/ABCD2345'
  );
});

describe("today's progress", () => {
  const atLeast = { activity: 'study', goal_type: 'at_least', target_hours: 2 } as const;
  const atMost = { activity: 'reels', goal_type: 'at_most', target_hours: 1 } as const;

  it.each([
    [atLeast, 1.5, 'pending', '1.5 / 2h today', '1.5 / 2h today – 0.5h to go'],
    [atLeast, null, 'pending', '0 / 2h today', '0 / 2h today – 2h to go'],
    [atLeast, 2.5, 'met', '2.5 / 2h today', 'Done for today'],
    [atLeast, 3, 'missed', '3 / 2h today', '3 / 2h today – 0h to go'],
    [atMost, 0.5, 'met', '0.5 / 1h today', '0.5h of 1h max so far'],
    [atMost, 1.5, 'missed', '1.5 / 1h today', 'Over the limit today'],
    [atMost, 0, 'pending', 'Not logged yet', 'Not logged yet'],
    [{ ...atMost, target_hours: 0 }, 0, 'met', '0h today', 'Reels-free so far today'],
    [{ ...atMost, target_hours: 0 }, 0.5, 'missed', '0.5h today', 'Over the limit today'],
  ] as const)('%o with %o hours, %s → "%s" / "%s"', (goal, hours, status, chip, progress) => {
    const input = { ...goal, today_hours: hours, today_status: status };
    expect(formatTodayChip(input)).toBe(chip);
    expect(formatTodayProgress(input)).toBe(progress);
  });

  it('says nothing when today does not count', () => {
    const input = { ...atLeast, today_hours: null, today_status: null };
    expect(formatTodayChip(input)).toBeNull();
    expect(formatTodayProgress(input)).toBeNull();
  });

  it.each([
    [2, 1.5, 0.75],
    [2, null, 0],
    [1, 3, 1],
    [0, 0, 0],
    [0, 0.5, 1],
  ])('getTodayRatio(target %d, hours %o) → %d', (target, hours, ratio) => {
    expect(getTodayRatio(target, hours)).toBe(ratio);
  });

  it.each([
    ['at_least', 'met', 'Done today'],
    ['at_least', 'missed', 'Missed today'],
    ['at_least', 'pending', 'Not done yet today'],
    ['at_most', 'met', 'Within the limit today'],
    ['at_most', 'missed', 'Over the limit today'],
    ['at_most', 'pending', 'Not logged yet today'],
  ] as const)('describes %s / %s as "%s"', (goal, status, text) => {
    expect(describeTodayStatus(goal, status)).toBe(text);
  });
});

describe('days', () => {
  const day = (overrides: Partial<ChallengeDay>): ChallengeDay => ({
    date: '2026-10-23',
    hours: 2.5,
    status: 'met',
    locked: true,
    ...overrides,
  });

  it.each([
    [day({}), false, 'Oct 23: met, 2.5 hours'],
    [day({ status: 'pending', hours: 1 }), true, 'Oct 23 (today): pending, 1 hour'],
    [day({ status: 'missed', hours: 0 }), false, 'Oct 23: missed, 0 hours'],
    [day({ status: 'upcoming', hours: null }), false, 'Oct 23: upcoming'],
    [day({ status: 'none', hours: null }), false, 'Oct 23: not taking part'],
    [day({ status: 'mystery' as ChallengeDay['status'], hours: null }), false, 'Oct 23: mystery'],
  ])('describes %o (today: %s)', (value, isToday, label) => {
    expect(describeChallengeDay(value, isToday)).toBe(label);
  });

  it('decodes day strings', () => {
    expect(parseDayCodes('MXPU-?')).toEqual([
      'met',
      'missed',
      'pending',
      'upcoming',
      'none',
      'none',
    ]);
  });

  const days = 'MMXMMPPUUUUUUUUUUUUUU'; // 21 days from Oct 1; today is Oct 7 (index 6)

  it.each([
    ['in the middle', '2026-10-07', ['M', 'M', 'X', 'M', 'M', 'P', 'P']],
    ['early on', '2026-10-03', ['M', 'M', 'X']],
    ['after the end', '2026-11-30', ['U', 'U', 'U', 'U', 'U', 'U', 'U']],
    ['before the start', '2026-09-30', []],
  ])('takes the last 7 days %s', (_label, today, codes) => {
    expect(getRecentDays(days, '2026-10-01', today)).toEqual(parseDayCodes(codes.join('')));
  });

  it('returns nothing without days and supports other window sizes', () => {
    expect(getRecentDays('', '2026-10-01', '2026-10-07')).toEqual([]);
    expect(getRecentDays(days, '2026-10-01', '2026-10-07', 2)).toEqual(['pending', 'pending']);
  });

  it.each([
    [['met', 'met', 'missed', 'pending'], '2 met, 1 missed, 1 pending'],
    [['none', 'met', 'none'], '1 met, 2 not taking part'],
    [['upcoming'], '1 upcoming'],
    [[], 'no days yet'],
  ] as const)('summarizes %o as "%s"', (statuses, text) => {
    expect(summarizeDays([...statuses])).toBe(text);
  });
});

describe('daily target input', () => {
  it('allows 0.25–24 hours for "at least" and 0–23.75 for "at most"', () => {
    expect(getTargetRange('at_least')).toEqual({ min: 0.25, max: 24 });
    expect(getTargetRange('at_most')).toEqual({ min: 0, max: 23.75 });
  });

  it.each([
    ['at_least', 0, 0.25],
    ['at_least', 30, 24],
    ['at_least', 1.3, 1.25],
    ['at_least', 1.38, 1.5],
    ['at_most', 24, 23.75],
    ['at_most', -1, 0],
    ['at_most', 0, 0],
  ] as const)('clampTarget(%s, %d) → %d', (goal, hours, expected) => {
    expect(clampTarget(goal, hours)).toBe(expected);
  });

  it.each([
    ['1.5', 1.5],
    ['1,5', 1.5],
    [' 2 ', 2],
    ['', null],
    ['abc', null],
  ])('parseHoursInput(%o) → %o', (raw, expected) => {
    expect(parseHoursInput(raw)).toBe(expected);
  });

  it.each([
    ['at_least', '2', null],
    ['at_least', '0.25', null],
    ['at_least', '24', null],
    ['at_least', '0', 'Pick between 0.25 and 24 hours'],
    ['at_least', '24.25', 'Pick between 0.25 and 24 hours'],
    ['at_least', 'x', 'Pick between 0.25 and 24 hours'],
    ['at_least', '1.3', 'Use quarter hours, e.g. 0.25, 1.5 or 2'],
    ['at_most', '0', null],
    ['at_most', '23.75', null],
    ['at_most', '24', 'Pick between 0 and 23.75 hours'],
  ] as const)('getTargetError(%s, %o) → %o', (goal, raw, expected) => {
    expect(getTargetError(goal, raw)).toBe(expected);
  });
});

describe('errors', () => {
  const apiError = (status: number, code?: string, message = 'Request failed') =>
    new ApiError(message, status, code);

  it('reads the error code and status of failed requests', () => {
    expect(getErrorCode(apiError(409, 'CHALLENGE_FULL'))).toBe('CHALLENGE_FULL');
    expect(getErrorCode(apiError(500))).toBeUndefined();
    expect(getErrorCode(new TypeError('Failed to fetch'))).toBeUndefined();
    expect(getErrorCode(null)).toBeUndefined();
    expect(getErrorStatus(apiError(404))).toBe(404);
    expect(getErrorStatus(new TypeError('Failed to fetch'))).toBeUndefined();
    expect(getErrorStatus(undefined)).toBeUndefined();
  });

  it.each([
    [apiError(404), true],
    [apiError(404, 'CHALLENGE_NOT_FOUND'), true],
    [apiError(410, 'CHALLENGE_NOT_FOUND'), true],
    [apiError(409, 'CHALLENGE_FULL'), false],
    [new TypeError('Failed to fetch'), false],
  ])('isChallengeNotFound(%o) → %s', (error, expected) => {
    expect(isChallengeNotFound(error)).toBe(expected);
  });

  it('explains why a challenge cannot be joined', () => {
    expect(CHALLENGE_LIMIT_MESSAGE).toBe("You're already in 10 challenges – finish one first");
    expect(getJoinBlockedMessage('ended')).toBe('This challenge has ended');
    expect(getJoinBlockedMessage('full')).toBe('This challenge is full');
    expect(getJoinBlockedMessage('limit')).toBe(CHALLENGE_LIMIT_MESSAGE);
    expect(getJoinBlockedMessage('closed' as 'full')).toBe("You can't join this challenge");
  });

  it.each([
    ['CHALLENGE_ENDED', 'ended'],
    ['CHALLENGE_FULL', 'full'],
    ['CHALLENGE_LIMIT_REACHED', 'limit'],
    ['CHALLENGE_NOT_FOUND', null],
  ])('maps a join failure with %s to %o', (code, reason) => {
    expect(getJoinBlockedReason(apiError(409, code))).toBe(reason);
  });

  it.each([
    [apiError(409, 'CHALLENGE_LIMIT_REACHED'), 'create', CHALLENGE_LIMIT_MESSAGE],
    [apiError(409, 'CHALLENGE_FULL'), 'join', 'This challenge is full'],
    [apiError(409, 'CHALLENGE_ENDED'), 'leave', 'This challenge has ended'],
    [
      apiError(409, 'CHALLENGE_NOT_ACTIVE'),
      'cheer',
      'Cheers are only possible while a challenge is running',
    ],
    [
      apiError(409, 'CREATOR_CANNOT_LEAVE'),
      'leave',
      "You started this challenge, so you can't leave it",
    ],
    [
      apiError(409, 'CHALLENGE_IN_PROGRESS'),
      'delete',
      "This challenge is under way with others in it, so it can't be deleted",
    ],
    [apiError(404, 'CHALLENGE_NOT_FOUND'), 'invite', 'This challenge no longer exists'],
    [apiError(400, 'CANNOT_CHEER_SELF'), 'cheer', "You can't cheer yourself"],
    [
      apiError(400, 'INVALID_CHALLENGE', 'title must be 1-60 characters'),
      'create',
      'title must be 1-60 characters',
    ],
    [apiError(400, 'INVALID_CHALLENGE', ''), 'create', "Couldn't create the challenge. Try again."],
    [apiError(500), 'join', "Couldn't join the challenge. Try again."],
    [
      new TypeError('Failed to fetch'),
      'load',
      "Couldn't load the challenge. Check your connection and try again.",
    ],
    [
      new TypeError('Failed to fetch'),
      'invite',
      "Couldn't send the invites. Check your connection and try again.",
    ],
  ] as const)('explains %o when trying to %s', (error, action, message) => {
    expect(getChallengeErrorMessage(error, action)).toBe(message);
  });
});
