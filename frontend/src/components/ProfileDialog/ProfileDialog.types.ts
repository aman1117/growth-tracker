/**
 * ProfileDialog Types
 */

export interface ProfileDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onLogout: () => void;
}

export interface ToastState {
  message: string;
  type: 'success' | 'error';
}

export interface ProfileDialogState {
  isEditingUsername: boolean;
  newUsername: string;
  error: string;
  isLoading: boolean;
  isPrivate: boolean;
  isPrivacyLoading: boolean;
  isUploadingPic: boolean;
  showPicOptions: boolean;
  showFullscreenPic: boolean;
  toast: ToastState | null;
  isChangingPassword: boolean;
  currentPassword: string;
  newPassword: string;
  passwordError: string;
  isPasswordLoading: boolean;
  passwordSuccess: boolean;
}
