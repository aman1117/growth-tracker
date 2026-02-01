/**
 * UserProfileHeader Component
 *
 * Displays the profile header when viewing another user's dashboard.
 * Shows avatar, stats, bio, follow button, and analytics link.
 */

import { BarChart3, Clock } from 'lucide-react';
import React from 'react';

import type { ActivityPhoto } from '../../../types';
import { formatLastLogged } from '../../../types';
import { FollowButton, FollowStats, MutualFollowers } from '../../social';
import { ProtectedImage, VerifiedBadge } from '../../ui';

interface UserProfileHeaderProps {
  targetUsername: string;
  targetUserId: number | null;
  targetProfilePic: string | null;
  targetBio: string | null;
  targetIsVerified: boolean;
  targetIsPrivate: boolean;
  targetLastLoggedAt: string | null;
  isPrivateAccount: boolean;
  targetUserPhotos: ActivityPhoto[];
  targetUserPhotosOwnerId: number | null;
  onAvatarClick: () => void;
  onAnalyticsClick: () => void;
}

export const UserProfileHeader: React.FC<UserProfileHeaderProps> = ({
  targetUsername,
  targetUserId,
  targetProfilePic,
  targetBio,
  targetIsVerified,
  targetIsPrivate,
  targetLastLoggedAt,
  isPrivateAccount,
  targetUserPhotos,
  targetUserPhotosOwnerId,
  onAvatarClick,
  onAnalyticsClick,
}) => {
  // Check if user has viewable stories (not private, has photos, and photos belong to current user)
  const hasStories = !isPrivateAccount && targetUserPhotos.length > 0 && targetUserPhotosOwnerId === targetUserId;

  return (
    <div
      style={{
        background: 'var(--tile-glass-bg)',
        backdropFilter: 'blur(var(--tile-glass-blur))',
        WebkitBackdropFilter: 'blur(var(--tile-glass-blur))',
        padding: '1rem',
        marginBottom: '1rem',
        borderRadius: '20px',
        border: '1px solid var(--tile-glass-border)',
        boxShadow: 'var(--tile-glass-shadow), var(--tile-glass-inner-glow)',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.75rem',
      }}
    >
      {/* Row 1: Avatar + Stats */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '1rem',
        }}
      >
        <div
          onClick={onAvatarClick}
          style={{
            width: '72px',
            height: '72px',
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
            flexShrink: 0,
            cursor: hasStories || targetProfilePic ? 'pointer' : 'default',
            // Use consistent 3px border, only color changes for story indicator
            border: hasStories
              ? '3px solid #0095f6'  // Story ring indicator
              : '3px solid var(--border)',
          }}
        >
          {targetProfilePic ? (
            <ProtectedImage
              src={targetProfilePic}
              alt={targetUsername}
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
              }}
            />
          ) : (
            targetUsername.charAt(0)
          )}
        </div>
        {/* Stats next to avatar */}
        <div style={{ flex: 1 }}>
          {targetUserId && (
            <FollowStats
              userId={targetUserId}
              username={targetUsername}
              isPrivate={targetIsPrivate}
              canView={!isPrivateAccount}
            />
          )}
        </div>
      </div>

      {/* Row 2: Username + Bio */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.25rem',
            fontWeight: 600,
            fontSize: '0.875rem',
            color: 'var(--text-primary)',
          }}
        >
          {targetUsername}
          {targetIsVerified && <VerifiedBadge size={14} />}
        </span>
        {!isPrivateAccount && targetBio && (
          <span
            style={{
              fontSize: '0.875rem',
              color: 'var(--text-primary)',
              lineHeight: 1.4,
              wordBreak: 'break-word',
            }}
          >
            {targetBio}
          </span>
        )}
        {/* Last logged - only shown when available (privacy-aware from backend) */}
        {targetLastLoggedAt && (
          <span
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              fontSize: '12px',
              color: 'var(--text-primary)',
              marginTop: '2px',
            }}
          >
            <Clock size={12} />
            Last logged {formatLastLogged(targetLastLoggedAt)}
          </span>
        )}
        {/* Mutual Followers - "Followed by X, Y and N others" */}
        {targetUserId && (
          <MutualFollowers userId={targetUserId} username={targetUsername} />
        )}
      </div>

      {/* Row 3: Follow Button + Analytics */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
        }}
      >
        {targetUserId && (
          <div style={{ flex: 1 }}>
            <FollowButton
              userId={targetUserId}
              username={targetUsername}
              isPrivate={targetIsPrivate}
              size="md"
              fullWidth
            />
          </div>
        )}
        {!isPrivateAccount && (
          <button
            onClick={onAnalyticsClick}
            className="secondary-button"
            style={{
              padding: '0 0.875rem',
              borderRadius: '8px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              height: '32px',
              minWidth: '40px',
            }}
            title="View Analytics"
          >
            <BarChart3 size={16} />
          </button>
        )}
      </div>
    </div>
  );
};
