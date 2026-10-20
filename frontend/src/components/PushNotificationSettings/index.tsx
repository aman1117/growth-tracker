/**
 * Push Notification Settings Component
 *
 * Allows users to manage their push notification preferences:
 * - Enable/disable push notifications
 * - Configure notification types
 * - Set quiet hours
 */

import { AlertCircle, Bell, BellOff, ChevronRight } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { usePushNotifications } from '../../hooks/usePushNotifications';
import type { NotificationType } from '../../types/notification';
import { Button } from '../ui';
import {
  NotificationsBlockedGuide,
  NotificationTypesAccordion,
  QuietHoursAccordion,
} from './components';
import styles from './PushNotificationSettings.module.css';
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
      <div className={styles.errorBanner} role="status">
        <AlertCircle size={16} strokeWidth={2.4} aria-hidden="true" />
        <span>Push notifications aren't supported in this browser.</span>
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
        <button
          type="button"
          className={styles.blockedCard}
          onClick={() => setShowBlockedGuide(true)}
        >
          <span className={styles.blockedIcon} aria-hidden="true">
            <BellOff size={18} strokeWidth={2.3} />
          </span>
          <span className={styles.blockedText}>
            <span className={styles.blockedTitle}>Notifications blocked</span>
            <span className={styles.blockedHint}>Tap to see how to turn them on</span>
          </span>
          <ChevronRight size={16} strokeWidth={2.4} aria-hidden="true" />
        </button>
      </>
    );
  }

  // Not subscribed - show enable button
  if (!isSubscribed) {
    return (
      <div className={styles.container}>
        {error && (
          <div className={styles.errorBanner} role="alert">
            <AlertCircle size={16} strokeWidth={2.4} aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}

        <div className={styles.enableRow}>
          <p className={styles.enableText}>Get notified about likes, badges, and streaks</p>
          <Button
            type="button"
            size="sm"
            onClick={subscribe}
            loading={isLoading}
            icon={<Bell size={14} strokeWidth={2.4} />}
          >
            {isLoading ? 'Enabling…' : 'Enable'}
          </Button>
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
    <div className={styles.container}>
      {error && (
        <div className={styles.errorBanner} role="alert">
          <AlertCircle size={16} strokeWidth={2.4} aria-hidden="true" />
          <span>{error}</span>
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
