/**
 * Notification visuals
 *
 * Single source of truth for the icon + color tone of each notification type,
 * shared by the notification list and the live preview toast.
 */

import type { LucideIcon } from 'lucide-react';
import {
  AlertTriangle,
  AtSign,
  Camera,
  Flame,
  Heart,
  Megaphone,
  MessageCircle,
  Reply,
  Trophy,
  UserCheck,
  UserPlus,
} from 'lucide-react';

import type { NotificationType } from '../../../types';
import tones from './NotificationTone.module.css';

export interface NotificationVisual {
  /** Lucide icon component for the type */
  Icon: LucideIcon;
  /** Class that sets --tone / --tone-soft for the icon chip */
  toneClass: string;
}

const NOTIFICATION_VISUALS: Record<NotificationType, NotificationVisual> = {
  like_received: { Icon: Heart, toneClass: tones.like },
  story_liked: { Icon: Heart, toneClass: tones.like },
  badge_unlocked: { Icon: Trophy, toneClass: tones.badge },
  streak_milestone: { Icon: Flame, toneClass: tones.streak },
  streak_at_risk: { Icon: AlertTriangle, toneClass: tones.warning },
  system_announcement: { Icon: Megaphone, toneClass: tones.system },
  new_follower: { Icon: UserPlus, toneClass: tones.follow },
  follow_request: { Icon: UserPlus, toneClass: tones.follow },
  follow_accepted: { Icon: UserCheck, toneClass: tones.follow },
  photo_uploaded: { Icon: Camera, toneClass: tones.photo },
  comment_received: { Icon: MessageCircle, toneClass: tones.comment },
  comment_reply: { Icon: Reply, toneClass: tones.comment },
  comment_mention: { Icon: AtSign, toneClass: tones.comment },
  comment_liked: { Icon: Heart, toneClass: tones.like },
};

const FALLBACK_VISUAL: NotificationVisual = { Icon: Megaphone, toneClass: tones.system };

/** Icon + tone for a notification type (falls back to a neutral megaphone) */
export const getNotificationVisual = (type: NotificationType): NotificationVisual =>
  NOTIFICATION_VISUALS[type] ?? FALLBACK_VISUAL;
