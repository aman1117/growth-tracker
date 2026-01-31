/**
 * Story Types
 *
 * Type definitions for Instagram-like story feature
 */

// Activity photo uploaded for a specific day
export interface ActivityPhoto {
  id: number;
  user_id: number;
  activity_name: string;
  photo_date: string; // YYYY-MM-DD
  photo_url: string;
  thumbnail_url: string;
  // Custom tile metadata (optional, only for custom activities)
  activity_icon?: string;
  activity_color?: string;
  activity_label?: string;
  created_at: string;
  // View status (only in following stories response)
  viewed?: boolean;
}

// Data for rendering a story circle
export interface StoryCircleData {
  activity_name: string;
  display_label: string;
  icon?: string; // Icon name string for DynamicIcon
  color: string;
  photo?: ActivityPhoto;
  has_photo: boolean;
  is_uploadable: boolean; // Can upload (own circle, date within 7 days)
}

// User's story group (all photos for a date)
export interface UserStoryGroup {
  user_id: number;
  username: string;
  profile_pic?: string;
  photos: ActivityPhoto[];
  has_unseen: boolean;
}

// Photo viewer info
export interface PhotoViewer {
  user_id: number;
  username: string;
  profile_pic?: string;
  viewed_at: string;
}

// API response types
export interface UploadPhotoResponse {
  success: boolean;
  photo?: ActivityPhoto;
  error?: string;
}

export interface GetPhotosResponse {
  success: boolean;
  photos: ActivityPhoto[];
  error?: string;
}

export interface GetFollowingStoriesResponse {
  success: boolean;
  stories: UserStoryGroup[];
  error?: string;
}

export interface GetPhotoViewersResponse {
  success: boolean;
  viewers: PhotoViewer[];
  total: number;
  error?: string;
}

// Story viewer navigation state
export interface StoryViewerState {
  isOpen: boolean;
  photos: ActivityPhoto[];
  currentIndex: number;
  ownerUsername: string;
  ownerProfilePic?: string;
  isOwnStory: boolean;
}
