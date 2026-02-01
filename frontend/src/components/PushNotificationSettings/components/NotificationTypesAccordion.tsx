/**
 * NotificationTypesAccordion Component
 *
 * Expandable section for notification type preferences.
 */

import { ChevronDown } from 'lucide-react';
import React from 'react';

import type { NotificationType } from '../../../types/notification';
import type { PushPreferences } from '../../../types/push';
import { styles } from '../PushNotificationSettings.styles';
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
  const enabledTypesCount = NOTIFICATION_TYPES.filter(
    (config) => preferences?.preferences?.[config.type] ?? true
  ).length;
  const typesSummary = `${enabledTypesCount}/${NOTIFICATION_TYPES.length} enabled`;

  return (
    <div style={styles.expandedCard}>
      <button type="button" onClick={onToggleExpand} style={styles.expandedCardHeader}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
          <span>Types</span>
          <span style={styles.accordionSummary}>{typesSummary}</span>
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
          {NOTIFICATION_TYPES.map((config) => {
            const isEnabled = preferences?.preferences?.[config.type] ?? true;
            return (
              <div key={config.type} style={styles.compactRow}>
                <span style={styles.compactLabel}>{config.label}</span>
                <Toggle
                  enabled={isEnabled}
                  onChange={(enabled) => onTypeToggle(config.type, enabled)}
                  disabled={isLoading}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
