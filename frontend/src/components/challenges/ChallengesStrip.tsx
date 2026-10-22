/**
 * ChallengesStrip
 *
 * A compact, horizontally scrollable row of the user's active challenges on Home: activity,
 * title, day of the challenge and today's progress, each opening its challenge.
 *
 * Shown only when there are active challenges. The list comes from the challenge store (loaded
 * on mount); when it cannot load, the strip stays hidden and the failure is reported once.
 */

import { ChevronRight } from 'lucide-react';
import React, { useEffect, useId, useMemo, useRef } from 'react';
import { Link } from 'react-router-dom';

import { APP_ROUTES } from '../../constants/routes';
import { gl } from '../../services/goodlogs';
import { useChallengeStore } from '../../store';
import type { ChallengeSummary } from '../../types';
import {
  describeTodayStatus,
  formatTodayChip,
  getChallengeActivityVisual,
  getTodayRatio,
} from '../../utils/challenges';
import { ActivityChip } from './ActivityChip';
import styles from './ChallengesStrip.module.css';

const StripCard: React.FC<{ challenge: ChallengeSummary }> = ({ challenge }) => {
  const { me } = challenge;
  const { color } = getChallengeActivityVisual(challenge.activity);
  const todayText = formatTodayChip({
    activity: challenge.activity,
    goal_type: challenge.goal_type,
    target_hours: challenge.target_hours,
    today_hours: me.today_hours,
    today_status: me.today_status,
  });
  const fill = getTodayRatio(challenge.target_hours, me.today_hours);
  const day = challenge.day_number ?? 1;

  return (
    <Link
      to={APP_ROUTES.CHALLENGE(challenge.id)}
      className={styles.card}
      style={{ '--activity-color': color } as React.CSSProperties}
    >
      <span className={styles.cardTop}>
        <ActivityChip activity={challenge.activity} size="sm" />
        <span className={styles.cardText}>
          <span className={styles.title}>{challenge.title}</span>
          <span className={styles.day}>
            <span aria-hidden="true">
              Day {day}/{challenge.duration_days}
            </span>
            <span className="sr-only">
              Day {day} of {challenge.duration_days}
            </span>
          </span>
        </span>
      </span>
      {todayText && me.today_status && (
        <span className={styles.today}>
          <span className={`${styles.meter} ${styles[me.today_status]}`} aria-hidden="true">
            <span className={styles.meterFill} style={{ width: `${fill * 100}%` }} />
          </span>
          <span className={styles.todayText}>
            {!(challenge.goal_type === 'at_most' && me.today_status === 'pending') && (
              <span className="sr-only">
                {describeTodayStatus(challenge.goal_type, me.today_status)}:{' '}
              </span>
            )}
            {todayText}
          </span>
        </span>
      )}
    </Link>
  );
};

export const ChallengesStrip: React.FC = () => {
  const titleId = useId();
  const challenges = useChallengeStore((state) => state.challenges);
  const status = useChallengeStore((state) => state.status);
  const fetchChallenges = useChallengeStore((state) => state.fetchChallenges);
  const reportedRef = useRef(false);

  useEffect(() => {
    void fetchChallenges();
  }, [fetchChallenges]);

  useEffect(() => {
    if (status !== 'error' || reportedRef.current) return;
    reportedRef.current = true;
    gl.warn('challenge_strip_hidden', { metadata: { reason: 'list_failed' } });
  }, [status]);

  const active = useMemo(
    () => challenges.filter((challenge) => challenge.status === 'active'),
    [challenges]
  );

  if (active.length === 0) return null;

  return (
    <section className={styles.strip} aria-labelledby={titleId}>
      <div className={styles.header}>
        <h2 id={titleId} className={styles.heading}>
          Challenges
        </h2>
        <Link to={APP_ROUTES.CHALLENGES} className={styles.seeAll}>
          See all
          <ChevronRight size={14} strokeWidth={2.5} aria-hidden="true" />
        </Link>
      </div>
      <ul className={styles.row}>
        {active.map((challenge) => (
          <li key={challenge.id} className={styles.item}>
            <StripCard challenge={challenge} />
          </li>
        ))}
      </ul>
    </section>
  );
};
