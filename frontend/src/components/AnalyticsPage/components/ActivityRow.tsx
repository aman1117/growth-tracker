/**
 * ActivityRow Component
 *
 * A row in the activity summary list showing hours and progress bar.
 */

import { Coffee } from 'lucide-react';
import React, { Suspense } from 'react';

import { getActivityConfig } from '../../../constants';
import type { ActivityName, ActivitySummary, CustomTile } from '../../../types';
import { DynamicIcon } from '../../DynamicIcon';

interface ActivityRowProps {
  activity: ActivitySummary;
  maxHours: number;
  delay: number;
  animate: boolean;
  customTiles?: CustomTile[];
  tileColors?: Record<string, string>;
}

export const ActivityRow: React.FC<ActivityRowProps> = ({
  activity,
  maxHours,
  delay,
  animate,
  customTiles = [],
  tileColors = {},
}) => {
  const actConfig = getActivityConfig(activity.name as ActivityName, customTiles, tileColors);
  const Icon = actConfig.icon || Coffee;
  const color = actConfig.color || '#64748b';
  const label = actConfig.label || activity.name;
  const iconName = actConfig.iconName; // For custom tiles
  const percentage = maxHours > 0 ? (activity.total_hours / maxHours) * 100 : 0;

  return (
    <div
      className="activity-row"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.5rem',
        padding: '0.4rem 0.25rem',
        borderRadius: '6px',
        cursor: 'default',
        animation: animate ? `fadeInUp 0.3s ease-out ${delay}s forwards` : 'none',
        opacity: animate ? 1 : 0,
      }}
    >
      {/* Icon */}
      <div
        style={{
          width: '28px',
          height: '28px',
          borderRadius: '6px',
          backgroundColor: `${color}20`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        {iconName ? (
          <Suspense fallback={<div style={{ width: 14, height: 14 }} />}>
            <DynamicIcon name={iconName} size={14} color={color} />
          </Suspense>
        ) : (
          <Icon size={14} color={color} />
        )}
      </div>

      {/* Info */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: '0.25rem',
          }}
        >
          <span
            style={{
              fontSize: '0.8rem',
              fontWeight: 500,
              color: 'var(--text-primary)',
            }}
          >
            {label}
          </span>
          <span
            style={{
              fontSize: '0.8rem',
              fontWeight: 600,
              color: 'var(--text-primary)',
            }}
          >
            {activity.total_hours.toFixed(1)}h
          </span>
        </div>

        {/* Progress bar */}
        <div
          style={{
            height: '6px',
            backgroundColor: 'var(--bg-secondary)',
            borderRadius: '3px',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              height: '100%',
              width: animate ? `${percentage}%` : '0%',
              backgroundColor: color,
              borderRadius: '3px',
              transition: `width 0.6s cubic-bezier(0.34, 1.56, 0.64, 1) ${delay}s`,
            }}
          />
        </div>
      </div>
    </div>
  );
};
