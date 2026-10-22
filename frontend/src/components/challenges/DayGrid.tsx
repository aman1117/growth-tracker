/**
 * DayGrid
 *
 * The user's days in a challenge, a week per row: met, missed, pending (can still be logged),
 * upcoming, or before they joined. Each day is described for screen readers
 * ("Oct 23: met, 2.5 hours"); today is ringed.
 */

import React, { useId } from 'react';

import type { ChallengeDay, ChallengeDayStatus } from '../../types';
import { describeChallengeDay, parseDateKey } from '../../utils/challenges';
import styles from './DayGrid.module.css';

interface DayGridProps {
  days: ChallengeDay[];
  /** The server's IST date */
  today: string;
  /** The results are final, so days can no longer be logged or fixed */
  isFinal?: boolean;
}

const LEGEND: { status: ChallengeDayStatus; label: string }[] = [
  { status: 'met', label: 'Met' },
  { status: 'missed', label: 'Missed' },
  { status: 'pending', label: 'Pending' },
  { status: 'upcoming', label: 'Upcoming' },
  { status: 'none', label: 'Not taking part' },
];

export const DayGrid: React.FC<DayGridProps> = ({ days, today, isFinal = false }) => {
  const hintId = useId();
  const hasNone = days.some((day) => day.status === 'none');
  const legend = hasNone ? LEGEND : LEGEND.filter((entry) => entry.status !== 'none');

  return (
    <div className={styles.wrapper}>
      <ol
        className={styles.grid}
        aria-label="Your days"
        aria-describedby={isFinal ? undefined : hintId}
      >
        {days.map((day) => {
          const isToday = day.date === today;
          return (
            <li key={day.date} className={styles.cell}>
              <span
                role="img"
                aria-label={describeChallengeDay(day, isToday)}
                className={`${styles.day} ${styles[day.status] ?? styles.none} ${
                  isToday ? styles.today : ''
                }`}
                aria-current={isToday ? 'date' : undefined}
              >
                {parseDateKey(day.date)?.getDate() ?? ''}
              </span>
            </li>
          );
        })}
      </ol>

      <ul className={styles.legend} aria-label="Legend">
        {legend.map(({ status, label }) => (
          <li key={status} className={styles.legendItem}>
            <span className={`${styles.swatch} ${styles[status]}`} aria-hidden="true" />
            {label}
          </li>
        ))}
      </ul>

      {!isFinal && (
        <p id={hintId} className={styles.hint}>
          You can log or fix a day until the end of the next day. After that it&apos;s final.
        </p>
      )}
    </div>
  );
};
