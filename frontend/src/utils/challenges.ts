/**
 * Challenge helpers
 *
 * Pure formatting, date and error helpers shared by the Challenges screens, the Home strip
 * and the challenge store.
 *
 * Challenge dates are IST calendar dates ("YYYY-MM-DD"). They are parsed as local calendar
 * dates — never with `new Date('YYYY-MM-DD')`, which is UTC midnight and shows the previous
 * day west of UTC. "Today" is the server's IST date: prefer `ChallengeDetail.today` and fall
 * back to `getIstToday()`.
 */

import type { LucideIcon } from 'lucide-react';
import { Sparkles } from 'lucide-react';

import { getActivityConfig } from '../constants/activities';
import {
  CHALLENGE_ERROR_CODES,
  CHALLENGE_LIMITS,
  CHALLENGE_TIME_ZONE,
} from '../constants/challenges';
import { APP_ROUTES } from '../constants/routes';
import type {
  ActivityName,
  ChallengeDay,
  ChallengeDayStatus,
  ChallengeGoalType,
  ChallengeJoinBlockedReason,
  ChallengeProgress,
  ChallengeStatus,
  ChallengeSummary,
  ChallengeTodayStatus,
} from '../types';
import { truncateToCharacters } from './text';

// ============================================================================
// Dates
// ============================================================================

const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

const IST_DATE_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: CHALLENGE_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const SHORT_DATE_FORMAT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });

/** Parses "YYYY-MM-DD" as a local calendar date; null when it is not a real date */
export const parseDateKey = (value: string): Date | null => {
  const match = DATE_KEY_PATTERN.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(year, month, day);
  // Rejects dates that overflow into the next month, e.g. 2026-02-31
  const isExact =
    date.getFullYear() === year && date.getMonth() === month && date.getDate() === day;
  return isExact ? date : null;
};

/** A local date as "YYYY-MM-DD" */
export const toDateKey = (date: Date): string =>
  [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');

/** The calendar date `days` after `key` (before it when negative); invalid keys are returned as-is */
export const addDays = (key: string, days: number): string => {
  const date = parseDateKey(key);
  if (!date) return key;
  date.setDate(date.getDate() + days);
  return toDateKey(date);
};

const toUtcDay = (key: string): number | null => {
  const date = parseDateKey(key);
  return date ? Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) : null;
};

/** Whole calendar days from `from` to `to` (negative when `to` is earlier; 0 when invalid) */
export const daysBetween = (from: string, to: string): number => {
  const start = toUtcDay(from);
  const end = toUtcDay(to);
  if (start === null || end === null) return 0;
  return Math.round((end - start) / MS_PER_DAY);
};

/** Today's calendar date in India — the date the server calls "today" */
export const getIstToday = (now: Date = new Date()): string => {
  const parts = IST_DATE_FORMAT.formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
};

/** "Oct 23" */
export const formatShortDate = (key: string): string => {
  const date = parseDateKey(key);
  return date ? SHORT_DATE_FORMAT.format(date) : key;
};

/** "Oct 23 – Nov 12", or "Oct 3 – 9" within one month */
export const formatDateRange = (start: string, end: string): string => {
  const startDate = parseDateKey(start);
  const endDate = parseDateKey(end);
  if (!startDate || !endDate) return `${start} – ${end}`;
  if (start === end) return formatShortDate(start);
  const sameMonth =
    startDate.getFullYear() === endDate.getFullYear() &&
    startDate.getMonth() === endDate.getMonth();
  return `${formatShortDate(start)} – ${sameMonth ? endDate.getDate() : formatShortDate(end)}`;
};

/** First and last date a new challenge may start on (IST), as for a date input's min/max */
export const getStartDateBounds = (today: string): { min: string; max: string } => ({
  min: today,
  max: addDays(today, CHALLENGE_LIMITS.MAX_START_OFFSET_DAYS),
});

// ============================================================================
// Numbers and counts
// ============================================================================

/** 2 → "2", 1.5 → "1.5", 0.25 → "0.25" */
export const formatHoursValue = (hours: number): string => String(Math.round(hours * 100) / 100);

/** 2 → "2h", 1.5 → "1.5h", 0.25 → "0.25h" */
export const formatHours = (hours: number): string => `${formatHoursValue(hours)}h`;

