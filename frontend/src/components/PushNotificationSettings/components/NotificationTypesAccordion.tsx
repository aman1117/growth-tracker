/**
 * NotificationTypesAccordion Component
 *
 * Expandable section for notification type preferences.
 */

import { ChevronDown } from 'lucide-react';
import React, { useId } from 'react';

import type { NotificationType } from '../../../types/notification';
import type { PushPreferences } from '../../../types/push';
import styles from '../PushNotificationSettings.module.css';
import { NOTIFICATION_TYPES } from '../PushNotificationSettings.types';
import { Toggle } from './Toggle';

interface NotificationTypesAccordionProps {
  isExpanded: boolean;
  onToggleExpand: () => void;
  preferences: PushPreferences | null | undefined;
  isLoading: boolean;
  onTypeToggle: (type: NotificationType, enabled: boolean) => void;
}

export const NotificationTypesAccordion: React.FC<NotificationTypesAccordionProps> = ({
  isExpanded,
  onToggleExpand,
  preferences,
  isLoading,
  onTypeToggle,
}) => {
  const panelId = useId();
  const baseId = useId();
  const enabledTypesCount = NOTIFICATION_TYPES.filter(
    (config) => preferences?.preferences?.[config.type] ?? true
  ).length;
  const typesSummary = `${enabledTypesCount} of ${NOTIFICATION_TYPES.length} on`;

  return (
    <div className={styles.panel}>
      <button
        type="button"
        className={styles.panelHeader}
        onClick={onToggleExpand}
        aria-expanded={isExpanded}
        aria-controls={panelId}
      >
        <span className={styles.panelTitle}>Notification types</span>
        <span className={styles.panelSummary}>{typesSummary}</span>
        <ChevronDown
          size={16}
          strokeWidth={2.4}
          className={`${styles.chevron} ${isExpanded ? styles.chevronOpen : ''}`}
          aria-hidden="true"
        />
      </button>
      {isExpanded && (
        <div id={panelId} className={styles.panelBody}>
          {NOTIFICATION_TYPES.map((config) => {
            const isEnabled = preferences?.preferences?.[config.type] ?? true;
            const toggleId = `${baseId}-${config.type}`;
            return (
              <div key={config.type} className={styles.prefRow}>
                <label htmlFor={toggleId} className={styles.prefText}>
                  <span id={`${toggleId}-label`} className={styles.prefLabel}>
                    {config.label}
                  </span>
                  <span id={`${toggleId}-description`} className={styles.prefDescription}>
                    {config.description}
                  </span>
                </label>
                <Toggle
                  id={toggleId}
                  enabled={isEnabled}
                  onChange={(enabled) => onTypeToggle(config.type, enabled)}
                  busy={isLoading}
                  aria-labelledby={`${toggleId}-label`}
                  aria-describedby={`${toggleId}-description`}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
