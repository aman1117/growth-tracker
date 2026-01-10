/**
 * Push Notification Settings Component
 *
 * Allows users to manage their push notification preferences:
 * - Enable/disable push notifications
 * - Configure notification types
 * - Set quiet hours
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Bell, AlertCircle, Loader2, ChevronDown } from 'lucide-react';
import { usePushNotifications } from '../hooks/usePushNotifications';
import type { NotificationType } from '../types/notification';

// ============================================================================
// Types
// ============================================================================

interface PushNotificationSettingsProps {
  onToast?: (message: string, type: 'success' | 'error') => void;
}

interface NotificationTypeConfig {
  type: NotificationType;
  label: string;
  description: string;
}

// ============================================================================
// Constants
// ============================================================================

const NOTIFICATION_TYPES: NotificationTypeConfig[] = [
  {
    type: 'like_received',
    label: 'Likes',
    description: 'When someone likes your day',
  },
  {
    type: 'badge_unlocked',
    label: 'Badges',
    description: 'When you unlock a new badge',
  },
  {
    type: 'streak_milestone',
    label: 'Streak Milestones',
    description: 'When you reach streak milestones',
  },
  {
    type: 'streak_at_risk',
    label: 'Streak Reminders',
    description: 'When your streak is at risk',
  },
];

const TIME_OPTIONS = Array.from({ length: 24 }, (_, i) => {
  const hour = i.toString().padStart(2, '0');
  return { value: `${hour}:00`, label: `${hour}:00` };
});

// ============================================================================
// Styles - Compact & Theme-aware
// ============================================================================

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
  },
  section: {
    background: 'var(--bg-secondary)',
    borderRadius: '10px',
    padding: '0.75rem',
    border: '1px solid var(--border)',
  },
  sectionTitle: {
    fontSize: '0.75rem',
    fontWeight: 600,
    color: 'var(--text-tertiary)',
    marginBottom: '0.5rem',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0.5rem 0',
  },
  rowWithBorder: {
    borderBottom: '1px solid var(--border)',
  },
  rowInfo: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.125rem',
    flex: 1,
    minWidth: 0,
  },
  rowLabel: {
    fontSize: '0.875rem',
    fontWeight: 500,
    color: 'var(--text-primary)',
  },
  rowDescription: {
    fontSize: '0.75rem',
    color: 'var(--text-tertiary)',
  },
  toggle: {
    position: 'relative',
    width: '40px',
    height: '22px',
    backgroundColor: 'var(--bg-tertiary)',
    borderRadius: '11px',
    cursor: 'pointer',
    transition: 'background-color 0.2s ease',
    border: 'none',
    padding: 0,
    flexShrink: 0,
  },
  toggleActive: {
    backgroundColor: 'var(--accent)',
  },
  toggleDisabled: {
    opacity: 0.5,
    cursor: 'not-allowed',
  },
  toggleKnob: {
    position: 'absolute',
    top: '2px',
    left: '2px',
    width: '18px',
    height: '18px',
    backgroundColor: 'white',
    borderRadius: '50%',
    transition: 'transform 0.2s ease',
    boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
  },
  toggleKnobActive: {
    transform: 'translateX(18px)',
  },
  errorBanner: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    padding: '0.625rem 0.75rem',
    background: 'var(--error-bg, rgba(239, 68, 68, 0.1))',
    borderRadius: '8px',
    border: '1px solid var(--error-border, rgba(239, 68, 68, 0.2))',
  },
  errorIcon: {
    color: 'var(--error-color, #ef4444)',
    flexShrink: 0,
  },
  errorText: {
    fontSize: '0.8125rem',
    color: 'var(--error-color, #ef4444)',
    lineHeight: 1.4,
  },
  enableButton: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '0.5rem',
    width: '100%',
    padding: '0.75rem 1rem',
    backgroundColor: 'var(--accent)',
    color: 'white',
    border: 'none',
    borderRadius: '8px',
    fontSize: '0.875rem',
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'opacity 0.2s ease',
  },
  enableButtonDisabled: {
    opacity: 0.6,
    cursor: 'not-allowed',
  },
  quietHoursRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    paddingTop: '0.5rem',
  },
  timeSelect: {
    padding: '0.375rem 0.5rem',
    borderRadius: '6px',
    border: '1px solid var(--border)',
    background: 'var(--bg-primary)',
    color: 'var(--text-primary)',
    fontSize: '0.8125rem',
    cursor: 'pointer',
  },
  timeLabel: {
    fontSize: '0.8125rem',
    color: 'var(--text-tertiary)',
  },
  accordionHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    padding: '0.625rem 0.75rem',
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border)',
    borderRadius: '8px',
    cursor: 'pointer',
    transition: 'background-color 0.15s ease',
    color: 'var(--text-primary)',
  },
  accordionTitle: {
    fontSize: '0.8125rem',
    fontWeight: 500,
    color: 'inherit',
  },
  accordionChevron: {
    color: 'var(--text-secondary)',
    transition: 'transform 0.2s ease',
  },
  accordionSummary: {
    fontSize: '0.75rem',
    color: 'var(--text-tertiary)',
  },
  inlineAccordion: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.375rem',
    padding: 0,
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    fontSize: '0.8125rem',
    fontWeight: 500,
    color: 'var(--text-primary)',
  },
  expandedCard: {
    background: 'var(--bg-tertiary)',
    border: '1px solid var(--border)',
    borderRadius: '8px',
    overflow: 'hidden',
  },
  expandedCardHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    padding: '0.625rem 0.75rem',
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    fontSize: '0.8125rem',
    fontWeight: 500,
    color: 'var(--text-primary)',
  },
  expandedCardContent: {
    padding: '0 0.75rem 0.5rem 0.75rem',
    borderTop: '1px solid var(--border)',
  },
  compactRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0.375rem 0',
  },
  compactLabel: {
    fontSize: '0.8125rem',
    color: 'var(--text-secondary)',
  },
  accordionContent: {
    overflow: 'hidden',
    transition: 'max-height 0.2s ease, opacity 0.2s ease, padding 0.2s ease',
  },
};

// ============================================================================
// Toggle Component
// ============================================================================

interface ToggleProps {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
  disabled?: boolean;
}

const Toggle: React.FC<ToggleProps> = ({ enabled, onChange, disabled }) => (
  <button
    type="button"
    onClick={() => !disabled && onChange(!enabled)}
    style={{
      ...styles.toggle,
      ...(enabled ? styles.toggleActive : {}),
      ...(disabled ? styles.toggleDisabled : {}),
    }}
    aria-pressed={enabled}
    disabled={disabled}
  >
    <span
      style={{
        ...styles.toggleKnob,
        ...(enabled ? styles.toggleKnobActive : {}),
      }}
    />
  </button>
);

// ============================================================================
// Main Component
// ============================================================================

export const PushNotificationSettings: React.FC<PushNotificationSettingsProps> = ({ onToast }) => {
  const {
    isSupported,
    permission,
    isSubscribed,
    isLoading,
    error,
    preferences,
    subscribe,
    updatePreferences,
    clearError,
  } = usePushNotifications();

  const [localQuietStart, setLocalQuietStart] = useState('22:00');
  const [localQuietEnd, setLocalQuietEnd] = useState('08:00');
  
  // Accordion state
  const [typesExpanded, setTypesExpanded] = useState(false);
  const [quietExpanded, setQuietExpanded] = useState(false);
  
  // Debounce timer for quiet hours time changes
  const quietTimeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync quiet hours from preferences
  useEffect(() => {
    if (preferences) {
      if (preferences.quiet_start) setLocalQuietStart(preferences.quiet_start);
      if (preferences.quiet_end) setLocalQuietEnd(preferences.quiet_end);
    }
  }, [preferences]);

  // Clear error on unmount and cleanup debounce timer
  useEffect(() => {
    return () => {
      clearError();
      if (quietTimeDebounceRef.current) {
        clearTimeout(quietTimeDebounceRef.current);
      }
    };
  }, [clearError]);

  // Debounced API call for quiet time changes
  const debouncedQuietTimeUpdate = useCallback(
    (start: string, end: string) => {
      // Clear any pending debounce
      if (quietTimeDebounceRef.current) {
        clearTimeout(quietTimeDebounceRef.current);
      }
      
      quietTimeDebounceRef.current = setTimeout(async () => {
        if (preferences?.quiet_hours_enabled) {
          const success = await updatePreferences({
            quiet_start: start,
            quiet_end: end,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          });
          if (success) onToast?.('Preferences saved', 'success');
        }
      }, 500); // 500ms debounce
    },
    [preferences?.quiet_hours_enabled, updatePreferences, onToast]
  );

  // Not supported
  if (!isSupported) {
    return (
      <div style={styles.errorBanner}>
        <AlertCircle size={16} style={styles.errorIcon} />
        <span style={styles.errorText}>
          Push notifications not supported in this browser.
        </span>
      </div>
    );
  }

  // Permission denied
  if (permission === 'denied') {
    return (
      <div style={styles.errorBanner}>
        <AlertCircle size={16} style={styles.errorIcon} />
        <span style={styles.errorText}>
          Notifications blocked. Update browser settings to enable.
        </span>
      </div>
    );
  }

  // Not subscribed - show enable button
  if (!isSubscribed) {
    return (
      <div style={styles.container}>
        {error && (
          <div style={styles.errorBanner}>
            <AlertCircle size={16} style={styles.errorIcon} />
            <span style={styles.errorText}>{error}</span>
          </div>
        )}
        
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
          <p style={{ ...styles.rowDescription, margin: 0, flex: 1 }}>
            Get notified about likes, badges, and streaks
          </p>
          <button
            onClick={subscribe}
            disabled={isLoading}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.375rem',
              padding: '0.5rem 0.875rem',
              backgroundColor: 'var(--accent)',
              color: 'white',
              border: 'none',
              borderRadius: '8px',
              fontSize: '0.8125rem',
              fontWeight: 600,
              cursor: isLoading ? 'not-allowed' : 'pointer',
              opacity: isLoading ? 0.6 : 1,
              whiteSpace: 'nowrap',
            }}
          >
            {isLoading ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                Enabling...
              </>
            ) : (
              <>
                <Bell size={14} />
                Enable
              </>
            )}
          </button>
        </div>
      </div>
    );
  }

  // Subscribed - show preferences
  const handleTypeToggle = async (type: NotificationType, enabled: boolean) => {
    const success = await updatePreferences({
      preferences: {
        [type]: enabled,
      },
    });
    if (success) onToast?.('Preferences saved', 'success');
  };

  const handleQuietHoursToggle = async (enabled: boolean) => {
    const success = await updatePreferences({
      quiet_hours_enabled: enabled,
      quiet_start: localQuietStart,
      quiet_end: localQuietEnd,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    if (success) onToast?.('Preferences saved', 'success');
  };

  const handleQuietTimeChange = (field: 'start' | 'end', value: string) => {
    const newStart = field === 'start' ? value : localQuietStart;
    const newEnd = field === 'end' ? value : localQuietEnd;
    
    if (field === 'start') {
      setLocalQuietStart(value);
    } else {
      setLocalQuietEnd(value);
    }

    // Trigger debounced API update
    debouncedQuietTimeUpdate(newStart, newEnd);
  };

  // Summary for accordions
  const enabledTypesCount = NOTIFICATION_TYPES.filter(
    (config) => preferences?.preferences?.[config.type] ?? true
  ).length;
  const typesSummary = `${enabledTypesCount}/${NOTIFICATION_TYPES.length} enabled`;
  const quietSummary = preferences?.quiet_hours_enabled 
    ? `${localQuietStart} – ${localQuietEnd}` 
    : 'Off';

  return (
    <div style={styles.container}>
      {error && (
        <div style={styles.errorBanner}>
          <AlertCircle size={16} style={styles.errorIcon} />
          <span style={styles.errorText}>{error}</span>
        </div>
      )}

      {/* Notification Types */}
      <div style={styles.expandedCard}>
        <button
          type="button"
          onClick={() => setTypesExpanded(!typesExpanded)}
          style={styles.expandedCardHeader}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
            <span>Types</span>
            <span style={styles.accordionSummary}>{typesSummary}</span>
          </div>
          <ChevronDown 
            size={14} 
            style={{ 
              color: 'var(--text-tertiary)',
              transition: 'transform 0.2s',
              transform: typesExpanded ? 'rotate(180deg)' : 'rotate(0deg)' 
            }} 
          />
        </button>
        {typesExpanded && (
          <div style={styles.expandedCardContent}>
            {NOTIFICATION_TYPES.map((config) => {
              const isEnabled = preferences?.preferences?.[config.type] ?? true;
              return (
                <div key={config.type} style={styles.compactRow}>
                  <span style={styles.compactLabel}>{config.label}</span>
                  <Toggle
                    enabled={isEnabled}
                    onChange={(enabled) => handleTypeToggle(config.type, enabled)}
                    disabled={isLoading}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Quiet Hours */}
      <div style={styles.expandedCard}>
        <button
          type="button"
          onClick={() => setQuietExpanded(!quietExpanded)}
          style={styles.expandedCardHeader}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
            <span>Quiet Hours</span>
            <span style={styles.accordionSummary}>{quietSummary}</span>
          </div>
          <ChevronDown 
            size={14} 
            style={{ 
              color: 'var(--text-tertiary)',
              transition: 'transform 0.2s',
              transform: quietExpanded ? 'rotate(180deg)' : 'rotate(0deg)' 
            }} 
          />
        </button>
        {quietExpanded && (
          <div style={styles.expandedCardContent}>
            <div style={styles.compactRow}>
              <span style={styles.compactLabel}>Pause notifications</span>
              <Toggle
                enabled={preferences?.quiet_hours_enabled ?? false}
                onChange={handleQuietHoursToggle}
                disabled={isLoading}
              />
            </div>
            {preferences?.quiet_hours_enabled && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', paddingTop: '0.375rem' }}>
                <select
                  value={localQuietStart}
                  onChange={(e) => handleQuietTimeChange('start', e.target.value)}
                  style={styles.timeSelect}
                >
                  {TIME_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
                <span style={{ color: 'var(--text-tertiary)', fontSize: '0.75rem' }}>to</span>
                <select
                  value={localQuietEnd}
                  onChange={(e) => handleQuietTimeChange('end', e.target.value)}
                  style={styles.timeSelect}
                >
                  {TIME_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
