/**
 * QuietHoursAccordion Component
 *
 * Expandable section for quiet hours configuration.
 */

import { ChevronDown } from 'lucide-react';
import React, { useId } from 'react';

import type { PushPreferences } from '../../../types/push';
import styles from '../PushNotificationSettings.module.css';
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
  const panelId = useId();
  const toggleId = useId();
  const startId = useId();
  const endId = useId();
  const isEnabled = preferences?.quiet_hours_enabled ?? false;
  const quietSummary = isEnabled ? `${localQuietStart} – ${localQuietEnd}` : 'Off';

  return (
    <div className={styles.panel}>
      <button
        type="button"
        className={styles.panelHeader}
        onClick={onToggleExpand}
        aria-expanded={isExpanded}
        aria-controls={panelId}
      >
        <span className={styles.panelTitle}>Quiet hours</span>
        <span className={`${styles.panelSummary} ${isEnabled ? styles.panelSummaryOn : ''}`}>
          {quietSummary}
        </span>
        <ChevronDown
          size={16}
          strokeWidth={2.4}
          className={`${styles.chevron} ${isExpanded ? styles.chevronOpen : ''}`}
          aria-hidden="true"
        />
      </button>
      {isExpanded && (
        <div id={panelId} className={styles.panelBody}>
          <div className={styles.prefRow}>
            <label htmlFor={toggleId} className={styles.prefText}>
              <span id={`${toggleId}-label`} className={styles.prefLabel}>
                Pause notifications
              </span>
              <span id={`${toggleId}-description`} className={styles.prefDescription}>
                Hold them during the hours you pick
              </span>
            </label>
            <Toggle
              id={toggleId}
              enabled={isEnabled}
              onChange={onQuietHoursToggle}
              busy={isLoading}
              aria-labelledby={`${toggleId}-label`}
              aria-describedby={`${toggleId}-description`}
            />
          </div>
          {isEnabled && (
            <div className={styles.timeRow}>
              <div className={styles.timeField}>
                <label htmlFor={startId} className={styles.timeLabel}>
                  From
                </label>
                <span className={styles.selectWrap}>
                  <select
                    id={startId}
                    value={localQuietStart}
                    onChange={(e) => onQuietTimeChange('start', e.target.value)}
                    className={styles.select}
                  >
                    {TIME_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                  <ChevronDown
                    size={14}
                    strokeWidth={2.4}
                    className={styles.selectIcon}
                    aria-hidden="true"
                  />
                </span>
              </div>
              <div className={styles.timeField}>
                <label htmlFor={endId} className={styles.timeLabel}>
                  To
                </label>
                <span className={styles.selectWrap}>
                  <select
                    id={endId}
                    value={localQuietEnd}
                    onChange={(e) => onQuietTimeChange('end', e.target.value)}
                    className={styles.select}
                  >
                    {TIME_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                  <ChevronDown
                    size={14}
                    strokeWidth={2.4}
                    className={styles.selectIcon}
                    aria-hidden="true"
                  />
                </span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
