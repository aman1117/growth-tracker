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
import { Avatar, VerifiedBadge } from '../../ui';
import styles from './UserProfileHeader.module.css';

interface UserProfileHeaderProps {
  targetUsername: string;
  targetUserId: number | null;
  targetProfilePic: string | null;
  targetProfilePicThumb: string | null;
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
  targetProfilePicThumb,
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
  const hasStories =
    !isPrivateAccount && targetUserPhotos.length > 0 && targetUserPhotosOwnerId === targetUserId;
  const isAvatarInteractive = hasStories || !!targetProfilePic;

  const avatar = (
    <Avatar
      src={targetProfilePic}
      thumbnailSrc={targetProfilePicThumb}
      name={targetUsername}
      size="xl"
      className={styles.avatar}
    />
  );

  return (
    <section className={styles.container} aria-label={`${targetUsername}'s profile`}>
      {/* Row 1: Avatar + Stats */}
      <div className={styles.avatarRow}>
        {isAvatarInteractive ? (
          <button
            type="button"
            onClick={onAvatarClick}
            className={`${styles.avatarRing} ${hasStories ? styles.avatarWithStory : ''}`}
            aria-label={
              hasStories ? `View ${targetUsername}'s stories` : `View ${targetUsername}'s photo`
            }
          >
            {avatar}
          </button>
        ) : (
          <div className={styles.avatarRing}>{avatar}</div>
        )}
        <div className={styles.statsCol}>
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
      <div className={styles.infoCol}>
        <span className={styles.usernameRow}>
          {targetUsername}
          {targetIsVerified && <VerifiedBadge size={16} />}
        </span>
        {!isPrivateAccount && targetBio && <p className={styles.bio}>{targetBio}</p>}
        {/* Last logged - only shown when available (privacy-aware from backend) */}
        {targetLastLoggedAt && (
          <span className={styles.lastLogged}>
            <Clock size={12} strokeWidth={2.5} aria-hidden="true" />
            Last logged {formatLastLogged(targetLastLoggedAt)}
          </span>
        )}
        {/* Mutual Followers - "Followed by X, Y and N others" */}
        {targetUserId && <MutualFollowers userId={targetUserId} username={targetUsername} />}
      </div>

      {/* Row 3: Follow Button + Analytics */}
      <div className={styles.actionRow}>
        {targetUserId && (
          <div className={styles.followCol}>
            <FollowButton
              userId={targetUserId}
              username={targetUsername}
              isPrivate={targetIsPrivate}
              size="lg"
              fullWidth
            />
          </div>
        )}
        {!isPrivateAccount && (
          <button
            type="button"
            onClick={onAnalyticsClick}
            className={styles.analyticsButton}
            title="View Analytics"
            aria-label={`View ${targetUsername}'s insights`}
          >
            <BarChart3 size={16} strokeWidth={2.5} aria-hidden="true" />
            <span>Insights</span>
          </button>
        )}
      </div>
    </section>
  );
};
