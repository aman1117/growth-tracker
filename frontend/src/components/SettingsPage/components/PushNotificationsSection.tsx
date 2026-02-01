/**
 * Push Notifications Section
 *
 * Push notification settings with toggle and blocked state handling.
 */

import { Bell, BellOff, ChevronRight } from 'lucide-react';
import React, { useState } from 'react';

import { usePushNotifications } from '../../../hooks/usePushNotifications';
import { PushNotificationSettings } from '../../PushNotificationSettings';
import type { PushNotificationsSectionProps } from '../SettingsPage.types';
import { NotificationsBlockedDialog } from './NotificationsBlockedDialog';

export const PushNotificationsSection: React.FC<PushNotificationsSectionProps> = ({ onToast }) => {
  const { isSubscribed, isLoading, toggleSubscription, isSupported, permission } =
    usePushNotifications();
  const [showBlockedDialog, setShowBlockedDialog] = useState(false);

  // Don't show if not supported
  if (!isSupported) {
    return null;
  }

  // Show blocked message if permission denied
  if (permission === 'denied') {
    return (
      <>
        <NotificationsBlockedDialog
          isOpen={showBlockedDialog}
          onClose={() => setShowBlockedDialog(false)}
        />
        <div
          onClick={() => setShowBlockedDialog(true)}
          style={{
            padding: '0.75rem 1rem',
            borderBottom: '1px solid var(--border)',
            cursor: 'pointer',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.75rem',
            }}
          >
            <div
              style={{
                width: '32px',
                height: '32px',
                borderRadius: '8px',
                backgroundColor: 'var(--icon-bg-muted)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--text-tertiary)',
              }}
            >
              <BellOff size={16} />
            </div>
            <div style={{ flex: 1 }}>
              <div
                style={{
                  fontSize: '0.875rem',
                  fontWeight: 500,
                  color: 'var(--text-primary)',
                }}
              >
                Push Notifications
              </div>
              <div
                style={{
                  fontSize: '0.75rem',
                  color: 'var(--text-tertiary)',
                  marginTop: '0.125rem',
                }}
              >
                Blocked · Tap to learn how to enable
              </div>
            </div>
            <ChevronRight size={16} style={{ color: 'var(--text-tertiary)' }} />
          </div>
        </div>
      </>
    );
  }

  const handleToggle = async () => {
    const success = await toggleSubscription();
    if (success) {
      onToast(isSubscribed ? 'Notifications disabled' : 'Notifications enabled', 'success');
    }
  };

  return (
    <div
      style={{
        padding: '0.75rem 1rem',
        borderBottom: '1px solid var(--border)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
        }}
      >
        <div
          style={{
            width: '32px',
            height: '32px',
            borderRadius: '8px',
            backgroundColor: 'var(--icon-bg-muted)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--text-secondary)',
          }}
        >
          <Bell size={16} />
        </div>
        <div
          style={{
            flex: 1,
            fontSize: '0.875rem',
            fontWeight: 500,
            color: 'var(--text-primary)',
          }}
        >
          Push Notifications
        </div>
        <button
          onClick={handleToggle}
          disabled={isLoading}
          style={{
            width: '44px',
            height: '24px',
            borderRadius: '12px',
            border: 'none',
            backgroundColor: isSubscribed ? '#0095f6' : 'var(--border)',
            cursor: isLoading ? 'not-allowed' : 'pointer',
            position: 'relative',
            transition: 'background-color 0.2s',
            opacity: isLoading ? 0.6 : 1,
          }}
        >
          <div
            style={{
              width: '18px',
              height: '18px',
              borderRadius: '50%',
              backgroundColor: 'white',
              position: 'absolute',
              top: '3px',
              left: isSubscribed ? '23px' : '3px',
              transition: 'left 0.2s',
              boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
            }}
          />
        </button>
      </div>
      {isSubscribed && (
        <div style={{ marginTop: '0.75rem' }}>
          <PushNotificationSettings onToast={onToast} />
        </div>
      )}
    </div>
  );
};
