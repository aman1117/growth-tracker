/**
 * BadgeShowcase Component
 *
 * Displays all badges with progress toward next badge.
 */

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

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h3 className={styles.title}>Streak Badges</h3>
        <span className={styles.count}>
          {earnedCount}/{badges.length}
        </span>
      </div>

      <div className={styles.badgeGrid}>
        {badges.map((badge) => (
          <StreakBadge key={badge.key} badge={badge} size={size} showName />
        ))}
      </div>

      {showProgress && nextBadge && (
        <div className={styles.progress}>
          <div className={styles.progressText}>
            <span>Next: {nextBadge.name}</span>
            <span className={styles.progressCount}>
              {longestStreak}/{nextBadge.threshold}d
            </span>
          </div>
          <div className={styles.progressBar}>
            <div
              className={styles.progressFill}
              style={{
                width: `${Math.min((longestStreak / nextBadge.threshold) * 100, 100)}%`,
                backgroundColor: nextBadge.color,
              }}
            />
          </div>
        </div>
      )}

      {!nextBadge && earnedCount === badges.length && (
        <div className={styles.allEarned}>🎉 Legendary status achieved!</div>
      )}
    </div>
  );
};

export default BadgeShowcase;
