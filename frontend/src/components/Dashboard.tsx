import React, { useState, useEffect, useCallback } from 'react';
import {
    DndContext,
    closestCenter,
    KeyboardSensor,
    PointerSensor,
    TouchSensor,
    useSensor,
    useSensors,
    DragOverlay,
} from '@dnd-kit/core';
import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core';
import {
    arrayMove,
    SortableContext,
    sortableKeyboardCoordinates,
    rectSortingStrategy,
} from '@dnd-kit/sortable';
import { useAuth, useFollowStore } from '../store';
import { api, ApiError } from '../services/api';
import { ACTIVITY_NAMES, isCustomTile, MAX_CUSTOM_TILES } from '../types';
import type { ActivityName, Activity, CustomTile, PredefinedActivityName } from '../types';
import type { Badge } from '../types/api';
import { STORAGE_KEYS, getActivityConfig, createCustomActivityName } from '../constants';
import { DaySummaryCard } from './DaySummaryCard';
import { ActivityTile } from './ActivityTile';
import type { TileSize } from './ActivityTile';
import { ActivityModal } from './ActivityModal';
import { BadgeUnlockModal } from './BadgeUnlockModal';
import { CreateCustomTileModal } from './CreateCustomTileModal';
import { HiddenTilesPanel } from './HiddenTilesPanel';
import { SnapToast, ProtectedImage, VerifiedBadge } from './ui';
import { FollowButton, FollowStats, MutualFollowers } from './social';
import { APP_ROUTES } from '../constants/routes';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { playActivitySound, playCompletionSound } from '../utils/sounds';
import { renderBadgeIcon } from '../utils/badgeIcons';
import { Lock, X, BarChart3, Plus, EyeOff, GripVertical, Undo2 } from 'lucide-react';

const STORAGE_KEY = STORAGE_KEYS.TILE_ORDER;
const SIZE_STORAGE_KEY = STORAGE_KEYS.TILE_SIZES;
const HIDDEN_STORAGE_KEY = STORAGE_KEYS.TILE_HIDDEN;
const COLORS_STORAGE_KEY = STORAGE_KEYS.TILE_COLORS;
const CUSTOM_TILES_STORAGE_KEY = STORAGE_KEYS.CUSTOM_TILES;

// Default tile configuration
const getDefaultTileSizes = (): Record<ActivityName, TileSize> => {
    const defaults: Partial<Record<ActivityName, TileSize>> = {
        sleep: 'medium',
        study: 'wide',
        eating: 'wide',
    };
    return ACTIVITY_NAMES.reduce((acc, name) => {
        acc[name] = defaults[name] || 'small';
        return acc;
    }, {} as Record<ActivityName, TileSize>);
};

// Check if localStorage has valid config
const hasLocalConfig = (): boolean => {
    try {
        const order = localStorage.getItem(STORAGE_KEY);
        const sizes = localStorage.getItem(SIZE_STORAGE_KEY);
        return !!(order && sizes);
    } catch {
        return false;
    }
};

// Load saved order from localStorage
const loadTileOrder = (): ActivityName[] => {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) {
            const parsed = JSON.parse(saved);
            // Validate that all activities are present
            if (parsed.length === ACTIVITY_NAMES.length && 
                ACTIVITY_NAMES.every((name: ActivityName) => parsed.includes(name))) {
                return parsed;
            }
        }
    } catch (e) {
        console.error('Failed to load tile order', e);
    }
    return [...ACTIVITY_NAMES];
};

// Save order to localStorage
const saveTileOrder = (order: ActivityName[]) => {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(order));
    } catch (e) {
        console.error('Failed to save tile order', e);
    }
};

// Load saved tile sizes from localStorage
const loadTileSizes = (): Record<ActivityName, TileSize> => {
    try {
        const saved = localStorage.getItem(SIZE_STORAGE_KEY);
        if (saved) {
            return JSON.parse(saved);
        }
    } catch (e) {
        console.error('Failed to load tile sizes', e);
    }
    return getDefaultTileSizes();
};

// Save tile sizes to localStorage
const saveTileSizes = (sizes: Record<ActivityName, TileSize>) => {
    try {
        localStorage.setItem(SIZE_STORAGE_KEY, JSON.stringify(sizes));
    } catch (e) {
        console.error('Failed to save tile sizes', e);
    }
};

/**
 * Parse date from URL search params
 * @param searchParams - URL search params
 * @returns Date object or null if invalid/not present
 */
const getDateFromSearchParams = (searchParams: URLSearchParams): Date | null => {
    const dateParam = searchParams.get('date');
    if (!dateParam) return null;
    
    // Parse YYYY-MM-DD format
    const parsed = new Date(dateParam + 'T00:00:00');
    if (isNaN(parsed.getTime())) return null;
    
    // Don't allow future dates
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (parsed > today) return null;
    
    return parsed;
};