/** 1 → "1 hour", 2.5 → "2.5 hours" (for screen readers) */
export const formatHoursSpoken = (hours: number): string =>
  `${formatHoursValue(hours)} ${hours === 1 ? 'hour' : 'hours'}`;

const pluralize = (count: number, singular: string, plural = `${singular}s`) =>
  `${count} ${count === 1 ? singular : plural}`;

/** "1 person", "4 people" */
export const formatPeopleCount = (count: number): string => pluralize(count, 'person', 'people');

/** "1 day", "21 days" */
export const formatDayCount = (count: number): string => pluralize(count, 'day');

/** "3-day streak", or null without a streak */
export const formatStreak = (days: number): string | null =>
  days > 0 ? `${days}-day streak` : null;

const ORDINAL_SUFFIXES: Record<number, string> = { 1: 'st', 2: 'nd', 3: 'rd' };

/** 1 → "1st", 2 → "2nd", 11 → "11th", 23 → "23rd" */
export const formatOrdinal = (value: number): string => {
  const tens = value % 100;
  if (tens >= 11 && tens <= 13) return `${value}th`;
  return `${value}${ORDINAL_SUFFIXES[value % 10] ?? 'th'}`;
};

/** Share of `value` in `max`, clamped to 0–1 (0 when there is nothing to fill) */
export const getRatio = (value: number, max: number): number =>
  max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;

// ============================================================================
// Goals, titles and status
// ============================================================================

type ChallengeGoal = Pick<ChallengeSummary, 'activity' | 'goal_type' | 'target_hours'>;

export interface ChallengeActivityVisual {
  label: string;
  /** Hex colour of the activity in the default palette */
  color: string;
  Icon: LucideIcon;
}

/**
 * Name, colour and icon of a challenge activity. Challenges only use the 16 predefined
 * activities, so the default palette is used — every participant sees the same names and
 * colours (custom tiles and colour overrides are per user).
 */
export const getChallengeActivityVisual = (activity: string): ChallengeActivityVisual => {
  const config = getActivityConfig(activity as ActivityName, [], {});
  return {
    label: config.label,
    color: config.color,
    Icon: typeof config.icon === 'string' ? Sparkles : config.icon,
  };
};

/** Display name of a challenge activity (see getChallengeActivityVisual) */
export const getChallengeActivityLabel = (activity: string): string =>
  getChallengeActivityVisual(activity).label;

/** "At least 2h of Study a day", "At most 1h of Reels a day", "No Reels at all" */
export const formatRuleText = ({ activity, goal_type, target_hours }: ChallengeGoal): string => {
  const label = getChallengeActivityLabel(activity);
  if (goal_type === 'at_least') return `At least ${formatHours(target_hours)} of ${label} a day`;
  if (target_hours <= 0) return `No ${label} at all`;
  return `At most ${formatHours(target_hours)} of ${label} a day`;
};

/** "Study 2h+ a day", "Reels under 1h a day", "Reels-free days" (never over the title limit) */
export const suggestChallengeTitle = ({
  activity,
  goal_type,
  target_hours,
}: ChallengeGoal): string => {
  const label = getChallengeActivityLabel(activity);
  let title: string;
  if (goal_type === 'at_least') title = `${label} ${formatHours(target_hours)}+ a day`;
  else if (target_hours <= 0) title = `${label}-free days`;
  else title = `${label} under ${formatHours(target_hours)} a day`;
  return truncateToCharacters(title, CHALLENGE_LIMITS.TITLE_MAX_LENGTH);
};

type StatusInput = Pick<
  ChallengeSummary,
  'status' | 'finalized' | 'start_date' | 'end_date' | 'duration_days' | 'day_number'
> & {
  /** end_date + 2 unless given */
  results_date?: string;
};

/**
 * "Starts tomorrow", "Day 5 of 21", "Last day", "Ended · final results on Nov 14" (before the
 * results are final) or "Ended Nov 12"
 */
