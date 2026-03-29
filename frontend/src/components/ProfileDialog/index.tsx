/**
 * ProfileDialog Component
 *
 * User profile management dialog with options for:
 * - Profile picture upload/removal
 * - Username change
 * - Password change
 * - Theme toggle
 * - Privacy settings
 * - Logout
 */

import { X } from 'lucide-react';
import React from 'react';

import { useTheme } from '../../store';
import { SnapToast } from '../ui';
import {
  FullscreenViewer,
  LogoutButton,
  PasswordEditor,
  PrivacyToggle,
  ProfilePicture,
  ThemeToggle,
  UsernameEditor,
} from './components';
import { useProfileDialog } from './hooks';
import styles from './ProfileDialog.module.css';
import type { ProfileDialogProps } from './ProfileDialog.types';

export const ProfileDialog: React.FC<ProfileDialogProps> = ({ isOpen, onClose, onLogout }) => {
  const { theme, toggleTheme } = useTheme();

  const {
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
  } = useProfileDialog(isOpen);

  if (!isOpen || !user) return null;

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className={styles.header}>
          <span className={styles.headerTitle}>Profile</span>
          <button onClick={onClose} className={styles.closeButton}>
            <X size={18} />
          </button>
        </div>

        {/* Profile Avatar */}
        <ProfilePicture
          user={user}
          isUploading={isUploadingPic}
          showOptions={showPicOptions}
          onToggleOptions={togglePicOptions}
          onOpenFullscreen={openFullscreenPic}
          onFileSelect={handleFileSelect}
          onRemove={handleRemovePicture}
          fileInputRef={fileInputRef}
        />

        {/* Options */}
        <div className={styles.body}>
          <UsernameEditor
            isEditing={isEditingUsername}
            newUsername={newUsername}
            error={usernameError}
            isLoading={isUsernameLoading}
            onStartEdit={startUsernameEdit}
            onChange={handleUsernameChange}
            onSave={handleSaveUsername}
            onCancel={handleCancelUsernameEdit}
          />

          <PasswordEditor
            isEditing={isChangingPassword}
            currentPassword={currentPassword}
            newPassword={newPassword}
            error={passwordError}
            isLoading={isPasswordLoading}
            success={passwordSuccess}
            onStartEdit={startPasswordChange}
            onCurrentPasswordChange={updateCurrentPassword}
            onNewPasswordChange={updateNewPassword}
            onSave={handlePasswordChange}
            onCancel={handleCancelPasswordChange}
          />

          <ThemeToggle theme={theme} onToggle={toggleTheme} />

          <PrivacyToggle
            isPrivate={isPrivate}
            isLoading={isPrivacyLoading}
            onToggle={togglePrivacy}
          />

          <LogoutButton onLogout={onLogout} />
        </div>
      </div>

      {/* Fullscreen Profile Picture Viewer */}
      {showFullscreenPic && user.profilePic && (
        <FullscreenViewer
          profilePic={user.profilePic}
          profilePicThumb={user.profilePicThumb}
          username={user.username}
          onClose={closeFullscreenPic}
        />
      )}

      {/* Toast notification */}
      {toast && <SnapToast message={toast.message} type={toast.type} onClose={clearToast} />}
    </div>
  );
};

export default ProfileDialog;
