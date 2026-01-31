/**
 * StoryViewer Component
 *
 * Fullscreen modal for viewing story photos.
 * Supports navigation, deletion (own photos), and "seen by" viewer list.
 */

import { AlertCircle, ChevronLeft, ChevronRight, Eye, Trash2, X } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { getActivityConfig } from '../../constants';
import { activityPhotoApi } from '../../services/api';
import type { ActivityName } from '../../types';
import type { ActivityPhoto, PhotoViewer } from '../../types/story';
import { DynamicIcon } from '../DynamicIcon';
import { Avatar, SnapToast } from '../ui';

import './StoryViewer.css';

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
}) => {
  const [currentIndex, setCurrentIndex] = useState(startIndex);
  const [showViewers, setShowViewers] = useState(false);
  const [viewers, setViewers] = useState<PhotoViewer[]>([]);
  const [viewersTotal, setViewersTotal] = useState(0);
  const [loadingViewers, setLoadingViewers] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [imageError, setImageError] = useState(false);
  const [slideDirection, setSlideDirection] = useState<'left' | 'right' | null>(null);
  const viewedPhotosRef = React.useRef<Set<number>>(new Set());
  // Track local photos list (for proper navigation after deletion)
  const [localPhotos, setLocalPhotos] = useState<ActivityPhoto[]>(photos);

  // Swipe gesture state
  const [swipeOffset, setSwipeOffset] = useState(0);
  const [isSwiping, setIsSwiping] = useState(false);
  const touchStartRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const currentPhoto = localPhotos[currentIndex];

  // Sync local photos with props when photos change
  useEffect(() => {
    setLocalPhotos(photos);
  }, [photos]);

  // Reset state when opening (but not on every photos change)
  const prevIsOpenRef = useRef(false);
  useEffect(() => {
    // Only reset when first opening, not when photos change while open
    if (isOpen && !prevIsOpenRef.current) {
      setCurrentIndex(startIndex);
      setShowViewers(false);
      setShowDeleteConfirm(false);
      setViewersTotal(0);
      setImageError(false);
      setToastMessage(null);
      setLocalPhotos(photos);
      viewedPhotosRef.current = new Set();
      // Reset swipe state
      setSwipeOffset(0);
      setIsSwiping(false);
      touchStartRef.current = null;
    }
    prevIsOpenRef.current = isOpen;
  }, [isOpen, startIndex, photos]);

  // Reset image error when photo changes
  useEffect(() => {
    setImageError(false);
    // Clear slide direction after animation completes
    const timer = setTimeout(() => setSlideDirection(null), 350);
    return () => clearTimeout(timer);
  }, [currentPhoto?.id]);

  // Fetch viewer count on load for own stories (not full list, just count)
  useEffect(() => {
    if (!isOpen || !isOwnStory || !currentPhoto) return;
    
    // Fetch viewer count for current photo
    activityPhotoApi.getPhotoViewers(currentPhoto.id).then(response => {
      if (response.success) {
        setViewersTotal(response.total || 0);
      }
    }).catch(err => {
      console.error('Failed to fetch viewer count:', err);
    });
  }, [isOpen, isOwnStory, currentPhoto?.id]);

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
  }, [currentPhoto?.id, isOwnStory]);

  // Notify parent when closing about all viewed photos (for marking stories as seen)
  const handleClose = useCallback(() => {
    // Notify parent about viewed photos
    if (!isOwnStory && viewedPhotosRef.current.size > 0 && onPhotosViewed) {
      onPhotosViewed(Array.from(viewedPhotosRef.current));
    }
    onClose();
  }, [isOwnStory, onClose, onPhotosViewed]);

  // Fetch viewers when showing viewer list
  const fetchViewers = useCallback(async () => {
    if (!currentPhoto || !isOwnStory) return;
    
    setLoadingViewers(true);
    try {
      const response = await activityPhotoApi.getPhotoViewers(currentPhoto.id);
      if (response.success) {
        setViewers(response.viewers || []);
        setViewersTotal(response.total || 0);
      }
    } catch (err) {
      console.error('Failed to fetch viewers:', err);
    } finally {
      setLoadingViewers(false);
    }
  }, [currentPhoto, isOwnStory]);

  useEffect(() => {
    if (showViewers && isOwnStory) {
      fetchViewers();
    }
  }, [showViewers, fetchViewers, isOwnStory]);

  // Keyboard navigation
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'Escape':
          if (showDeleteConfirm) {
            setShowDeleteConfirm(false);
          } else if (showViewers) {
            setShowViewers(false);
          } else {
            handleClose();
          }
          break;
        case 'ArrowLeft':
          if (currentIndex > 0) {
            setSlideDirection('right');
            setCurrentIndex(prev => prev - 1);
          }
          break;
        case 'ArrowRight':
          if (currentIndex < photos.length - 1) {
            setSlideDirection('left');
            setCurrentIndex(prev => prev + 1);
          }
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, currentIndex, photos.length, showDeleteConfirm, showViewers, handleClose]);

  // Touch/Swipe gesture handlers
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    // Don't track swipes if modals are open
    if (showDeleteConfirm || showViewers) return;
    
    const touch = e.touches[0];
    touchStartRef.current = {
      x: touch.clientX,
      y: touch.clientY,
      time: Date.now(),
    };
    setIsSwiping(false);
    setSwipeOffset(0);
  }, [showDeleteConfirm, showViewers]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!touchStartRef.current) return;
    
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
        // Rubber band effect: reduce movement by 70%
        offset = offset * 0.3;
      }
      
      // Clamp offset to reasonable bounds
      const maxOffset = window.innerWidth * 0.6;
      offset = Math.max(-maxOffset, Math.min(maxOffset, offset));
      
      setSwipeOffset(offset);
    }
  }, [currentIndex, localPhotos.length]);

  const handleTouchEnd = useCallback(() => {
    if (!touchStartRef.current) return;
    
    const swipeThreshold = 50; // Minimum distance to trigger navigation
    const velocityThreshold = 0.3; // Minimum velocity (px/ms) for quick swipes
    
    const endTime = Date.now();
    const duration = endTime - touchStartRef.current.time;
    const velocity = Math.abs(swipeOffset) / duration;
    
    // Determine if swipe is strong enough
    const isStrongSwipe = Math.abs(swipeOffset) > swipeThreshold || velocity > velocityThreshold;
    
    if (isSwiping && isStrongSwipe) {
      if (swipeOffset < 0 && currentIndex < localPhotos.length - 1) {
        // Swipe left -> go to next
        setSlideDirection('left');
        setCurrentIndex(prev => prev + 1);
      } else if (swipeOffset > 0 && currentIndex > 0) {
        // Swipe right -> go to previous
        setSlideDirection('right');
        setCurrentIndex(prev => prev - 1);
      }
    }
    
    // Reset state
    touchStartRef.current = null;
    setIsSwiping(false);
    setSwipeOffset(0);
  }, [swipeOffset, isSwiping, currentIndex, localPhotos.length]);

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

  // Navigate
  const goNext = () => {
    if (currentIndex < localPhotos.length - 1) {
      setSlideDirection('left');
      setCurrentIndex(prev => prev + 1);
    }
  };

  const goPrev = () => {
    if (currentIndex > 0) {
      setSlideDirection('right');
      setCurrentIndex(prev => prev - 1);
    }
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
    <div className="story-viewer-overlay" onClick={handleClose}>
      <div className="story-viewer-container">
        {/* Header */}
        <div className="story-viewer-header" onClick={e => e.stopPropagation()}>
          <div className="story-viewer-user">
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
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          onTouchCancel={handleTouchEnd}
        >
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
            className={`story-viewer-image-container ${isSwiping ? 'swiping' : ''}`}
            onClick={e => e.stopPropagation()}
            style={{
              transform: isSwiping ? `translateX(${swipeOffset}px)` : undefined,
              transition: isSwiping ? 'none' : 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
            }}
          >
            {imageError ? (
              <div className="story-viewer-image-error">
                <AlertCircle size={48} />
                <span>Failed to load photo</span>
              </div>
            ) : (
              <img
                key={currentPhoto.id}
                src={currentPhoto.photo_url}
                alt={`${ownerUsername}'s ${currentPhoto.activity_name} activity`}
                className={`story-viewer-image ${slideDirection && !isSwiping ? `slide-${slideDirection}` : ''}`}
                onError={() => setImageError(true)}
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

        {/* Footer - Seen by (own stories only) */}
        {isOwnStory && (
          <button
            className="story-viewer-footer"
            onClick={(e) => {
              e.stopPropagation();
              setShowViewers(true);
            }}
          >
            <Eye size={16} />
            <span>Seen by {viewersTotal > 0 ? viewersTotal : '—'}</span>
          </button>
        )}

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

        {/* Viewers list panel */}
        {showViewers && (
          <div 
            className="story-viewer-viewers-overlay" 
            onClick={(e) => {
              e.stopPropagation(); // Prevent closing the main viewer
              setShowViewers(false);
            }}
          >
            <div className="story-viewer-viewers-panel" onClick={e => e.stopPropagation()}>
              <div className="story-viewer-viewers-header">
                <h3>Seen by {viewersTotal}</h3>
                <button onClick={() => setShowViewers(false)} aria-label="Close viewers">
                  <X size={20} />
                </button>
              </div>
              <div className="story-viewer-viewers-list">
                {loadingViewers ? (
                  <div className="story-viewer-viewers-loading">Loading...</div>
                ) : viewers.length === 0 ? (
                  <div className="story-viewer-viewers-empty">No views yet</div>
                ) : (
                  viewers.map(viewer => (
                    <div key={viewer.user_id} className="story-viewer-viewer-item">
                      <Avatar src={viewer.profile_pic} name={viewer.username} size="sm" />
                      <span className="story-viewer-viewer-name">{viewer.username}</span>
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
