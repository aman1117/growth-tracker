/**
 * Push Notification Settings Component
 *
 * Allows users to manage their push notification preferences:
 * - Enable/disable push notifications
 * - Configure notification types
 * - Set quiet hours
 */

import { AlertCircle, Bell, BellOff, ChevronRight, Loader2 } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { usePushNotifications } from '../../hooks/usePushNotifications';
import type { NotificationType } from '../../types/notification';
import {
  NotificationsBlockedGuide,
  NotificationTypesAccordion,
  QuietHoursAccordion,
} from './components';
import { styles } from './PushNotificationSettings.styles';
import type { PushNotificationSettingsProps } from './PushNotificationSettings.types';

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

  // Blocked guide modal state
  const [showBlockedGuide, setShowBlockedGuide] = useState(false);

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
      }, 500);
    },
    [preferences?.quiet_hours_enabled, updatePreferences, onToast]
  );

  // Not supported
  if (!isSupported) {
    return (
      <div style={styles.errorBanner}>
        <AlertCircle size={16} style={styles.errorIcon} />
        <span style={styles.errorText}>Push notifications not supported in this browser.</span>
      </div>
    );
  }

  // Permission denied - show clickable guide
  if (permission === 'denied') {
    return (
      <>
        <NotificationsBlockedGuide
          isOpen={showBlockedGuide}
          onClose={() => setShowBlockedGuide(false)}
        />
        <div
          onClick={() => setShowBlockedGuide(true)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.75rem',
            padding: '0.75rem',
            background: 'var(--error-bg, rgba(239, 68, 68, 0.08))',
            borderRadius: '10px',
            border: '1px solid var(--error-border, rgba(239, 68, 68, 0.15))',
            cursor: 'pointer',
            transition: 'background 0.15s ease',
          }}
        >
          <div
            style={{
              width: '36px',
              height: '36px',
              borderRadius: '10px',
              background: 'var(--error-bg, rgba(239, 68, 68, 0.15))',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--error-color, #ef4444)',
              flexShrink: 0,
            }}
          >
            <BellOff size={18} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: '0.875rem',
                fontWeight: 600,
                color: 'var(--text-primary)',
                marginBottom: '0.125rem',
              }}
            >
              Notifications Blocked
            </div>
            <div
              style={{
                fontSize: '0.75rem',
                color: 'var(--text-tertiary)',
              }}
            >
              Tap to learn how to enable
            </div>
          </div>
          <ChevronRight size={16} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
        </div>
      </>
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

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '1rem',
          }}
        >
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

    debouncedQuietTimeUpdate(newStart, newEnd);
  };

  return (
    <div style={styles.container}>
      {error && (
        <div style={styles.errorBanner}>
          <AlertCircle size={16} style={styles.errorIcon} />
          <span style={styles.errorText}>{error}</span>
        </div>
      )}

      <NotificationTypesAccordion
        isExpanded={typesExpanded}
        onToggleExpand={() => setTypesExpanded(!typesExpanded)}
        preferences={preferences}
        isLoading={isLoading}
        onTypeToggle={handleTypeToggle}
      />

      <QuietHoursAccordion
        isExpanded={quietExpanded}
        onToggleExpand={() => setQuietExpanded(!quietExpanded)}
        preferences={preferences}
        localQuietStart={localQuietStart}
        localQuietEnd={localQuietEnd}
        isLoading={isLoading}
        onQuietHoursToggle={handleQuietHoursToggle}
        onQuietTimeChange={handleQuietTimeChange}
      />
    </div>
  );
};

export default PushNotificationSettings;
