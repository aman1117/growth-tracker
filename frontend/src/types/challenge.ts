/**
 * Challenge Types
 *
 * Mirrors the Challenges API (snake_case JSON). Dates are IST calendar dates ("YYYY-MM-DD").
 */

import type { PredefinedActivityName } from './index';

export type ChallengeGoalType = 'at_least' | 'at_most';

/** `finalized` is reported separately: an ended challenge becomes final on end_date + 2 */
export type ChallengeStatus = 'upcoming' | 'active' | 'ended';

/** Today's state for a participant (null when today is outside their window) */
export type ChallengeTodayStatus = 'met' | 'missed' | 'pending';

export type ChallengeDayStatus = 'met' | 'missed' | 'pending' | 'upcoming' | 'none';

export type ChallengeJoinBlockedReason = 'ended' | 'full' | 'limit';

export interface ChallengeUser {
  id: number;
  username: string;
  profile_pic: string | null;
  profile_pic_thumb: string | null;
  is_verified: boolean;
}

export interface ChallengeProgress {
  /** Competition ranking (1, 2, 2, 4); null while upcoming */
  rank: number | null;
  days_met: number;
  days_elapsed: number;
  days_possible: number;
  current_streak: number;
  total_hours: number;
  /** Only while active and today is in the participant's window */
  today_hours: number | null;
  today_status: ChallengeTodayStatus | null;
  /** Only once finalized */
  completed: boolean | null;
}

export interface ChallengeSummary {
  id: number;
  title: string;
  /** One of the 16 predefined activity names */
  activity: string;
  goal_type: ChallengeGoalType;
  target_hours: number;
  start_date: string;
  end_date: string;
  duration_days: number;
  status: ChallengeStatus;
  finalized: boolean;
  /** today - start_date + 1 while active, else null */
  day_number: number | null;
  participant_count: number;
  is_creator: boolean;
  me: ChallengeProgress;
}

export interface ChallengeParticipant extends ChallengeProgress {
  user: ChallengeUser;
  joined_on: string;
  is_me: boolean;
  /** Whether the viewer already cheered this participant today */
  cheered_today: boolean;
  /**
   * One character per date from start_date to end_date: M met, X missed, P pending,
   * U upcoming, '-' not taking part yet
   */
  days: string;
}

export interface ChallengeDay {
  date: string;
  /** null for upcoming days and days before the participant joined */
  hours: number | null;
  status: ChallengeDayStatus;
  locked: boolean;
}

export interface ChallengeDetail extends ChallengeSummary {
  invite_code: string;
  /** The server's "today" (IST) */
  today: string;
  locked_through: string | null;
  /** end_date + 2: when results become final */
  results_date: string;
  completion_days: number;
  max_participants: number;
  creator: ChallengeUser;
  can_invite: boolean;
  can_leave: boolean;
  can_delete: boolean;
  /** Ordered by rank (nulls last), then username */
  participants: ChallengeParticipant[];
  /** One entry per date, start_date..end_date */
  my_days: ChallengeDay[];
}

export interface InviteCandidate extends ChallengeUser {
  /** Already has an invite (from anyone); leaving the challenge removes it */
  invited: boolean;
}

export interface ChallengePreview {
  id: number;
  title: string;
  activity: string;
  goal_type: ChallengeGoalType;
  target_hours: number;
  start_date: string;
  end_date: string;
  duration_days: number;
  status: ChallengeStatus;
  finalized: boolean;
  participant_count: number;
  max_participants: number;
  creator: ChallengeUser;
  /** Up to 5, earliest joined first */
  participants_preview: ChallengeUser[];
  is_participant: boolean;
  can_join: boolean;
  join_blocked_reason: ChallengeJoinBlockedReason | null;
}

// ==================== Requests ====================

export interface CreateChallengeRequest {
  title: string;
  activity: PredefinedActivityName;
  goal_type: ChallengeGoalType;
  target_hours: number;
  duration_days: number;
  start_date: string;
}

// ==================== Responses ====================

export interface ChallengesListResponse {
  success: boolean;
  challenges: ChallengeSummary[];
}

export interface ChallengeDetailResponse {
  success: boolean;
  challenge: ChallengeDetail;
}

export interface ChallengeActionResponse {
  success: boolean;
}

export interface ChallengeCheerResponse {
  success: boolean;
  already_cheered: boolean;
}

export interface InviteCandidatesResponse {
  success: boolean;
  users: InviteCandidate[];
}

export interface ChallengeInvitesResponse {
  success: boolean;
  invited: number;
  skipped: number;
}

export interface ChallengePreviewResponse {
  success: boolean;
  preview: ChallengePreview;
}
