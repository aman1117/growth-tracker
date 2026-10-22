/**
 * Challenge Constants
 *
 * Rules and limits of the Challenges feature. They mirror the backend's challenge rules
 * (keep in sync); the server validates every request again, these only shape the UI.
 */

export const CHALLENGE_LIMITS = {
  /** Title length in characters (Unicode code points, counted with utils/text) */
  TITLE_MAX_LENGTH: 60,
  /** Daily targets move in quarter hours */
  HOURS_STEP: 0.25,
  AT_LEAST_MIN_HOURS: 0.25,
  AT_LEAST_MAX_HOURS: 24,
  AT_MOST_MIN_HOURS: 0,
  AT_MOST_MAX_HOURS: 23.75,
  MIN_DURATION_DAYS: 3,
  MAX_DURATION_DAYS: 60,
  /** A challenge starts today at the earliest and 30 days from today at the latest */
  MAX_START_OFFSET_DAYS: 30,
  MAX_PARTICIPANTS: 50,
  /** Upcoming + active challenges one person can take part in at the same time */
  MAX_OPEN_CHALLENGES: 10,
  MAX_INVITES_PER_REQUEST: 20,
} as const;

/** Durations offered when creating a challenge, in days */
export const CHALLENGE_DURATION_OPTIONS = [7, 14, 21, 30] as const;

/** Daily target a new challenge starts with, per goal type */
export const CHALLENGE_DEFAULT_TARGET_HOURS = { at_least: 2, at_most: 1 } as const;

/** Challenge dates are calendar dates in India Standard Time, like streaks and photo dates */
export const CHALLENGE_TIME_ZONE = 'Asia/Kolkata';

/** Error codes returned by the challenge endpoints (`error_code` in the API envelope) */
export const CHALLENGE_ERROR_CODES = {
  INVALID: 'INVALID_CHALLENGE',
  NOT_FOUND: 'CHALLENGE_NOT_FOUND',
  FULL: 'CHALLENGE_FULL',
  LIMIT_REACHED: 'CHALLENGE_LIMIT_REACHED',
  ENDED: 'CHALLENGE_ENDED',
  NOT_ACTIVE: 'CHALLENGE_NOT_ACTIVE',
  CREATOR_CANNOT_LEAVE: 'CREATOR_CANNOT_LEAVE',
  IN_PROGRESS: 'CHALLENGE_IN_PROGRESS',
  CANNOT_CHEER_SELF: 'CANNOT_CHEER_SELF',
} as const;
