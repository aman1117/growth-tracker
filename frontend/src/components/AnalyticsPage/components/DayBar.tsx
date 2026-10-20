/**
 * DayBar Component
 *
 * A single stacked bar in the weekly chart showing the day's activity mix.
 */

import React from 'react';

import { getActivityConfig } from '../../../constants';
import type { ActivityName, CustomTile, DayAnalytics } from '../../../types';
import styles from './DayBar.module.css';

interface DayBarProps {
  day: DayAnalytics;
  animate: boolean;
  delay: number;
  activityFilter?: string[];
  customTiles?: CustomTile[];
  tileColors?: Record<string, string>;
  /** Highlights the label for today */
  isToday?: boolean;
  /** Hours represented by the full chart height (defaults to a whole day) */
  scaleMax?: number;
}

const MAX_DAY_HOURS = 24;
const FALLBACK_COLOR = '#64748b';
const OTHERS_COLOR = 'var(--text-faint)';

interface Segment {
  key: string;
  label: string;
  hours: number;
  color: string;
}

export const DayBar: React.FC<DayBarProps> = ({
  day,
  animate,
  delay,
  activityFilter = [],
  customTiles = [],
  tileColors = {},
  isToday = false,
  scaleMax = MAX_DAY_HOURS,
}) => {
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

  const heightPct = Math.min(displayHours / (scaleMax > 0 ? scaleMax : MAX_DAY_HOURS), 1) * 100;

  // Top 3 activities + "Others" (top of the bar); highest hours sit at the bottom
  const segments: Segment[] = (() => {
    if (activityFilter.length === 1) {
      const config = getConfig(activityFilter[0]);
      return [
        {
          key: activityFilter[0],
          label: config.label,
          hours: displayHours,
          color: config.color || FALLBACK_COLOR,
        },
      ];
    }

    const topActivities = filteredActivities.slice(0, 3);
    const othersHours = filteredActivities.slice(3).reduce((sum, a) => sum + a.hours, 0);
    const result: Segment[] = [];
    if (othersHours > 0) {
      result.push({ key: 'others', label: 'Others', hours: othersHours, color: OTHERS_COLOR });
    }
    [...topActivities].reverse().forEach((activity) => {
      const config = getConfig(activity.name);
      result.push({
        key: activity.name,
        label: config.label,
        hours: activity.hours,
        color: config.color || FALLBACK_COLOR,
      });
    });
    return result;
  })();

  const shortName = day.day_name.slice(0, 3);
  const hoursText = displayHours > 0 ? `${displayHours.toFixed(1)}h` : '–';
  const srText = `${day.day_name}${isToday ? ' (today)' : ''}: ${
    displayHours > 0 ? `${displayHours.toFixed(1)} hours` : 'nothing logged'
  }`;

  return (
    <div
      className={`${styles.column} ${isToday ? styles.today : ''}`}
      style={{ '--delay': `${delay}s` } as React.CSSProperties}
    >
      <div className={styles.track} title={`${day.day_name}: ${displayHours.toFixed(1)}h`}>
        {displayHours > 0 ? (
          <div className={styles.stack} style={{ height: animate ? `${heightPct}%` : '0%' }}>
            {segments.map((segment) => (
              <div
                key={segment.key}
                className={styles.segment}
                style={{ flexGrow: segment.hours, background: segment.color }}
                title={`${segment.label}: ${segment.hours.toFixed(1)}h`}
              />
            ))}
          </div>
        ) : (
          <div className={styles.empty} />
        )}
      </div>

      <div className={styles.labels} aria-hidden="true">
        <span className={styles.dayName}>{shortName}</span>
        <span className={styles.dayHours}>{hoursText}</span>
      </div>
      <span className="sr-only">{srText}</span>
    </div>
  );
};
