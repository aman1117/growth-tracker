/**
 * Profile Section Component
 *
 * User profile card with avatar, bio, and follow counts.
 */

import { Camera, Pencil } from 'lucide-react';
import React from 'react';

import { ProtectedImage } from '../../ui';
import type { ProfileSectionProps } from '../SettingsPage.types';

export const ProfileSection: React.FC<ProfileSectionProps> = ({
  username,
  bio,
  profilePic,
  followersCount,
  followingCount,
  isUploadingPic,
  onProfilePicClick,
  onEditPicClick,
  onBioClick,
  onFollowersClick,
  onFollowingClick,
}) => {
  return (
    <div className="card" style={{ padding: '1rem', marginBottom: '0.75rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
        {/* Profile Picture */}
        <div style={{ position: 'relative' }}>
          <div
            style={{
              width: '56px',
              height: '56px',
              borderRadius: '50%',
              backgroundColor: 'var(--avatar-bg)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 700,
              fontSize: '1.5rem',
              color: 'var(--text-primary)',
              textTransform: 'uppercase',
              overflow: 'hidden',
              cursor: profilePic ? 'zoom-in' : 'pointer',
              border: '2px solid var(--border)',
              transition: 'border-color 0.2s',
            }}
            onClick={onProfilePicClick}
            onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--accent)')}
            onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--border)')}
          >
            {isUploadingPic ? (
              <div
                style={{
                  width: '20px',
                  height: '20px',
                  border: '2px solid var(--text-secondary)',
                  borderTopColor: 'var(--accent)',
                  borderRadius: '50%',
                  animation: 'spin 1s linear infinite',
                }}
              />
            ) : profilePic ? (
              <ProtectedImage
                src={profilePic}
                alt={username}
                style={{
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover',
                }}
              />
            ) : (
              username.charAt(0)
            )}
          </div>

          {/* Camera icon overlay */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onEditPicClick();
            }}
            style={{
              position: 'absolute',
              bottom: '-2px',
              right: '-2px',
              width: '22px',
              height: '22px',
              borderRadius: '50%',
              backgroundColor: 'var(--accent)',
              border: '2px solid var(--bg-primary)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
            }}
          >
            <Camera size={10} color="white" />
          </button>
        </div>

        <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
          <h2
            style={{
              fontSize: '1rem',
              fontWeight: 600,
              color: 'var(--text-primary)',
              margin: 0,
            }}
          >
            {username}
          </h2>
          <div
            onClick={onBioClick}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.35rem',
              marginTop: '0.25rem',
              cursor: 'pointer',
              maxWidth: '100%',
            }}
          >
            <p
              style={{
                fontSize: '0.8rem',
                color: bio ? 'var(--text-secondary)' : 'var(--accent)',
                margin: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                flex: 1,
                minWidth: 0,
              }}
            >
              {bio || '+ Add bio'}
            </p>
            <Pencil size={12} color="var(--accent)" style={{ flexShrink: 0 }} />
          </div>

          {/* Followers / Following Stats */}
          <div
            style={{
              display: 'flex',
              gap: '1rem',
              marginTop: '0.5rem',
            }}
          >
            <button
              onClick={onFollowersClick}
              style={{
                background: 'none',
                border: 'none',
                padding: 0,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '0.25rem',
              }}
            >
              <span
                style={{
                  fontSize: '0.875rem',
                  fontWeight: 600,
                  color: 'var(--text-primary)',
                }}
              >
                {followersCount}
              </span>
              <span
                style={{
                  fontSize: '0.8rem',
                  color: 'var(--text-secondary)',
                }}
              >
                Followers
              </span>
            </button>
            <button
              onClick={onFollowingClick}
              style={{
                background: 'none',
                border: 'none',
                padding: 0,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '0.25rem',
              }}
            >
              <span
                style={{
                  fontSize: '0.875rem',
                  fontWeight: 600,
                  color: 'var(--text-primary)',
                }}
              >
                {followingCount}
              </span>
              <span
                style={{
                  fontSize: '0.8rem',
                  color: 'var(--text-secondary)',
                }}
              >
                Following
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
