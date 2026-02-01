/**
 * ProfilePicture Component
 *
 * Profile picture display with upload/remove options.
 */

import { Camera, Trash2 } from 'lucide-react';
import type { RefObject } from 'react';
import React from 'react';

import type { User } from '../../../store/useAuthStore';
import { ProtectedImage } from '../../ui';

interface ProfilePictureProps {
  user: User;
  isUploading: boolean;
  showOptions: boolean;
  onToggleOptions: () => void;
  onOpenFullscreen: () => void;
  onFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onRemove: () => void;
  fileInputRef: RefObject<HTMLInputElement | null>;
}

export const ProfilePicture: React.FC<ProfilePictureProps> = ({
  user,
  isUploading,
  showOptions,
  onToggleOptions,
  onOpenFullscreen,
  onFileSelect,
  onRemove,
  fileInputRef,
}) => {
  return (
    <div
      style={{
        padding: '1rem',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '0.5rem',
      }}
    >
      {/* Hidden file input */}
      <input
        type="file"
        ref={fileInputRef}
        onChange={onFileSelect}
        accept="image/jpeg,image/png,image/webp"
        style={{ display: 'none' }}
      />

      {/* Profile Picture Container */}
      <div style={{ position: 'relative' }}>
        <div
          style={{
            width: '72px',
            height: '72px',
            borderRadius: '12px',
            backgroundColor: 'var(--avatar-bg)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontWeight: 700,
            fontSize: '1.5rem',
            color: 'var(--text-primary)',
            textTransform: 'uppercase',
            overflow: 'hidden',
            cursor: 'pointer',
            border: '2px solid var(--border)',
            transition: 'border-color 0.2s',
          }}
          onClick={onToggleOptions}
          onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--accent)')}
          onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--border)')}
        >
          {isUploading ? (
            <div
              style={{
                width: '24px',
                height: '24px',
                border: '2px solid var(--text-secondary)',
                borderTopColor: 'var(--accent)',
                borderRadius: '50%',
                animation: 'spin 1s linear infinite',
              }}
            />
          ) : user.profilePic ? (
            <div
              onClick={(e) => {
                e.stopPropagation();
                onOpenFullscreen();
              }}
              style={{
                width: '100%',
                height: '100%',
                cursor: 'zoom-in',
              }}
            >
              <ProtectedImage
                src={user.profilePic}
                alt={user.username}
                style={{
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover',
                }}
              />
            </div>
          ) : (
            user.username.charAt(0)
          )}
        </div>

        {/* Camera icon overlay */}
        <div
          style={{
            position: 'absolute',
            bottom: '-4px',
            right: '-4px',
            width: '24px',
            height: '24px',
            borderRadius: '50%',
            backgroundColor: 'var(--accent)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            boxShadow: '0 2px 4px rgba(0,0,0,0.2)',
          }}
          onClick={(e) => {
            e.stopPropagation();
            onToggleOptions();
          }}
        >
          <Camera size={12} color="white" />
        </div>
      </div>

      {/* Picture Options Dropdown */}
      {showOptions && (
        <div
          style={{
            display: 'flex',
            gap: '0.5rem',
            marginTop: '0.25rem',
          }}
        >
          <button
            onClick={() => fileInputRef.current?.click()}
            style={{
              padding: '0.4rem 0.75rem',
              borderRadius: '6px',
              border: 'none',
              backgroundColor: 'var(--accent)',
              color: 'white',
              fontSize: '0.75rem',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '0.3rem',
            }}
          >
            <Camera size={12} />
            {user.profilePic ? 'Change' : 'Upload'}
          </button>
          {user.profilePic && (
            <button
              onClick={onRemove}
              style={{
                padding: '0.4rem 0.75rem',
                borderRadius: '6px',
                border: '1px solid #ef4444',
                backgroundColor: 'transparent',
                color: '#ef4444',
                fontSize: '0.75rem',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '0.3rem',
              }}
            >
              <Trash2 size={12} />
              Remove
            </button>
          )}
        </div>
      )}

      <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{user.username}</span>
    </div>
  );
};
