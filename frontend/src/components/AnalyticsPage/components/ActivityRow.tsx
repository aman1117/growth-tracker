/**
 * ActivityRow Component
 *
 * A row in the activity summary list showing hours, share of the week and a progress bar.
 */

import type { LucideIcon } from 'lucide-react';
import { Coffee } from 'lucide-react';
import React from 'react';

import { getActivityConfig } from '../../../constants';
import type { ActivityName, ActivitySummary, CustomTile } from '../../../types';
import { DynamicIcon } from '../../DynamicIcon';
import styles from './ActivityRow.module.css';

interface ActivityRowProps {
  activity: ActivitySummary;
  maxHours: number;
  delay: number;
  animate: boolean;
  customTiles?: CustomTile[];
  tileColors?: Record<string, string>;
  /** Total hours across all activities; when set, the row shows its share */
  totalHours?: number;
}

export const ActivityRow: React.FC<ActivityRowProps> = ({
  activity,
  maxHours,
  delay,
  animate,
  customTiles = [],
  tileColors = {},
  totalHours,
}) => {
  const actConfig = getActivityConfig(activity.name as ActivityName, customTiles, tileColors);
  const Icon = (typeof actConfig.icon === 'string' ? null : actConfig.icon) || Coffee;
  const color = actConfig.color || '#64748b';
  const label = actConfig.label || activity.name;
  const iconName = actConfig.iconName; // For custom tiles
  const percentage = maxHours > 0 ? (activity.total_hours / maxHours) * 100 : 0;
  const share =
    totalHours && totalHours > 0 ? Math.round((activity.total_hours / totalHours) * 100) : null;
  const IconComponent = Icon as LucideIcon;

  return (
    <li
      className={`${styles.row} ${animate ? styles.animate : styles.hidden}`}
      style={{ '--row-color': color, '--delay': `${delay}s` } as React.CSSProperties}
    >
      {/* Icon */}
      <span className={styles.icon} aria-hidden="true">
        {iconName ? (
          <DynamicIcon name={iconName} size={17} strokeWidth={2.1} />
        ) : (
          <IconComponent size={17} strokeWidth={2.1} />
        )}
      </span>

      {/* Info */}
      <div className={styles.info}>
        <div className={styles.top}>
          <span className={styles.name}>{label}</span>
          <span className={styles.values}>
            {share !== null && <span className={styles.share}>{share}%</span>}
            <span className={styles.hours}>{activity.total_hours.toFixed(1)}h</span>
          </span>
        </div>

        {/* Progress bar */}
        <div className={styles.bar} aria-hidden="true">
          <div className={styles.fill} style={{ width: animate ? `${percentage}%` : '0%' }} />
        </div>
      </div>
    </li>
  );
};
