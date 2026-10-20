/**
 * SettingsPage Types
 *
 * Centralized type definitions for the SettingsPage module.
 */

import type { Badge } from '../../types/api';

// ============================================================================
// Toast Types
// ============================================================================

export interface ToastData {
  message: string;
  type: 'success' | 'error';
}

export type ToastCallback = (message: string, type: 'success' | 'error') => void;

// ============================================================================
// Dialog Props Types
// ============================================================================

export interface DialogWrapperProps {
  children: React.ReactNode;
  onClose: () => void;
}

export interface ProfilePictureDialogProps {
  isOpen: boolean;
  onClose: () => void;
  hasProfilePic: boolean;
  onUploadClick: () => void;
  onRemoveClick: () => void;
}

export interface UsernameDialogProps {
  isOpen: boolean;
  onClose: () => void;
  currentUsername: string;
  onSuccess: (newUsername: string) => void;
}

export interface PasswordDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export interface BioDialogProps {
  isOpen: boolean;
  onClose: () => void;
  currentBio: string;
  onSuccess: (newBio: string) => void;
}

export interface LogoutDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

export interface NotificationsBlockedDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

// ============================================================================
// Component Props Types
// ============================================================================

/** Accent palette for settings row icon chips */
export type SettingsTone =
  | 'violet'
  | 'indigo'
  | 'sky'
  | 'teal'
  | 'green'
  | 'amber'
  | 'orange'
  | 'pink'
  | 'red'
  | 'slate';

export interface SettingsItemProps {
  icon: React.ReactNode;
  label: string;
  /** Secondary line under the label */
  value?: string;
  /** Makes the row a button */
  onClick?: () => void;
  /** Makes the row a link (opened in a new tab when `external`) */
  href?: string;
  /** Shows an external-link indicator and opens `href` in a new tab */
  external?: boolean;
  /** @deprecated Rows now draw inset dividers automatically */
  showBorder?: boolean;
  /** Explicit icon color (overrides `tone`) */
  iconColor?: string;
  /** Explicit icon chip background (overrides `tone`) */
  iconBg?: string;
  /** Icon chip color family */
  tone?: SettingsTone;
  /** Replaces the default chevron (e.g. a switch, count badge) */
  trailing?: React.ReactNode;
  /** Destructive styling (e.g. Log out) */
  danger?: boolean;
  /** Count shown as a pill before the chevron (hidden when 0) */
  badge?: number;
  /**
   * For static rows with a trailing control: id of that control. The row text becomes its
   * <label>, and `${controlId}-label` / `${controlId}-description` name and describe it.
   */
  controlId?: string;
  /** Content rendered under the row, inside the same group (e.g. expanded preferences) */
  children?: React.ReactNode;
}

export interface SettingsSectionProps {
  /** Visible group heading; omit for a standalone group (then pass `ariaLabel`) */
  title?: string;
  /** Accessible name when there is no visible title */
  ariaLabel?: string;
  /** Optional helper text under the group */
  footnote?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

export interface ThemePickerProps {
  value: 'light' | 'dark' | 'system';
  onChange: (theme: 'light' | 'dark' | 'system') => void;
}

export interface PushNotificationsSectionProps {
  onToast: ToastCallback;
}

export interface ProfileSectionProps {
  username: string;
  bio: string | null | undefined;
  profilePic: string | null | undefined;
  profilePicThumb: string | null | undefined;
  followersCount: number;
  followingCount: number;
  isUploadingPic: boolean;
  /** Shows the verified badge next to the username */
  isVerified?: boolean;
  onProfilePicClick: () => void;
  onEditPicClick: () => void;
  onBioClick: () => void;
  onFollowersClick: () => void;
  onFollowingClick: () => void;
}

export interface FullscreenProfilePicProps {
  profilePic: string;
  profilePicThumb?: string | null;
  username: string;
  onClose: () => void;
}

// ============================================================================
// State Types
// ============================================================================

export interface SettingsDialogState {
  showUsernameDialog: boolean;
  showPasswordDialog: boolean;
  showLogoutDialog: boolean;
  showFullscreenPic: boolean;
  showPicDialog: boolean;
  showBioDialog: boolean;
  showFollowRequestsModal: boolean;
  showFollowListModal: 'followers' | 'following' | null;
}

export interface ProfileState {
  followersCount: number;
  followingCount: number;
  isPrivate: boolean;
  isPrivacyLoading: boolean;
  badges: Badge[];
  longestStreak: number;
  badgesLoading: boolean;
  isUploadingPic: boolean;
}
