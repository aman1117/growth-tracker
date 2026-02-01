/**
 * Dashboard Component (Modular Version)
 *
 * Main dashboard page that composes modular hooks and components.
 * Displays activity tiles with drag-and-drop reordering, date navigation,
 * and support for viewing own or other users' profiles.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { createCustomActivityName, getActivityConfig } from '../../constants';
import { APP_ROUTES } from '../../constants/routes';
import { api } from '../../services/api';
import { useAuth, useCompletionStore } from '../../store';
import type { ActivityName, CustomTile } from '../../types';
import { MAX_CUSTOM_TILES } from '../../types';
import type { Badge } from '../../types/api';
import { playActivitySound, playCompletionSound } from '../../utils/sounds';
import { ActivityModal } from '../ActivityModal';
import type { TileSize } from '../ActivityTile';
import { BadgeUnlockModal } from '../BadgeUnlockModal';
import { CreateCustomTileModal } from '../CreateCustomTileModal';
import { DaySummaryCard } from '../DaySummaryCard';
import { HiddenTilesPanel } from '../HiddenTilesPanel';
import { StoryCirclesRow, StoryViewer } from '../story';
import { PullToRefreshWrapper, SnapToast } from '../ui';

import {
  EditModeToolbar,
  FullscreenProfilePic,
  HideConfirmDialog,
  LoadingSkeleton,
  PrivateAccountView,
  TileGrid,
  UndoDeleteToast,
  UserProfileHeader,
} from './components';
import { formatDateForApi, saveTileSizes, UNDO_TIMEOUT_DURATION } from './Dashboard.constants';
import type { StoryViewerState } from './Dashboard.types';
import {
  useActivityData,
  useDateNavigation,
  useDragAndDrop,
  useEditMode,
  useTileConfig,
} from './hooks';
import { useTargetUser } from './hooks/useTargetUser';

export const Dashboard: React.FC = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  
  // Toast state (moved up so callbacks can reference setToast)
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  
  // Private account state (moved up so callbacks can reference setters)
  const [isPrivateAccount, setIsPrivateAccount] = useState(false);
  const [privateAccountBadges, setPrivateAccountBadges] = useState<Badge[]>([]);
  
  // Stable callbacks for useActivityData (prevents infinite re-render loop)
  const handlePrivateAccount = useCallback((isPrivate: boolean) => {
    setIsPrivateAccount(isPrivate);
  }, []);
  
  const handlePrivateAccountBadges = useCallback((badges: Badge[]) => {
    setPrivateAccountBadges(badges);
  }, []);
  
  const handleActivityError = useCallback((message: string) => {
    setToast({ message, type: 'error' });
  }, []);
  
  // Ref to store fetchActivities for the follow-accepted event handler
  // This avoids circular dependency between useTargetUser and useActivityData
  const fetchActivitiesRef = useRef<() => void>(() => {});

  // ============================================================================
  // Core State Hooks
  // ============================================================================

  // Date navigation
  const {
    currentDate,
    handlePrevDay,
    handleNextDay,
    handleDateChange,
    isNextDisabled,
    tilesAnimating,
    animationDirection,
  } = useDateNavigation();

  // Target user (own profile vs viewing other's)
  const targetUserState = useTargetUser({
    fetchActivities: () => fetchActivitiesRef.current(),
  });

  const {
    targetUsername,
    targetUserId,
    targetProfilePic,
    targetBio,
    targetIsVerified,
    targetIsPrivate,
    targetLastLoggedAt,
    isReadOnly,
    targetUserPhotos,
    setTargetUserPhotos,
    targetUserPhotosOwnerId,
    setTargetUserPhotosOwnerId,
    showTargetFullscreenPic,
    setShowTargetFullscreenPic,
  } = targetUserState;

  // Activity data
  const {
    activities,
    setActivities,
    activityNotes,
    setActivityNotes,
    loading,
    fetchActivities,
  } = useActivityData({
    targetUsername,
    currentDate,
    isReadOnly,
    onPrivateAccount: handlePrivateAccount,
    onPrivateAccountBadges: handlePrivateAccountBadges,
    onError: handleActivityError,
  });
  
  // Update ref so useTargetUser's follow-accepted handler can call fetchActivities
  useEffect(() => {
    fetchActivitiesRef.current = fetchActivities;
  }, [fetchActivities]);

  // Tile configuration
  const {
    tileOrder,
    setTileOrder,
    tileSizes,
    setTileSizes,
    hiddenTiles,
    setHiddenTiles,
    tileColors,
    setTileColors,
    customTiles,
    setCustomTiles,
    configLoading,
    visibleTiles,
    saveTileConfigToBackend,
    handleTileResize,
  } = useTileConfig({
    isReadOnly,
    targetUsername,
  });

  // Edit mode
  const {
    isEditMode,
    selectedTile,
    setSelectedTile,
    cancelEditMode: baseCancelEditMode,
    saveEditMode: baseSaveEditMode,
  } = useEditMode({
    isReadOnly,
    tileOrder,
    tileSizes,
    hiddenTiles,
    customTiles,
    tileColors,
    setTileOrder,
    setTileSizes,
    setHiddenTiles,
    setCustomTiles,
    setTileColors,
    saveTileConfigToBackend,
  });

  // Drag and drop
  const {
    activeDragId,
    sensors,
    handleDragStart,
    handleDragEnd,
  } = useDragAndDrop({
    setTileOrder,
  });

  // ============================================================================
  // Refresh State (for pull-to-refresh)
  // ============================================================================
  
  const [refreshKey, setRefreshKey] = useState(0);

  // ============================================================================
  // Modal State
  // ============================================================================

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedActivity, setSelectedActivity] = useState<ActivityName | null>(null);
  const [showCustomTileModal, setShowCustomTileModal] = useState(false);
  const [editingCustomTile, setEditingCustomTile] = useState<CustomTile | undefined>(undefined);
  const [showHiddenTilesPanel, setShowHiddenTilesPanel] = useState(false);
  const [isCalendarOpen, setIsCalendarOpen] = useState(false);

  // Hide confirmation dialog state
  const [hideConfirm, setHideConfirm] = useState<{
    tileName: ActivityName;
    displayName: string;
  } | null>(null);

  // Undo delete state
  const [deletedTile, setDeletedTile] = useState<{
    tile: CustomTile;
    orderIndex: number;
    wasHidden: boolean;
    color?: string;
  } | null>(null);
  const [undoTimeoutId, setUndoTimeoutId] = useState<ReturnType<typeof setTimeout> | null>(null);

  // Badge unlock modal state
  const [newBadges, setNewBadges] = useState<Badge[]>([]);
  const [showBadgeUnlockModal, setShowBadgeUnlockModal] = useState(false);

  // Story viewer state
  const [storyViewerState, setStoryViewerState] = useState<StoryViewerState>({
    isOpen: false,
    photos: [],
    startIndex: 0,
    ownerUsername: '',
    ownerProfilePic: undefined,
    isOwnStory: false,
    handlers: undefined,
  });

  // ============================================================================
  // Effects
  // ============================================================================

  // Reset target user photos when date changes (for other user's profile)
  useEffect(() => {
    if (isReadOnly) {
      setTargetUserPhotos([]);
    }
  }, [currentDate, isReadOnly, setTargetUserPhotos]);

  // Prefetch heat map data for calendar on Dashboard load
  const { fetchMonthData, updateDay } = useCompletionStore();
  const currentYear = currentDate.getFullYear();
  const currentMonth = currentDate.getMonth();

  useEffect(() => {
    if (targetUsername) {
      fetchMonthData(targetUsername, currentYear, currentMonth);
    }
  }, [targetUsername, currentYear, currentMonth, fetchMonthData]);

  // DEV: Test confetti by running in console: window.dispatchEvent(new CustomEvent('test-badge-unlock'))
  useEffect(() => {
    const handleTestBadgeUnlock = () => {
      setNewBadges([
        {
          key: 'first_step',
          name: 'First Step',
          icon: 'Footprints',
          color: '#22c55e',
          threshold: 1,
          earned: true,
          earned_at: new Date().toISOString().split('T')[0],
        },
      ]);
      setShowBadgeUnlockModal(true);
    };
    window.addEventListener('test-badge-unlock', handleTestBadgeUnlock);
    return () => window.removeEventListener('test-badge-unlock', handleTestBadgeUnlock);
  }, []);

  // ============================================================================
  // Handlers
  // ============================================================================

  const handleActivityClick = (name: ActivityName) => {
    if (isReadOnly) return;
    if (currentDate > new Date()) return;

    setSelectedActivity(name);
    setIsModalOpen(true);
  };

  const handleSaveActivity = async (hours: number, note?: string) => {
    if (!user || !selectedActivity) return;

    try {
      const res = await api.post('/create-activity', {
        username: targetUsername,
        activity: selectedActivity,
        hours: hours,
        date: formatDateForApi(currentDate),
        note: note || null,
      });

      if (res.success) {
        const previousHours = activities[selectedActivity] || 0;
        const currentTotalHours = Object.values(activities).reduce((sum, h) => sum + h, 0);
        const newTotalHours = currentTotalHours - previousHours + hours;

        if (newTotalHours >= 24 && currentTotalHours < 24) {
          playCompletionSound();
          setToast({ message: '🎉 Day fully logged! Great job!', type: 'success' });
        } else {
          playActivitySound();
          setToast({ message: 'Activity saved successfully', type: 'success' });
        }

        setActivities((prev) => ({ ...prev, [selectedActivity]: hours }));
        setActivityNotes((prev) => {
          const newNotes = { ...prev };
          if (note) {
            newNotes[selectedActivity] = note;
          } else {
            delete newNotes[selectedActivity];
          }
          return newNotes;
        });

        if (targetUsername) {
          updateDay(targetUsername, currentDate, newTotalHours);
        }
      } else {
        throw new Error(res.error);
      }
    } catch (err) {
      console.error('[Dashboard] Failed to save activity', err);
      setToast({ message: 'Failed to save activity', type: 'error' });
      throw err;
    }
  };

  // Hide tile handlers
  const handleHideTileClick = (name: ActivityName) => {
    const config = getActivityConfig(name, customTiles, tileColors);
    setHideConfirm({ tileName: name, displayName: config.label });
  };

  const handleConfirmHide = () => {
    if (hideConfirm) {
      setHiddenTiles((prev) => {
        if (prev.includes(hideConfirm.tileName)) return prev;
        return [...prev, hideConfirm.tileName];
      });
      setHideConfirm(null);
    }
  };

  // Restore tile handler
  const handleRestoreTile = (name: ActivityName) => {
    const newHiddenTiles = hiddenTiles.filter((t) => t !== name);
    setHiddenTiles(newHiddenTiles);

    let newTileOrder = tileOrder;
    if (!tileOrder.includes(name)) {
      newTileOrder = [...tileOrder, name];
      setTileOrder(newTileOrder);
    }

    saveTileConfigToBackend(newTileOrder, tileSizes, newHiddenTiles, tileColors, customTiles);
  };

  // Custom tile handlers
  const handleSaveCustomTile = (tile: CustomTile) => {
    const existingIndex = customTiles.findIndex((t) => t.id === tile.id);
    const isNewTile = existingIndex < 0;

    const newCustomTiles = isNewTile
      ? [...customTiles, tile]
      : customTiles.map((t, i) => (i === existingIndex ? tile : t));
    setCustomTiles(newCustomTiles);

    const activityName = createCustomActivityName(tile.id);
    let newTileOrder = tileOrder;
    let newTileSizes = tileSizes;

    if (isNewTile && !tileOrder.includes(activityName)) {
      newTileOrder = [...tileOrder, activityName];
      setTileOrder(newTileOrder);

      newTileSizes = { ...tileSizes, [activityName]: 'small' as TileSize };
      setTileSizes(newTileSizes);
      saveTileSizes(newTileSizes);
    }

    if (!(activityName in activities)) {
      setActivities((prev) => ({ ...prev, [activityName]: 0 }));
    }

    saveTileConfigToBackend(newTileOrder, newTileSizes, hiddenTiles, tileColors, newCustomTiles);
    setShowCustomTileModal(false);
    setEditingCustomTile(undefined);
  };

  // Delete custom tile handlers
  const handleDeleteCustomTile = (tileId: string) => {
    const activityName = createCustomActivityName(tileId);
    const tileToDelete = customTiles.find((t) => t.id === tileId);
    if (!tileToDelete) return;

    const orderIndex = tileOrder.indexOf(activityName);
    const wasHidden = hiddenTiles.includes(activityName);
    const color = tileColors[activityName];

    if (undoTimeoutId) clearTimeout(undoTimeoutId);

    setDeletedTile({ tile: tileToDelete, orderIndex, wasHidden, color });

    const newCustomTiles = customTiles.filter((t) => t.id !== tileId);
    const newTileOrder = tileOrder.filter((t) => t !== activityName);
    const newHiddenTiles = hiddenTiles.filter((t) => t !== activityName);
    const newTileColors = { ...tileColors };
    delete newTileColors[activityName];

    setCustomTiles(newCustomTiles);
    setTileOrder(newTileOrder);
    setHiddenTiles(newHiddenTiles);
    setTileColors(newTileColors);

    saveTileConfigToBackend(newTileOrder, tileSizes, newHiddenTiles, newTileColors, newCustomTiles);

    const timeoutId = setTimeout(() => setDeletedTile(null), UNDO_TIMEOUT_DURATION);
    setUndoTimeoutId(timeoutId);
  };

  const handleUndoDelete = useCallback(() => {
    if (!deletedTile) return;

    const { tile, orderIndex, wasHidden, color } = deletedTile;
    const activityName = createCustomActivityName(tile.id);

    if (customTiles.length >= MAX_CUSTOM_TILES) {
      setDeletedTile(null);
      if (undoTimeoutId) {
        clearTimeout(undoTimeoutId);
        setUndoTimeoutId(null);
      }
      return;
    }

    const newCustomTiles = [...customTiles, tile];
    const newTileOrder = [...tileOrder];
    const insertIndex = Math.min(orderIndex, newTileOrder.length);
    newTileOrder.splice(insertIndex, 0, activityName);
    const newHiddenTiles = wasHidden ? [...hiddenTiles, activityName] : hiddenTiles;
    const newTileColors = color ? { ...tileColors, [activityName]: color } : tileColors;

    setCustomTiles(newCustomTiles);
    setTileOrder(newTileOrder);
    if (wasHidden) setHiddenTiles(newHiddenTiles);
    if (color) setTileColors(newTileColors);

    saveTileConfigToBackend(newTileOrder, tileSizes, newHiddenTiles, newTileColors, newCustomTiles);

    if (undoTimeoutId) clearTimeout(undoTimeoutId);
    setDeletedTile(null);
    setUndoTimeoutId(null);
  }, [deletedTile, undoTimeoutId, customTiles, tileOrder, hiddenTiles, tileColors, tileSizes, saveTileConfigToBackend]);

  // Edit mode handlers with undo cleanup
  const cancelEditMode = () => {
    if (undoTimeoutId) {
      clearTimeout(undoTimeoutId);
      setUndoTimeoutId(null);
    }
    setDeletedTile(null);
    baseCancelEditMode();
  };

  const saveEditMode = () => {
    if (undoTimeoutId) {
      clearTimeout(undoTimeoutId);
      setUndoTimeoutId(null);
    }
    setDeletedTile(null);
    baseSaveEditMode();
  };

  // Avatar click handler for story viewing
  const handleAvatarClick = () => {
    const hasStories = !isPrivateAccount && targetUserPhotos.length > 0 && targetUserPhotosOwnerId === targetUserId;
    
    if (hasStories) {
      const sortedPhotos = [...targetUserPhotos].sort((a, b) => 
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      );
      setStoryViewerState({
        isOpen: true,
        photos: sortedPhotos,
        startIndex: 0,
        ownerUsername: targetUsername || '',
        ownerProfilePic: targetProfilePic || undefined,
        isOwnStory: false,
        handlers: {
          onPhotoDeleted: (photoId) => {
            setTargetUserPhotos(prev => prev.filter(p => p.id !== photoId));
          },
          onPhotosViewed: () => {},
        },
      });
    } else if (targetProfilePic) {
      setShowTargetFullscreenPic(true);
    }
  };

  // Pull-to-refresh handler - refreshes all dashboard data
  const handlePullToRefresh = useCallback(async () => {
    try {
      // Refresh all data sources in parallel
      await Promise.all([
        // 1. Activities and likes
        fetchActivities(),
        // 2. Heat map / calendar data
        targetUsername ? fetchMonthData(targetUsername, currentYear, currentMonth) : Promise.resolve(),
      ]);
      
      // 3. Increment refreshKey to force StoryCirclesRow to re-fetch photos/stories
      setRefreshKey(prev => prev + 1);
    } catch (error) {
      console.error('[Dashboard] Pull-to-refresh failed:', error);
      setToast({ message: 'Failed to refresh. Please try again.', type: 'error' });
    }
  }, [fetchActivities, fetchMonthData, targetUsername, currentYear, currentMonth]);

  // Disable pull-to-refresh during drag-and-drop, edit mode, or any overlay/modal
  const isPullToRefreshDisabled =
    !!activeDragId ||
    isEditMode ||
    storyViewerState.isOpen ||
    isModalOpen ||
    showBadgeUnlockModal ||
    showCustomTileModal ||
    showHiddenTilesPanel ||
    showTargetFullscreenPic ||
    isCalendarOpen ||
    !!hideConfirm;

  // ============================================================================
  // Render
  // ============================================================================

  return (
    <PullToRefreshWrapper
      onRefresh={handlePullToRefresh}
      disabled={isPullToRefreshDisabled}
    >
    <div className="container" style={{ paddingBottom: '2rem' }}>
      {/* User Profile Header (when viewing other's profile) */}
      {isReadOnly && (
        <UserProfileHeader
          targetUsername={targetUsername || ''}
          targetUserId={targetUserId}
          targetProfilePic={targetProfilePic}
          targetBio={targetBio}
          targetIsVerified={targetIsVerified}
          targetIsPrivate={targetIsPrivate}
          targetLastLoggedAt={targetLastLoggedAt}
          isPrivateAccount={isPrivateAccount}
          targetUserPhotos={targetUserPhotos}
          targetUserPhotosOwnerId={targetUserPhotosOwnerId}
          onAvatarClick={handleAvatarClick}
          onAnalyticsClick={() => targetUsername && navigate(APP_ROUTES.USER_ANALYTICS(targetUsername))}
        />
      )}

      {/* Day Summary Card - hidden during edit mode with animation */}
      {!isPrivateAccount && (
        <div
          style={{
            overflow: 'hidden',
            transition: 'all 0.35s cubic-bezier(0.4, 0, 0.2, 1)',
            maxHeight: isEditMode ? '0px' : '200px',
            opacity: isEditMode ? 0 : 1,
            transform: isEditMode ? 'translateY(-10px) scale(0.98)' : 'translateY(0) scale(1)',
            marginBottom: isEditMode ? '0px' : undefined,
          }}
        >
          <DaySummaryCard
            username={targetUsername || ''}
            currentDate={currentDate}
            onPrev={handlePrevDay}
            onNext={handleNextDay}
            onDateChange={handleDateChange}
            isNextDisabled={isNextDisabled()}
            activities={activities}
            loading={loading}
            onNewBadges={(badges) => {
              setNewBadges(badges);
              setShowBadgeUnlockModal(true);
            }}
            onCalendarOpenChange={setIsCalendarOpen}
          />
        </div>
      )}

      {/* Story Circles Row */}
      {!isEditMode && targetUserId && !isPrivateAccount && (
        <StoryCirclesRow
          key={`stories-${refreshKey}`}
          currentDate={currentDate}
          targetUserId={targetUserId}
          targetUsername={targetUsername || ''}
          isOwnProfile={!isReadOnly}
          activities={tileOrder}
          customTiles={customTiles}
          colorOverrides={tileColors}
          isEditMode={isEditMode}
          onPhotoClick={(photos, startIndex, ownerUsername, ownerProfilePic, isOwn, handlers) => {
            setStoryViewerState({
              isOpen: true,
              photos,
              startIndex,
              ownerUsername,
              ownerProfilePic,
              isOwnStory: isOwn || false,
              handlers,
            });
          }}
          onTargetUserPhotos={isReadOnly ? (photos) => {
            setTargetUserPhotos(photos);
            setTargetUserPhotosOwnerId(targetUserId);
          } : undefined}
        />
      )}

      {/* Edit Mode Toolbar */}
      {!isReadOnly && isEditMode && (
        <EditModeToolbar
          hiddenTilesCount={hiddenTiles.length}
          onManageTiles={() => setShowHiddenTilesPanel(true)}
          onCancel={cancelEditMode}
          onSave={saveEditMode}
        />
      )}

      {/* Main Content */}
      {loading || configLoading ? (
        <LoadingSkeleton />
      ) : isPrivateAccount ? (
        <PrivateAccountView
          targetUsername={targetUsername || ''}
          badges={privateAccountBadges}
        />
      ) : (
        <TileGrid
          visibleTiles={visibleTiles}
          activities={activities}
          activityNotes={activityNotes}
          customTiles={customTiles}
          tileColors={tileColors}
          tileSizes={tileSizes}
          isEditMode={isEditMode}
          isReadOnly={isReadOnly}
          selectedTile={selectedTile}
          activeDragId={activeDragId}
          tilesAnimating={tilesAnimating}
          animationDirection={animationDirection}
          sensors={sensors}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onActivityClick={handleActivityClick}
          onTileResize={handleTileResize}
          onSelectTile={setSelectedTile}
          onHideTile={handleHideTileClick}
          onEditCustomTile={(tile) => {
            setEditingCustomTile(tile);
            setShowCustomTileModal(true);
          }}
          onAddCustomTile={() => setShowCustomTileModal(true)}
        />
      )}

      {/* Modals */}
      <ActivityModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onSave={handleSaveActivity}
        activityName={selectedActivity}
        currentHours={selectedActivity ? activities[selectedActivity] || 0 : 0}
        currentNote={selectedActivity ? activityNotes[selectedActivity] : undefined}
        customTiles={customTiles}
      />

      <BadgeUnlockModal
        badges={newBadges}
        isOpen={showBadgeUnlockModal}
        onClose={() => {
          setShowBadgeUnlockModal(false);
          setNewBadges([]);
        }}
      />

      <CreateCustomTileModal
        isOpen={showCustomTileModal}
        onClose={() => {
          setShowCustomTileModal(false);
          setEditingCustomTile(undefined);
        }}
        onSave={handleSaveCustomTile}
        existingTile={editingCustomTile}
        currentTileCount={customTiles.length}
        existingTiles={customTiles}
      />

      <HiddenTilesPanel
        isOpen={showHiddenTilesPanel}
        onClose={() => setShowHiddenTilesPanel(false)}
        hiddenTiles={hiddenTiles}
        customTiles={customTiles}
        tileOrder={tileOrder}
        colorOverrides={tileColors}
        onRestoreTile={handleRestoreTile}
        onDeleteCustomTile={handleDeleteCustomTile}
        onEditCustomTile={(tile) => {
          setEditingCustomTile(tile);
          setShowCustomTileModal(true);
          setShowHiddenTilesPanel(false);
        }}
      />

      {/* Dialogs & Toasts */}
      {hideConfirm && (
        <HideConfirmDialog
          displayName={hideConfirm.displayName}
          onConfirm={handleConfirmHide}
          onCancel={() => setHideConfirm(null)}
        />
      )}

      {deletedTile && (
        <UndoDeleteToast
          tileName={deletedTile.tile.name}
          onUndo={handleUndoDelete}
          onDismiss={() => {
            if (undoTimeoutId) clearTimeout(undoTimeoutId);
            setDeletedTile(null);
          }}
        />
      )}

      {toast && (
        <SnapToast message={toast.message} type={toast.type} onClose={() => setToast(null)} />
      )}

      {/* Fullscreen Profile Picture */}
      {showTargetFullscreenPic && targetProfilePic && (
        <FullscreenProfilePic
          profilePic={targetProfilePic}
          username={targetUsername || ''}
          onClose={() => setShowTargetFullscreenPic(false)}
        />
      )}

      {/* Story Viewer */}
      {storyViewerState.isOpen && (
        <StoryViewer
          isOpen={storyViewerState.isOpen}
          photos={storyViewerState.photos}
          startIndex={storyViewerState.startIndex}
          ownerUsername={storyViewerState.ownerUsername}
          ownerProfilePic={storyViewerState.ownerProfilePic}
          isOwnStory={storyViewerState.isOwnStory}
          onClose={() => setStoryViewerState({
            isOpen: false,
            photos: [],
            startIndex: 0,
            ownerUsername: '',
            ownerProfilePic: undefined,
            isOwnStory: false,
            handlers: undefined,
          })}
          onPhotoDeleted={(photoId) => {
            storyViewerState.handlers?.onPhotoDeleted(photoId);
          }}
          onPhotosViewed={(photoIds) => {
            storyViewerState.handlers?.onPhotosViewed(photoIds);
          }}
        />
      )}
    </div>
    </PullToRefreshWrapper>
  );
};
