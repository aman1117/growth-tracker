/**
 * ActivityChip
 *
 * The icon of a challenge activity on a soft tint of its colour. Decorative: the rule text
 * next to it always names the activity.
 */

import React from 'react';

import { getChallengeActivityVisual } from '../../utils/challenges';
import styles from './ActivityChip.module.css';

export type ActivityChipSize = 'sm' | 'md' | 'lg';

interface ActivityChipProps {
  activity: string;
  size?: ActivityChipSize;
  className?: string;
}

const ICON_SIZES: Record<ActivityChipSize, number> = { sm: 16, md: 20, lg: 26 };

export const ActivityChip: React.FC<ActivityChipProps> = ({
  activity,
  size = 'md',
  className = '',
}) => {
  const { Icon, color } = getChallengeActivityVisual(activity);

  return (
    <span
      className={`${styles.chip} ${styles[size]} ${className}`.trim()}
      style={{ '--activity-color': color } as React.CSSProperties}
      aria-hidden="true"
      data-activity={activity}
    >
      <Icon size={ICON_SIZES[size]} strokeWidth={2.2} />
    </span>
  );
};
