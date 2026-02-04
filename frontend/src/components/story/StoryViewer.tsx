/**
 * StoryViewer Component
 *
 * Fullscreen modal for viewing story photos.
 * Supports navigation, deletion (own photos), likes, and "seen by" / "liked by" combined list.
 */

import './StoryViewer.css';

import { AlertCircle, ChevronLeft, ChevronRight, Eye, Heart, Trash2, X } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { getActivityConfig } from '../../constants';
import { activityPhotoApi } from '../../services/api';
import type { ActivityName } from '../../types';
import type { ActivityPhoto, PhotoInteraction } from '../../types/story';
import { DynamicIcon } from '../DynamicIcon';
import { Avatar, SnapToast } from '../ui';

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
  const [likeStatus, setLikeStatus] = useState<Map<number, { liked: boolean; count: number }>>(new Map());
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

  // Lock body scroll when viewer is open
  useEffect(() => {
    if (isOpen) {
      const originalOverflow = document.body.style.overflow;
      const originalTouchAction = document.body.style.touchAction;
      document.body.style.overflow = 'hidden';
      document.body.style.touchAction = 'none';
      
      return () => {
        document.body.style.overflow = originalOverflow;
        document.body.style.touchAction = originalTouchAction;
      };
    }
  }, [isOpen]);

  // Reset state when opening (but not on every photos change)
  const prevIsOpenRef = useRef(false);
  useEffect(() => {
    // Only reset when first opening, not when photos change while open
    if (isOpen && !prevIsOpenRef.current) {
      setCurrentIndex(startIndex);
      setShowInteractions(false);
      setShowDeleteConfirm(false);
      setInteractionsTotal(0);
      setFailedImages(new Set());
      setToastMessage(null);
      setLocalPhotos(photos);
      viewedPhotosRef.current = new Set();
      setLikeStatus(new Map());
      setShowLikeAnimation(false);
      // Reset swipe state
      setSwipeOffset(0);
      setIsSwiping(false);
      setIsAnimating(false);
      touchStartRef.current = null;
    }
    prevIsOpenRef.current = isOpen;
  }, [isOpen, startIndex, photos]);

  // Fetch interactions count on load for own stories
  useEffect(() => {
    if (!isOpen || !isOwnStory || !currentPhoto) return;
    
    // Fetch interaction count for current photo
    activityPhotoApi.getPhotoInteractions(currentPhoto.id).then(response => {
      if (response.success) {
        setInteractionsTotal(response.total || 0);
      }
    }).catch(err => {
      console.error('Failed to fetch interactions count:', err);
    });
  }, [isOpen, isOwnStory, currentPhoto]);

  // Fetch like status when photo changes (for non-own photos)
  useEffect(() => {
    if (!currentPhoto || isOwnStory) return;
    
    // Check if we already have status for this photo
    if (likeStatus.has(currentPhoto.id)) return;
    
    activityPhotoApi.getLikeStatus(currentPhoto.id).then(response => {
      if (response.success) {
        setLikeStatus(prev => new Map(prev).set(currentPhoto.id, {
          liked: response.liked,
          count: response.like_count
        }));
      }
    }).catch(err => {
      console.error('Failed to fetch like status:', err);
    });
  }, [currentPhoto, isOwnStory, likeStatus]);

  // Record view when photo changes (only for non-own photos)
  useEffect(() => {
    if (!currentPhoto || isOwnStory) return;
    if (viewedPhotosRef.current.has(currentPhoto.id)) return; // Already recorded
    
    // Mark as viewed immediately to prevent duplicate calls
    viewedPhotosRef.current.add(currentPhoto.id);
    
    activityPhotoApi.recordView(currentPhoto.id).catch(err => {
      // Fail silently - view recording is not critical
      console.error('Failed to record view:', err);
    });
  }, [currentPhoto, isOwnStory]);

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
    setLikeStatus(prev => new Map(prev).set(currentPhoto.id, { liked: newLiked, count: newCount }));
    setLikePending(true);
    
    // Haptic feedback
    if (navigator.vibrate) {
      navigator.vibrate(newLiked ? 50 : 30);
    }
    
    try {
      if (newLiked) {
        await activityPhotoApi.likePhoto(currentPhoto.id);
      } else {
        await activityPhotoApi.unlikePhoto(currentPhoto.id);
      }
    } catch (err) {
      // Revert on error
      console.error('Failed to toggle like:', err);
      setLikeStatus(prev => new Map(prev).set(currentPhoto.id, currentStatus));
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
  const handleImageTap = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    if (isOwnStory) return;
    
    const now = Date.now();
    const DOUBLE_TAP_DELAY = 300;
    
    if (now - lastTapRef.current < DOUBLE_TAP_DELAY) {
      e.preventDefault();
      e.stopPropagation();
      handleDoubleTap();
    }
    lastTapRef.current = now;
  }, [isOwnStory, handleDoubleTap]);

  // Helper helper to handle navigation with animation
  const animateTo = useCallback((direction: 'next' | 'prev' | 'stay') => {
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
        setCurrentIndex(prev => Math.min(prev + 1, localPhotos.length - 1));
      } else if (direction === 'prev') {
        setCurrentIndex(prev => Math.max(prev - 1, 0));
      }
      setIsAnimating(false);
      setSwipeOffset(0);
    }, 300); // Match CSS duration
  }, [localPhotos.length]);

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

  // Keyboard navigation
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (isAnimating) return; // Ignore keys during animation
      
      switch (e.key) {
        case 'Escape':
          if (showDeleteConfirm) {
            setShowDeleteConfirm(false);
          } else if (showInteractions) {
            setShowInteractions(false);
          } else {
            handleClose();
          }
          break;
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
  }, [isOpen, showDeleteConfirm, showInteractions, handleClose, goNext, goPrev, isAnimating, isOwnStory, handleLikeToggle]);

  // Touch/Swipe gesture handlers
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
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
  }, [showDeleteConfirm, showInteractions, isAnimating]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
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
  }, [currentIndex, localPhotos.length, isAnimating]);

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

  // Handle browser back
  useEffect(() => {
    if (!isOpen) return;

    // Push a state to handle back button
    window.history.pushState({ storyViewer: true }, '');

    const handlePopState = () => {
      handleClose();
    };

    window.addEventListener('popstate', handlePopState);
    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, [isOpen, handleClose]);

  // Delete photo - closes immediately and deletes in background
  const handleDelete = async () => {
    if (!currentPhoto) return;

    const photoIdToDelete = currentPhoto.id;
    const newPhotos = localPhotos.filter(p => p.id !== photoIdToDelete);
    
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
    
    setShowDeleteConfirm(false);
  };

  // Early return if not open
  if (!isOpen) return null;

  // If no photos (deleted last one), show toast briefly then nothing
  if (!currentPhoto) {
    return toastMessage ? (
      <div className="story-viewer-overlay">
        <SnapToast
          message={toastMessage}
          type={toastMessage.includes('Failed') ? 'error' : 'success'}
          onClose={() => setToastMessage(null)}
        />
      </div>
    ) : null;
  }

  // Format date for display
  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  // Get activity display info (label, icon, color)
  const getActivityInfo = (photo: ActivityPhoto): { label: string; icon?: string; color: string } => {
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

  return (
    <div 
      className="story-viewer-overlay" 
      onClick={handleClose}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
    >
      <div className="story-viewer-container">
        {/* Header */}
        <div className="story-viewer-header" onClick={e => e.stopPropagation()}>
          <div 
            className={`story-viewer-user ${onProfileClick ? 'story-viewer-user-clickable' : ''}`}
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
            <Avatar src={ownerProfilePic} name={ownerUsername} size="sm" />
            <div className="story-viewer-user-info">
              <div className="story-viewer-user-top">
                <span className="story-viewer-username">{ownerUsername}</span>
                <span className="story-viewer-activity-dot">•</span>
                <div className="story-viewer-activity-badge" style={{ backgroundColor: activityInfo.color }}>
                  {activityInfo.icon && <DynamicIcon name={activityInfo.icon} size={12} color="white" />}
                </div>
                <span className="story-viewer-activity">{activityInfo.label}</span>
              </div>
              <span className="story-viewer-date">{formatDate(currentPhoto.photo_date)}</span>
            </div>
          </div>

          <div className="story-viewer-actions">
            {isOwnStory && (
              <button
                className="story-viewer-btn story-viewer-delete-btn"
                onClick={() => setShowDeleteConfirm(true)}
                aria-label="Delete photo"
              >
                <Trash2 size={20} />
              </button>
            )}
            <button
              className="story-viewer-btn"
              onClick={handleClose}
              aria-label="Close"
            >
              <X size={24} />
            </button>
          </div>
        </div>

        {/* Main image */}
        <div 
          ref={containerRef}
          className="story-viewer-content"
          onClick={handleImageTap}
        >
          {/* Double-tap like animation */}
          {showLikeAnimation && (
            <div className="story-viewer-like-animation">
              <Heart size={100} fill="white" color="white" />
            </div>
          )}

          {/* Navigation arrows */}
          {currentIndex > 0 && (
            <button
              className="story-viewer-nav story-viewer-nav-prev"
              onClick={(e) => {
                e.stopPropagation();
                goPrev();
              }}
              aria-label="Previous photo"
            >
              <ChevronLeft size={32} />
            </button>
          )}

          <div 
            ref={trackRef}
            className={`story-viewer-track ${isAnimating ? 'animating' : isSwiping ? 'swiping' : ''}`}
            onClick={e => e.stopPropagation()}
            style={{
              transform: `translateX(${swipeOffset}px)`,
            }}
          >
            {/* Render Previous, Current, Next */}
            {[currentIndex - 1, currentIndex, currentIndex + 1].map((idx, offset) => {
              const photo = localPhotos[idx];
              if (!photo) return null;
              
              const position = offset === 0 ? 'prev' : offset === 1 ? 'current' : 'next';
              const isError = failedImages.has(photo.id);

              return (
                <div key={`${photo.id}-${position}`} className={`story-viewer-slide ${position}`}>
                  {isError ? (
                    <div className="story-viewer-image-error">
                      <AlertCircle size={48} />
                      <span>Failed to load photo</span>
                    </div>
                  ) : (
                    <img
                      src={photo.photo_url}
                      alt={`${ownerUsername}'s ${photo.activity_name} activity`}
                      className="story-viewer-image"
                      onError={() => setFailedImages(prev => new Set(prev).add(photo.id))}
                      style={{
                        WebkitUserSelect: 'none',
                        userSelect: 'none',
                        pointerEvents: 'none',
                        WebkitTouchCallout: 'none',
                      }}
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
              className="story-viewer-nav story-viewer-nav-next"
              onClick={(e) => {
                e.stopPropagation();
                goNext();
              }}
              aria-label="Next photo"
            >
              <ChevronRight size={32} />
            </button>
          )}
        </div>

        {/* Progress dots */}
        {localPhotos.length > 1 && (
          <div className="story-viewer-progress" onClick={e => e.stopPropagation()}>
            {localPhotos.map((_, idx) => (
              <button
                key={idx}
                className={`story-viewer-dot ${idx === currentIndex ? 'active' : ''}`}
                onClick={() => setCurrentIndex(idx)}
                aria-label={`Go to photo ${idx + 1}`}
              />
            ))}
          </div>
        )}

        {/* Footer */}
        <div className="story-viewer-footer-container" onClick={e => e.stopPropagation()}>
          {/* Like button (non-own stories) - no count shown, only owner sees counts */}
          {!isOwnStory && currentPhoto && (
            <button
              className={`story-viewer-like-btn ${likeStatus.get(currentPhoto.id)?.liked ? 'liked' : ''}`}
              onClick={handleLikeToggle}
              disabled={likePending}
              aria-label={likeStatus.get(currentPhoto.id)?.liked ? 'Unlike photo' : 'Like photo'}
            >
              <Heart 
                size={24} 
                fill={likeStatus.get(currentPhoto.id)?.liked ? 'currentColor' : 'none'} 
              />
            </button>
          )}

          {/* Interactions button (own stories) */}
          {isOwnStory && (
            <button
              className="story-viewer-footer"
              onClick={(e) => {
                e.stopPropagation();
                setShowInteractions(true);
              }}
            >
              <Eye size={16} />
              <span>Seen by {interactionsTotal > 0 ? interactionsTotal : '—'}</span>
            </button>
          )}
        </div>

        {/* Delete confirmation dialog */}
        {showDeleteConfirm && (
          <div 
            className="story-viewer-dialog-overlay" 
            onClick={(e) => {
              e.stopPropagation(); // Prevent closing the main viewer
              setShowDeleteConfirm(false);
            }}
          >
            <div className="story-viewer-dialog" onClick={e => e.stopPropagation()}>
              <h3>Delete Photo?</h3>
              <p>This photo will be permanently deleted.</p>
              <div className="story-viewer-dialog-actions">
                <button
                  className="story-viewer-dialog-btn story-viewer-dialog-cancel"
                  onClick={() => setShowDeleteConfirm(false)}
                >
                  Cancel
                </button>
                <button
                  className="story-viewer-dialog-btn story-viewer-dialog-delete"
                  onClick={handleDelete}
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Interactions panel (combined views + likes) */}
        {showInteractions && (
          <div 
            className="story-viewer-viewers-overlay" 
            onClick={(e) => {
              e.stopPropagation(); // Prevent closing the main viewer
              setShowInteractions(false);
            }}
          >
            <div className="story-viewer-viewers-panel" onClick={e => e.stopPropagation()}>
              <div className="story-viewer-viewers-header">
                <h3>Activity</h3>
                <button onClick={() => setShowInteractions(false)} aria-label="Close">
                  <X size={20} />
                </button>
              </div>
              <div className="story-viewer-viewers-list">
                {loadingInteractions ? (
                  <div className="story-viewer-viewers-loading">Loading...</div>
                ) : interactions.length === 0 ? (
                  <div className="story-viewer-viewers-empty">No activity yet</div>
                ) : (
                  interactions.map(interaction => (
                    <div key={interaction.user_id} className="story-viewer-viewer-item">
                      <Avatar src={interaction.profile_pic} name={interaction.username} size="sm" />
                      <span className="story-viewer-viewer-name">{interaction.username}</span>
                      <div className="story-viewer-interaction-icons">
                        {(interaction.interaction_type === 'view' || interaction.interaction_type === 'both') && (
                          <Eye size={14} className="story-viewer-icon-view" />
                        )}
                        {(interaction.interaction_type === 'like' || interaction.interaction_type === 'both') && (
                          <Heart size={14} fill="currentColor" className="story-viewer-icon-like" />
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        {/* Toast notification */}
        {toastMessage && (
          <SnapToast
            message={toastMessage}
            type={toastMessage.includes('Failed') ? 'error' : 'success'}
            onClose={() => setToastMessage(null)}
          />
        )}
      </div>
    </div>
  );
};

export default StoryViewer;
