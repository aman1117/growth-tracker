/**
 * ChallengeProgressCard ("Your progress")
 *
 * Days met so far as a ring, the current streak, today's status with a shortcut to log it,
 * the final result once known, and the day grid.
 */

import { CalendarClock, CheckCircle2, Clock, Flame, PenLine, Trophy, XCircle } from 'lucide-react';
import React, { useId } from 'react';

import type { ChallengeDetail } from '../../types';
import {
  formatOrdinal,
  formatShortDate,
  formatStartsIn,
  formatStreak,
  formatTodayProgress,
  getChallengeActivityVisual,
} from '../../utils/challenges';
import { Button, ProgressRing } from '../ui';
import layout from './ChallengeLayout.module.css';
import styles from './ChallengeProgressCard.module.css';
import { DayGrid } from './DayGrid';

/** Share of a participant's days that must be met to complete a challenge, in percent */
const COMPLETION_PERCENT = 80;

/** Days to meet out of `days`: ceil(80%) in exact integer arithmetic, like the server */
const completionThreshold = (days: number): number => Math.ceil((days * COMPLETION_PERCENT) / 100);

interface ChallengeProgressCardProps {
  challenge: ChallengeDetail;
  onLogToday: () => void;
}

export const ChallengeProgressCard: React.FC<ChallengeProgressCardProps> = ({
  challenge,
  onLogToday,
}) => {
  const titleId = useId();
  const { me, status } = challenge;
  const { color } = getChallengeActivityVisual(challenge.activity);
  const daysToComplete = completionThreshold(me.days_possible);
  const isFinal = status === 'ended' && challenge.finalized;

  const today = formatTodayProgress({
    activity: challenge.activity,
    goal_type: challenge.goal_type,
    target_hours: challenge.target_hours,
    today_hours: me.today_hours,
    today_status: me.today_status,
  });
  const TodayIcon =
    me.today_status === 'met' ? CheckCircle2 : me.today_status === 'missed' ? XCircle : Clock;

  const renderStatus = () => {
    if (status === 'upcoming') {
      return (
        <p className={styles.headline}>
          <CalendarClock size={18} aria-hidden="true" />
          {formatStartsIn(challenge.start_date, challenge.today)}
        </p>
      );
    }

    if (status === 'active') {
      return (
        <>
          {today && (
            <p className={`${styles.headline} ${styles[me.today_status ?? 'pending']}`}>
              <TodayIcon size={18} aria-hidden="true" />
              {today}
            </p>
          )}
          {me.today_status !== null && (
            <Button
              size="sm"
              variant="secondary"
              icon={<PenLine size={15} />}
              className={`${layout.touchTarget} ${styles.logButton}`}
              onClick={onLogToday}
            >
              Log today
            </Button>
          )}
        </>
      );
    }

    if (isFinal && me.rank !== null) {
      return (
        <p className={styles.headline}>
          <Trophy size={18} aria-hidden="true" />
          You finished {formatOrdinal(me.rank)}
          {me.completed ? ' · Completed' : ''}
        </p>
      );
    }

    return (
      <p className={styles.headline}>
        <Clock size={18} aria-hidden="true" />
        Final results on {formatShortDate(challenge.results_date)}
      </p>
    );
  };

  const streak = formatStreak(me.current_streak);

  return (
    <section className={layout.card} aria-labelledby={titleId}>
      <div className={layout.cardHeader}>
        <h2 id={titleId} className={layout.cardTitle}>
          Your progress
        </h2>
      </div>

      <div className={styles.summary}>
        <ProgressRing
          value={me.days_met}
          max={me.days_possible}
          size={104}
          strokeWidth={10}
          color={color}
          label="Days met"
          valueText={`${me.days_met} of ${me.days_possible} days met`}
        >
          <span className={styles.ringValue}>{me.days_met}</span>
          <span className={styles.ringLabel}>of {me.days_possible} days</span>
        </ProgressRing>

        <div className={styles.details}>
          {renderStatus()}
          {status !== 'upcoming' && (
            <p className={styles.detail}>
              <Flame size={15} aria-hidden="true" className={styles.flame} />
              {streak ?? 'No streak yet'}
            </p>
          )}
          {!isFinal && (
            <p className={styles.detail}>
              Meet the goal on {daysToComplete} of {me.days_possible} days to complete it
            </p>
          )}
          {isFinal && me.completed === false && (
            <p className={styles.detail}>
              {me.days_met} of the {daysToComplete} days needed to complete it
            </p>
          )}
        </div>
      </div>

      <DayGrid days={challenge.my_days} today={challenge.today} isFinal={isFinal} />
    </section>
  );
};