export const formatStatusText = (challenge: StatusInput, today: string): string => {
  if (challenge.status === 'upcoming') {
    const daysUntil = daysBetween(today, challenge.start_date);
    if (daysUntil <= 0) return 'Starts today';
    if (daysUntil === 1) return 'Starts tomorrow';
    return `Starts ${formatShortDate(challenge.start_date)}`;
  }

  if (challenge.status === 'active') {
    const day = challenge.day_number ?? daysBetween(challenge.start_date, today) + 1;
    if (day >= challenge.duration_days) return 'Last day';
    return `Day ${Math.max(1, day)} of ${challenge.duration_days}`;
  }

  if (challenge.finalized) return `Ended ${formatShortDate(challenge.end_date)}`;
  const resultsDate = challenge.results_date ?? addDays(challenge.end_date, 2);
  return `Ended · final results on ${formatShortDate(resultsDate)}`;
};

/** "Starts today", "Starts tomorrow" or "Starts in 5 days" */
export const formatStartsIn = (startDate: string, today: string): string => {
  const daysUntil = daysBetween(today, startDate);
  if (daysUntil <= 0) return 'Starts today';
  if (daysUntil === 1) return 'Starts tomorrow';
  return `Starts in ${daysUntil} days`;
};

/** Sections of the Challenges list, in the server's order */
export const groupChallengesByStatus = (
  challenges: ChallengeSummary[]
): Record<ChallengeStatus, ChallengeSummary[]> => ({
  active: challenges.filter((challenge) => challenge.status === 'active'),
  upcoming: challenges.filter((challenge) => challenge.status === 'upcoming'),
  ended: challenges.filter((challenge) => challenge.status === 'ended'),
});

/** Full invite link for sharing, e.g. https://trackgrowth.in/c/ABCD2345 */
export const buildInviteLink = (origin: string, inviteCode: string): string =>
  `${origin}${APP_ROUTES.JOIN_CHALLENGE(inviteCode)}`;

// ============================================================================
// Today's progress
// ============================================================================

type TodayInput = ChallengeGoal & Pick<ChallengeProgress, 'today_hours' | 'today_status'>;

/** Compact progress for cards: "1.5 / 2h today", "0.5h today" for a 0h limit (null when today does not count) */
export const formatTodayChip = ({
  goal_type,
  target_hours,
  today_hours,
  today_status,
}: TodayInput): string | null => {
  if (today_status === null) return null;
  if (goal_type === 'at_most' && today_status === 'pending') return 'Not logged yet';
  if (goal_type === 'at_most' && target_hours <= 0) return `${formatHours(today_hours ?? 0)} today`;
  return `${formatHoursValue(today_hours ?? 0)} / ${formatHours(target_hours)} today`;
};

/**
 * Today's status in words: "1.5 / 2h today – 0.5h to go", "Done for today", or for "at most"
 * goals "0.5h of 1h max so far", "Over the limit today" and "Not logged yet"
 */
export const formatTodayProgress = (input: TodayInput): string | null => {
  const { goal_type, target_hours, today_hours, today_status } = input;
  if (today_status === null) return null;
  const hours = today_hours ?? 0;

  if (goal_type === 'at_least') {
    if (today_status === 'met') return 'Done for today';
    const toGo = Math.max(0, target_hours - hours);
    return `${formatHoursValue(hours)} / ${formatHours(target_hours)} today – ${formatHours(toGo)} to go`;
  }

  if (today_status === 'missed') return 'Over the limit today';
  if (today_status === 'pending') return 'Not logged yet';
  if (target_hours <= 0) return `${getChallengeActivityLabel(input.activity)}-free so far today`;
  return `${formatHours(hours)} of ${formatHours(target_hours)} max so far`;
};

/** How far today's hours are towards the daily target (an "at most" target of 0 fills on any) */
export const getTodayRatio = (targetHours: number, todayHours: number | null): number => {
  const hours = todayHours ?? 0;
  if (targetHours <= 0) return hours > 0 ? 1 : 0;
  return getRatio(hours, targetHours);
};

/** Screen-reader wording for a participant's status today */
export const describeTodayStatus = (
  goalType: ChallengeGoalType,
  status: ChallengeTodayStatus
): string => {
  if (status === 'met') return goalType === 'at_least' ? 'Done today' : 'Within the limit today';
  if (status === 'missed') return goalType === 'at_least' ? 'Missed today' : 'Over the limit today';
  return goalType === 'at_least' ? 'Not done yet today' : 'Not logged yet today';
};

