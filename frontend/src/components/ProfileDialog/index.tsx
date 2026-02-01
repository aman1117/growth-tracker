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
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        zIndex: 100,
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        paddingTop: '15vh',
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: '100%',
          maxWidth: '300px',
          background: 'var(--glass-bg)',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
          borderRadius: '14px',
          boxShadow: 'var(--glass-shadow)',
          border: '1px solid var(--glass-border)',
          overflow: 'hidden',
          margin: '0 1rem',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            padding: '0.75rem 1rem',
            borderBottom: '1px solid var(--border)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--text-primary)' }}>
            Profile
          </span>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              padding: '0.25rem',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
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
        <div style={{ padding: '0 0.5rem 0.5rem' }}>
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
