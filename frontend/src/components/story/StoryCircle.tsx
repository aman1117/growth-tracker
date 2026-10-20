/**
 * StoryCircle Component
 *
 * Displays a circular story indicator similar to Instagram stories.
 * Shows activity thumbnail with an aurora ring (unseen) or neutral ring (seen/own).
 * Shows "+" icon for uploadable activities without photos.
 */

import { Camera, Plus } from 'lucide-react';
import React from 'react';

import type { ActivityPhoto } from '../../types/story';
import { DynamicIcon } from '../DynamicIcon';
import styles from './StoryCircle.module.css';
import ring from './StoryRing.module.css';

export interface StoryCircleProps {
  /** Activity name (e.g., 'sleep', 'custom:uuid') */
  activityName: string;
  /** Display label for the activity */
  displayLabel: string;
  /** Lucide icon name (for custom tiles) */
  icon?: string;
  /** Activity color */
  color: string;
  /** Photo data if uploaded */
  photo?: ActivityPhoto;
  /** Whether this circle has been viewed (for friend's stories) */
  isViewed?: boolean;
  /** Whether this is the current user's own circle */
  isOwn?: boolean;
  /** Whether upload is allowed (date within 7 days, own profile) */
  canUpload?: boolean;
  /** Click handler */
  onClick?: () => void;
  /** Upload handler (for "+" circles) */
  onUpload?: () => void;
  /** Whether upload is in progress */
  isUploading?: boolean;
  /** Size variant */
  size?: 'small' | 'medium' | 'large';
}

const ICON_SIZES = { small: 16, medium: 22, large: 28 } as const;

export const StoryCircle: React.FC<StoryCircleProps> = ({
  displayLabel,
  icon,
  color,
  photo,
  isViewed = false,
  isOwn = false,
  canUpload = false,
  onClick,
  onUpload,
  isUploading = false,
  size = 'medium',
}) => {
  const hasPhoto = !!photo;
  const showAddButton = !hasPhoto && canUpload;
  const iconSize = ICON_SIZES[size];

  // Determine ring style
  const ringClass = hasPhoto
    ? isOwn || isViewed
      ? ring.ringViewed
      : ring.ringUnseen
    : ring.ringEmpty;

  const sizeClass = size === 'small' ? ring.small : size === 'large' ? ring.large : '';

  const handleClick = () => {
    if (isUploading) return;

    if (showAddButton && onUpload) {
      onUpload();
    } else if (hasPhoto && onClick) {
      onClick();
    }
  };

  // Generate aria label for accessibility
  const ariaLabel = hasPhoto
    ? `View ${displayLabel} photo`
    : canUpload
      ? `Upload photo for ${displayLabel}`
      : `${displayLabel} - no photo`;

  return (
    <div className={ring.item} style={{ '--activity-color': color } as React.CSSProperties}>
      <button
        className={`${ring.ring} ${sizeClass} ${ringClass} ${isUploading ? ring.ringUploading : ''}`}
        onClick={handleClick}
        disabled={isUploading || (!hasPhoto && !canUpload)}
        aria-label={ariaLabel}
        aria-busy={isUploading || undefined}
        type="button"
      >
        <span className={ring.ringContent}>
          {hasPhoto && photo ? (
            <img
              src={photo.thumbnail_url}
              alt={`${displayLabel} activity`}
              className={ring.image}
              loading="lazy"
              draggable={false}
              onContextMenu={(e) => e.preventDefault()}
            />
          ) : showAddButton ? (
            <span className={`${styles.fill} ${styles.add}`}>
              {isUploading ? (
                <span className={styles.spinner} aria-hidden="true" />
              ) : (
                <Plus size={iconSize} strokeWidth={2.5} aria-hidden="true" />
              )}
            </span>
          ) : (
            <span className={`${styles.fill} ${styles.placeholder}`}>
              {icon ? (
                <DynamicIcon name={icon} size={iconSize} aria-hidden="true" />
              ) : (
                <Camera size={iconSize} aria-hidden="true" />
              )}
            </span>
          )}
        </span>

        {/* Activity icon badge (bottom-right) */}
        {hasPhoto && icon && (
          <span className={styles.badge} aria-hidden="true">
            <DynamicIcon name={icon} size={12} color="white" />
          </span>
        )}
      </button>

      {/* Activity name label */}
      <span className={ring.label} title={displayLabel}>
        {displayLabel}
      </span>
    </div>
  );
};

export default StoryCircle;
