/**
 * useNotificationNavigation Hook
 *
 * Encapsulates navigation logic for notification clicks.
 * Used by Layout (notification panel) and NotificationPreviewToast.
 */

import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

import { APP_ROUTES } from '../constants/routes';
import type { LikeMetadata, Notification } from '../types';
import type { CommentMetadata } from '../types/notification';

function isLikeMetadata(metadata: unknown): metadata is LikeMetadata {
  return (
    metadata !== null &&
    typeof metadata === 'object' &&
    'liker_username' in metadata &&
    'liked_date' in metadata
  );
}

function isStoryLikedMetadata(
  metadata: unknown
): metadata is { liker_username: string; photo_date: string } {
  return (
    typeof metadata === 'object' &&
    metadata !== null &&
    'liker_username' in metadata &&
    'photo_date' in metadata
  );
}

function isDayCompletedMetadata(
  metadata: unknown
): metadata is { completed_username: string; completed_date: string } {
  return (
    typeof metadata === 'object' &&
    metadata !== null &&
    'completed_username' in metadata &&
    'completed_date' in metadata
  );
}

function isPhotoUploadedMetadata(
  metadata: unknown
): metadata is { uploader_username: string; photo_date: string } {
  return (
    typeof metadata === 'object' &&
    metadata !== null &&
    'uploader_username' in metadata &&
    'photo_date' in metadata
  );
}

function isCommentMetadata(metadata: unknown): metadata is CommentMetadata {
  return (
    typeof metadata === 'object' &&
    metadata !== null &&
    'day_owner_username' in metadata &&
    'day_date' in metadata
  );
}

export function useNotificationNavigation() {
  const navigate = useNavigate();

  const handleNotificationClick = useCallback(
    (notification: Notification) => {
      const metadata = notification.metadata as Record<string, unknown> | undefined;

      if (notification.type === 'like_received' && isLikeMetadata(notification.metadata)) {
        navigate(`${APP_ROUTES.HOME}?date=${notification.metadata.liked_date}`);
      } else if (
        notification.type === 'story_liked' &&
        isStoryLikedMetadata(notification.metadata)
      ) {
        navigate(`${APP_ROUTES.HOME}?date=${notification.metadata.photo_date}`);
      } else if (
        notification.type === 'streak_milestone' &&
        isDayCompletedMetadata(notification.metadata)
      ) {
        navigate(
          `${APP_ROUTES.USER_PROFILE(notification.metadata.completed_username)}?date=${notification.metadata.completed_date}`
        );
      } else if (
        notification.type === 'photo_uploaded' &&
        isPhotoUploadedMetadata(notification.metadata)
      ) {
        navigate(
          `${APP_ROUTES.USER_PROFILE(notification.metadata.uploader_username)}?date=${notification.metadata.photo_date}`
        );
      } else if (
        (notification.type === 'new_follower' ||
          notification.type === 'follow_request' ||
          notification.type === 'follow_accepted') &&
        metadata?.actor_username
      ) {
        navigate(APP_ROUTES.USER_PROFILE(metadata.actor_username as string));
      } else if (
        (notification.type === 'comment_received' ||
          notification.type === 'comment_reply' ||
          notification.type === 'comment_mention' ||
          notification.type === 'comment_liked') &&
        isCommentMetadata(notification.metadata)
      ) {
        navigate(
          `${APP_ROUTES.USER_PROFILE(notification.metadata.day_owner_username)}?date=${notification.metadata.day_date}&comments=true`
        );
      }
    },
    [navigate]
  );

  const handleUsernameClick = useCallback(
    (username: string) => {
      navigate(APP_ROUTES.USER_PROFILE(username));
    },
    [navigate]
  );

  return { handleNotificationClick, handleUsernameClick };
}
