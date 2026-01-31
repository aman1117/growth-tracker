/**
 * StoryCirclesRow Component
 *
 * Horizontal scrollable row of story circles below the dashboard card.
 * Instagram-style layout: Add Story button, friends' stories, then own story at the end.
 */

import { Camera, Image, Plus, X } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { getActivityConfig } from '../../constants';
import { activityPhotoApi } from '../../services/api';
import { useAuth } from '../../store';
import type { ActivityName, CustomTile } from '../../types';
import type { ActivityPhoto, UserStoryGroup } from '../../types/story';
import {
  compressImageToFile,
  formatDateForAPI,
  isDateWithinUploadWindow,
  isValidImageSize,
  isValidImageType,
} from '../../utils/image-utils';
import { Avatar, SnapToast } from '../ui';
import { DynamicIcon } from '../DynamicIcon';

import './StoryCirclesRow.css';

export interface StoryCirclesRowProps {
  /** Current date being viewed */
  currentDate: Date;
  /** Target user ID (whose dashboard we're viewing) */
  targetUserId: number;
  /** Target username */
  targetUsername: string;
  /** Whether viewing own profile */
  isOwnProfile: boolean;
  /** All activities including predefined and custom */
  activities: ActivityName[];
  /** Custom tiles configuration */
  customTiles: CustomTile[];
  /** Color overrides for tiles */
  colorOverrides: Record<string, string>;
  /** Whether in edit mode (hide stories) */
  isEditMode: boolean;
  /** Callback when a photo is clicked - returns handlers for deletion/viewing */
  onPhotoClick: (
    photos: ActivityPhoto[], 
    startIndex: number, 
    ownerUsername: string, 
    ownerProfilePic?: string, 
    isOwn?: boolean,
    handlers?: {
      onPhotoDeleted: (photoId: number) => void;
      onPhotosViewed: (photoIds: number[]) => void;
    }
  ) => void;
}

interface AvailableActivity {
  name: string;
  displayLabel: string;
  icon?: string;
  color: string;
}