export const Dashboard: React.FC = () => {
    const { user } = useAuth();
    const { username: routeUsername } = useParams<{ username: string }>();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    
    // Initialize date from URL param or default to today
    const [currentDate, setCurrentDate] = useState(() => {
        return getDateFromSearchParams(searchParams) || new Date();
    });
    
    // Sync date state when URL search params change (e.g., from notification click)
    useEffect(() => {
        const urlDate = getDateFromSearchParams(searchParams);
        if (urlDate) {
            const currentNorm = new Date(currentDate);
            currentNorm.setHours(0, 0, 0, 0);
            urlDate.setHours(0, 0, 0, 0);
            
            // Only update if the dates are different
            if (currentNorm.getTime() !== urlDate.getTime()) {
                setCurrentDate(urlDate);
            }
        }
    }, [searchParams]);
    const [activities, setActivities] = useState<Record<string, number>>({});
    const [activityNotes, setActivityNotes] = useState<Record<string, string>>({});
    const [loading, setLoading] = useState(true);
    // Always show loading for other users, or check localStorage for own profile
    const isViewingOther = routeUsername && routeUsername !== user?.username;
    const [configLoading, setConfigLoading] = useState(isViewingOther ? true : !hasLocalConfig());
    const [tileOrder, setTileOrder] = useState<ActivityName[]>(isViewingOther ? [...ACTIVITY_NAMES] : loadTileOrder);
    const [tileSizes, setTileSizes] = useState<Record<ActivityName, TileSize>>(isViewingOther ? getDefaultTileSizes() : loadTileSizes);
    const [isEditMode, setIsEditMode] = useState(false);
    const [selectedTile, setSelectedTile] = useState<ActivityName | null>(null);
    const [activeDragId, setActiveDragId] = useState<ActivityName | null>(null);
    
    // Custom tiles state
    const [customTiles, setCustomTiles] = useState<CustomTile[]>([]);
    const [hiddenTiles, setHiddenTiles] = useState<ActivityName[]>([]);
    const [tileColors, setTileColors] = useState<Record<string, string>>({});
    
    // Custom tile modal state
    const [showCustomTileModal, setShowCustomTileModal] = useState(false);
    const [editingCustomTile, setEditingCustomTile] = useState<CustomTile | undefined>(undefined);
    const [showHiddenTilesPanel, setShowHiddenTilesPanel] = useState(false);
    
    // Hide confirmation dialog state
    const [hideConfirm, setHideConfirm] = useState<{ tileName: ActivityName; displayName: string } | null>(null);
    
    // Undo delete state - stores recently deleted tile for recovery
    const [deletedTile, setDeletedTile] = useState<{
        tile: CustomTile;
        orderIndex: number;
        wasHidden: boolean;
        color?: string;
    } | null>(null);
    const [undoTimeoutId, setUndoTimeoutId] = useState<ReturnType<typeof setTimeout> | null>(null);
    
    // Store original values when entering edit mode (for cancel)
    const [originalTileOrder, setOriginalTileOrder] = useState<ActivityName[]>([]);
    const [originalTileSizes, setOriginalTileSizes] = useState<Record<ActivityName, TileSize>>({} as Record<ActivityName, TileSize>);
    const [originalHiddenTiles, setOriginalHiddenTiles] = useState<ActivityName[]>([]);
    const [originalCustomTiles, setOriginalCustomTiles] = useState<CustomTile[]>([]);

    // Determine if we are viewing another user's profile
    const targetUsername = routeUsername || user?.username;
    const isReadOnly = routeUsername && routeUsername !== user?.username;

    // Modal State
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [selectedActivity, setSelectedActivity] = useState<ActivityName | null>(null);

    // Toast State
    const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

    // Badge unlock modal state
    const [newBadges, setNewBadges] = useState<Badge[]>([]);
    const [showBadgeUnlockModal, setShowBadgeUnlockModal] = useState(false);

    // DEV: Test confetti by running in console: window.dispatchEvent(new CustomEvent('test-badge-unlock'))
    useEffect(() => {
        const handleTestBadgeUnlock = () => {
            setNewBadges([{
                key: 'first_step',
                name: 'First Step',
                icon: 'Footprints',
                color: '#22c55e',
                threshold: 1,
                earned: true,
                earned_at: new Date().toISOString().split('T')[0],
            }]);
            setShowBadgeUnlockModal(true);
        };
        window.addEventListener('test-badge-unlock', handleTestBadgeUnlock);
        return () => window.removeEventListener('test-badge-unlock', handleTestBadgeUnlock);
    }, []);

    // Private account state (when viewing someone else's private profile)
    const [isPrivateAccount, setIsPrivateAccount] = useState(false);
    const [privateAccountBadges, setPrivateAccountBadges] = useState<Badge[]>([]);

    // Target user's profile pic and bio (when viewing another user's dashboard)
    const [targetProfilePic, setTargetProfilePic] = useState<string | null>(null);
    const [targetBio, setTargetBio] = useState<string | null>(null);
    const [targetIsVerified, setTargetIsVerified] = useState<boolean>(false);
    const [targetUserId, setTargetUserId] = useState<number | null>(null);
    const [targetIsPrivate, setTargetIsPrivate] = useState<boolean>(false);
    const [showTargetFullscreenPic, setShowTargetFullscreenPic] = useState(false);

    // Tile animation state for day transitions
    const [tilesAnimating, setTilesAnimating] = useState(false);
    const [animationDirection, setAnimationDirection] = useState<'left' | 'right'>('left');

    // DnD Sensors
    const sensors = useSensors(
        useSensor(PointerSensor, {
            activationConstraint: {
                distance: 8,
            },
        }),
        useSensor(TouchSensor, {
            activationConstraint: {
                delay: 200,
                tolerance: 5,
            },
        }),
        useSensor(KeyboardSensor, {
            coordinateGetter: sortableKeyboardCoordinates,
        })
    );

    const handleDragStart = (event: DragStartEvent) => {
        setActiveDragId(event.active.id as ActivityName);
    };

    const handleDragEnd = (event: DragEndEvent) => {
        const { active, over } = event;
        setActiveDragId(null);

        if (over && active.id !== over.id) {
            setTileOrder((items) => {
                // Find indices in the full tileOrder
                const oldIndex = items.indexOf(active.id as ActivityName);
                const newIndex = items.indexOf(over.id as ActivityName);
                
                // If both items exist, reorder them
                if (oldIndex !== -1 && newIndex !== -1) {
                    const newOrder = arrayMove(items, oldIndex, newIndex);
                    saveTileOrder(newOrder);
                    return newOrder;
                }
                return items;
            });
        }
    };

    const handleTileResize = (name: ActivityName, size: TileSize) => {
        setTileSizes((prev) => {
            const newSizes = { ...prev, [name]: size };
            saveTileSizes(newSizes);
            return newSizes;
        });
    };

    const formatDateForApi = (date: Date) => {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    };

    // Cache key for offline data
    const getCacheKey = (username: string, date: string) => `dashboard_${username}_${date}`;

    // Fetch badges for private accounts (badges are always public)
    const fetchBadgesForPrivateAccount = async (username: string) => {
        try {
            const res = await api.post('/badges/user', { username });
            if (res.success && res.badges) {
                setPrivateAccountBadges(res.badges);
            }
        } catch (error) {
            console.error('Failed to fetch badges for private account:', error);
        }
    };

    // Save activities to localStorage for offline access
    const cacheActivities = (username: string, date: string, activities: Record<string, number>, notes: Record<string, string>) => {
        try {
            const cacheKey = getCacheKey(username, date);
            localStorage.setItem(cacheKey, JSON.stringify({ activities, notes, timestamp: Date.now() }));
        } catch (e) {
            // localStorage might be full or unavailable
            console.warn('Failed to cache activities:', e);
        }
    };

    // Load cached activities from localStorage
    const loadCachedActivities = (username: string, date: string) => {
        try {
            const cacheKey = getCacheKey(username, date);
            const cached = localStorage.getItem(cacheKey);
            if (cached) {
                const data = JSON.parse(cached);
                // Cache valid for 24 hours
                if (Date.now() - data.timestamp < 24 * 60 * 60 * 1000) {
                    return data;
                }
            }
        } catch (e) {
            console.warn('Failed to load cached activities:', e);
        }
        return null;
    };

    const fetchActivities = useCallback(async () => {
        if (!targetUsername) return;
        setLoading(true);
        const dateStr = formatDateForApi(currentDate);
        
        try {
            const res = await api.post('/get-activities', {
                username: targetUsername,
                start_date: dateStr,
                end_date: dateStr
            });

            if (res.success) {
                setIsPrivateAccount(false);
                const activityMap: Record<string, number> = {};
                const notesMap: Record<string, string> = {};
                // Initialize all activities with 0
                ACTIVITY_NAMES.forEach(name => {
                    activityMap[name] = 0;
                });

                // Update with actual data from backend
                res.data.forEach((a: Activity) => {
                    activityMap[a.name] = a.hours;
                    if (a.note) {
                        notesMap[a.name] = a.note;
                    }
                });
                setActivities(activityMap);
                setActivityNotes(notesMap);
                
                // Cache for offline access (only cache own data)
                if (!isReadOnly) {
                    cacheActivities(targetUsername, dateStr, activityMap, notesMap);
                }
            } else if (res.error_code === 'ACCOUNT_PRIVATE') {
                setIsPrivateAccount(true);
                // Fetch badges for private accounts (badges are always public)
                fetchBadgesForPrivateAccount(targetUsername);
            }
        } catch (err: unknown) {
            // Check if it's a private account error
            if (err instanceof ApiError && err.errorCode === 'ACCOUNT_PRIVATE') {
                setIsPrivateAccount(true);
                // Fetch badges for private accounts (badges are always public)
                fetchBadgesForPrivateAccount(targetUsername);
            } else {
                console.error('Failed to fetch activities', err);
                
                // Try to load from cache when offline
                const cached = loadCachedActivities(targetUsername, dateStr);
                if (cached) {
                    setActivities(cached.activities);
                    setActivityNotes(cached.notes);
                } else {
                    setToast({ message: 'Failed to load activities', type: 'error' });
                }
            }
        } finally {
            setLoading(false);
        }
    }, [currentDate, targetUsername, isReadOnly]);

    useEffect(() => {
        fetchActivities();
    }, [fetchActivities]);

    // Listen for follow-accepted events to refresh profile data
    useEffect(() => {
        const handleFollowAccepted = (event: CustomEvent<{ actorId: number; actorUsername: string }>) => {
            // If we're viewing the profile of the user who accepted our request, refresh
            if (isReadOnly && targetUsername?.toLowerCase() === event.detail.actorUsername?.toLowerCase()) {
                console.log('[Dashboard] Follow accepted, refreshing profile data');
                setIsPrivateAccount(false);
                fetchActivities();
            }
        };
        
        window.addEventListener('follow-accepted', handleFollowAccepted as EventListener);
        return () => window.removeEventListener('follow-accepted', handleFollowAccepted as EventListener);
    }, [isReadOnly, targetUsername, fetchActivities]);

    // Get lookupRelationships from follow store
    const { lookupRelationships } = useFollowStore();

    // Fetch target user's profile pic and bio when viewing another user's dashboard
    useEffect(() => {
        const fetchTargetUserProfile = async () => {
            if (isReadOnly && targetUsername) {
                // Reset state when switching users
                setTargetProfilePic(null);
                setTargetBio(null);
                setTargetIsVerified(false);
                setTargetUserId(null);
                setTargetIsPrivate(false);
                
                try {
                    const res = await api.post('/users', { username: targetUsername });
                    if (res.success && res.data && res.data.length > 0) {
                        const exactMatch = res.data.find((u: { username: string }) => 
                            u.username.toLowerCase() === targetUsername.toLowerCase()
                        );
                        if (exactMatch) {
                            setTargetProfilePic(exactMatch.profile_pic || null);
                            // Bio is only returned for public profiles (backend handles privacy)
                            setTargetBio(exactMatch.bio || null);
                            setTargetIsVerified(exactMatch.is_verified || false);
                            setTargetUserId(exactMatch.id || null);
                            setTargetIsPrivate(exactMatch.is_private || false);
                            
                            // Lookup relationship state to get pending status
                            if (exactMatch.id) {
                                await lookupRelationships([exactMatch.id]);
                            }
                        }
                    }
                } catch (err) {
                    console.error('Failed to fetch target user profile', err);
                }
            }
        };
        fetchTargetUserProfile();
    }, [isReadOnly, targetUsername, lookupRelationships]);

    // Fetch tile config from backend - always fetch
    useEffect(() => {
        const fetchTileConfig = async () => {
            setConfigLoading(true);
            
            try {
                // Fetch config based on whose profile we're viewing
                const res = isReadOnly && targetUsername
                    ? await api.post('/tile-config/user', { username: targetUsername })
                    : await api.get('/tile-config');
                    
                if (res.success && res.data) {
                    const { order, sizes, hidden, colors, customTiles: customTilesData } = res.data;
                    
                    // Load custom tiles first (needed for order validation)
                    if (customTilesData && Array.isArray(customTilesData)) {
                        setCustomTiles(customTilesData);
                        if (!isReadOnly) {
                            localStorage.setItem(CUSTOM_TILES_STORAGE_KEY, JSON.stringify(customTilesData));
                        }
                    }
                    
                    // Load hidden tiles
                    if (hidden && Array.isArray(hidden)) {
                        setHiddenTiles(hidden);
                        if (!isReadOnly) {
                            localStorage.setItem(HIDDEN_STORAGE_KEY, JSON.stringify(hidden));
                        }
                    }
                    
                    // Load color overrides
                    if (colors && typeof colors === 'object') {
                        setTileColors(colors);
                        if (!isReadOnly) {
                            localStorage.setItem(COLORS_STORAGE_KEY, JSON.stringify(colors));
                        }
                    }
                    
                    // Validate and apply order (including custom tiles)
                    if (order && Array.isArray(order)) {
                        // For validation, check predefined activities + custom tiles
                        const validOrder = order.filter((name: string) => 
                            ACTIVITY_NAMES.includes(name as PredefinedActivityName) || 
                            isCustomTile(name)
                        );
                        setTileOrder(validOrder as ActivityName[]);
                        if (!isReadOnly) saveTileOrder(validOrder as ActivityName[]);
                    } else {
                        setTileOrder([...ACTIVITY_NAMES]);
                    }
                    
                    // Apply sizes
                    if (sizes && typeof sizes === 'object') {
                        setTileSizes(sizes);
                        if (!isReadOnly) saveTileSizes(sizes);
                    } else {
                        setTileSizes(getDefaultTileSizes());
                    }
                } else {
                    // No config - use defaults, but try localStorage first
                    if (!isReadOnly) {
                        try {
                            const localHidden = localStorage.getItem(HIDDEN_STORAGE_KEY);
                            const localColors = localStorage.getItem(COLORS_STORAGE_KEY);
                            const localCustomTiles = localStorage.getItem(CUSTOM_TILES_STORAGE_KEY);
                            
                            if (localHidden) setHiddenTiles(JSON.parse(localHidden));
                            if (localColors) setTileColors(JSON.parse(localColors));
                            if (localCustomTiles) setCustomTiles(JSON.parse(localCustomTiles));
                        } catch (e) {
                            console.error('Failed to load from localStorage', e);
                        }
                    }
                    
                    setTileOrder([...ACTIVITY_NAMES]);
                    setTileSizes(getDefaultTileSizes());
                }
            } catch (err) {
                console.error('Failed to fetch tile config', err);
                setTileOrder([...ACTIVITY_NAMES]);
                setTileSizes(getDefaultTileSizes());
            } finally {
                setConfigLoading(false);
            }
        };

        fetchTileConfig();
    }, [isReadOnly, targetUsername]);

    // Save tile config to backend (includes custom tiles, hidden, colors)
    const saveTileConfigToBackend = useCallback(async (
        order: ActivityName[], 
        sizes: Record<ActivityName, TileSize>,
        hidden: ActivityName[],
        colors: Record<string, string>,
        customTilesList: CustomTile[]
    ) => {
        try {
            await api.post('/tile-config', {
                config: { 
                    order, 
                    sizes,
                    hidden: hidden.length > 0 ? hidden : undefined,
                    colors: Object.keys(colors).length > 0 ? colors : undefined,
                    customTiles: customTilesList.length > 0 ? customTilesList : undefined,
                }
            });
            
            // Also save to localStorage for quick loading
            localStorage.setItem(HIDDEN_STORAGE_KEY, JSON.stringify(hidden));
            localStorage.setItem(COLORS_STORAGE_KEY, JSON.stringify(colors));
            localStorage.setItem(CUSTOM_TILES_STORAGE_KEY, JSON.stringify(customTilesList));
        } catch (err) {
            console.error('Failed to save tile config to backend', err);
        }
    }, []);

    // Listen for edit mode toggle from nav bar
    useEffect(() => {
        const handleToggleEditMode = () => {
            if (!isReadOnly) {
                if (!isEditMode) {
                    setOriginalTileOrder([...tileOrder]);
                    setOriginalTileSizes({...tileSizes});
                    setOriginalHiddenTiles([...hiddenTiles]);
                    setOriginalCustomTiles([...customTiles]);
                }
                setIsEditMode(prev => !prev);
                setSelectedTile(null);
            }
        };
        
        window.addEventListener('toggleEditMode', handleToggleEditMode);
        return () => window.removeEventListener('toggleEditMode', handleToggleEditMode);
    }, [isEditMode, isReadOnly, tileOrder, tileSizes, hiddenTiles, customTiles]);

    const handlePrevDay = () => {
        setAnimationDirection('right');
        setTilesAnimating(true);
        setTimeout(() => {
            const newDate = new Date(currentDate);
            newDate.setDate(newDate.getDate() - 1);
            setCurrentDate(newDate);
            setTimeout(() => setTilesAnimating(false), 50);
        }, 150);
    };

    const handleNextDay = () => {
        setAnimationDirection('left');
        setTilesAnimating(true);
        setTimeout(() => {
            const newDate = new Date(currentDate);
            newDate.setDate(newDate.getDate() + 1);
            setCurrentDate(newDate);
            setTimeout(() => setTilesAnimating(false), 50);
        }, 150);
    };

    const handleDateChange = (newDate: Date) => {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const targetDate = new Date(newDate);
        targetDate.setHours(0, 0, 0, 0);
        const currentDateNorm = new Date(currentDate);
        currentDateNorm.setHours(0, 0, 0, 0);

        // Determine animation direction based on date comparison
        if (targetDate < currentDateNorm) {
            setAnimationDirection('right');
        } else if (targetDate > currentDateNorm) {
            setAnimationDirection('left');
        }

        setTilesAnimating(true);
        setTimeout(() => {
            setCurrentDate(newDate);
            setTimeout(() => setTilesAnimating(false), 50);
        }, 150);
    };

    const isNextDisabled = () => {
        const today = new Date();
        return currentDate.toDateString() === today.toDateString() || currentDate > today;
    };

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
                // Calculate new total hours
                const previousHours = activities[selectedActivity] || 0;
                const currentTotalHours = Object.values(activities).reduce((sum, h) => sum + h, 0);
                const newTotalHours = currentTotalHours - previousHours + hours;
                
                // Play appropriate sound
                if (newTotalHours >= 24 && currentTotalHours < 24) {
                    // Just completed 24 hours!
                    playCompletionSound();
                    setToast({ message: '🎉 Day fully logged! Great job!', type: 'success' });
                } else {
                    // Regular activity update
                    playActivitySound();
                    setToast({ message: 'Activity saved successfully', type: 'success' });
                }
                
                setActivities(prev => ({
                    ...prev,
                    [selectedActivity]: hours
                }));
                
                // Update notes
                setActivityNotes(prev => {
                    const newNotes = { ...prev };
                    if (note) {
                        newNotes[selectedActivity] = note;
                    } else {
                        delete newNotes[selectedActivity];
                    }
                    return newNotes;
                });
            } else {
                throw new Error(res.error);
            }
        } catch (err) {
            console.error(err);
            setToast({ message: 'Failed to save activity', type: 'error' });
            throw err;
        }
    };

    // Hide a tile (soft delete) - shows confirmation first
    const handleHideTileClick = (name: ActivityName) => {
        const config = getActivityConfig(name, customTiles, tileColors);
        setHideConfirm({ tileName: name, displayName: config.label });
    };

    const handleConfirmHide = () => {
        if (hideConfirm) {
            setHiddenTiles(prev => {
                if (prev.includes(hideConfirm.tileName)) return prev;
                return [...prev, hideConfirm.tileName];
            });
            setHideConfirm(null);
        }
    };

    const handleCancelHide = () => {
        setHideConfirm(null);
    };

    // Restore a hidden tile (adds to end of grid)
    const handleRestoreTile = (name: ActivityName) => {
        const newHiddenTiles = hiddenTiles.filter(t => t !== name);
        setHiddenTiles(newHiddenTiles);
        
        // If it's not in the tile order (custom tile case), add to end
        let newTileOrder = tileOrder;
        if (!tileOrder.includes(name)) {
            newTileOrder = [...tileOrder, name];
            setTileOrder(newTileOrder);
        }
        
        // Save to backend immediately to persist the change
        saveTileConfigToBackend(newTileOrder, tileSizes, newHiddenTiles, tileColors, customTiles);
    };

    // Save a new or edited custom tile
    const handleSaveCustomTile = (tile: CustomTile) => {
        setCustomTiles(prev => {
            const existingIndex = prev.findIndex(t => t.id === tile.id);
            if (existingIndex >= 0) {
                // Editing existing tile
                const updated = [...prev];
                updated[existingIndex] = tile;
                return updated;
            } else {
                // New tile
                return [...prev, tile];
            }
        });

        // Create activity name for tile
        const activityName = createCustomActivityName(tile.id);
        
        // If new tile, add to tile order
        if (!tileOrder.includes(activityName)) {
            setTileOrder(prev => [...prev, activityName]);
        }
        
        // Initialize activity data for the custom tile (if not exists)
        if (!(activityName in activities)) {
            setActivities(prev => ({
                ...prev,
                [activityName]: 0
            }));
        }
        
        setShowCustomTileModal(false);
        setEditingCustomTile(undefined);
    };

    // Delete a custom tile with undo support
    const handleDeleteCustomTile = (tileId: string) => {
        const activityName = createCustomActivityName(tileId);
        const tileToDelete = customTiles.find(t => t.id === tileId);
        
        if (!tileToDelete) return;
        
        // Store tile info for potential undo
        const orderIndex = tileOrder.indexOf(activityName);
        const wasHidden = hiddenTiles.includes(activityName);
        const color = tileColors[activityName];
        
        // Clear any existing undo timeout
        if (undoTimeoutId) {
            clearTimeout(undoTimeoutId);
        }
        
        // Store deleted tile for undo
        setDeletedTile({
            tile: tileToDelete,
            orderIndex,
            wasHidden,
            color,
        });
        
        // Calculate new state values
        const newCustomTiles = customTiles.filter(t => t.id !== tileId);
        const newTileOrder = tileOrder.filter(t => t !== activityName);
        const newHiddenTiles = hiddenTiles.filter(t => t !== activityName);
        const newTileColors = { ...tileColors };
        delete newTileColors[activityName];
        
        // Update local state
        setCustomTiles(newCustomTiles);
        setTileOrder(newTileOrder);
        setHiddenTiles(newHiddenTiles);
        setTileColors(newTileColors);
        
        // Save to backend immediately to persist the deletion
        saveTileConfigToBackend(newTileOrder, tileSizes, newHiddenTiles, newTileColors, newCustomTiles);
        
        // Set timeout to clear undo option after 8 seconds
        const timeoutId = setTimeout(() => {
            setDeletedTile(null);
        }, 8000);
        setUndoTimeoutId(timeoutId);
    };
    
    // Undo delete - restore the deleted tile
    const handleUndoDelete = useCallback(() => {
        if (!deletedTile) return;
        
        const { tile, orderIndex, wasHidden, color } = deletedTile;
        const activityName = createCustomActivityName(tile.id);
        
        // Check if we're at the limit (user may have created a new tile after delete)
        if (customTiles.length >= MAX_CUSTOM_TILES) {
            // Can't restore - show toast or silently fail
            setDeletedTile(null);
            if (undoTimeoutId) {
                clearTimeout(undoTimeoutId);
                setUndoTimeoutId(null);
            }
            return;
        }
        
        // Calculate new state values
        const newCustomTiles = [...customTiles, tile];
        const newTileOrder = [...tileOrder];
        const insertIndex = Math.min(orderIndex, newTileOrder.length);
        newTileOrder.splice(insertIndex, 0, activityName);
        const newHiddenTiles = wasHidden ? [...hiddenTiles, activityName] : hiddenTiles;
        const newTileColors = color ? { ...tileColors, [activityName]: color } : tileColors;
        
        // Update local state
        setCustomTiles(newCustomTiles);
        setTileOrder(newTileOrder);
        if (wasHidden) {
            setHiddenTiles(newHiddenTiles);
        }
        if (color) {
            setTileColors(newTileColors);
        }
        
        // Save to backend immediately to persist the restore
        saveTileConfigToBackend(newTileOrder, tileSizes, newHiddenTiles, newTileColors, newCustomTiles);
        
        // Clear undo state
        if (undoTimeoutId) {
            clearTimeout(undoTimeoutId);
        }
        setDeletedTile(null);
        setUndoTimeoutId(null);
    }, [deletedTile, undoTimeoutId, customTiles, tileOrder, hiddenTiles, tileColors, tileSizes, saveTileConfigToBackend]);

    // Get visible tiles (filtering out hidden ones)
    const visibleTiles = tileOrder.filter(name => !hiddenTiles.includes(name));

    return (
        <div className="container" style={{ paddingBottom: '2rem' }}>
            {isReadOnly && (
                <div style={{
                    background: 'var(--tile-glass-bg)',
                    backdropFilter: 'blur(var(--tile-glass-blur))',
                    WebkitBackdropFilter: 'blur(var(--tile-glass-blur))',
                    padding: '1rem',
                    marginBottom: '1rem',
                    borderRadius: '20px',
                    border: '1px solid var(--tile-glass-border)',
                    boxShadow: 'var(--tile-glass-shadow), var(--tile-glass-inner-glow)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.75rem'
                }}>
                    {/* Row 1: Avatar + Stats */}
                    <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '1rem'
                    }}>
                        <div 
                            onClick={() => targetProfilePic && setShowTargetFullscreenPic(true)}
                            style={{
                                width: '72px',
                                height: '72px',
                                borderRadius: '50%',
                                backgroundColor: 'var(--avatar-bg)',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                fontWeight: 700,
                                fontSize: '1.5rem',
                                color: 'var(--text-primary)',
                                textTransform: 'uppercase',
                                overflow: 'hidden',
                                flexShrink: 0,
                                cursor: targetProfilePic ? 'zoom-in' : 'default',
                                border: '2px solid var(--border)'
                            }}>
                            {targetProfilePic ? (
                                <ProtectedImage
                                    src={targetProfilePic}
                                    alt={targetUsername || ''}
                                    style={{
                                        width: '100%',
                                        height: '100%',
                                        objectFit: 'cover'
                                    }}
                                />
                            ) : (
                                targetUsername?.charAt(0)
                            )}
                        </div>
                        {/* Stats next to avatar */}
                        <div style={{ flex: 1 }}>
                            {targetUserId && (
                                <FollowStats
                                    userId={targetUserId}
                                    username={targetUsername || ''}
                                    isPrivate={targetIsPrivate}
                                    canView={!isPrivateAccount}
                                />
                            )}
                        </div>
                    </div>

                    {/* Row 2: Username + Bio */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                        <span style={{ 
                            display: 'flex', 
                            alignItems: 'center',
                            gap: '0.25rem',
                            fontWeight: 600,
                            fontSize: '0.875rem',
                            color: 'var(--text-primary)'
                        }}>
                            {targetUsername}
                            {targetIsVerified && <VerifiedBadge size={14} />}
                        </span>
                        {!isPrivateAccount && targetBio && (
                            <span style={{
                                fontSize: '0.875rem',
                                color: 'var(--text-primary)',
                                lineHeight: 1.4,
                                wordBreak: 'break-word'
                            }}>
                                {targetBio}
                            </span>
                        )}
                        {/* Mutual Followers - "Followed by X, Y and N others" */}
                        {targetUserId && (
                            <MutualFollowers
                                userId={targetUserId}
                                username={targetUsername || ''}
                            />
                        )}
                    </div>

                    {/* Row 3: Follow Button + Analytics */}
                    <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.5rem'
                    }}>
                        {targetUserId && (
                            <div style={{ flex: 1 }}>
                                <FollowButton
                                    userId={targetUserId}
                                    username={targetUsername || ''}
                                    isPrivate={targetIsPrivate}
                                    size="md"
                                    fullWidth
                                />
                            </div>
                        )}
                        {!isPrivateAccount && (
                            <button
                                onClick={() => targetUsername && navigate(APP_ROUTES.USER_ANALYTICS(targetUsername))}
                                className="secondary-button"
                                style={{
                                    padding: '0 0.875rem',
                                    borderRadius: '8px',
                                    cursor: 'pointer',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    flexShrink: 0,
                                    height: '32px',
                                    minWidth: '40px'
                                }}
                                title="View Analytics"
                            >
                                <BarChart3 size={16} />
                            </button>
                        )}
                    </div>
                </div>
            )}

            {/* Day Summary Card - hidden during edit mode with animation */}
            {!isPrivateAccount && (
                <div style={{
                    overflow: 'hidden',
                    transition: 'all 0.35s cubic-bezier(0.4, 0, 0.2, 1)',
                    maxHeight: isEditMode ? '0px' : '200px',
                    opacity: isEditMode ? 0 : 1,
                    transform: isEditMode ? 'translateY(-10px) scale(0.98)' : 'translateY(0) scale(1)',
                    marginBottom: isEditMode ? '0px' : undefined,
                }}>
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
                    />
                </div>
            )}

            {/* Edit Mode Bar - sticky at top when in edit mode */}
            {!isReadOnly && isEditMode && (
                <div style={{
                    position: 'sticky',
                    top: '16px',
                    display: 'flex',
                    alignItems: 'stretch',
                    justifyContent: 'space-between',
                    padding: '14px 16px',
                    background: 'var(--glass-bg)',
                    backdropFilter: 'blur(20px)',
                    WebkitBackdropFilter: 'blur(20px)',
                    borderRadius: '12px',
                    marginBottom: '12px',
                    border: '1px solid var(--border)',
                    boxShadow: '0 4px 20px rgba(0, 0, 0, 0.15)',
                    animation: 'editBarSlideIn 0.25s ease-out',
                    gap: '16px',
                    zIndex: 50,
                }}>
                    <style>{`
                        @keyframes editBarSlideIn {
                            from { opacity: 0; transform: translateY(-8px); }
                            to { opacity: 1; transform: translateY(0); }
                        }
                    `}</style>
                    
                    {/* Left: Instructions stacked vertically */}
                    <div style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '8px',
                        justifyContent: 'center',
                    }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                            <GripVertical size={14} style={{ color: '#0095f6' }} />
                            <span>Drag to reorder</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                            <span style={{ width: '14px', textAlign: 'center', color: '#0095f6' }}>↔</span>
                            <span>Tap to resize</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                            <span style={{ width: '14px', textAlign: 'center', color: '#ef4444', fontWeight: 600 }}>✕</span>
                            <span>Tap X to hide</span>
                        </div>
                    </div>

                    {/* Right: Buttons stacked vertically */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', flexShrink: 0 }}>
                        {hiddenTiles.length > 0 && (
                            <button
                                onClick={() => setShowHiddenTilesPanel(true)}
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    gap: '6px',
                                    padding: '8px 16px',
                                    background: 'rgba(251, 191, 36, 0.15)',
                                    color: '#fbbf24',
                                    border: '1px solid rgba(251, 191, 36, 0.3)',
                                    borderRadius: '8px',
                                    cursor: 'pointer',
                                    fontSize: '0.85rem',
                                    fontWeight: 500,
                                }}
                            >
                                <EyeOff size={14} />
                                {hiddenTiles.length} Hidden
                            </button>
                        )}
                        <button
                            onClick={() => {
                                // Clear undo state if pending
                                if (undoTimeoutId) {
                                    clearTimeout(undoTimeoutId);
                                    setUndoTimeoutId(null);
                                }
                                setDeletedTile(null);
                                
                                // Restore original state
                                setTileOrder(originalTileOrder);
                                setTileSizes(originalTileSizes);
                                setHiddenTiles(originalHiddenTiles);
                                setCustomTiles(originalCustomTiles);
                                saveTileOrder(originalTileOrder);
                                saveTileSizes(originalTileSizes);
                                setIsEditMode(false);
                                setSelectedTile(null);
                            }}
                            style={{
                                padding: '8px 20px',
                                backgroundColor: 'var(--bg-secondary)',
                                color: 'var(--text-primary)',
                                border: '1px solid var(--border)',
                                borderRadius: '8px',
                                cursor: 'pointer',
                                fontSize: '0.85rem',
                                fontWeight: 500,
                            }}
                        >
                            Cancel
                        </button>
                        <button
                            onClick={() => {
                                // Clear undo state - deletion is now final
                                if (undoTimeoutId) {
                                    clearTimeout(undoTimeoutId);
                                    setUndoTimeoutId(null);
                                }
                                setDeletedTile(null);
                                
                                saveTileConfigToBackend(tileOrder, tileSizes, hiddenTiles, tileColors, customTiles);
                                setIsEditMode(false);
                                setSelectedTile(null);
                            }}
                            style={{
                                padding: '8px 20px',
                                background: 'linear-gradient(135deg, #0095f6 0%, #0077cc 100%)',
                                color: '#ffffff',
                                border: 'none',
                                borderRadius: '8px',
                                cursor: 'pointer',
                                fontSize: '0.85rem',
                                fontWeight: 600,
                                boxShadow: '0 2px 8px rgba(0, 149, 246, 0.3)',
                            }}
                        >
                            Done
                        </button>
                    </div>
                </div>
            )}

            {(loading || configLoading) ? (
                <div style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
                    gridAutoRows: '100px',
                    gap: '8px',
                    padding: '8px'
                }}>
                    {Array.from({ length: 8 }).map((_, i) => (
                        <div
                            key={i}
                            className="skeleton-glass"
                            style={{
                                gridColumn: i < 2 ? 'span 2' : 'span 1',
                                gridRow: i === 0 ? 'span 2' : 'span 1',
                                width: '100%',
                                height: '100%',
                                borderRadius: '24px',
                                background: 'var(--tile-glass-bg)',
                                backdropFilter: 'blur(var(--tile-glass-blur))',
                                WebkitBackdropFilter: 'blur(var(--tile-glass-blur))',
                                border: '1px solid var(--tile-glass-border)',
                                boxShadow: 'var(--tile-glass-shadow), var(--tile-glass-inner-glow)',
                            }}
                        />
                    ))}
                </div>
            ) : isPrivateAccount ? (
                <div style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: '32px 24px',
                    textAlign: 'center',
                    margin: '8px',
                    background: 'var(--tile-glass-bg)',
                    backdropFilter: 'blur(var(--tile-glass-blur))',
                    WebkitBackdropFilter: 'blur(var(--tile-glass-blur))',
                    borderRadius: '24px',
                    border: '1px solid var(--tile-glass-border)',
                    boxShadow: 'var(--tile-glass-shadow), var(--tile-glass-inner-glow)',
                }}>
                    <div style={{
                        width: '56px',
                        height: '56px',
                        borderRadius: '50%',
                        background: 'linear-gradient(135deg, rgba(255,255,255,0.1) 0%, rgba(255,255,255,0.05) 100%)',
                        border: '2px solid var(--tile-glass-border)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        marginBottom: '12px',
                        boxShadow: '0 4px 16px rgba(0, 0, 0, 0.1)',
                    }}>
                        <Lock size={24} style={{ color: 'var(--text-secondary)' }} />
                    </div>
                    <h3 style={{
                        margin: '0 0 4px 0',
                        fontSize: '1rem',
                        fontWeight: 600,
                        color: 'var(--text-primary)',
                    }}>
                        Private Account
                    </h3>
                    <p style={{
                        margin: '0 0 16px 0',
                        fontSize: '0.8rem',
                        color: 'var(--text-secondary)',
                    }}>
                        @{targetUsername}'s activity is hidden
                    </p>
                    
                    {/* Show badges (always public) */}
                    {privateAccountBadges.filter(b => b.earned).length > 0 && (
                        <div style={{
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            gap: '8px',
                            paddingTop: '16px',
                            borderTop: '1px solid var(--tile-glass-border)',
                            width: '100%',
                        }}>
                            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                Badges earned
                            </span>
                            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'center' }}>
                                {privateAccountBadges.filter(b => b.earned).map((badge) => (
                                    <div
                                        key={badge.key}
                                        title={`${badge.name} - ${badge.threshold} day streak`}
                                        style={{
                                            width: '36px',
                                            height: '36px',
                                            borderRadius: '10px',
                                            background: `color-mix(in srgb, ${badge.color} 15%, var(--bg-secondary))`,
                                            border: `1px solid ${badge.color}40`,
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                        }}
                                    >
                                        {renderBadgeIcon(badge.icon, badge.color, 20)}
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            ) : (
                <>
                    <style>{`
                        @keyframes slideOutLeft {
                            from { opacity: 1; transform: translateX(0); }
                            to { opacity: 0; transform: translateX(-20px); }
                        }
                        @keyframes slideOutRight {
                            from { opacity: 1; transform: translateX(0); }
                            to { opacity: 0; transform: translateX(20px); }
                        }
                        @keyframes slideInLeft {
                            from { opacity: 0; transform: translateX(20px); }
                            to { opacity: 1; transform: translateX(0); }
                        }
                        @keyframes slideInRight {
                            from { opacity: 0; transform: translateX(-20px); }
                            to { opacity: 1; transform: translateX(0); }
                        }
                        .tiles-slide-out-left {
                            animation: slideOutLeft 0.15s ease-out forwards;
                        }
                        .tiles-slide-out-right {
                            animation: slideOutRight 0.15s ease-out forwards;
                        }
                        .tiles-slide-in-left {
                            animation: slideInLeft 0.25s ease-out forwards;
                        }
                        .tiles-slide-in-right {
                            animation: slideInRight 0.25s ease-out forwards;
                        }
                    `}</style>
                    <DndContext
                        sensors={sensors}
                        collisionDetection={closestCenter}
                        onDragStart={handleDragStart}
                        onDragEnd={handleDragEnd}
                    >
                        <SortableContext items={visibleTiles} strategy={rectSortingStrategy}>
                            <div 
                                className={tilesAnimating 
                                    ? (animationDirection === 'left' ? 'tiles-slide-out-left' : 'tiles-slide-out-right')
                                    : (animationDirection === 'left' ? 'tiles-slide-in-left' : 'tiles-slide-in-right')
                                }
                                style={{
                                    display: 'grid',
                                gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
                                gridAutoRows: '100px',
                                gap: '8px',
                                padding: '8px',
                            }}
                            onClick={() => {
                                if (isEditMode && selectedTile) {
                                    setSelectedTile(null);
                                }
                            }}
                        >
                            {visibleTiles.map((name, index) => {
                                const config = getActivityConfig(name, customTiles, tileColors);
                                // For custom tiles, icon is a string (handled by iconName prop)
                                const iconComponent = typeof config.icon === 'string' ? undefined : config.icon;
                                // Find the custom tile object if this is a custom tile (for editing)
                                const customTile = isCustomTile(name) 
                                    ? customTiles.find(t => createCustomActivityName(t.id) === name)
                                    : undefined;
                                return (
                                    <ActivityTile
                                        key={name}
                                        name={name}
                                        hours={activities[name] || 0}
                                        onClick={() => handleActivityClick(name)}
                                        icon={iconComponent}
                                        color={config.color}
                                        isDraggable={isEditMode && !isReadOnly}
                                        size={tileSizes[name]}
                                        onResize={handleTileResize}
                                        isSelected={selectedTile === name}
                                        onSelect={setSelectedTile}
                                        isOtherSelected={selectedTile !== null && selectedTile !== name}
                                        isDragging={activeDragId === name}
                                        hasNote={!isReadOnly && !!activityNotes[name]}
                                        isEditMode={isEditMode}
                                        onHide={handleHideTileClick}
                                        onEditCustomTile={customTile ? () => {
                                            setEditingCustomTile(customTile);
                                            setShowCustomTileModal(true);
                                        } : undefined}
                                        displayLabel={config.label}
                                        tileIndex={index}
                                        iconName={config.iconName}
                                    />
                                );
                            })}
                            
                            {/* Add Custom Tile Button - show in edit mode when under limit */}
                            {isEditMode && !isReadOnly && customTiles.length < MAX_CUSTOM_TILES && (
                                <div
                                    onClick={() => setShowCustomTileModal(true)}
                                    style={{
                                        gridColumn: 'span 1',
                                        display: 'flex',
                                        flexDirection: 'column',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        gap: '8px',
                                        background: 'var(--tile-glass-bg)',
                                        backdropFilter: 'blur(var(--tile-glass-blur))',
                                        WebkitBackdropFilter: 'blur(var(--tile-glass-blur))',
                                        borderRadius: '24px',
                                        border: '2px dashed var(--border)',
                                        cursor: 'pointer',
                                        transition: 'all 0.2s ease',
                                    }}
                                    onMouseEnter={(e) => {
                                        e.currentTarget.style.borderColor = '#0095f6';
                                        e.currentTarget.style.background = 'rgba(0, 149, 246, 0.1)';
                                    }}
                                    onMouseLeave={(e) => {
                                        e.currentTarget.style.borderColor = 'var(--border)';
                                        e.currentTarget.style.background = 'var(--tile-glass-bg)';
                                    }}
                                >
                                    <Plus size={24} style={{ color: '#0095f6' }} />
                                    <span style={{ 
                                        fontSize: '0.65rem', 
                                        color: 'var(--text-secondary)',
                                        textAlign: 'center',
                                        padding: '0 4px'
                                    }}>
                                        Add Tile
                                    </span>
                                </div>
                            )}
                        </div>
                    </SortableContext>
                    <DragOverlay>
                        {activeDragId ? (() => {
                            const dragConfig = getActivityConfig(activeDragId, customTiles, tileColors);
                            return (
                                <div
                                    style={{
                                        backgroundColor: dragConfig.color || 'var(--bg-tertiary)',
                                        padding: '1rem',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        minWidth: tileSizes[activeDragId] === 'small' ? '100px' : '208px',
                                        minHeight: tileSizes[activeDragId] === 'medium' ? '208px' : '100px',
                                        opacity: 0.9,
                                        boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
                                        border: '3px solid var(--text-primary)',
                                        borderRadius: '8px',
                                    }}
                                >
                                    <span style={{
                                        fontSize: tileSizes[activeDragId] === 'medium' ? '1.2rem' : '0.75rem',
                                        fontWeight: 700,
                                        color: 'white',
                                        textTransform: 'uppercase',
                                        letterSpacing: '1px',
                                    }}>
                                        {tileSizes[activeDragId]}
                                    </span>
                                </div>
                            );
                        })() : null}
                    </DragOverlay>
                    </DndContext>
                </>
            )}

            <ActivityModal
                isOpen={isModalOpen}
                onClose={() => setIsModalOpen(false)}
                onSave={handleSaveActivity}
                activityName={selectedActivity}
                currentHours={selectedActivity ? (activities[selectedActivity] || 0) : 0}
                currentNote={selectedActivity ? activityNotes[selectedActivity] : undefined}
                customTiles={customTiles}
            />

            {toast && (
                <SnapToast
                    message={toast.message}
                    type={toast.type}
                    onClose={() => setToast(null)}
                />
            )}

            {/* Fullscreen Target Profile Picture */}
            {showTargetFullscreenPic && targetProfilePic && (
                <div
                    onClick={() => setShowTargetFullscreenPic(false)}
                    style={{
                        position: 'fixed',
                        top: 0,
                        left: 0,
                        right: 0,
                        bottom: 0,
                        backgroundColor: 'rgba(0, 0, 0, 0.95)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        zIndex: 10000,
                        cursor: 'zoom-out',
                        animation: 'fadeIn 0.2s ease-out'
                    }}
                >
                    <button
                        onClick={() => setShowTargetFullscreenPic(false)}
                        style={{
                            position: 'absolute',
                            top: '20px',
                            right: '20px',
                            width: '40px',
                            height: '40px',
                            borderRadius: '50%',
                            border: 'none',
                            backgroundColor: 'rgba(255, 255, 255, 0.1)',
                            color: 'white',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center'
                        }}
                    >
                        <X size={24} />
                    </button>
                    <ProtectedImage
                        src={targetProfilePic}
                        alt={targetUsername || ''}
                        style={{
                            maxWidth: '90vw',
                            maxHeight: '90vh',
                            objectFit: 'contain',
                            borderRadius: '8px',
                            cursor: 'default',
                            animation: 'scaleIn 0.2s ease-out'
                        }}
                    />
                    <div style={{
                        position: 'absolute',
                        bottom: '30px',
                        left: '50%',
                        transform: 'translateX(-50%)',
                        color: 'white',
                        fontSize: '1rem',
                        fontWeight: 500,
                        padding: '8px 16px',
                        backgroundColor: 'rgba(0, 0, 0, 0.5)',
                        borderRadius: '20px'
                    }}>
                        {targetUsername}
                    </div>
                </div>
            )}

            {/* Badge Unlock Modal */}
            <BadgeUnlockModal
                badges={newBadges}
                isOpen={showBadgeUnlockModal}
                onClose={() => {
                    setShowBadgeUnlockModal(false);
                    setNewBadges([]);
                }}
            />

            {/* Create/Edit Custom Tile Modal */}
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

            {/* Hidden Tiles Panel */}
            <HiddenTilesPanel
                isOpen={showHiddenTilesPanel}
                onClose={() => setShowHiddenTilesPanel(false)}
                hiddenTiles={hiddenTiles}
                customTiles={customTiles}
                colorOverrides={tileColors}
                onRestoreTile={handleRestoreTile}
                onDeleteCustomTile={handleDeleteCustomTile}
                onEditCustomTile={(tile) => {
                    setEditingCustomTile(tile);
                    setShowCustomTileModal(true);
                    setShowHiddenTilesPanel(false);
                }}
            />

            {/* Hide Tile Confirmation Dialog */}
            {hideConfirm && (
                <div
                    style={{
                        position: 'fixed',
                        inset: 0,
                        background: 'rgba(0, 0, 0, 0.6)',
                        backdropFilter: 'blur(4px)',
                        WebkitBackdropFilter: 'blur(4px)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        zIndex: 1000,
                        padding: '16px',
                    }}
                    onClick={handleCancelHide}
                >
                    <div
                        onClick={(e) => e.stopPropagation()}
                        style={{
                            background: 'var(--bg-primary)',
                            borderRadius: '16px',
                            padding: '24px',
                            width: '300px',
                            maxWidth: '90vw',
                            border: '1px solid var(--border)',
                            boxShadow: '0 20px 40px rgba(0, 0, 0, 0.3)',
                            animation: 'hideConfirmScaleIn 0.2s ease-out',
                        }}
                    >
                        <style>{`
                            @keyframes hideConfirmScaleIn {
                                from {
                                    opacity: 0;
                                    transform: scale(0.9);
                                }
                                to {
                                    opacity: 1;
                                    transform: scale(1);
                                }
                            }
                        `}</style>
                        <div style={{
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            textAlign: 'center',
                        }}>
                            <div style={{
                                width: '48px',
                                height: '48px',
                                borderRadius: '50%',
                                background: 'rgba(251, 191, 36, 0.15)',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                marginBottom: '16px',
                            }}>
                                <EyeOff size={24} color="#f59e0b" />
                            </div>
                            <h3 style={{
                                margin: '0 0 8px',
                                fontSize: '1rem',
                                fontWeight: 600,
                                color: 'var(--text-primary)',
                            }}>
                                Hide Tile?
                            </h3>
                            <p style={{
                                margin: '0 0 20px',
                                fontSize: '0.85rem',
                                color: 'var(--text-secondary)',
                                lineHeight: 1.4,
                            }}>
                                Hide <strong style={{ color: 'var(--text-primary)' }}>"{hideConfirm.displayName}"</strong> from your dashboard? You can restore it anytime from the hidden tiles panel.
                            </p>
                            <div style={{
                                display: 'flex',
                                gap: '12px',
                                width: '100%',
                            }}>
                                <button
                                    onClick={handleCancelHide}
                                    style={{
                                        flex: 1,
                                        padding: '12px 16px',
                                        background: 'var(--bg-secondary)',
                                        border: '1px solid var(--border)',
                                        borderRadius: '12px',
                                        color: 'var(--text-primary)',
                                        fontSize: '0.9rem',
                                        fontWeight: 600,
                                        cursor: 'pointer',
                                    }}
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handleConfirmHide}
                                    style={{
                                        flex: 1,
                                        padding: '12px 16px',
                                        background: 'linear-gradient(135deg, #0095f6 0%, #0077cc 100%)',
                                        border: 'none',
                                        borderRadius: '12px',
                                        color: 'white',
                                        fontSize: '0.9rem',
                                        fontWeight: 600,
                                        cursor: 'pointer',
                                        boxShadow: '0 2px 8px rgba(0, 149, 246, 0.3)',
                                    }}
                                >
                                    Hide
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Undo Delete Toast */}
            {deletedTile && (
                <div
                    style={{
                        position: 'fixed',
                        bottom: '24px',
                        left: '50%',
                        transform: 'translateX(-50%)',
                        zIndex: 10001,
                        animation: 'undoToastSlideUp 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)',
                    }}
                >
                    <style>{`
                        @keyframes undoToastSlideUp {
                            0% {
                                opacity: 0;
                                transform: translateX(-50%) translateY(16px) scale(0.95);
                            }
                            100% {
                                opacity: 1;
                                transform: translateX(-50%) translateY(0) scale(1);
                            }
                        }
                        @keyframes undoProgress {
                            0% { width: 100%; }
                            100% { width: 0%; }
                        }
                    `}</style>
                    <div
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '12px',
                            padding: '10px 12px 10px 20px',
                            background: 'var(--bg-secondary)',
                            backdropFilter: 'blur(16px)',
                            WebkitBackdropFilter: 'blur(16px)',
                            borderRadius: '100px',
                            border: '1px solid rgba(239, 68, 68, 0.3)',
                            boxShadow: '0 8px 32px var(--shadow-md), 0 0 20px rgba(239, 68, 68, 0.1)',
                            position: 'relative',
                            overflow: 'hidden',
                            minWidth: '300px',
                        }}
                    >
                        {/* Progress bar */}
                        <div
                            style={{
                                position: 'absolute',
                                bottom: 0,
                                left: 0,
                                height: '2px',
                                background: 'linear-gradient(90deg, #ef4444, #f97316)',
                                borderRadius: '0 0 100px 100px',
                                animation: 'undoProgress 8s linear forwards',
                            }}
                        />
                        
                        {/* Text */}
                        <span style={{
                            flex: 1,
                            fontSize: '0.875rem',
                            color: 'var(--text-primary)',
                            whiteSpace: 'nowrap',
                        }}>
                            <span style={{ color: '#ef4444' }}>Deleted</span>{' '}
                            <span style={{ fontWeight: 500 }}>{deletedTile.tile.name}</span>
                        </span>
                        
                        {/* Undo button */}
                        <button
                            onClick={handleUndoDelete}
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '5px',
                                padding: '6px 12px',
                                background: 'rgba(239, 68, 68, 0.15)',
                                border: '1px solid rgba(239, 68, 68, 0.3)',
                                borderRadius: '100px',
                                color: '#ef4444',
                                fontSize: '0.8rem',
                                fontWeight: 600,
                                cursor: 'pointer',
                                transition: 'all 0.15s ease',
                                flexShrink: 0,
                            }}
                            onMouseEnter={(e) => {
                                e.currentTarget.style.background = 'rgba(239, 68, 68, 0.25)';
                                e.currentTarget.style.borderColor = 'rgba(239, 68, 68, 0.5)';
                            }}
                            onMouseLeave={(e) => {
                                e.currentTarget.style.background = 'rgba(239, 68, 68, 0.15)';
                                e.currentTarget.style.borderColor = 'rgba(239, 68, 68, 0.3)';
                            }}
                        >
                            <Undo2 size={14} />
                            Undo
                        </button>
                        
                        {/* Dismiss button */}
                        <button
                            onClick={() => {
                                if (undoTimeoutId) clearTimeout(undoTimeoutId);
                                setDeletedTile(null);
                            }}
                            style={{
                                padding: '6px',
                                background: 'transparent',
                                border: 'none',
                                borderRadius: '50%',
                                color: 'var(--text-secondary)',
                                cursor: 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                transition: 'color 0.15s ease',
                                flexShrink: 0,
                            }}
                            onMouseEnter={(e) => {
                                e.currentTarget.style.color = 'var(--text-primary)';
                            }}
                            onMouseLeave={(e) => {
                                e.currentTarget.style.color = 'var(--text-secondary)';
                            }}
                        >
                            <X size={16} />
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
};
