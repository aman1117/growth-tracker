/**
 * BadgeShowcase Component
 *
 * Displays all badges with progress toward next badge.
 */

import { Sparkles } from 'lucide-react';
import React from 'react';

import type { Badge } from '../types/api';
import styles from './BadgeShowcase.module.css';
import { StreakBadge } from './ui/Badge';

export interface BadgeShowcaseProps {
  badges: Badge[];
  longestStreak: number;
  showProgress?: boolean;
  size?: 'sm' | 'md' | 'lg';
}

export const BadgeShowcase: React.FC<BadgeShowcaseProps> = ({
  badges,
  longestStreak,
  showProgress = true,
  size = 'sm',
}) => {
  // Find next badge to earn
  const nextBadge = badges.find((b) => !b.earned);
  const earnedCount = badges.filter((b) => b.earned).length;
  const progressPct = nextBadge
    ? Math.min(Math.round((longestStreak / Math.max(1, nextBadge.threshold)) * 100), 100)
    : 100;

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h3 className={styles.title}>Streak badges</h3>
        <span className={styles.count} aria-label={`${earnedCount} of ${badges.length} earned`}>
          {earnedCount}/{badges.length}
        </span>
      </div>

      <div className={styles.badgeGrid}>
        {badges.map((badge) => (
          <StreakBadge key={badge.key} badge={badge} size={size} showName />
        ))}
      </div>

      {showProgress && nextBadge && (
        <div
          className={styles.progress}
          style={{ '--badge-color': nextBadge.color } as React.CSSProperties}
        >
          <div className={styles.progressText}>
            <span>
              Next: <strong className={styles.nextName}>{nextBadge.name}</strong>
            </span>
            <span className={styles.progressCount}>
              {longestStreak}/{nextBadge.threshold} days
            </span>
          </div>
          <div
            className={styles.progressBar}
            role="progressbar"
            aria-label={`Progress to ${nextBadge.name}`}
            aria-valuemin={0}
            aria-valuemax={nextBadge.threshold}
            aria-valuenow={Math.min(longestStreak, nextBadge.threshold)}
          >
            <div className={styles.progressFill} style={{ width: `${progressPct}%` }} />
          </div>
        </div>
      )}

      {!nextBadge && earnedCount === badges.length && (
        <div className={styles.allEarned}>
          <Sparkles size={14} strokeWidth={2.5} aria-hidden="true" />
          Legendary status achieved!
        </div>
      )}
    </div>
  );
};

export default BadgeShowcase;
