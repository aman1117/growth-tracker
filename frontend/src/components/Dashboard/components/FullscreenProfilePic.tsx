/**
 * FullscreenProfilePic Component
 *
 * Displays a fullscreen view of a user's profile picture.
 * Closes on tap outside, Escape, or the system Back gesture.
 */

import { X } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useBackDismiss } from '../../../hooks/useBackDismiss';
import { useBodyScrollLock } from '../../../hooks/useBodyScrollLock';
import { useEscapeKey } from '../../../hooks/useEscapeKey';
import { ProtectedImage } from '../../ui';
import styles from './FullscreenProfilePic.module.css';

interface FullscreenProfilePicProps {
  profilePic: string;
  profilePicThumb?: string | null;
  username: string;
  onClose: () => void;
}

export const FullscreenProfilePic: React.FC<FullscreenProfilePicProps> = ({
  profilePic,
  profilePicThumb,
  username,
  onClose,
}) => {
  const [fullLoaded, setFullLoaded] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  // Mounted only while open: Back closes the photo instead of leaving the profile
  useBackDismiss(true, onClose);
  useEscapeKey(true, onClose);
  useBodyScrollLock(true);

  // Focus the close button for keyboard users
  useEffect(() => {
    closeButtonRef.current?.focus({ preventScroll: true });
  }, []);

  // Preload full image in background
  useEffect(() => {
    if (!profilePicThumb) return;
    const img = new Image();
    img.onload = () => setFullLoaded(true);
    img.src = profilePic;
    return () => {
      img.onload = null;
    };
  }, [profilePic, profilePicThumb]);

  const showThumb = !!profilePicThumb && !fullLoaded;

  return createPortal(
    <div
      className={styles.overlay}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`${username}'s profile photo`}
    >
      <button
        ref={closeButtonRef}
        type="button"
        className={styles.closeButton}
        onClick={onClose}
        aria-label="Close photo"
      >
        <X size={22} strokeWidth={2.25} aria-hidden="true" />
      </button>

      <div className={styles.frame} onClick={(e) => e.stopPropagation()}>
        {showThumb && profilePicThumb && (
          <ProtectedImage
            src={profilePicThumb}
            alt=""
            className={`${styles.image} ${styles.thumb}`}
          />
        )}
        <ProtectedImage
          src={profilePic}
          alt={username}
          className={`${styles.image} ${profilePicThumb ? styles.progressive : ''} ${
            fullLoaded || !profilePicThumb ? styles.loaded : ''
          }`}
        />
      </div>

      <div className={styles.caption}>{username}</div>
    </div>,
    document.body
  );
};