// ============================================================================
// Days
// ============================================================================

const DAY_STATUS_WORDS: Record<ChallengeDayStatus, string> = {
  met: 'met',
  missed: 'missed',
  pending: 'pending',
  upcoming: 'upcoming',
  none: 'not taking part',
};

/** "Oct 23: met, 2.5 hours", "Oct 24 (today): pending, 1 hour", "Oct 30: upcoming" */
export const describeChallengeDay = (day: ChallengeDay, isToday = false): string => {
  const date = `${formatShortDate(day.date)}${isToday ? ' (today)' : ''}`;
  const status = DAY_STATUS_WORDS[day.status] ?? day.status;
  return day.hours === null
    ? `${date}: ${status}`
    : `${date}: ${status}, ${formatHoursSpoken(day.hours)}`;
};

const DAY_CODES: Record<string, ChallengeDayStatus> = {
  M: 'met',
  X: 'missed',
  P: 'pending',
  U: 'upcoming',
  '-': 'none',
};

/** Decodes a participant's `days` string ("MMXP-U…") into statuses */
export const parseDayCodes = (days: string): ChallengeDayStatus[] =>
  Array.from(days, (code) => DAY_CODES[code] ?? 'none');

/** A participant's last `count` days up to today (or the last day once ended), oldest first */
export const getRecentDays = (
  days: string,
  startDate: string,
  today: string,
  count = 7
): ChallengeDayStatus[] => {
  const statuses = parseDayCodes(days);
  const todayIndex = daysBetween(startDate, today);
  if (statuses.length === 0 || todayIndex < 0) return [];
  const last = Math.min(todayIndex, statuses.length - 1);
  return statuses.slice(Math.max(0, last - count + 1), last + 1);
};

const SUMMARY_ORDER: ChallengeDayStatus[] = ['met', 'missed', 'pending', 'none', 'upcoming'];

/** "5 met, 1 missed, 1 pending" */
export const summarizeDays = (statuses: ChallengeDayStatus[]): string => {
  const parts = SUMMARY_ORDER.flatMap((status) => {
    const count = statuses.filter((entry) => entry === status).length;
    return count > 0 ? [`${count} ${DAY_STATUS_WORDS[status]}`] : [];
  });
  return parts.length > 0 ? parts.join(', ') : 'no days yet';
};

// ============================================================================
// Daily target input
// ============================================================================

/** Allowed daily target for a goal type */
export const getTargetRange = (goalType: ChallengeGoalType): { min: number; max: number } =>
  goalType === 'at_least'
    ? { min: CHALLENGE_LIMITS.AT_LEAST_MIN_HOURS, max: CHALLENGE_LIMITS.AT_LEAST_MAX_HOURS }
    : { min: CHALLENGE_LIMITS.AT_MOST_MIN_HOURS, max: CHALLENGE_LIMITS.AT_MOST_MAX_HOURS };

/** Rounds to the nearest quarter hour within the goal type's range */
export const clampTarget = (goalType: ChallengeGoalType, hours: number): number => {
  const { min, max } = getTargetRange(goalType);
  const step = CHALLENGE_LIMITS.HOURS_STEP;
  const snapped = Math.round(hours / step) * step;
  return Math.min(max, Math.max(min, snapped));
};

/** Reads hours typed by the user ("1.5" or "1,5"); null when it is not a number */
export const parseHoursInput = (raw: string): number | null => {
  const normalized = raw.trim().replace(',', '.');
  if (!normalized) return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
};

/** Why a typed daily target is not allowed, or null when it is */
export const getTargetError = (goalType: ChallengeGoalType, raw: string): string | null => {
  const hours = parseHoursInput(raw);
  const { min, max } = getTargetRange(goalType);
  const range = `Pick between ${formatHoursValue(min)} and ${formatHoursValue(max)} hours`;
  if (hours === null) return range;
  const steps = hours / CHALLENGE_LIMITS.HOURS_STEP;
  if (Math.abs(steps - Math.round(steps)) > 1e-9) return 'Use quarter hours, e.g. 0.25, 1.5 or 2';
  if (hours < min || hours > max) return range;
  return null;
};

