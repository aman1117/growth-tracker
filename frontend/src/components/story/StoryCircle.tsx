/**
 * StoryCircle Component
 *
 * Displays a circular story indicator similar to Instagram stories.
 * Shows activity thumbnail with gradient ring (unseen) or gray ring (seen/own).
 * Shows "+" icon for uploadable activities without photos.
 */

import { Camera, Plus } from 'lucide-react';
import React from 'react';

import type { ActivityPhoto } from '../../types/story';
import { DynamicIcon } from '../DynamicIcon';

import './StoryCircle.css';

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
  
  // Determine ring style
  const ringClass = hasPhoto
    ? isOwn || isViewed
      ? 'story-ring-viewed'
      : 'story-ring-unseen'
    : 'story-ring-empty';

  const handleClick = () => {
    if (isUploading) return;
    
    if (showAddButton && onUpload) {
      onUpload();
    } else if (hasPhoto && onClick) {
      onClick();
    }
  };

  const sizeClass = `story-circle-${size}`;

  // Generate aria label for accessibility
  const ariaLabel = hasPhoto
    ? `View ${displayLabel} photo`
    : canUpload
      ? `Upload photo for ${displayLabel}`
      : `${displayLabel} - no photo`;

  return (
    <div className={`story-circle-container ${sizeClass}`}>
      <button
        className={`story-circle ${ringClass} ${isUploading ? 'story-circle-uploading' : ''}`}
        onClick={handleClick}
        disabled={isUploading || (!hasPhoto && !canUpload)}
        aria-label={ariaLabel}
        type="button"
      >
        {/* Inner content */}
        <div className="story-circle-inner">
          {hasPhoto && photo ? (
            <img
              src={photo.thumbnail_url}
              alt={`${displayLabel} activity`}
              className="story-circle-image"
              loading="lazy"
            />
          ) : showAddButton ? (
            <div className="story-circle-add" style={{ backgroundColor: `${color}20` }}>
              {isUploading ? (
                <div className="story-circle-spinner" />
              ) : (
                <Plus size={size === 'small' ? 16 : size === 'large' ? 28 : 22} color={color} />
              )}
            </div>
          ) : (
            <div className="story-circle-placeholder" style={{ backgroundColor: `${color}15` }}>
              {icon ? (
                <DynamicIcon name={icon} size={size === 'small' ? 16 : size === 'large' ? 28 : 22} color={color} />
              ) : (
                <Camera size={size === 'small' ? 16 : size === 'large' ? 28 : 22} color={color} />
              )}
            </div>
          )}
        </div>

        {/* Activity icon badge (bottom-right) */}
        {hasPhoto && icon && (
          <div className="story-circle-badge" style={{ backgroundColor: color }}>
            <DynamicIcon name={icon} size={12} color="white" />
          </div>
        )}
      </button>

      {/* Activity name label */}
      <span className="story-circle-label" title={displayLabel}>
        {displayLabel.length > 10 ? `${displayLabel.slice(0, 9)}...` : displayLabel}
      </span>
    </div>
  );
};

export default StoryCircle;