export const StoryCirclesRow: React.FC<StoryCirclesRowProps> = ({
  currentDate,
  targetUserId,
  targetUsername,
  isOwnProfile,
  activities,
  customTiles,
  colorOverrides,
  isEditMode,
  onPhotoClick,
}) => {
  const { user } = useAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const galleryInputRef = useRef<HTMLInputElement>(null);
  
  const [ownPhotos, setOwnPhotos] = useState<ActivityPhoto[]>([]);
  const [followingStories, setFollowingStories] = useState<UserStoryGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploadingActivity, setUploadingActivity] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [showActivityPicker, setShowActivityPicker] = useState(false);
  const [showSourcePicker, setShowSourcePicker] = useState(false);
  const [selectedActivity, setSelectedActivity] = useState<string | null>(null);

  const dateStr = formatDateForAPI(currentDate);
  const canUpload = isOwnProfile && isDateWithinUploadWindow(currentDate);

  // Lock body scroll when activity picker is open
  useEffect(() => {
    if (showActivityPicker || showSourcePicker) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [showActivityPicker, showSourcePicker]);

  // Fetch photos
  const fetchPhotos = useCallback(async () => {
    if (!user?.id) return;
    
    setLoading(true);
    setError(null);
    
    try {
      // Fetch own photos (or target user's if viewing someone else)
      const photosResponse = await activityPhotoApi.getPhotos(targetUserId, dateStr);
      if (photosResponse.success) {
        setOwnPhotos(photosResponse.photos || []);
      }

      // Fetch following stories only on own profile
      if (isOwnProfile) {
        const storiesResponse = await activityPhotoApi.getFollowingStories(dateStr);
        if (storiesResponse.success) {
          setFollowingStories(storiesResponse.stories || []);
        }
      }
    } catch (err) {
      console.error('Failed to fetch stories:', err);
      setError('failed');
    } finally {
      setLoading(false);
    }
  }, [user?.id, targetUserId, dateStr, isOwnProfile]);

  useEffect(() => {
    fetchPhotos();
  }, [fetchPhotos]);

  // Get available activities (ones without photos yet)
  const getAvailableActivities = useCallback((): AvailableActivity[] => {
    const uploadedSet = new Set(ownPhotos.map(p => p.activity_name));
    
    return activities
      .filter(activityName => !uploadedSet.has(activityName))
      .map(activityName => {
        const isCustom = activityName.startsWith('custom:');
        const customTile = isCustom
          ? customTiles.find(t => `custom:${t.id}` === activityName)
          : null;
        
        const config = isCustom ? null : getActivityConfig(activityName);
        const displayLabel = customTile?.name || config?.label || activityName;
        const iconName = customTile?.icon || config?.iconName;
        const color = colorOverrides[activityName] || customTile?.color || config?.color || '#666';

        return {
          name: activityName,
          displayLabel,
          icon: iconName,
          color,
        };
      })
      .sort((a, b) => a.displayLabel.localeCompare(b.displayLabel));
  }, [activities, customTiles, colorOverrides, ownPhotos]);

  // Handle file selection for upload
  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    const activityToUpload = selectedActivity;
    
    // Reset both inputs
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    if (galleryInputRef.current) {
      galleryInputRef.current.value = '';
    }

    if (!file || !activityToUpload) {
      setSelectedActivity(null);
      setShowSourcePicker(false);
      return;
    }

    setUploadingActivity(activityToUpload);
    setShowActivityPicker(false);
    setShowSourcePicker(false);

    // Validate
    if (!isValidImageType(file)) {
      setToastMessage('Please select a JPEG, PNG, or WebP image');
      setUploadingActivity(null);
      setSelectedActivity(null);
      return;
    }

    if (!isValidImageSize(file)) {
      setToastMessage('Image must be less than 5MB');
      setUploadingActivity(null);
      setSelectedActivity(null);
      return;
    }

    try {
      // Compress image
      const compressedFile = await compressImageToFile(file);
      
      // Get custom tile metadata if this is a custom activity
      let customTileMetadata: { icon?: string; color?: string; label?: string } | undefined;
      if (activityToUpload.startsWith('custom:')) {
        const customTile = customTiles.find(t => `custom:${t.id}` === activityToUpload);
        if (customTile) {
          customTileMetadata = {
            icon: customTile.icon,
            color: colorOverrides[activityToUpload] || customTile.color,
            label: customTile.name,
          };
        }
      }
      
      // Upload with custom tile metadata
      const response = await activityPhotoApi.uploadPhoto(compressedFile, activityToUpload, dateStr, customTileMetadata);
      
      if (response.success && response.photo) {
        setOwnPhotos(prev => [...prev, response.photo!]);
        setToastMessage('Photo uploaded!');
      } else {
        setToastMessage(response.error || 'Upload failed');
      }
    } catch (err) {
      console.error('Upload error:', err);
      setToastMessage(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploadingActivity(null);
      setSelectedActivity(null);
    }
  };

  // Handle activity selection from picker - show source picker
  const handleActivitySelect = (activityName: string) => {
    setSelectedActivity(activityName);
    setShowActivityPicker(false);
    setShowSourcePicker(true);
  };

  // Handle selecting camera as source
  const handleCameraSelect = () => {
    setShowSourcePicker(false);
    setTimeout(() => fileInputRef.current?.click(), 100);
  };

  // Handle selecting gallery as source
  const handleGallerySelect = () => {
    setShowSourcePicker(false);
    setTimeout(() => galleryInputRef.current?.click(), 100);
  };

  // Handle closing source picker
  const handleSourcePickerClose = () => {
    setShowSourcePicker(false);
    setSelectedActivity(null);
  };

  // Handle clicking "Add Story" button
  const handleAddStoryClick = () => {
    const available = getAvailableActivities();
    if (available.length === 0) {
      setToastMessage('You\'ve added photos for all activities today!');
      return;
    }
    setShowActivityPicker(true);
  };

  // Handler for when own photo is deleted
  const handlePhotoDeleted = useCallback((photoId: number) => {
    setOwnPhotos(prev => prev.filter(p => p.id !== photoId));
  }, []);

  // Handler for when friend's photos are viewed - mark individual photos as viewed
  const handlePhotosViewed = useCallback((photoIds: number[], userId: number) => {
    setFollowingStories(prev => prev.map(group => {
      if (group.user_id === userId) {
        // Mark viewed photos
        const updatedPhotos = group.photos.map(photo => 
          photoIds.includes(photo.id) ? { ...photo, viewed: true } : photo
        );
        const hasUnseen = updatedPhotos.some(p => !p.viewed);
        return { ...group, photos: updatedPhotos, has_unseen: hasUnseen };
      }
      return group;
    }));
  }, []);

  // Handle clicking on own story avatar (when user has uploaded photos)
  const handleOwnStoryClick = () => {
    // Sort by created_at (older first)
    const sortedPhotos = [...ownPhotos].sort((a, b) => 
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );
    onPhotoClick(
      sortedPhotos, 
      0, // Always start from first for own photos
      'Your Story',
      user?.profilePic || undefined, 
      true,
      { onPhotoDeleted: handlePhotoDeleted, onPhotosViewed: () => {} }
    );
  };

  // Handle clicking on friend's story - start from first unseen photo
  const handleFriendStoryClick = (group: UserStoryGroup) => {
    // Photos are already sorted by created_at from backend
    // Find the index of first unseen photo
    let startIndex = 0;
    const firstUnseenIndex = group.photos.findIndex(p => !p.viewed);
    if (firstUnseenIndex !== -1) {
      startIndex = firstUnseenIndex;
    }
    // If all photos are viewed, start from the first one
    
    onPhotoClick(
      group.photos, 
      startIndex, 
      group.username, 
      group.profile_pic, 
      false,
      { onPhotoDeleted: handlePhotoDeleted, onPhotosViewed: (photoIds) => handlePhotosViewed(photoIds, group.user_id) }
    );
  };

  // Don't render in edit mode
  if (isEditMode) return null;

  // Don't render if date is too old and no content
  if (!isDateWithinUploadWindow(currentDate) && ownPhotos.length === 0 && followingStories.length === 0) {
    return null;
  }

  const hasOwnPhotos = ownPhotos.length > 0;
  const hasContent = canUpload || hasOwnPhotos || followingStories.length > 0;

  // Don't show anything if loading failed or no content
  if (error || (!hasContent && !loading)) return null;

  const availableActivities = getAvailableActivities();

  return (
    <div className="story-row-container glass-surface">
      {/* Hidden file input for camera */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        capture="environment"
        onChange={handleFileSelect}
        style={{ display: 'none' }}
        aria-hidden="true"
      />
      
      {/* Hidden file input for gallery (no capture attribute) */}
      <input
        ref={galleryInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        onChange={handleFileSelect}
        style={{ display: 'none' }}
        aria-hidden="true"
      />

      {/* Scrollable content */}
      <div className="story-row-scroll">
        {loading ? (
          <div className="story-row-skeletons">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="story-circle-skeleton" />
            ))}
          </div>
        ) : (
          <>
            {/* Own profile layout: Add Story button → Friends' stories */}
            {isOwnProfile && (
              <>
                {/* 1. Add Story button (always show if can upload or has photos) */}
                {(canUpload || hasOwnPhotos) && (
                  <div className="story-circle-container story-circle-medium">
                    <div className="story-add-circle-wrapper">
                      {/* Avatar part - view own story if has photos */}
                      <button
                        className={`story-add-circle ${uploadingActivity ? 'story-circle-uploading' : ''} ${hasOwnPhotos ? 'story-add-circle-clickable' : 'story-add-circle-no-photos'}`}
                        onClick={hasOwnPhotos ? handleOwnStoryClick : undefined}
                        disabled={!!uploadingActivity || !hasOwnPhotos}
                        aria-label={hasOwnPhotos ? "View your story" : "Your story"}
                        type="button"
                      >
                        <div className="story-add-avatar">
                          <Avatar 
                            src={user?.profilePic} 
                            name={user?.username || 'You'} 
                            size="lg" 
                          />
                        </div>
                      </button>
                      {/* Plus icon - add new story */}
                      {canUpload && availableActivities.length > 0 && (
                        <button
                          className="story-add-badge"
                          onClick={handleAddStoryClick}
                          disabled={!!uploadingActivity}
                          aria-label="Add new story"
                          type="button"
                        >
                          {uploadingActivity ? (
                            <div className="story-add-spinner" />
                          ) : (
                            <Plus size={14} strokeWidth={3} />
                          )}
                        </button>
                      )}
                    </div>
                    <span className="story-circle-label">{hasOwnPhotos ? 'Your Story' : 'Add Story'}</span>
                  </div>
                )}

                {/* 2. Friends' stories */}
                {followingStories.map(group => (
                  <div key={group.user_id} className="story-circle-container story-circle-medium">
                    <button
                      className={`story-circle ${group.has_unseen ? 'story-ring-unseen' : 'story-ring-viewed'}`}
                      onClick={() => handleFriendStoryClick(group)}
                      aria-label={`View ${group.username}'s story`}
                    >
                      <div className="story-circle-inner">
                        {group.profile_pic ? (
                          <img 
                            src={group.profile_pic} 
                            alt={group.username}
                            className="story-circle-image"
                          />
                        ) : (
                          <div className="story-circle-avatar-placeholder">
                            {group.username.charAt(0).toUpperCase()}
                          </div>
                        )}
                      </div>
                    </button>
                    <span className="story-circle-label">{group.username}</span>
                  </div>
                ))}
              </>
            )}

            {/* Viewing someone else's profile - show their photos with their avatar */}
            {!isOwnProfile && hasOwnPhotos && (
              <div className="story-circle-container story-circle-medium">
                <button
                  className="story-circle story-ring-viewed"
                  onClick={() => {
                    // Sort by created_at
                    const sortedPhotos = [...ownPhotos].sort((a, b) => 
                      new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
                    );
                    onPhotoClick(
                      sortedPhotos, 
                      0, 
                      targetUsername, 
                      undefined, 
                      false,
                      { onPhotoDeleted: handlePhotoDeleted, onPhotosViewed: () => {} }
                    );
                  }}
                  aria-label={`View ${targetUsername}'s story`}
                >
                  <div className="story-circle-inner">
                    <div className="story-circle-avatar-placeholder">
                      {targetUsername.charAt(0).toUpperCase()}
                    </div>
                  </div>
                </button>
                <span className="story-circle-label">{targetUsername}</span>
              </div>
            )}
          </>
        )}
      </div>

      {/* Activity Picker Modal */}
      {/* Activity Picker Modal - rendered in portal to escape overflow:hidden */}
      {showActivityPicker && createPortal(
        <div className="story-activity-picker-overlay" onClick={() => setShowActivityPicker(false)}>
          <div className="story-activity-picker" onClick={e => e.stopPropagation()}>
            <div className="story-activity-picker-header">
              <div>
                <h3>Add Story</h3>
                <p>Select an activity</p>
              </div>
              <button 
                className="story-activity-picker-close"
                onClick={() => setShowActivityPicker(false)}
                aria-label="Close"
              >
                <X size={20} />
              </button>
            </div>
            <div className="story-activity-picker-list">
              {availableActivities.map(activity => (
                <button
                  key={activity.name}
                  className="story-activity-picker-item"
                  onClick={() => handleActivitySelect(activity.name)}
                >
                  <div 
                    className="story-activity-picker-icon"
                    style={{ backgroundColor: activity.color }}
                  >
                    {activity.icon ? (
                      <DynamicIcon name={activity.icon} size={18} color="white" />
                    ) : (
                      <Camera size={18} color="white" />
                    )}
                  </div>
                  <span className="story-activity-picker-label">{activity.displayLabel}</span>
                </button>
              ))}
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Source Picker Modal - Camera or Gallery */}
      {showSourcePicker && createPortal(
        <div className="story-activity-picker-overlay" onClick={handleSourcePickerClose}>
          <div className="story-source-picker" onClick={e => e.stopPropagation()}>
            <div className="story-source-picker-header">
              <h3>Add Photo</h3>
              <button 
                className="story-activity-picker-close"
                onClick={handleSourcePickerClose}
                aria-label="Close"
              >
                <X size={20} />
              </button>
            </div>
            <div className="story-source-picker-options">
              <button
                className="story-source-picker-option"
                onClick={handleCameraSelect}
              >
                <div className="story-source-picker-icon">
                  <Camera size={24} />
                </div>
                <span>Take Photo</span>
              </button>
              <button
                className="story-source-picker-option"
                onClick={handleGallerySelect}
              >
                <div className="story-source-picker-icon">
                  <Image size={24} />
                </div>
                <span>Choose from Gallery</span>
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Toast notification */}
      {toastMessage && (
        <SnapToast
          message={toastMessage}
          type={toastMessage.includes('failed') || toastMessage.includes('Please') || toastMessage.includes('must be') ? 'error' : 'success'}
          onClose={() => setToastMessage(null)}
        />
      )}
    </div>
  );
};

export default StoryCirclesRow;
