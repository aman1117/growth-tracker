/**
 * StoryViewer Component
 *
 * Fullscreen modal for viewing story photos.
 * Supports navigation, deletion (own photos), likes, and "seen by" / "liked by" combined list.
 */

import { AlertCircle, ChevronLeft, ChevronRight, Eye, Heart, Trash2, X } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { getActivityConfig } from '../../constants';
import { useBackDismiss } from '../../hooks/useBackDismiss';
import { useBodyScrollLock } from '../../hooks/useBodyScrollLock';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import { activityPhotoApi } from '../../services/api';
import { gl } from '../../services/goodlogs';
import type { ActivityName } from '../../types';
import type { ActivityPhoto, PhotoInteraction } from '../../types/story';
import { DynamicIcon } from '../DynamicIcon';
import { Avatar, ConfirmDialog, EmptyState, Modal, Skeleton, SnapToast } from '../ui';
import styles from './StoryViewer.module.css';

export interface StoryViewerProps {
  /** Whether the viewer is open */
  isOpen: boolean;
  /** Photos to display */
  photos: ActivityPhoto[];
  /** Starting index */
  startIndex?: number;
  /** Owner's username */
  ownerUsername: string;
  /** Owner's profile picture */
  ownerProfilePic?: string;
  /** Whether viewing own stories */
  isOwnStory: boolean;
  /** Close handler */
  onClose: () => void;
  /** Callback after deletion */
  onPhotoDeleted?: (photoId: number) => void;
  /** Callback when photos are viewed (for marking friend stories as seen) */
  onPhotosViewed?: (photoIds: number[]) => void;
  /** Callback when user clicks on the profile (avatar/username) */
  onProfileClick?: (username: string) => void;
}

