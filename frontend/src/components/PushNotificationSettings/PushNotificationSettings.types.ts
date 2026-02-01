/**
 * PushNotificationSettings Types & Constants
 */

import type { NotificationType } from '../../types/notification';

// ============================================================================
// Types
// ============================================================================

export interface PushNotificationSettingsProps {
  onToast?: (message: string, type: 'success' | 'error') => void;
}

export interface NotificationTypeConfig {
  type: NotificationType;
  label: string;
  description: string;
}

export interface ToggleProps {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
  disabled?: boolean;
}

export interface NotificationsBlockedGuideProps {
  isOpen: boolean;
  onClose: () => void;
}

// ============================================================================
// Constants
// ============================================================================

export const NOTIFICATION_TYPES: NotificationTypeConfig[] = [
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
    description: 'When you or someone you follow reaches a milestone',
  },
  {
    type: 'streak_at_risk',
    label: 'Streak Reminders',
    description: 'When your streak is at risk',
  },
];

export const TIME_OPTIONS = Array.from({ length: 24 }, (_, i) => {
  const hour = i.toString().padStart(2, '0');
  return { value: `${hour}:00`, label: `${hour}:00` };
});
