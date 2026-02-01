/**
 * QuietHoursAccordion Component
 *
 * Expandable section for quiet hours configuration.
 */

import { ChevronDown } from 'lucide-react';
import React from 'react';

import type { PushPreferences } from '../../../types/push';
import { styles } from '../PushNotificationSettings.styles';
import { TIME_OPTIONS } from '../PushNotificationSettings.types';
import { Toggle } from './Toggle';

interface QuietHoursAccordionProps {
  isExpanded: boolean;
  onToggleExpand: () => void;
  preferences: PushPreferences | null | undefined;
  localQuietStart: string;
  localQuietEnd: string;
  isLoading: boolean;
  onQuietHoursToggle: (enabled: boolean) => void;
  onQuietTimeChange: (field: 'start' | 'end', value: string) => void;
}

export const QuietHoursAccordion: React.FC<QuietHoursAccordionProps> = ({
  isExpanded,
  onToggleExpand,
  preferences,
  localQuietStart,
  localQuietEnd,
  isLoading,
  onQuietHoursToggle,
  onQuietTimeChange,
}) => {
  const quietSummary = preferences?.quiet_hours_enabled
    ? `${localQuietStart} – ${localQuietEnd}`
    : 'Off';

  return (
    <div style={styles.expandedCard}>
      <button type="button" onClick={onToggleExpand} style={styles.expandedCardHeader}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
          <span>Quiet Hours</span>
          <span style={styles.accordionSummary}>{quietSummary}</span>
        </div>
        <ChevronDown
          size={14}
          style={{
            color: 'var(--text-tertiary)',
            transition: 'transform 0.2s',
            transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
          }}
        />
      </button>
      {isExpanded && (
        <div style={styles.expandedCardContent}>
          <div style={styles.compactRow}>
            <span style={styles.compactLabel}>Pause notifications</span>
            <Toggle
              enabled={preferences?.quiet_hours_enabled ?? false}
              onChange={onQuietHoursToggle}
              disabled={isLoading}
            />
          </div>
          {preferences?.quiet_hours_enabled && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                paddingTop: '0.375rem',
              }}
            >
              <select
                value={localQuietStart}
                onChange={(e) => onQuietTimeChange('start', e.target.value)}
                style={styles.timeSelect}
              >
                {TIME_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <span style={{ color: 'var(--text-tertiary)', fontSize: '0.75rem' }}>to</span>
              <select
                value={localQuietEnd}
                onChange={(e) => onQuietTimeChange('end', e.target.value)}
                style={styles.timeSelect}
              >
                {TIME_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
