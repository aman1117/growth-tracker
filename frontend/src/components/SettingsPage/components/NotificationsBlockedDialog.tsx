/**
 * Notifications Blocked Dialog
 *
 * Help dialog showing how to enable blocked notifications. Shares its implementation
 * with the push settings guide so the steps never drift apart.
 */

import React from 'react';

import { NotificationsBlockedGuide } from '../../PushNotificationSettings/components';
import type { NotificationsBlockedDialogProps } from '../SettingsPage.types';

export const NotificationsBlockedDialog: React.FC<NotificationsBlockedDialogProps> = (props) => (
  <NotificationsBlockedGuide {...props} />
);
