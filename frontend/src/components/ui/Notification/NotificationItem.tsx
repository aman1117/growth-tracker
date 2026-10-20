/**
 * NotificationItem Component
 *
 * Individual notification item with glassmorphism styling.
 * Displays notification content with type-specific icons and metadata.
 * Supports clickable usernames and navigation to specific dates.
 */

import { X } from 'lucide-react';
import React, { useCallback, useMemo } from 'react';

import type { LikeMetadata, Notification } from '../../../types';
import { formatNotificationTime } from '../../../types';
import styles from './Notification.module.css';
import { getNotificationVisual } from './notificationVisuals';

/** Duration of the delete animation in milliseconds */
const DELETE_ANIMATION_DURATION = 250;

interface NotificationItemProps {
  notification: Notification;
  onMarkAsRead: (id: number) => void;
  onStartDeleting: (id: number) => void;
  onDelete: (id: number) => void;
  onClick?: (notification: Notification) => void;
  onUsernameClick?: (username: string) => void;
  isNew?: boolean;
  isDeleting?: boolean;
}

const ICON_SIZE = 17;

/**
 * Type guard to check if metadata is LikeMetadata (for like_received or story_liked)
 */
const isLikeMetadata = (metadata: unknown): metadata is LikeMetadata => {
  return typeof metadata === 'object' && metadata !== null && 'liker_username' in metadata;
};

export const NotificationItem: React.FC<NotificationItemProps> = ({
  notification,
  onMarkAsRead,
  onStartDeleting,
  onDelete,
  onClick,
  onUsernameClick,
  isNew = false,
  isDeleting = false,
}) => {
  const isUnread = !notification.read_at;
  const { Icon: TypeIcon, toneClass } = getNotificationVisual(notification.type);

  // Extract username from metadata for like notifications (day likes and story likes)
  const likeMetadata = useMemo(() => {
    if (
      (notification.type === 'like_received' || notification.type === 'story_liked') &&
      isLikeMetadata(notification.metadata)
    ) {
      return notification.metadata;
    }
    return null;
  }, [notification.type, notification.metadata]);

  const handleItemAction = useCallback(() => {
    if (isDeleting) return;
    if (isUnread) {
      onMarkAsRead(notification.id);
    }
    onClick?.(notification);

    // Delete the notification after clicking (for navigation actions)
    // Use a short delay to let the panel close first
    setTimeout(() => {
      onStartDeleting(notification.id);
      setTimeout(() => onDelete(notification.id), DELETE_ANIMATION_DURATION);
    }, 50);
  }, [isDeleting, isUnread, notification, onMarkAsRead, onClick, onStartDeleting, onDelete]);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      // Don't trigger if clicking on the delete button or username link
      if (
        (e.target as HTMLElement).closest(`.${styles.deleteButton}`) ||
        (e.target as HTMLElement).closest(`.${styles.usernameLink}`)
      ) {
        return;
      }
      handleItemAction();
    },
    [handleItemAction]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        handleItemAction();
      }
    },
    [handleItemAction]
  );

  const handleDelete = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      if (isDeleting) return;

      // Start animation, then remove after animation completes
      onStartDeleting(notification.id);
      setTimeout(() => onDelete(notification.id), DELETE_ANIMATION_DURATION);
    },
    [isDeleting, notification.id, onStartDeleting, onDelete]
  );

  const handleUsernameClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      if (likeMetadata && onUsernameClick) {
        // Mark as read when clicking username too
        if (isUnread) {
          onMarkAsRead(notification.id);
        }
        onUsernameClick(likeMetadata.liker_username);
      }
    },
    [likeMetadata, onUsernameClick, isUnread, onMarkAsRead, notification.id]
  );

  // Render body with clickable username for like notifications
  const renderBody = () => {
    if (likeMetadata && notification.body.includes(likeMetadata.liker_username)) {
      const parts = notification.body.split(likeMetadata.liker_username);
      return (
        <>
          {parts[0]}
          <button className={styles.usernameLink} onClick={handleUsernameClick} type="button">
            {likeMetadata.liker_username}
          </button>
          {parts.slice(1).join(likeMetadata.liker_username)}
        </>
      );
    }
    return notification.body;
  };

  const itemClasses = [
    styles.item,
    isUnread && styles.itemUnread,
    isNew && styles.itemNew,
    isDeleting && styles.itemDeleting,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={itemClasses}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={0}
    >
      <div className={`${styles.itemIcon} ${toneClass}`} aria-hidden="true">
        <TypeIcon size={ICON_SIZE} />
      </div>

      <div className={styles.itemContent}>
        <p className={styles.itemBody}>
          <span className={styles.itemTitle}>{notification.title}</span>
          {' · '}
          {renderBody()}
        </p>
        <span className={styles.itemTime}>{formatNotificationTime(notification.created_at)}</span>
      </div>

      <button
        className={styles.deleteButton}
        onClick={handleDelete}
        aria-label="Delete notification"
      >
        <X size={14} />
      </button>

      {isUnread && <div className={styles.unreadDot} aria-hidden="true" />}
    </div>
  );
};

export default NotificationItem;
