/**
 * Dashboard Types
 *
 * Centralized type definitions for the Dashboard module.
 */

import type { ActivityName, ActivityPhoto, CustomTile } from '../../types';
import type { Badge } from '../../types/api';
import type { TileSize } from '../ActivityTile';

// ============================================================================
// Tile Configuration Types
// ============================================================================

export interface TileConfig {
  tileOrder: ActivityName[];
  tileSizes: Record<ActivityName, TileSize>;
  hiddenTiles: ActivityName[];
  tileColors: Record<string, string>;
  customTiles: CustomTile[];
}

export interface TileConfigState extends TileConfig {
  configLoading: boolean;
  setTileOrder: React.Dispatch<React.SetStateAction<ActivityName[]>>;
  setTileSizes: React.Dispatch<React.SetStateAction<Record<ActivityName, TileSize>>>;
  setHiddenTiles: React.Dispatch<React.SetStateAction<ActivityName[]>>;
  setTileColors: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setCustomTiles: React.Dispatch<React.SetStateAction<CustomTile[]>>;
  saveTileConfigToBackend: (
    order: ActivityName[],
    sizes: Record<ActivityName, TileSize>,
    hidden: ActivityName[],
    colors: Record<string, string>,
    customTilesList: CustomTile[]
  ) => Promise<void>;
}

// ============================================================================
// Activity Data Types
// ============================================================================

export interface ActivityDataState {
  activities: Record<string, number>;
  activityNotes: Record<string, string>;
  loading: boolean;
  setActivities: React.Dispatch<React.SetStateAction<Record<string, number>>>;
  setActivityNotes: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  fetchActivities: () => Promise<void>;
}

// ============================================================================
// Target User Types
// ============================================================================

export interface TargetUserState {
  targetUsername: string | undefined;
  targetUserId: number | null;
  targetProfilePic: string | null;
  targetBio: string | null;
  targetIsVerified: boolean;
  targetIsPrivate: boolean;
  targetLastLoggedAt: string | null;
  isReadOnly: boolean;
  isPrivateAccount: boolean;
  privateAccountBadges: Badge[];
  targetUserPhotos: ActivityPhoto[];
  targetUserPhotosOwnerId: number | null;
  setTargetUserPhotos: React.Dispatch<React.SetStateAction<ActivityPhoto[]>>;
  setTargetUserPhotosOwnerId: React.Dispatch<React.SetStateAction<number | null>>;
  setIsPrivateAccount: React.Dispatch<React.SetStateAction<boolean>>;
}

// ============================================================================
// Date Navigation Types
// ============================================================================

export interface DateNavigationState {
  currentDate: Date;
  setCurrentDate: React.Dispatch<React.SetStateAction<Date>>;
  handlePrevDay: () => void;
  handleNextDay: () => void;
  handleDateChange: (newDate: Date) => void;
  isNextDisabled: () => boolean;
  tilesAnimating: boolean;
  animationDirection: 'left' | 'right';
}

// ============================================================================
// Edit Mode Types
// ============================================================================

export interface EditModeState {
  isEditMode: boolean;
  setIsEditMode: React.Dispatch<React.SetStateAction<boolean>>;
  selectedTile: ActivityName | null;
  setSelectedTile: React.Dispatch<React.SetStateAction<ActivityName | null>>;
  enterEditMode: () => void;
  cancelEditMode: () => void;
  saveEditMode: () => void;
}

export interface EditModeOriginals {
  originalTileOrder: ActivityName[];
  originalTileSizes: Record<ActivityName, TileSize>;
  originalHiddenTiles: ActivityName[];
  originalCustomTiles: CustomTile[];
}

// ============================================================================
// Drag and Drop Types
// ============================================================================

export interface DragAndDropState {
  activeDragId: ActivityName | null;
  sensors: ReturnType<typeof import('@dnd-kit/core').useSensors>;
  handleDragStart: (event: import('@dnd-kit/core').DragStartEvent) => void;
  handleDragEnd: (event: import('@dnd-kit/core').DragEndEvent) => void;
}

// ============================================================================
// Modal State Types
// ============================================================================

export interface ActivityModalState {
  isModalOpen: boolean;
  selectedActivity: ActivityName | null;
  setIsModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setSelectedActivity: React.Dispatch<React.SetStateAction<ActivityName | null>>;
}

export interface CustomTileModalState {
  showCustomTileModal: boolean;
  editingCustomTile: CustomTile | undefined;
  setShowCustomTileModal: React.Dispatch<React.SetStateAction<boolean>>;
  setEditingCustomTile: React.Dispatch<React.SetStateAction<CustomTile | undefined>>;
}

export interface HideConfirmState {
  hideConfirm: { tileName: ActivityName; displayName: string } | null;
  setHideConfirm: React.Dispatch<
    React.SetStateAction<{ tileName: ActivityName; displayName: string } | null>
  >;
  handleConfirmHide: () => void;
  handleCancelHide: () => void;
}

export interface DeletedTileState {
  deletedTile: {
    tile: CustomTile;
    orderIndex: number;
    wasHidden: boolean;
    color?: string;
  } | null;
  setDeletedTile: React.Dispatch<
    React.SetStateAction<{
      tile: CustomTile;
      orderIndex: number;
      wasHidden: boolean;
      color?: string;
    } | null>
  >;
  handleUndoDelete: () => void;
}

// ============================================================================
// Story Viewer Types
// ============================================================================

export interface StoryViewerState {
  isOpen: boolean;
  photos: ActivityPhoto[];
  startIndex: number;
  ownerUsername: string;
  ownerProfilePic?: string;
  isOwnStory: boolean;
  handlers?: {
    onPhotoDeleted: (photoId: number) => void;
    onPhotosViewed: (photoIds: number[]) => void;
  };
}

// ============================================================================
// Toast Types
// ============================================================================

export interface ToastState {
  toast: { message: string; type: 'success' | 'error' } | null;
  setToast: React.Dispatch<React.SetStateAction<{ message: string; type: 'success' | 'error' } | null>>;
}

// ============================================================================
// Badge Types
// ============================================================================

export interface BadgeUnlockState {
  newBadges: Badge[];
  showBadgeUnlockModal: boolean;
  setNewBadges: React.Dispatch<React.SetStateAction<Badge[]>>;
  setShowBadgeUnlockModal: React.Dispatch<React.SetStateAction<boolean>>;
}
