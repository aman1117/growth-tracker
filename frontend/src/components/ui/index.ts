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
export { Button, type ButtonProps, type ButtonVariant, type ButtonSize } from './Button';
export { IconButton, type IconButtonProps, type IconButtonVariant, type IconButtonSize } from './IconButton';
export { Input, type InputProps } from './Input';
export { Toggle, type ToggleProps } from './Toggle';

// Navigation
export { Tabs, type TabsProps, type Tab } from './Tabs';

// Feedback & Status
export { SnapToast, type SnapToastProps, type SnapToastType } from './SnapToast';
export { LoadingSpinner, type LoadingSpinnerProps, type SpinnerSize } from './LoadingSpinner';
export { Skeleton, SkeletonText, SkeletonAvatar, SkeletonCard, type SkeletonProps, type SkeletonTextProps, type SkeletonAvatarProps, type SkeletonCardProps } from './Skeleton';
export { EmptyState, type EmptyStateProps } from './EmptyState';

// Social & Interactions
export { LikeButton, type LikeButtonProps } from './LikeButton';
export { StreakBadge, type StreakBadgeProps } from './Badge';
export { VerifiedBadge, type VerifiedBadgeProps } from './VerifiedBadge';
export { NotificationCenter, NotificationPanel, NotificationItem, NotificationBell } from './Notification';

// Date & Time
export { CalendarPicker, type CalendarPickerProps } from './CalendarPicker';

// Media
export { ProtectedImage } from './ProtectedImage';
