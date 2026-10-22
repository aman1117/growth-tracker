import type { LucideIcon } from 'lucide-react';
import {
  AlertTriangle,
  AtSign,
  Camera,
  Flag,
  Flame,
  Heart,
  Medal,
  Megaphone,
  MessageCircle,
  PartyPopper,
  Reply,
  Target,
  Trophy,
  UserCheck,
  UserPlus,
} from 'lucide-react';
import { describe, expect, it } from 'vitest';

import type { NotificationType } from '../../../types';
import tones from './NotificationTone.module.css';
import { getNotificationVisual } from './notificationVisuals';

describe('getNotificationVisual', () => {
  it.each<[NotificationType, LucideIcon, string]>([
    ['like_received', Heart, tones.like],
    ['story_liked', Heart, tones.like],
    ['comment_liked', Heart, tones.like],
    ['badge_unlocked', Trophy, tones.badge],
    ['streak_milestone', Flame, tones.streak],
    ['streak_at_risk', AlertTriangle, tones.warning],
    ['system_announcement', Megaphone, tones.system],
    ['new_follower', UserPlus, tones.follow],
    ['follow_request', UserPlus, tones.follow],
    ['follow_accepted', UserCheck, tones.follow],
    ['photo_uploaded', Camera, tones.photo],
    ['comment_received', MessageCircle, tones.comment],
    ['comment_reply', Reply, tones.comment],
    ['comment_mention', AtSign, tones.comment],
    ['challenge_invite', Target, tones.challenge],
    ['challenge_joined', Flag, tones.challenge],
    ['challenge_cheer', PartyPopper, tones.challenge],
    ['challenge_ended', Medal, tones.challenge],
  ])('maps %s to its icon and tone', (type, Icon, toneClass) => {
    expect(getNotificationVisual(type)).toEqual({ Icon, toneClass });
  });

  it('gives challenge notifications their own tone', () => {
    expect(tones.challenge).toEqual(expect.any(String));
    expect(tones.challenge).not.toBe(tones.system);
  });

  it('falls back to a neutral megaphone for unknown types', () => {
    expect(getNotificationVisual('brand_new_type' as NotificationType)).toEqual({
      Icon: Megaphone,
      toneClass: tones.system,
    });
  });
});
