/**
 * Avatar Component
 *
 * Displays user avatar with fallback to initials.
 */

import React, { useEffect, useState } from 'react';

import styles from './Avatar.module.css';

export type AvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

export interface AvatarProps {
  /** Image URL (full-size) */
  src?: string | null;
  /** Thumbnail URL (preferred for display, falls back to src) */
  thumbnailSrc?: string | null;
  /** Alt text / username for fallback initials */
  name: string;
  /** Avatar size */
  size?: AvatarSize;
  /** Click handler */
  onClick?: () => void;
  /** Whether to show zoom cursor */
  zoomable?: boolean;
  /** Custom className */
  className?: string;
}

const getInitials = (name: string): string => {
  return name.charAt(0).toUpperCase();
};

const INITIALS_TONES = 6;

/** Stable tone per name so the same user always gets the same fallback color */
const getToneIndex = (name: string): number => {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % INITIALS_TONES;
};

export const Avatar: React.FC<AvatarProps> = ({
  src,
  thumbnailSrc,
  name,
  size = 'md',
  onClick,
  zoomable = false,
  className = '',
}) => {
  const [imageError, setImageError] = useState(false);

  const displaySrc = thumbnailSrc || src;
  const showImage = displaySrc && !imageError;

  // Reset error state when the image source changes
  useEffect(() => {
    setImageError(false);
  }, [displaySrc]);

  const classNames = [
    styles.avatar,
    styles[size],
    showImage ? '' : styles[`tone${getToneIndex(name)}`],
    onClick ? styles.clickable : '',
    zoomable ? styles.zoomable : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  // A clickable avatar behaves like a button: Enter and Space activate it (Space without scrolling)
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onClick?.();
  };

  return (
    <div
      className={classNames}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      aria-label={onClick ? name : undefined}
      onKeyDown={onClick ? handleKeyDown : undefined}
    >
      {showImage ? (
        <img
          src={displaySrc}
          alt={name}
          className={styles.image}
          onError={() => setImageError(true)}
          draggable={false}
          onContextMenu={(e) => e.preventDefault()}
          style={{
            WebkitUserSelect: 'none',
            userSelect: 'none',
            WebkitTouchCallout: 'none',
          }}
        />
      ) : (
        <span className={styles.initials}>{getInitials(name)}</span>
      )}
    </div>
  );
};

export default Avatar;
