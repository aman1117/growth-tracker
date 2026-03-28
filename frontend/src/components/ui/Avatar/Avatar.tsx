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
    onClick ? styles.clickable : '',
    zoomable ? styles.zoomable : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classNames} onClick={onClick}>
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
