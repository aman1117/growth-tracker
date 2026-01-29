/**
 * UI Components barrel export
 *
 * Central export for all reusable UI components.
 * Import from '@/components/ui' for clean imports.
 */

// Layout & Structure
export { Avatar, type AvatarProps, type AvatarSize } from './Avatar';
export { Card, type CardProps } from './Card';
export { Modal, type ModalProps, type ModalSize } from './Modal';

// Form Controls
export { Button, type ButtonProps, type ButtonSize, type ButtonVariant } from './Button';
export {
  IconButton,
  type IconButtonProps,
  type IconButtonSize,
  type IconButtonVariant,
} from './IconButton';
export { Input, type InputProps } from './Input';
export { Toggle, type ToggleProps } from './Toggle';

// Navigation
export { type Tab, Tabs, type TabsProps } from './Tabs';

// Feedback & Status
export { EmptyState, type EmptyStateProps } from './EmptyState';
export { LoadingSpinner, type LoadingSpinnerProps, type SpinnerSize } from './LoadingSpinner';
export {
  Skeleton,
  SkeletonAvatar,
  type SkeletonAvatarProps,
  SkeletonCard,
  type SkeletonCardProps,
  type SkeletonProps,
  SkeletonText,
  type SkeletonTextProps,
} from './Skeleton';
export { SnapToast, type SnapToastProps, type SnapToastType } from './SnapToast';

// Social & Interactions
export { StreakBadge, type StreakBadgeProps } from './Badge';
export { LikeButton, type LikeButtonProps } from './LikeButton';
export {
  NotificationBell,
  NotificationCenter,
  NotificationItem,
  NotificationPanel,
} from './Notification';
export { VerifiedBadge, type VerifiedBadgeProps } from './VerifiedBadge';

// Date & Time
export { CalendarPicker, type CalendarPickerProps } from './CalendarPicker';

// Media
export { ProtectedImage } from './ProtectedImage';
