/**
 * Profile Picture Dialog
 *
 * Dialog for uploading or removing profile picture.
 */

import { Camera, Trash2, X } from 'lucide-react';
import React from 'react';

import type { ProfilePictureDialogProps } from '../SettingsPage.types';
import { DialogWrapper } from './DialogWrapper';

export const ProfilePictureDialog: React.FC<ProfilePictureDialogProps> = ({
  isOpen,
  onClose,
  hasProfilePic,
  onUploadClick,
  onRemoveClick,
}) => {
  if (!isOpen) return null;

  return (
    <DialogWrapper onClose={onClose}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '1rem',
        }}
      >
        <h3
          style={{
            margin: 0,
            fontSize: '1.125rem',
            fontWeight: 600,
            color: 'var(--text-primary)',
          }}
        >
          Profile photo
        </h3>
        <button
          type="button"
          onClick={onClose}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--text-secondary)',
            cursor: 'pointer',
            padding: '0.25rem',
          }}
        >
          <X size={20} />
        </button>
      </div>

      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button
          onClick={() => {
            onUploadClick();
            onClose();
          }}
          style={{
            flex: 1,
            padding: '0.625rem 1.25rem',
            borderRadius: '8px',
            border: 'none',
            backgroundColor: '#0095f6',
            color: '#ffffff',
            fontSize: '0.875rem',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '0.5rem',
            fontWeight: 500,
          }}
        >
          <Camera size={16} />
          {hasProfilePic ? 'Change' : 'Upload'}
        </button>
        {hasProfilePic && (
          <button
            onClick={onRemoveClick}
            style={{
              flex: 1,
              padding: '0.625rem 1.25rem',
              borderRadius: '8px',
              border: '1px solid #ef4444',
              backgroundColor: 'transparent',
              color: '#ef4444',
              fontSize: '0.875rem',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.5rem',
              fontWeight: 500,
            }}
          >
            <Trash2 size={16} />
            Remove
          </button>
        )}
      </div>
    </DialogWrapper>
  );
};
