/**
 * StreakBadge Component
 *
 * Displays a single streak badge with earned/locked state.
 */

import React from 'react';
import { Lock } from 'lucide-react';
import type { Badge } from '../../../types/api';
import { getBadgeIconComponent } from '../../../utils/badgeIcons';
import styles from './StreakBadge.module.css';

export interface StreakBadgeProps {
  badge: Badge;
  size?: 'sm' | 'md' | 'lg';
  showTooltip?: boolean;
  showName?: boolean;
}

const sizeMap = {
  sm: 16,
  md: 22,
  lg: 28,
};

export const StreakBadge: React.FC<StreakBadgeProps> = ({
  badge,
  size = 'md',
  showTooltip = true,
  showName = false,
}) => {
  const IconComponent = getBadgeIconComponent(badge.icon);
  const iconSize = sizeMap[size];

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  const tooltipText = badge.earned
    ? `${badge.name} - Earned ${formatDate(badge.earned_at!)}`
    : `${badge.name} - Reach ${badge.threshold} day${badge.threshold > 1 ? 's' : ''} to unlock`;

  return (
    <div
      className={`${styles.badge} ${styles[size]} ${badge.earned ? styles.earned : styles.locked}`}
      title={showTooltip ? tooltipText : undefined}
      style={{
        '--badge-color': badge.color,
      } as React.CSSProperties}
    >
      <div className={styles.iconWrapper}>
        <IconComponent
          size={iconSize}
          className={styles.icon}
          fill={badge.earned ? badge.color : 'none'}
          strokeWidth={badge.earned ? 1.5 : 2}
        />
        {!badge.earned && (
          <div className={styles.lockOverlay}>
            <Lock size={iconSize * 0.35} />
          </div>
        )}
      </div>
      {showName ? (
        <span className={styles.name}>{badge.name}</span>
      ) : (
        <span className={styles.threshold}>{badge.threshold}d</span>
      )}
    </div>
  );
};

export default StreakBadge;