// ============================================================================
// Errors
// ============================================================================

/** The API `error_code` of a failed request, if any */
export const getErrorCode = (error: unknown): string | undefined => {
  const code = (error as { errorCode?: unknown } | null | undefined)?.errorCode;
  return typeof code === 'string' ? code : undefined;
};

/** The HTTP status of a failed request; undefined for network failures */
export const getErrorStatus = (error: unknown): number | undefined => {
  const status = (error as { statusCode?: unknown } | null | undefined)?.statusCode;
  return typeof status === 'number' ? status : undefined;
};

/** The challenge does not exist, or the user is not taking part in it */
export const isChallengeNotFound = (error: unknown): boolean =>
  getErrorStatus(error) === 404 || getErrorCode(error) === CHALLENGE_ERROR_CODES.NOT_FOUND;

export const CHALLENGE_LIMIT_MESSAGE = `You're already in ${CHALLENGE_LIMITS.MAX_OPEN_CHALLENGES} challenges – finish one first`;

const JOIN_BLOCKED_MESSAGES: Record<ChallengeJoinBlockedReason, string> = {
  ended: 'This challenge has ended',
  full: 'This challenge is full',
  limit: CHALLENGE_LIMIT_MESSAGE,
};

/** Why the user cannot join a challenge */
export const getJoinBlockedMessage = (reason: ChallengeJoinBlockedReason): string =>
  JOIN_BLOCKED_MESSAGES[reason] ?? "You can't join this challenge";

/** The join-blocked reason a failed join stands for, or null for other failures */
export const getJoinBlockedReason = (error: unknown): ChallengeJoinBlockedReason | null => {
  switch (getErrorCode(error)) {
    case CHALLENGE_ERROR_CODES.ENDED:
      return 'ended';
    case CHALLENGE_ERROR_CODES.FULL:
      return 'full';
    case CHALLENGE_ERROR_CODES.LIMIT_REACHED:
      return 'limit';
    default:
      return null;
  }
};

export type ChallengeAction = 'load' | 'create' | 'join' | 'leave' | 'delete' | 'cheer' | 'invite';

const ACTION_FAILURES: Record<ChallengeAction, string> = {
  load: "Couldn't load the challenge",
  create: "Couldn't create the challenge",
  join: "Couldn't join the challenge",
  leave: "Couldn't leave the challenge",
  delete: "Couldn't delete the challenge",
  cheer: "Couldn't send your cheer",
  invite: "Couldn't send the invites",
};

const CODE_MESSAGES: Record<string, string> = {
  [CHALLENGE_ERROR_CODES.LIMIT_REACHED]: CHALLENGE_LIMIT_MESSAGE,
  [CHALLENGE_ERROR_CODES.FULL]: 'This challenge is full',
  [CHALLENGE_ERROR_CODES.ENDED]: 'This challenge has ended',
  [CHALLENGE_ERROR_CODES.NOT_ACTIVE]: 'Cheers are only possible while a challenge is running',
  [CHALLENGE_ERROR_CODES.CREATOR_CANNOT_LEAVE]: "You started this challenge, so you can't leave it",
  [CHALLENGE_ERROR_CODES.IN_PROGRESS]:
    "This challenge is under way with others in it, so it can't be deleted",
  [CHALLENGE_ERROR_CODES.NOT_FOUND]: 'This challenge no longer exists',
  [CHALLENGE_ERROR_CODES.CANNOT_CHEER_SELF]: "You can't cheer yourself",
};

/** A friendly, actionable message for a failed challenge request */
export const getChallengeErrorMessage = (error: unknown, action: ChallengeAction): string => {
  const code = getErrorCode(error);
  if (code && CODE_MESSAGES[code]) return CODE_MESSAGES[code];
  // Validation errors name the field that needs fixing
  if (code === CHALLENGE_ERROR_CODES.INVALID && error instanceof Error && error.message) {
    return error.message;
  }
  // No HTTP status means the request never reached the server
  const hint =
    getErrorStatus(error) === undefined ? 'Check your connection and try again.' : 'Try again.';
  return `${ACTION_FAILURES[action]}. ${hint}`;
};
