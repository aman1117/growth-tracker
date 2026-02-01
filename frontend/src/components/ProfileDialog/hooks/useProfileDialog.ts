/**
 * useProfileDialog Hook
 *
 * Manages all state and handlers for the ProfileDialog component.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { VALIDATION, VALIDATION_MESSAGES } from '../../../constants/validation';
import { api } from '../../../services/api';
import { useAuth } from '../../../store';
import type { ToastState } from '../ProfileDialog.types';

export const useProfileDialog = (isOpen: boolean) => {
  const { user, updateUsername, updateProfilePic } = useAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Username editing state
  const [isEditingUsername, setIsEditingUsername] = useState(false);
  const [newUsername, setNewUsername] = useState(user?.username || '');
  const [usernameError, setUsernameError] = useState('');
  const [isUsernameLoading, setIsUsernameLoading] = useState(false);

  // Privacy state
  const [isPrivate, setIsPrivate] = useState(false);
  const [isPrivacyLoading, setIsPrivacyLoading] = useState(false);

  // Profile picture state
  const [isUploadingPic, setIsUploadingPic] = useState(false);
  const [showPicOptions, setShowPicOptions] = useState(false);
  const [showFullscreenPic, setShowFullscreenPic] = useState(false);

  // Toast state
  const [toast, setToast] = useState<ToastState | null>(null);

  // Password change state
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [isPasswordLoading, setIsPasswordLoading] = useState(false);
  const [passwordSuccess, setPasswordSuccess] = useState(false);

  // Fetch privacy setting and profile when dialog opens
  useEffect(() => {
    if (isOpen && user) {
      // Reset all edit states when dialog opens
      setIsEditingUsername(false);
      setNewUsername(user.username || '');
      setUsernameError('');
      setIsChangingPassword(false);
      setCurrentPassword('');
      setNewPassword('');
      setPasswordError('');
      setPasswordSuccess(false);
      setShowPicOptions(false);
      setShowFullscreenPic(false);

      api.get('/get-privacy').then((res) => {
        if (res.success) {
          setIsPrivate(res.is_private);
        }
      });
      api.get('/profile').then((res) => {
        if (res.success && res.profile_pic) {
          updateProfilePic(res.profile_pic);
        }
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Privacy toggle
  const togglePrivacy = useCallback(async () => {
    setIsPrivacyLoading(true);
    try {
      const res = await api.post('/update-privacy', { is_private: !isPrivate });
      if (res.success) {
        setIsPrivate(res.is_private);
      }
    } catch {
      console.error('Failed to update privacy');
    } finally {
      setIsPrivacyLoading(false);
    }
  }, [isPrivate]);

  // Profile picture handlers
  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      const ext = file.name.toLowerCase().split('.').pop();

      if (
        !VALIDATION.ALLOWED_IMAGE_TYPES.includes(file.type) &&
        !VALIDATION.ALLOWED_IMAGE_EXTENSIONS.includes(ext || '')
      ) {
        setToast({ message: VALIDATION_MESSAGES.FILE_TYPE_ERROR, type: 'error' });
        return;
      }

      if (file.size > VALIDATION.MAX_FILE_SIZE) {
        setToast({ message: VALIDATION_MESSAGES.FILE_SIZE_ERROR, type: 'error' });
        return;
      }

      setIsUploadingPic(true);
      setShowPicOptions(false);

      try {
        const res = await api.uploadFile('/profile/upload-picture', file);
        if (res.success) {
          updateProfilePic(res.profile_pic ?? null);
          setToast({ message: 'Profile picture updated!', type: 'success' });
        } else {
          setToast({ message: res.error || 'Failed to upload image', type: 'error' });
        }
      } catch {
        setToast({ message: 'Failed to upload image', type: 'error' });
      } finally {
        setIsUploadingPic(false);
        if (fileInputRef.current) {
          fileInputRef.current.value = '';
        }
      }
    },
    [updateProfilePic]
  );

  const handleRemovePicture = useCallback(async () => {
    setIsUploadingPic(true);
    setShowPicOptions(false);

    try {
      const res = await api.delete('/profile/picture');
      if (res.success) {
        updateProfilePic(null);
        setToast({ message: 'Profile picture removed', type: 'success' });
      } else {
        setToast({ message: res.error || 'Failed to remove image', type: 'error' });
      }
    } catch {
      setToast({ message: 'Failed to remove image', type: 'error' });
    } finally {
      setIsUploadingPic(false);
    }
  }, [updateProfilePic]);

  // Username handlers
  const validateUsername = (username: string): string | null => {
    if (username.length < 3 || username.length > 20) {
      return 'Username must be 3-20 characters';
    }
    if (!/^[a-z0-9_.]+$/.test(username)) {
      return 'Only lowercase letters, numbers, _ and . allowed';
    }
    return null;
  };

  const handleUsernameChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value.toLowerCase();
    setNewUsername(value);
    setUsernameError('');
  }, []);

  const handleSaveUsername = useCallback(async () => {
    const validationError = validateUsername(newUsername);
    if (validationError) {
      setUsernameError(validationError);
      return;
    }

    if (newUsername === user?.username) {
      setIsEditingUsername(false);
      return;
    }

    setIsUsernameLoading(true);
    try {
      const res = await api.post('/update-username', { new_username: newUsername });
      if (res.success) {
        updateUsername(res.new_username);
        setIsEditingUsername(false);
        setUsernameError('');
      } else {
        setUsernameError(res.error || 'Failed to update username');
      }
    } catch {
      setUsernameError('Failed to update username');
    } finally {
      setIsUsernameLoading(false);
    }
  }, [newUsername, user?.username, updateUsername]);

  const handleCancelUsernameEdit = useCallback(() => {
    setNewUsername(user?.username || '');
    setIsEditingUsername(false);
    setUsernameError('');
  }, [user?.username]);

  const startUsernameEdit = useCallback(() => {
    setIsEditingUsername(true);
  }, []);

  // Password handlers
  const handlePasswordChange = useCallback(async () => {
    if (currentPassword.length === 0 || newPassword.length === 0) {
      setPasswordError('All fields are required');
      return;
    }
    if (newPassword.length < 8) {
      setPasswordError('Password must be at least 8 characters');
      return;
    }

    setIsPasswordLoading(true);
    setPasswordError('');
    try {
      const res = await api.post('/change-password', {
        current_password: currentPassword,
        new_password: newPassword,
      });
      if (res.success) {
        setPasswordSuccess(true);
        setCurrentPassword('');
        setNewPassword('');
        setTimeout(() => {
          setIsChangingPassword(false);
          setPasswordSuccess(false);
        }, 1500);
      } else {
        setPasswordError(res.error || 'Failed to change password');
      }
    } catch {
      setPasswordError('Failed to change password');
    } finally {
      setIsPasswordLoading(false);
    }
  }, [currentPassword, newPassword]);

  const handleCancelPasswordChange = useCallback(() => {
    setCurrentPassword('');
    setNewPassword('');
    setPasswordError('');
    setIsChangingPassword(false);
    setPasswordSuccess(false);
  }, []);

  const startPasswordChange = useCallback(() => {
    setIsChangingPassword(true);
  }, []);

  const updateCurrentPassword = useCallback((value: string) => {
    setCurrentPassword(value);
    setPasswordError('');
  }, []);

  const updateNewPassword = useCallback((value: string) => {
    setNewPassword(value);
    setPasswordError('');
  }, []);

  // Picture options toggle
  const togglePicOptions = useCallback(() => {
    setShowPicOptions((prev) => !prev);
  }, []);

  const openFullscreenPic = useCallback(() => {
    setShowFullscreenPic(true);
  }, []);

  const closeFullscreenPic = useCallback(() => {
    setShowFullscreenPic(false);
  }, []);

  const clearToast = useCallback(() => {
    setToast(null);
  }, []);

  return {
    user,
    fileInputRef,
    // Username
    isEditingUsername,
    newUsername,
    usernameError,
    isUsernameLoading,
    handleUsernameChange,
    handleSaveUsername,
    handleCancelUsernameEdit,
    startUsernameEdit,
    // Privacy
    isPrivate,
    isPrivacyLoading,
    togglePrivacy,
    // Profile picture
    isUploadingPic,
    showPicOptions,
    showFullscreenPic,
    handleFileSelect,
    handleRemovePicture,
    togglePicOptions,
    openFullscreenPic,
    closeFullscreenPic,
    // Password
    isChangingPassword,
    currentPassword,
    newPassword,
    passwordError,
    isPasswordLoading,
    passwordSuccess,
    handlePasswordChange,
    handleCancelPasswordChange,
    startPasswordChange,
    updateCurrentPassword,
    updateNewPassword,
    // Toast
    toast,
    clearToast,
  };
};
