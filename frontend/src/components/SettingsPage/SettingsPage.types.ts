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

export interface SettingsItemProps {
  icon: React.ReactNode;
  label: string;
  value?: string;
  onClick: () => void;
  showBorder?: boolean;
  iconColor?: string;
  iconBg?: string;
}

export interface PushNotificationsSectionProps {
  onToast: ToastCallback;
}

export interface ProfileSectionProps {
  username: string;
  bio: string | null | undefined;
  profilePic: string | null | undefined;
  followersCount: number;
  followingCount: number;
  isUploadingPic: boolean;
  onProfilePicClick: () => void;
  onEditPicClick: () => void;
  onBioClick: () => void;
  onFollowersClick: () => void;
  onFollowingClick: () => void;
}

export interface FullscreenProfilePicProps {
  profilePic: string;
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
