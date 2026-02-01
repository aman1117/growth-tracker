/**
 * DayBar Component
 *
 * A single bar in the weekly chart showing activity breakdown.
 */

import React from 'react';

import { getActivityConfig } from '../../../constants';
import type { ActivityName, CustomTile, DayAnalytics } from '../../../types';

interface DayBarProps {
  day: DayAnalytics;
  animate: boolean;
  delay: number;
  activityFilter?: string[];
  customTiles?: CustomTile[];
  tileColors?: Record<string, string>;
}

export const DayBar: React.FC<DayBarProps> = ({
  day,
  animate,
  delay,
  activityFilter = [],
  customTiles = [],
  tileColors = {},
}) => {
  const maxHeight = 140;

  // Helper to get config for an activity
  const getConfig = (name: string) =>
    getActivityConfig(name as ActivityName, customTiles, tileColors);

  // Calculate hours based on filter (empty array = all activities)
  let displayHours = day.total_hours;
  let filteredActivities = day.activities;

  if (activityFilter.length > 0) {
    // Filter to only selected activities
    filteredActivities = day.activities.filter((a) => activityFilter.includes(a.name));
    displayHours = filteredActivities.reduce((sum, a) => sum + a.hours, 0);
  }

  const barHeight = Math.min((displayHours / 24) * maxHeight, maxHeight);

  // Get top 3 activities and others (for stacked view) - from filtered activities
  const topActivities = filteredActivities.slice(0, 3);
  const othersHours = filteredActivities.slice(3).reduce((sum, a) => sum + a.hours, 0);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        flex: 1,
        maxWidth: '36px',
      }}
    >
      {/* Bar */}
      <div
        style={{
          width: '100%',
          height: `${maxHeight}px`,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'flex-end',
          position: 'relative',
        }}
      >
        {displayHours > 0 ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              height: animate ? `${barHeight}px` : '0px',
              transition: `height 0.6s cubic-bezier(0.34, 1.56, 0.64, 1) ${delay}s`,
              overflow: 'hidden',
            }}
          >
            {activityFilter.length === 1 ? (
              // Single activity filter - show single color bar
              <div
                style={{
                  flex: 1,
                  backgroundColor: getConfig(activityFilter[0]).color || '#64748b',
                  minHeight: '2px',
                }}
                title={`${getConfig(activityFilter[0]).label}: ${displayHours.toFixed(1)}h`}
              />
            ) : (
              // Multiple/all activities - stacked segments
              (() => {
                const segments: { name: string; hours: number; color: string }[] = [];

                // Others segment goes first (top)
                if (othersHours > 0) {
                  segments.push({
                    name: 'Others',
                    hours: othersHours,
                    color: 'var(--text-tertiary)',
                  });
                }

                // Top activities in reverse order (so highest hours appears lower in the bar)
                [...topActivities].reverse().forEach((activity) => {
                  segments.push({
                    name: activity.name,
                    hours: activity.hours,
                    color: getConfig(activity.name).color || '#64748b',
                  });
                });

                return segments.map((seg, idx) => (
                  <div
                    key={`${seg.name}-${idx}`}
                    style={{
                      flex: seg.hours,
                      backgroundColor: seg.color,
                      minHeight: '2px',
                    }}
                    title={`${seg.name === 'Others' ? 'Others' : getConfig(seg.name).label}: ${seg.hours.toFixed(1)}h`}
                  />
                ));
              })()
            )}
          </div>
        ) : (
          <div
            style={{
              height: '4px',
              backgroundColor: 'var(--bg-secondary)',
              borderRadius: '2px',
            }}
          />
        )}
      </div>

      {/* Day label */}
      <span
        style={{
          fontSize: '0.7rem',
          color: 'var(--text-secondary)',
          marginTop: '0.5rem',
          fontWeight: 500,
        }}
      >
        {day.day_name}
      </span>

      {/* Hours label */}
      <span
        style={{
          fontSize: '0.6rem',
          color: 'var(--text-tertiary)',
          marginTop: '0.125rem',
        }}
      >
        {displayHours > 0 ? `${displayHours.toFixed(1)}h` : '-'}
      </span>
    </div>
  );
};
