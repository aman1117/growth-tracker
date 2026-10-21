import { describe, expect, it } from 'vitest';

import * as AutocompleteBarrel from './Autocomplete';
import * as AvatarBarrel from './Avatar';
import * as BadgeBarrel from './Badge';
import * as BrandLogoBarrel from './BrandLogo';
import * as ButtonBarrel from './Button';
import * as CalendarPickerBarrel from './CalendarPicker';
import * as CardBarrel from './Card';
import * as CommentsBarrel from './Comments';
import * as ConfirmDialogBarrel from './ConfirmDialog';
import * as EmptyStateBarrel from './EmptyState';
import * as IconButtonBarrel from './IconButton';
import * as ui from './index';
import * as InputBarrel from './Input';
import * as LikeButtonBarrel from './LikeButton';
import * as LoadingSpinnerBarrel from './LoadingSpinner';
import * as ModalBarrel from './Modal';
import * as NoticeBarrel from './Notice';
import * as NotificationBarrel from './Notification';
import * as NotificationPreviewToastBarrel from './NotificationPreviewToast';
import * as PageHeaderBarrel from './PageHeader';
import * as SkeletonBarrel from './Skeleton';
import * as SnapToastBarrel from './SnapToast';
import * as TabsBarrel from './Tabs';
import * as ToggleBarrel from './Toggle';
import * as TypographyBarrel from './Typography';
import * as VerifiedBadgeBarrel from './VerifiedBadge';

type Barrel = Record<string, unknown>;

/** Function components, or the objects React.memo/forwardRef return. */
const isComponent = (value: unknown) =>
  typeof value === 'function' ||
  (typeof value === 'object' && value !== null && '$$typeof' in value);

const barrelsWithDefault: [string, Barrel][] = [
  ['Autocomplete', AutocompleteBarrel],
  ['Avatar', AvatarBarrel],
  ['BrandLogo', BrandLogoBarrel],
  ['Button', ButtonBarrel],
  ['CalendarPicker', CalendarPickerBarrel],
  ['Card', CardBarrel],
  ['ConfirmDialog', ConfirmDialogBarrel],
  ['EmptyState', EmptyStateBarrel],
  ['IconButton', IconButtonBarrel],
  ['Input', InputBarrel],
  ['LoadingSpinner', LoadingSpinnerBarrel],
  ['Modal', ModalBarrel],
  ['Notice', NoticeBarrel],
  ['Skeleton', SkeletonBarrel],
  ['SnapToast', SnapToastBarrel],
  ['Tabs', TabsBarrel],
  ['Toggle', ToggleBarrel],
  ['VerifiedBadge', VerifiedBadgeBarrel],
];

const namedOnlyBarrels: [string, Barrel, string[]][] = [
  ['Badge', BadgeBarrel, ['StreakBadge']],
  [
    'Comments',
    CommentsBarrel,
    [
      'CommentButton',
      'CommentInput',
      'CommentItem',
      'CommentPreview',
      'CommentSheet',
      'MentionAutocomplete',
    ],
  ],
  ['LikeButton', LikeButtonBarrel, ['LikeButton', 'LikersModal']],
  [
    'Notification',
    NotificationBarrel,
    ['NotificationBell', 'NotificationCenter', 'NotificationItem', 'NotificationPanel'],
  ],
  ['NotificationPreviewToast', NotificationPreviewToastBarrel, ['NotificationPreviewToast']],
  ['PageHeader', PageHeaderBarrel, ['PageHeader']],
  ['Typography', TypographyBarrel, ['Heading', 'Text']],
];

describe('components/ui barrels', () => {
  it('expose every design-system component from the package entry point', () => {
    expect(Object.keys(ui).sort()).toEqual([
      'Autocomplete',
      'Avatar',
      'BrandLogo',
      'Button',
      'CalendarPicker',
      'Card',
      'CommentButton',
      'CommentPreview',
      'CommentSheet',
      'ConfirmDialog',
      'EmptyState',
      'Heading',
      'IconButton',
      'Input',
      'LikeButton',
      'LoadingSpinner',
      'Modal',
      'Notice',
      'NoticeStack',
      'NotificationBell',
      'NotificationCenter',
      'NotificationItem',
      'NotificationPanel',
      'NotificationPreviewToast',
      'PageHeader',
      'PasswordInput',
      'ProtectedImage',
      'PullToRefreshIndicator',
      'PullToRefreshWrapper',
      'Skeleton',
      'SkeletonAvatar',
      'SkeletonCard',
      'SkeletonText',
      'SnapToast',
      'StreakBadge',
      'Tabs',
      'Text',
      'Toggle',
      'VerifiedBadge',
    ]);
    for (const component of Object.values(ui)) {
      expect(isComponent(component)).toBe(true);
    }
  });

  it.each(barrelsWithDefault)(
    '%s/index exports its component as both a named and the default export',
    (name, barrel) => {
      expect(isComponent(barrel[name])).toBe(true);
      expect(barrel.default).toBe(barrel[name]);
      expect((ui as Barrel)[name]).toBe(barrel[name]);
    }
  );

  it('Input/index also exports PasswordInput', () => {
    expect(InputBarrel.PasswordInput).toBe(ui.PasswordInput);
  });

  it('Notice/index and Skeleton/index export their companion components', () => {
    expect(NoticeBarrel.NoticeStack).toBe(ui.NoticeStack);
    expect([
      SkeletonBarrel.SkeletonAvatar,
      SkeletonBarrel.SkeletonCard,
      SkeletonBarrel.SkeletonText,
    ]).toEqual([ui.SkeletonAvatar, ui.SkeletonCard, ui.SkeletonText]);
  });

  it.each(namedOnlyBarrels)('%s/index exports its components by name', (_folder, barrel, names) => {
    expect(Object.keys(barrel).sort()).toEqual(names);
    for (const name of names) {
      expect(isComponent(barrel[name])).toBe(true);
      if (name in ui) expect((ui as Barrel)[name]).toBe(barrel[name]);
    }
  });
});
