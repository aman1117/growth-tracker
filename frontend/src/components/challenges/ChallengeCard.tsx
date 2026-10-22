/**
 * ChallengeCard
 *
 * A challenge in the Challenges list: activity, title, rule, status, my progress and (while it
 * runs) today's status; final rank and completion once the results are in. The whole card
 * opens the challenge — the title link stretches over it.
 */

import { CheckCircle2, ChevronRight } from 'lucide-react';
import React from 'react';
import { Link } from 'react-router-dom';

import { APP_ROUTES } from '../../constants/routes';
import type { ChallengeSummary } from '../../types';
import {
  formatPeopleCount,
  formatRuleText,
  formatStatusText,
  getChallengeActivityVisual,
  getRatio,
} from '../../utils/challenges';
import { ActivityChip } from './ActivityChip';
import styles from './ChallengeCard.module.css';
import { TodayStatusChip } from './TodayStatusChip';

interface ChallengeCardProps {
  challenge: ChallengeSummary;
  /** The IST date the status is relative to */
  today: string;
}

const MEDAL_CLASSES: Record<number, string> = {
  1: styles.gold,
  2: styles.silver,
  3: styles.bronze,
};

export const ChallengeCard: React.FC<ChallengeCardProps> = ({ challenge, today }) => {
  const { me } = challenge;
  const { color } = getChallengeActivityVisual(challenge.activity);
  const isFinal = challenge.status === 'ended' && challenge.finalized;
  const showToday = challenge.status === 'active' && me.today_status !== null;
  const showCompleted = isFinal && me.completed === true;
  const daysPossible = Math.max(0, me.days_possible);
  const fill = getRatio(me.days_met, daysPossible);

  return (
    <article
      className={styles.card}
      style={{ '--activity-color': color } as React.CSSProperties}
      data-status={challenge.status}
    >
      <div className={styles.top}>
        <ActivityChip activity={challenge.activity} />
        <div className={styles.text}>
          <h3 className={styles.title}>
            <Link to={APP_ROUTES.CHALLENGE(challenge.id)} className={styles.link}>
              {challenge.title}
            </Link>
          </h3>
          <p className={styles.rule}>{formatRuleText(challenge)}</p>
          <p className={styles.meta}>
            {formatStatusText(challenge, today)} · {formatPeopleCount(challenge.participant_count)}
          </p>
        </div>
        {isFinal && me.rank !== null && (
          <span className={`${styles.rank} ${MEDAL_CLASSES[me.rank] ?? ''}`}>
            <span className="sr-only">Final rank </span>#{me.rank}
          </span>
        )}
        <ChevronRight className={styles.chevron} size={18} aria-hidden="true" />
      </div>

      <div className={styles.progress}>
        <div
          className={styles.bar}
          role="progressbar"
          aria-label="Days met"
          aria-valuemin={0}
          aria-valuemax={Math.max(1, daysPossible)}
          aria-valuenow={Math.min(me.days_met, Math.max(1, daysPossible))}
          aria-valuetext={`${me.days_met} of ${daysPossible} days met`}
        >
          <span className={styles.barFill} style={{ width: `${fill * 100}%` }} />
        </div>
        <span className={styles.progressLabel} aria-hidden="true">
          {me.days_met}/{daysPossible} days
        </span>
      </div>

      {(showToday || showCompleted) && (
        <div className={styles.footer}>
          {showToday && (
            <TodayStatusChip
              activity={challenge.activity}
              goalType={challenge.goal_type}
              targetHours={challenge.target_hours}
              todayHours={me.today_hours}
              todayStatus={me.today_status}
            />
          )}
          {showCompleted && (
            <span className={styles.completed}>
              <CheckCircle2 size={14} strokeWidth={2.5} aria-hidden="true" />
              Completed
            </span>
          )}
        </div>
      )}
    </article>
  );
};
