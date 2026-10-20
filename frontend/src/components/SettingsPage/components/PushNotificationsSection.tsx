/**
 * Push Notifications Section
 *
 * "Notifications" settings group: push switch with its preferences, the blocked-permission
 * help, and an install hint on iOS Safari (where web push needs a Home Screen app).
 */

import { Bell, BellOff, Smartphone } from 'lucide-react';
import React, { useId, useState } from 'react';

import { usePushNotifications } from '../../../hooks/usePushNotifications';
import { PushNotificationSettings } from '../../PushNotificationSettings';
import { getPushPlatform } from '../../PushNotificationSettings/pushPlatform';
import { Toggle } from '../../ui';
import type { PushNotificationsSectionProps } from '../SettingsPage.types';
import { NotificationsBlockedDialog } from './NotificationsBlockedDialog';
import { SettingsItem } from './SettingsItem';
import { SettingsSection } from './SettingsSection';

export const PushNotificationsSection: React.FC<PushNotificationsSectionProps> = ({ onToast }) => {
  const { isSubscribed, isLoading, toggleSubscription, isSupported, permission } =
    usePushNotifications();
  const [showBlockedDialog, setShowBlockedDialog] = useState(false);
  const controlId = useId();

  const blockedDialog = (
    <NotificationsBlockedDialog
      isOpen={showBlockedDialog}
      onClose={() => setShowBlockedDialog(false)}
    />
  );

  if (!isSupported) {
    const { isIOS, isStandalone } = getPushPlatform();
    // iOS Safari only supports web push for apps added to the Home Screen
    if (!isIOS || isStandalone) return null;

    return (
      <SettingsSection title="Notifications">
        {blockedDialog}
        <SettingsItem
          icon={<Smartphone size={18} strokeWidth={2.25} />}
          tone="sky"
          label="Push notifications"
          value="Add Growth Tracker to your Home Screen to turn them on"
          onClick={() => setShowBlockedDialog(true)}
        />
      </SettingsSection>
    );
  }

  if (permission === 'denied') {
    return (
      <SettingsSection title="Notifications">
        {blockedDialog}
        <SettingsItem
          icon={<BellOff size={18} strokeWidth={2.25} />}
          tone="red"
          label="Push notifications"
          value="Blocked · Tap to see how to turn them on"
          onClick={() => setShowBlockedDialog(true)}
        />
      </SettingsSection>
    );
  }

  const handleToggle = async () => {
    const wasSubscribed = isSubscribed;
    const success = await toggleSubscription();
    if (success) {
      onToast(wasSubscribed ? 'Notifications turned off' : 'Notifications turned on', 'success');
      return;
    }
    console.warn('[Settings] Push notification toggle failed', { wasSubscribed });
    onToast(
      wasSubscribed
        ? "Couldn't turn off notifications. Try again."
        : "Couldn't turn on notifications. Check your browser permissions.",
      'error'
    );
  };

  return (
    <SettingsSection title="Notifications">
      <SettingsItem
        icon={<Bell size={18} strokeWidth={2.25} />}
        tone="sky"
        label="Push notifications"
        value={
          isSubscribed ? 'On for this device' : 'Likes, badges and streak reminders on this device'
        }
        controlId={controlId}
        trailing={
          <Toggle
            id={controlId}
            checked={isSubscribed}
            onChange={handleToggle}
            busy={isLoading}
            aria-labelledby={`${controlId}-label`}
            aria-describedby={`${controlId}-description`}
          />
        }
      >
        {isSubscribed && <PushNotificationSettings onToast={onToast} />}
      </SettingsItem>
    </SettingsSection>
  );
};
