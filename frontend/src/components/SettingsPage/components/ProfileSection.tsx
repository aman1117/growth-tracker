/**
 * Profile Section Component
 *
 * Profile card for the "You" tab: avatar (view / change photo), username, bio and follow counts.
 */

import { Camera, Pencil, Plus } from 'lucide-react';
import React from 'react';

import { Avatar, LoadingSpinner, VerifiedBadge } from '../../ui';
import type { ProfileSectionProps } from '../SettingsPage.types';
import styles from './ProfileSection.module.css';

const formatCount = (count: number): string =>
  count >= 10000 ? `${(count / 1000).toFixed(count >= 100000 ? 0 : 1)}k` : count.toLocaleString();

export const ProfileSection: React.FC<ProfileSectionProps> = ({
  username,
  bio,
  profilePic,
  profilePicThumb,
  followersCount,
  followingCount,
  isUploadingPic,
  isVerified = false,
  onProfilePicClick,
  onEditPicClick,
  onBioClick,
  onFollowersClick,
  onFollowingClick,
}) => {
  const trimmedBio = bio?.trim();

  return (
    <section className={styles.card} aria-label="Your profile">
      <div className={styles.top}>
        <div className={styles.avatarWrap}>
          <button
            type="button"
            className={`${styles.ring} ${profilePic ? styles.ringZoom : ''}`}
            onClick={onProfilePicClick}
            aria-label={profilePic ? 'View profile photo' : 'Add a profile photo'}
            disabled={isUploadingPic}
          >
            <span className={styles.ringInner}>
              <Avatar
                src={profilePic}
                thumbnailSrc={profilePicThumb}
                name={username}
                size="xl"
                className={styles.avatar}
              />
              {isUploadingPic && (
                <span className={styles.uploading} role="status">
                  <LoadingSpinner size="sm" />
                  <span className="sr-only">Uploading photo…</span>
                </span>
              )}
            </span>
          </button>
          <button
            type="button"
            className={styles.cameraButton}
            onClick={onEditPicClick}
            aria-label={profilePic ? 'Change profile photo' : 'Add a profile photo'}
            disabled={isUploadingPic}
          >
            <Camera size={14} strokeWidth={2.4} aria-hidden="true" />
          </button>
        </div>

        <div className={styles.identity}>
          <h2 className={styles.username}>
            <span className={styles.usernameText}>{username}</span>
            {isVerified && <VerifiedBadge size={18} />}
          </h2>
          <button
            type="button"
            className={styles.bioButton}
            onClick={onBioClick}
            aria-label={trimmedBio ? `Edit bio: ${trimmedBio}` : 'Add a bio'}
          >
            {trimmedBio ? (
              <>
                <span className={styles.bioText}>{trimmedBio}</span>
                <Pencil size={13} strokeWidth={2.4} className={styles.bioIcon} aria-hidden="true" />
              </>
            ) : (
              <span className={styles.bioEmpty}>
                <Plus size={14} strokeWidth={2.6} aria-hidden="true" />
                Add a bio
              </span>
            )}
          </button>
        </div>
      </div>

      <div className={styles.stats}>
        <button type="button" className={styles.stat} onClick={onFollowersClick}>
          <span className={styles.statValue}>{formatCount(followersCount)}</span>
          <span className={styles.statLabel}>
            {followersCount === 1 ? 'Follower' : 'Followers'}
          </span>
        </button>
        <button type="button" className={styles.stat} onClick={onFollowingClick}>
          <span className={styles.statValue}>{formatCount(followingCount)}</span>
          <span className={styles.statLabel}>Following</span>
        </button>
      </div>
    </section>
  );
};
