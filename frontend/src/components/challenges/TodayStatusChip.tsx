/**
 * TodayStatusChip
 *
 * A participant's progress today ("1.5 / 2h today", "Not logged yet"), tinted by status and
 * marked with an icon so colour is never the only signal.
 */

import { Check, Clock, X } from 'lucide-react';
import React from 'react';

import type { ChallengeGoalType, ChallengeTodayStatus } from '../../types';
import { describeTodayStatus, formatTodayChip } from '../../utils/challenges';
import styles from './TodayStatusChip.module.css';

interface TodayStatusChipProps {
  activity: string;
  goalType: ChallengeGoalType;
  targetHours: number;
  todayHours: number | null;
  todayStatus: ChallengeTodayStatus | null;
  className?: string;
}

const ICONS = { met: Check, missed: X, pending: Clock } as const;

export const TodayStatusChip: React.FC<TodayStatusChipProps> = ({
  activity,
  goalType,
  targetHours,
  todayHours,
  todayStatus,
  className = '',
}) => {
  const text = formatTodayChip({
    activity,
    goal_type: goalType,
    target_hours: targetHours,
    today_hours: todayHours,
    today_status: todayStatus,
  });
  if (!text || !todayStatus) return null;

  const Icon = ICONS[todayStatus];
  // "Not logged yet" already says it all
  const isSelfExplanatory = goalType === 'at_most' && todayStatus === 'pending';

  return (
    <span className={`${styles.chip} ${styles[todayStatus]} ${className}`.trim()}>
      <Icon size={13} strokeWidth={2.6} aria-hidden="true" />
      {!isSelfExplanatory && (
        <span className="sr-only">{describeTodayStatus(goalType, todayStatus)}: </span>
      )}
      <span className={styles.text}>{text}</span>
    </span>
  );
};
