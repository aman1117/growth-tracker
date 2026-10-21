/**
 * StoryCirclesRow Component
 *
 * Horizontal scrollable row of story circles below the dashboard card.
 * Instagram-style layout: Add Story button, friends' stories, then own story at the end.
 */

import { Camera, Image as ImageIcon, ImagePlus, Plus } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { getActivityConfig } from '../../constants';
import { activityPhotoApi } from '../../services/api';
import { useAuth } from '../../store';
import type { ActivityName, CustomTile } from '../../types';
import type { ActivityPhoto, UserStoryGroup } from '../../types/story';
import { getOnColorTone } from '../../utils/color';
import {
  compressImageToFile,
  formatDateForAPI,
  isDateWithinUploadWindow,
  isValidImageSize,
  isValidImageType,
} from '../../utils/image-utils';
import { DynamicIcon } from '../DynamicIcon';
import { Avatar, Modal, Skeleton, SnapToast } from '../ui';
import styles from './StoryCirclesRow.module.css';
import ring from './StoryRing.module.css';

const SKELETON_ITEMS = [1, 2, 3, 4];

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
  /** Callback when target user's photos are fetched (for profile avatar click handling) */
  onTargetUserPhotos?: (photos: ActivityPhoto[]) => void;
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
  targetUsername: _targetUsername, // eslint-disable-line @typescript-eslint/no-unused-vars
  isOwnProfile,
  activities,
  customTiles,
  colorOverrides,
  isEditMode,
  onPhotoClick,
  onTargetUserPhotos,
}) => {
  const { user } = useAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const galleryInputRef = useRef<HTMLInputElement>(null);

  // Use ref to store callback to avoid infinite re-fetch loops
  // when the callback is recreated on parent re-renders
  const onTargetUserPhotosRef = useRef(onTargetUserPhotos);
  useEffect(() => {
    onTargetUserPhotosRef.current = onTargetUserPhotos;
  }, [onTargetUserPhotos]);

  const [ownPhotos, setOwnPhotos] = useState<ActivityPhoto[]>([]);
  const [followingStories, setFollowingStories] = useState<UserStoryGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploadingActivity, setUploadingActivity] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [showActivityPicker, setShowActivityPicker] = useState(false);
  const [showSourcePicker, setShowSourcePicker] = useState(false);
  const [selectedActivity, setSelectedActivity] = useState<string | null>(null);

  const dateStr = formatDateForAPI(currentDate);
  const canUpload = isOwnProfile && isDateWithinUploadWindow(currentDate);

  // Reset photos when switching between own profile and other users' profiles
  // This prevents stale data from being shown
  useEffect(() => {
    setOwnPhotos([]);
    setFollowingStories([]);
  }, [isOwnProfile, targetUserId]);

  // Fetch photos
  const fetchPhotos = useCallback(async () => {
    if (!user?.id) return;

    // Safety check: when viewing own profile, ensure we're fetching the logged-in user's photos
    // This prevents a race condition where targetUserId might be stale from viewing another user
    const userIdToFetch = isOwnProfile ? user.id : targetUserId;
    if (!userIdToFetch) return;

    setLoading(true);
    setError(null);

    try {
      // Fetch own photos (or target user's if viewing someone else)
      const photosResponse = await activityPhotoApi.getPhotos(userIdToFetch, dateStr);
      if (photosResponse.success) {
        const photos = photosResponse.photos || [];
        setOwnPhotos(photos);
        // Notify parent about target user's photos (for profile avatar click handling)
        if (!isOwnProfile && onTargetUserPhotosRef.current) {
          onTargetUserPhotosRef.current(photos);
        }
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
    const uploadedSet = new Set(ownPhotos.map((p) => p.activity_name));

    return activities
      .filter((activityName) => !uploadedSet.has(activityName))
      .map((activityName) => {
        const isCustom = activityName.startsWith('custom:');
        const customTile = isCustom
          ? customTiles.find((t) => `custom:${t.id}` === activityName)
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
      setToast({ message: 'Please select a JPEG, PNG, or WebP image', type: 'error' });
      setUploadingActivity(null);
      setSelectedActivity(null);
      return;
    }

    if (!isValidImageSize(file)) {
      setToast({ message: 'Image must be less than 5MB', type: 'error' });
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
        const customTile = customTiles.find((t) => `custom:${t.id}` === activityToUpload);
        if (customTile) {
          customTileMetadata = {
            icon: customTile.icon,
            color: colorOverrides[activityToUpload] || customTile.color,
            label: customTile.name,
          };
        }
      }

      // Upload with custom tile metadata
      const response = await activityPhotoApi.uploadPhoto(
        compressedFile,
        activityToUpload,
        dateStr,
        customTileMetadata
      );

      if (response.success && response.photo) {
        setOwnPhotos((prev) => [...prev, response.photo!]);
        setToast({ message: 'Photo uploaded!', type: 'success' });
      } else {
        setToast({ message: response.error || 'Upload failed', type: 'error' });
      }
    } catch (err) {
      console.error('Upload error:', err);
      setToast({ message: err instanceof Error ? err.message : 'Upload failed', type: 'error' });
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
      setToast({ message: "You've added photos for all activities today!", type: 'success' });
      return;
    }
    setShowActivityPicker(true);
  };

  // Handler for when own photo is deleted
  const handlePhotoDeleted = useCallback((photoId: number) => {
    setOwnPhotos((prev) => prev.filter((p) => p.id !== photoId));
  }, []);

  // Handler for when friend's photos are viewed - mark individual photos as viewed
  const handlePhotosViewed = useCallback((photoIds: number[], userId: number) => {
    setFollowingStories((prev) =>
      prev.map((group) => {
        if (group.user_id === userId) {
          // Mark viewed photos
          const updatedPhotos = group.photos.map((photo) =>
            photoIds.includes(photo.id) ? { ...photo, viewed: true } : photo
          );
          const hasUnseen = updatedPhotos.some((p) => !p.viewed);
          return { ...group, photos: updatedPhotos, has_unseen: hasUnseen };
        }
        return group;
      })
    );
  }, []);

  // Handle clicking on own story avatar (when user has uploaded photos)
  const handleOwnStoryClick = () => {
    // Sort by created_at (older first)
    const sortedPhotos = [...ownPhotos].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
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
    const firstUnseenIndex = group.photos.findIndex((p) => !p.viewed);
    if (firstUnseenIndex !== -1) {
      startIndex = firstUnseenIndex;
    }
    // If all photos are viewed, start from the first one

    onPhotoClick(group.photos, startIndex, group.username, group.profile_pic, false, {
      onPhotoDeleted: handlePhotoDeleted,
      onPhotosViewed: (photoIds) => handlePhotosViewed(photoIds, group.user_id),
    });
  };

  // Don't render in edit mode
  if (isEditMode) return null;

  // Don't render the card when viewing other user's profile (stories accessed via profile avatar)
  // Note: Photos are still fetched to notify parent via onTargetUserPhotos callback
  if (!isOwnProfile) return null;

  // Don't render if date is too old and no content
  if (
    !isDateWithinUploadWindow(currentDate) &&
    ownPhotos.length === 0 &&
    followingStories.length === 0
  ) {
    return null;
  }

  const hasOwnPhotos = ownPhotos.length > 0;
  const hasContent = canUpload || hasOwnPhotos || followingStories.length > 0;

  // Don't show anything if loading failed or no content
  if (error || (!hasContent && !loading)) return null;

  const availableActivities = getAvailableActivities();
  const canAddMore = canUpload && availableActivities.length > 0;
  const selectedActivityLabel = selectedActivity
    ? availableActivities.find((activity) => activity.name === selectedActivity)?.displayLabel
    : undefined;

  const handleOwnRingClick = () => {
    if (hasOwnPhotos) {
      handleOwnStoryClick();
    } else if (canAddMore) {
      handleAddStoryClick();
    }
  };

  return (
    <section className={styles.row} aria-label="Stories">
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
      <div className={styles.scroll}>
        {loading ? (
          SKELETON_ITEMS.map((i) => (
            <div key={i} className={styles.skeletonItem} aria-hidden="true">
              <Skeleton width={68} height={68} radius="full" />
              <Skeleton width={46} height={10} radius="full" />
            </div>
          ))
        ) : (
          <>
            {/* 1. Your story: view it, or start adding one */}
            {(canUpload || hasOwnPhotos) && (
              <div className={ring.item}>
                <div className={styles.ownWrapper}>
                  <button
                    type="button"
                    className={`${ring.ring} ${hasOwnPhotos ? ring.ringOwn : ring.ringEmpty} ${
                      uploadingActivity ? ring.ringUploading : ''
                    }`}
                    onClick={handleOwnRingClick}
                    disabled={!!uploadingActivity || (!hasOwnPhotos && !canAddMore)}
                    aria-label={hasOwnPhotos ? 'View your story' : 'Add to your story'}
                    aria-busy={!!uploadingActivity || undefined}
                  >
                    <span className={ring.ringContent}>
                      <Avatar
                        src={user?.profilePic}
                        thumbnailSrc={user?.profilePicThumb}
                        name={user?.username || 'You'}
                        size="lg"
                        className={ring.avatarFill}
                      />
                    </span>
                  </button>
                  {/* Plus badge - add new story */}
                  {canAddMore && (
                    <button
                      type="button"
                      className={styles.addBadge}
                      onClick={handleAddStoryClick}
                      disabled={!!uploadingActivity}
                      aria-label="Add new story"
                    >
                      {uploadingActivity ? (
                        <span className={styles.badgeSpinner} aria-hidden="true" />
                      ) : (
                        <Plus size={14} strokeWidth={3} aria-hidden="true" />
                      )}
                    </button>
                  )}
                </div>
                <span className={ring.label}>{hasOwnPhotos ? 'Your story' : 'Add story'}</span>
              </div>
            )}

            {/* 2. Friends' stories */}
            {followingStories.map((group) => (
              <div key={group.user_id} className={ring.item}>
                <button
                  type="button"
                  className={`${ring.ring} ${group.has_unseen ? ring.ringUnseen : ring.ringViewed}`}
                  onClick={() => handleFriendStoryClick(group)}
                  aria-label={`View ${group.username}'s story${group.has_unseen ? ' (new)' : ''}`}
                >
                  <span className={ring.ringContent}>
                    <Avatar
                      src={group.profile_pic}
                      thumbnailSrc={group.profile_pic_thumb}
                      name={group.username}
                      size="lg"
                      className={ring.avatarFill}
                    />
                  </span>
                </button>
                <span className={`${ring.label} ${group.has_unseen ? '' : ring.labelViewed}`}>
                  {group.username}
                </span>
              </div>
            ))}

            {/* Note: When viewing someone else's profile, their stories are opened via the profile avatar click in Dashboard */}
          </>
        )}
      </div>

      {/* Activity Picker */}
      <Modal
        isOpen={showActivityPicker}
        onClose={() => setShowActivityPicker(false)}
        title="Add to your story"
        subtitle="Which activity is this photo for?"
        icon={<ImagePlus size={19} strokeWidth={2.25} />}
        maxWidth="440px"
      >
        <div className={styles.pickerGrid}>
          {availableActivities.map((activity) => (
            <button
              key={activity.name}
              type="button"
              className={styles.pickerItem}
              onClick={() => handleActivitySelect(activity.name)}
              style={{ '--activity-color': activity.color } as React.CSSProperties}
            >
              <span
                className={`${styles.pickerIcon} ${
                  getOnColorTone(activity.color) === 'dark' ? styles.pickerIconDark : ''
                }`}
                aria-hidden="true"
              >
                {activity.icon ? (
                  <DynamicIcon name={activity.icon} size={20} strokeWidth={2.1} />
                ) : (
                  <Camera size={20} strokeWidth={2.1} />
                )}
              </span>
              <span className={styles.pickerLabel}>{activity.displayLabel}</span>
            </button>
          ))}
        </div>
      </Modal>

      {/* Source Picker - Camera or Gallery */}
      <Modal
        isOpen={showSourcePicker}
        onClose={handleSourcePickerClose}
        title="Add photo"
        subtitle={selectedActivityLabel ? `For ${selectedActivityLabel}` : undefined}
        icon={<Camera size={19} strokeWidth={2.25} />}
        maxWidth="400px"
      >
        <div className={styles.sourceOptions}>
          <button type="button" className={styles.sourceOption} onClick={handleCameraSelect}>
            <span className={`${styles.sourceIcon} ${styles.sourceCamera}`} aria-hidden="true">
              <Camera size={24} strokeWidth={2.1} />
            </span>
            <span className={styles.sourceLabel}>Take photo</span>
            <span className={styles.sourceHint}>Use your camera</span>
          </button>
          <button type="button" className={styles.sourceOption} onClick={handleGallerySelect}>
            <span className={`${styles.sourceIcon} ${styles.sourceGallery}`} aria-hidden="true">
              <ImageIcon size={24} strokeWidth={2.1} />
            </span>
            <span className={styles.sourceLabel}>Choose photo</span>
            <span className={styles.sourceHint}>From your gallery</span>
          </button>
        </div>
      </Modal>

      {/* Toast notification */}
      {toast?.message && (
        <SnapToast message={toast.message} type={toast.type} onClose={() => setToast(null)} />
      )}
    </section>
  );
};
export default StoryCirclesRow;