export const StoryViewer: React.FC<StoryViewerProps> = ({
  isOpen,
  photos,
  startIndex = 0,
  ownerUsername,
  ownerProfilePic,
  isOwnStory,
  onClose,
  onPhotoDeleted,
  onPhotosViewed,
  onProfileClick,
}) => {
  const [currentIndex, setCurrentIndex] = useState(startIndex);
  const [showInteractions, setShowInteractions] = useState(false);
  const [interactions, setInteractions] = useState<PhotoInteraction[]>([]);
  const [interactionsTotal, setInteractionsTotal] = useState(0);
  const [loadingInteractions, setLoadingInteractions] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [failedImages, setFailedImages] = useState<Set<number>>(new Set());
  const viewedPhotosRef = React.useRef<Set<number>>(new Set());
  // Track local photos list (for proper navigation after deletion)
  const [localPhotos, setLocalPhotos] = useState<ActivityPhoto[]>(photos);

  // Like state
  const [likeStatus, setLikeStatus] = useState<Map<number, { liked: boolean; count: number }>>(
    new Map()
  );
  const [likePending, setLikePending] = useState(false);
  const [showLikeAnimation, setShowLikeAnimation] = useState(false);
  const lastTapRef = useRef<number>(0);

  // Swipe gesture state
  const [swipeOffset, setSwipeOffset] = useState(0);
  const [isSwiping, setIsSwiping] = useState(false);
  const [isAnimating, setIsAnimating] = useState(false);
  const touchStartRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);

  const currentPhoto = localPhotos[currentIndex];

  // Sync local photos with props when photos change
  useEffect(() => {
    setLocalPhotos(photos);
  }, [photos]);

  // Lock page scroll and touch gestures while the viewer is open
  useBodyScrollLock(isOpen, { blockTouch: true });

  // Reset state when opening (but not on every photos change). This runs during render,
  // not in an effect, so the like-status and view effects below never run against the
  // previous session's photo and never see a second, freshly emptied like-status map.
  const [wasOpen, setWasOpen] = useState(isOpen);
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    if (isOpen) {
      setCurrentIndex(startIndex);
      setShowInteractions(false);
      setShowDeleteConfirm(false);
      setInteractionsTotal(0);
      setFailedImages(new Set());
      setToastMessage(null);
      setLocalPhotos(photos);
      setLikeStatus(new Map());
      setShowLikeAnimation(false);
      // Reset swipe state
      setSwipeOffset(0);
      setIsSwiping(false);
      setIsAnimating(false);
    }
  }

  // Refs cannot be reset during render, so clear them when the viewer opens
  const prevIsOpenRef = useRef(false);
  useEffect(() => {
    if (isOpen && !prevIsOpenRef.current) {
      viewedPhotosRef.current = new Set();
      touchStartRef.current = null;
    }
    prevIsOpenRef.current = isOpen;
  }, [isOpen]);

  // Fetch interactions count on load for own stories
  useEffect(() => {
    if (!isOpen || !isOwnStory || !currentPhoto) return;

    // Fetch interaction count for current photo
    activityPhotoApi
      .getPhotoInteractions(currentPhoto.id)
      .then((response) => {
        if (response.success) {
          setInteractionsTotal(response.total || 0);
        }
      })
      .catch((err) => {
        console.error('Failed to fetch interactions count:', err);
      });
  }, [isOpen, isOwnStory, currentPhoto]);

  // Fetch like status when photo changes (for non-own photos, only while open)
  useEffect(() => {
    if (!isOpen || !currentPhoto || isOwnStory) return;

    // Check if we already have status for this photo
    if (likeStatus.has(currentPhoto.id)) return;

    activityPhotoApi
      .getLikeStatus(currentPhoto.id)
      .then((response) => {
        if (response.success) {
          setLikeStatus((prev) =>
            new Map(prev).set(currentPhoto.id, {
              liked: response.liked,
              count: response.like_count,
            })
          );
        }
      })
      .catch((err) => {
        console.error('Failed to fetch like status:', err);
      });
  }, [isOpen, currentPhoto, isOwnStory, likeStatus]);

  // Record view when photo changes (only for non-own photos, only while open)
  useEffect(() => {
    if (!isOpen || !currentPhoto || isOwnStory) return;
    if (viewedPhotosRef.current.has(currentPhoto.id)) return; // Already recorded

    // Mark as viewed immediately to prevent duplicate calls
    viewedPhotosRef.current.add(currentPhoto.id);

    gl.track('story_viewed', { properties: { photoId: currentPhoto.id } });
    activityPhotoApi.recordView(currentPhoto.id).catch((err) => {
      // Fail silently - view recording is not critical
      console.error('Failed to record view:', err);
    });
  }, [isOpen, currentPhoto, isOwnStory]);

  // Notify parent when closing about all viewed photos (for marking stories as seen)
  const handleClose = useCallback(() => {
    // Notify parent about viewed photos
    if (!isOwnStory && viewedPhotosRef.current.size > 0 && onPhotosViewed) {
      onPhotosViewed(Array.from(viewedPhotosRef.current));
    }
    onClose();
  }, [isOwnStory, onClose, onPhotosViewed]);

  // Fetch interactions when showing the modal
  const fetchInteractions = useCallback(async () => {
    if (!currentPhoto || !isOwnStory) return;

    setLoadingInteractions(true);
    try {
      const response = await activityPhotoApi.getPhotoInteractions(currentPhoto.id);
      if (response.success) {
        setInteractions(response.interactions || []);
        setInteractionsTotal(response.total || 0);
      }
    } catch (err) {
      console.error('Failed to fetch interactions:', err);
    } finally {
      setLoadingInteractions(false);
    }
  }, [currentPhoto, isOwnStory]);

  useEffect(() => {
    if (showInteractions && isOwnStory) {
      fetchInteractions();
    }
  }, [showInteractions, fetchInteractions, isOwnStory]);

  // Handle like/unlike with optimistic update and haptic feedback
  const handleLikeToggle = useCallback(async () => {
    if (!currentPhoto || isOwnStory || likePending) return;

    const currentStatus = likeStatus.get(currentPhoto.id) || { liked: false, count: 0 };
    const newLiked = !currentStatus.liked;
    const newCount = newLiked ? currentStatus.count + 1 : Math.max(0, currentStatus.count - 1);

    // Optimistic update
    setLikeStatus((prev) =>
      new Map(prev).set(currentPhoto.id, { liked: newLiked, count: newCount })
    );
    setLikePending(true);

    // Haptic feedback
    if (navigator.vibrate) {
      navigator.vibrate(newLiked ? 50 : 30);
    }

    try {
      if (newLiked) {
        await activityPhotoApi.likePhoto(currentPhoto.id);
        gl.track('story_liked', { properties: { photoId: currentPhoto.id } });
      } else {
        await activityPhotoApi.unlikePhoto(currentPhoto.id);
        gl.track('story_unliked', { properties: { photoId: currentPhoto.id } });
      }
    } catch (err) {
      // Revert on error
      console.error('Failed to toggle like:', err);
      setLikeStatus((prev) => new Map(prev).set(currentPhoto.id, currentStatus));
      setToastMessage('Failed to update like');
    } finally {
      setLikePending(false);
    }
  }, [currentPhoto, isOwnStory, likeStatus, likePending]);

  // Double-tap to like
  const handleDoubleTap = useCallback(() => {
    if (!currentPhoto || isOwnStory) return;

    const currentStatus = likeStatus.get(currentPhoto.id);
    if (!currentStatus?.liked) {
      // Show heart animation
      setShowLikeAnimation(true);
      setTimeout(() => setShowLikeAnimation(false), 1000);

      // Like the photo
      handleLikeToggle();
    }
  }, [currentPhoto, isOwnStory, likeStatus, handleLikeToggle]);

  // Detect double-tap on image
  const handleImageTap = useCallback(
    (e: React.MouseEvent | React.TouchEvent) => {
      if (isOwnStory) return;

      const now = Date.now();
      const DOUBLE_TAP_DELAY = 300;

      if (now - lastTapRef.current < DOUBLE_TAP_DELAY) {
        e.preventDefault();
        e.stopPropagation();
        handleDoubleTap();
      }
      lastTapRef.current = now;
    },
    [isOwnStory, handleDoubleTap]
  );

  // Helper helper to handle navigation with animation
  const animateTo = useCallback(
    (direction: 'next' | 'prev' | 'stay') => {
      if (!containerRef.current) return;
      const width = containerRef.current.clientWidth;

      setIsSwiping(false);
      setIsAnimating(true);

      let targetOffset = 0;
      if (direction === 'next') targetOffset = -width;
      if (direction === 'prev') targetOffset = width;

      setSwipeOffset(targetOffset);

      // After animation, update index and reset
      setTimeout(() => {
        if (direction === 'next') {
          setCurrentIndex((prev) => Math.min(prev + 1, localPhotos.length - 1));
        } else if (direction === 'prev') {
          setCurrentIndex((prev) => Math.max(prev - 1, 0));
        }
        setIsAnimating(false);
        setSwipeOffset(0);
      }, 300); // Match CSS duration
    },
    [localPhotos.length]
  );

  // Navigate
  const goNext = useCallback(() => {
    if (currentIndex < localPhotos.length - 1 && !isAnimating) {
      animateTo('next');
    }
  }, [currentIndex, localPhotos.length, isAnimating, animateTo]);

  const goPrev = useCallback(() => {
    if (currentIndex > 0 && !isAnimating) {
      animateTo('prev');
    }
  }, [currentIndex, isAnimating, animateTo]);

  // Keyboard navigation (Escape is handled by the shared overlay stack below)
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore keys during animation or while a sheet/dialog sits on top
      if (isAnimating || showDeleteConfirm || showInteractions) return;

      switch (e.key) {
        case 'ArrowLeft':
          goPrev();
          break;
        case 'ArrowRight':
          goNext();
          break;
        case 'l':
        case 'L':
          // Keyboard shortcut to like (non-own photos)
          if (!isOwnStory) {
            handleLikeToggle();
          }
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    isOpen,
    showDeleteConfirm,
    showInteractions,
    goNext,
    goPrev,
    isAnimating,
    isOwnStory,
    handleLikeToggle,
  ]);

  // Escape closes the viewer; the delete dialog / activity sheet register later
  // so they close first when open
  useEscapeKey(isOpen, handleClose);

  // Touch/Swipe gesture handlers
  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      // Don't track swipes if modals are open or already animating
      if (showDeleteConfirm || showInteractions || isAnimating) return;

      const touch = e.touches[0];
      touchStartRef.current = {
        x: touch.clientX,
        y: touch.clientY,
        time: Date.now(),
      };
      setIsSwiping(false);
      setSwipeOffset(0);
    },
    [showDeleteConfirm, showInteractions, isAnimating]
  );

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (!touchStartRef.current || isAnimating) return;

      const touch = e.touches[0];
      const deltaX = touch.clientX - touchStartRef.current.x;
      const deltaY = touch.clientY - touchStartRef.current.y;

      // Determine if this is a horizontal swipe (more horizontal than vertical)
      const isHorizontalSwipe = Math.abs(deltaX) > Math.abs(deltaY);

      // Only track horizontal swipes after initial threshold
      if (Math.abs(deltaX) > 10 && isHorizontalSwipe) {
        setIsSwiping(true);

        // Calculate bounded offset with resistance at edges
        let offset = deltaX;
        const canGoLeft = currentIndex < localPhotos.length - 1;
        const canGoRight = currentIndex > 0;

        // Apply rubber-band resistance at edges
        if ((offset < 0 && !canGoLeft) || (offset > 0 && !canGoRight)) {
          // Rubber band effect: reduce movement logic
          offset = offset * 0.3;
        }

        setSwipeOffset(offset);
      }
    },
    [currentIndex, localPhotos.length, isAnimating]
  );

  const handleTouchEnd = useCallback(() => {
    if (!touchStartRef.current || isAnimating) return;

    if (isSwiping) {
      const threshold = (containerRef.current?.clientWidth || window.innerWidth) * 0.25; // 25% width threshold
      const velocityThreshold = 0.5; // px/ms

      const endTime = Date.now();
      const duration = endTime - touchStartRef.current.time;
      const velocity = Math.abs(swipeOffset) / duration;

      let direction: 'next' | 'prev' | 'stay' = 'stay';

      if (Math.abs(swipeOffset) > threshold || velocity > velocityThreshold) {
        if (swipeOffset < 0 && currentIndex < localPhotos.length - 1) {
          direction = 'next';
        } else if (swipeOffset > 0 && currentIndex > 0) {
          direction = 'prev';
        }
      }

      animateTo(direction);
    }

    // Reset touch ref
    touchStartRef.current = null;
  }, [swipeOffset, isSwiping, currentIndex, localPhotos.length, isAnimating, animateTo]);

  // Handle browser / hardware back: close the viewer instead of leaving the page
  useBackDismiss(isOpen, handleClose);

  // Delete photo - closes immediately and deletes in background
  const handleDelete = async () => {
    if (!currentPhoto) return;

    // Dismiss the confirmation right away; the delete itself is optimistic
    setShowDeleteConfirm(false);

    const photoIdToDelete = currentPhoto.id;
    const newPhotos = localPhotos.filter((p) => p.id !== photoIdToDelete);

    // Close immediately if no more photos, otherwise navigate
    if (newPhotos.length === 0) {
      // Close viewer immediately, delete happens in background
      handleClose();
    } else {
      // Update local state first for instant feedback
      setLocalPhotos(newPhotos);
      if (currentIndex >= newPhotos.length) {
        setCurrentIndex(newPhotos.length - 1);
      }
    }

    // Notify parent to update its state (for toast display)
    onPhotoDeleted?.(photoIdToDelete);

    gl.track('photo_deleted', { properties: { photoId: photoIdToDelete } });

    // Delete in background
    try {
      const response = await activityPhotoApi.deletePhoto(photoIdToDelete);
      if (!response.success) {
        console.error('Delete failed:', response.error);
        // Could add back the photo here if needed, but usually not critical
      }
    } catch (err) {
      console.error('Delete failed:', err);
    }
  };

  // Early return if not open
  if (!isOpen) return null;

  // If no photos (deleted last one), show toast briefly then nothing
  if (!currentPhoto) {
    return toastMessage ? (
      <SnapToast
        message={toastMessage}
        type={toastMessage.includes('Failed') ? 'error' : 'success'}
        onClose={() => setToastMessage(null)}
      />
    ) : null;
  }

  // Format date for display. photo_date is a calendar day (YYYY-MM-DD); new Date() would
  // read it as UTC midnight, i.e. the previous day west of UTC, so build a local date.
  const formatDate = (dateStr: string) => {
    const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
    const date = day
      ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]))
      : new Date(dateStr);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  // Get activity display info (label, icon, color)
  const getActivityInfo = (
    photo: ActivityPhoto
  ): { label: string; icon?: string; color: string } => {
    const isCustom = photo.activity_name.startsWith('custom:');

    // For custom tiles, prioritize stored metadata
    if (isCustom) {
      return {
        label: photo.activity_label || photo.activity_name.replace('custom:', ''),
        icon: photo.activity_icon,
        color: photo.activity_color || '#666',
      };
    }

    // For standard activities, use config
    const config = getActivityConfig(photo.activity_name as ActivityName);
    return {
      label: config?.label || photo.activity_name,
      icon: config?.iconName,
      color: config?.color || '#666',
    };
  };

  const activityInfo = getActivityInfo(currentPhoto);
  const isLiked = !!likeStatus.get(currentPhoto.id)?.liked;

  return createPortal(
    <div
      className={styles.overlay}
      onClick={handleClose}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
      role="dialog"
      aria-modal="true"
      aria-label={`${ownerUsername}'s story`}
    >
      {/* Ambient backdrop: blurred copy of the current photo */}
      {!failedImages.has(currentPhoto.id) && (
        <img
          key={currentPhoto.id}
          src={currentPhoto.thumbnail_url || currentPhoto.photo_url}
          alt=""
          aria-hidden="true"
          className={styles.ambient}
          draggable={false}
        />
      )}

      <div className={styles.container}>
        {/* Top: progress segments + header */}
        <div className={styles.top} onClick={(e) => e.stopPropagation()}>
          {localPhotos.length > 1 && (
            <div className={styles.segments}>
              {localPhotos.map((photo, idx) => (
                <button
                  key={photo.id}
                  type="button"
                  className={`${styles.segment} ${
                    idx === currentIndex
                      ? styles.segmentActive
                      : idx < currentIndex
                        ? styles.segmentSeen
                        : ''
                  }`}
                  onClick={() => setCurrentIndex(idx)}
                  aria-label={`Go to photo ${idx + 1} of ${localPhotos.length}`}
                  aria-current={idx === currentIndex ? 'step' : undefined}
                />
              ))}
            </div>
          )}

          <div className={styles.header}>
            <div
              className={`${styles.user} ${onProfileClick ? styles.userClickable : ''}`}
              onClick={() => {
                if (onProfileClick) {
                  onProfileClick(ownerUsername);
                }
              }}
              role={onProfileClick ? 'button' : undefined}
              tabIndex={onProfileClick ? 0 : undefined}
              onKeyDown={(e) => {
                if (onProfileClick && (e.key === 'Enter' || e.key === ' ')) {
                  e.preventDefault();
                  onProfileClick(ownerUsername);
                }
              }}
            >
              <span className={styles.avatarRing}>
                <Avatar src={ownerProfilePic} name={ownerUsername} size="sm" />
              </span>
              <div className={styles.userInfo}>
                <div className={styles.userTop}>
                  <span className={styles.username}>{ownerUsername}</span>
                  <span
                    className={styles.activityChip}
                    style={{ '--activity-color': activityInfo.color } as React.CSSProperties}
                  >
                    <span className={styles.activityIcon} aria-hidden="true">
                      {activityInfo.icon && (
                        <DynamicIcon name={activityInfo.icon} size={10} color="white" />
                      )}
                    </span>
                    {activityInfo.label}
                  </span>
                </div>
                <span className={styles.date}>{formatDate(currentPhoto.photo_date)}</span>
              </div>
            </div>

            <div className={styles.actions}>
              {isOwnStory && (
                <button
                  type="button"
                  className={`${styles.iconButton} ${styles.deleteButton}`}
                  onClick={() => setShowDeleteConfirm(true)}
                  aria-label="Delete photo"
                >
                  <Trash2 size={18} strokeWidth={2.25} aria-hidden="true" />
                </button>
              )}
              <button
                type="button"
                className={styles.iconButton}
                onClick={handleClose}
                aria-label="Close"
              >
                <X size={22} strokeWidth={2.25} aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>

        {/* Main image */}
        <div ref={containerRef} className={styles.content}>
          {/* Double-tap like animation */}
          {showLikeAnimation && (
            <div className={styles.likeBurst} aria-hidden="true">
              <Heart size={104} fill="currentColor" color="white" strokeWidth={1.25} />
            </div>
          )}

          {/* Navigation arrows */}
          {currentIndex > 0 && (
            <button
              type="button"
              className={`${styles.nav} ${styles.navPrev}`}
              onClick={(e) => {
                e.stopPropagation();
                goPrev();
              }}
              aria-label="Previous photo"
            >
              <ChevronLeft size={26} strokeWidth={2.25} aria-hidden="true" />
            </button>
          )}

          <div
            ref={trackRef}
            className={`${styles.track} ${isAnimating ? styles.trackAnimating : ''}`}
            onClick={(e) => {
              // Photo taps must not close the viewer, but still count towards a double-tap like
              e.stopPropagation();
              handleImageTap(e);
            }}
            style={{
              transform: `translateX(${swipeOffset}px)`,
            }}
          >
            {/* Render Previous, Current, Next */}
            {[currentIndex - 1, currentIndex, currentIndex + 1].map((idx, offset) => {
              const photo = localPhotos[idx];
              if (!photo) return null;

              const position = offset === 0 ? 'prev' : offset === 1 ? 'current' : 'next';
              const positionClass =
                position === 'prev'
                  ? styles.slidePrev
                  : position === 'next'
                    ? styles.slideNext
                    : '';
              const isError = failedImages.has(photo.id);

              return (
                <div
                  key={`${photo.id}-${position}`}
                  className={`${styles.slide} ${positionClass}`}
                  aria-hidden={position !== 'current' || undefined}
                >
                  {isError ? (
                    <div className={styles.imageError}>
                      <AlertCircle size={44} aria-hidden="true" />
                      <span>Failed to load photo</span>
                    </div>
                  ) : (
                    <img
                      src={photo.photo_url}
                      alt={`${ownerUsername}'s ${photo.activity_name} activity`}
                      className={styles.image}
                      onError={() => setFailedImages((prev) => new Set(prev).add(photo.id))}
                      draggable={false}
                      onContextMenu={(e) => e.preventDefault()}
                    />
                  )}
                </div>
              );
            })}
          </div>

          {currentIndex < localPhotos.length - 1 && (
            <button
              type="button"
              className={`${styles.nav} ${styles.navNext}`}
              onClick={(e) => {
                e.stopPropagation();
                goNext();
              }}
              aria-label="Next photo"
            >
              <ChevronRight size={26} strokeWidth={2.25} aria-hidden="true" />
            </button>
          )}
        </div>

        {/* Footer */}
        <div className={styles.footer} onClick={(e) => e.stopPropagation()}>
          {/* Like button (non-own stories) - no count shown, only owner sees counts */}
          {!isOwnStory && (
            <button
              type="button"
              className={`${styles.likeButton} ${isLiked ? styles.liked : ''}`}
              onClick={handleLikeToggle}
              disabled={likePending}
              aria-label={isLiked ? 'Unlike photo' : 'Like photo'}
              aria-pressed={isLiked}
            >
              <Heart
                size={24}
                strokeWidth={2.25}
                fill={isLiked ? 'currentColor' : 'none'}
                aria-hidden="true"
              />
            </button>
          )}

          {/* Interactions button (own stories) */}
          {isOwnStory && (
            <button
              type="button"
              className={styles.seenBy}
              onClick={(e) => {
                e.stopPropagation();
                gl.track('story_interactions_viewed', { properties: { photoId: currentPhoto.id } });
                setShowInteractions(true);
              }}
            >
              <Eye size={16} strokeWidth={2.25} aria-hidden="true" />
              <span>Seen by {interactionsTotal > 0 ? interactionsTotal : '—'}</span>
            </button>
          )}
        </div>
      </div>

      {/* Delete confirmation dialog (portal; stopPropagation keeps the viewer open) */}
      <div onClick={(e) => e.stopPropagation()} onTouchStart={(e) => e.stopPropagation()}>
        <ConfirmDialog
          isOpen={showDeleteConfirm}
          title="Delete this photo?"
          description="It will be removed from your story permanently."
          icon={<Trash2 size={22} strokeWidth={2.25} />}
          tone="danger"
          confirmLabel="Delete"
          onConfirm={handleDelete}
          onCancel={() => setShowDeleteConfirm(false)}
        />

        {/* Interactions sheet (combined views + likes) */}
        <Modal
          isOpen={showInteractions}
          onClose={() => setShowInteractions(false)}
          title="Story activity"
          subtitle={
            interactionsTotal > 0
              ? `${interactionsTotal} ${interactionsTotal === 1 ? 'person' : 'people'}`
              : undefined
          }
          icon={<Eye size={19} strokeWidth={2.25} />}
          maxWidth="440px"
        >
          {loadingInteractions ? (
            <div aria-busy="true" aria-label="Loading">
              {[1, 2, 3].map((i) => (
                <div key={i} className={styles.interactionSkeleton}>
                  <Skeleton width={32} height={32} radius="full" />
                  <Skeleton width="45%" height={12} radius="full" />
                </div>
              ))}
            </div>
          ) : interactions.length === 0 ? (
            <EmptyState
              icon={<Eye size={24} strokeWidth={2} />}
              title="No views yet"
              description="When friends see or like this photo, they'll show up here."
              size="sm"
            />
          ) : (
            <ul className={styles.interactionList}>
              {interactions.map((interaction) => {
                const viewed =
                  interaction.interaction_type === 'view' ||
                  interaction.interaction_type === 'both';
                const liked =
                  interaction.interaction_type === 'like' ||
                  interaction.interaction_type === 'both';
                return (
                  <li key={interaction.user_id} className={styles.interactionRow}>
                    <Avatar src={interaction.profile_pic} name={interaction.username} size="sm" />
                    <span className={styles.interactionName}>{interaction.username}</span>
                    <span className={styles.interactionIcons}>
                      {viewed && (
                        <span className={`${styles.iconChip} ${styles.iconView}`} title="Viewed">
                          <Eye size={14} strokeWidth={2.25} aria-label="Viewed" />
                        </span>
                      )}
                      {liked && (
                        <span className={`${styles.iconChip} ${styles.iconLike}`} title="Liked">
                          <Heart size={13} fill="currentColor" aria-label="Liked" />
                        </span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Modal>
      </div>

      {/* Toast notification */}
      {toastMessage && (
        <SnapToast
          message={toastMessage}
          type={toastMessage.includes('Failed') ? 'error' : 'success'}
          onClose={() => setToastMessage(null)}
        />
      )}
    </div>,
    document.body
  );
};
export default StoryViewer;
