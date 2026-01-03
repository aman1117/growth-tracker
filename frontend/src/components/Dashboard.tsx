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
import { useAuth } from '../context/AuthContext';
import { api } from '../utils/api';
import { ACTIVITY_NAMES } from '../types';
import type { ActivityName, Activity } from '../types';
import { DaySummaryCard } from './DaySummaryCard';
import { ActivityTile } from './ActivityTile';
import type { TileSize } from './ActivityTile';
import { ActivityModal } from './ActivityModal';
import { Toast } from './Toast';
import { useParams, useNavigate } from 'react-router-dom';
import { playActivitySound, playCompletionSound } from '../utils/sounds';
import {
    Moon, BookOpen, Utensils, Users, Sparkles,
    Dumbbell, Film, Home, Coffee, Palette,
    Plane, ShoppingBag, Sofa, Gamepad2, Briefcase,
    Lock, X, BarChart3
} from 'lucide-react';

// Activity Configuration Map
const ACTIVITY_CONFIG: Record<ActivityName, { icon: any, color: string }> = {
    sleep: { icon: Moon, color: '#6366f1' }, // Indigo
    study: { icon: BookOpen, color: '#3b82f6' }, // Blue
    book_reading: { icon: BookOpen, color: '#0ea5e9' }, // Sky
    eating: { icon: Utensils, color: '#f59e0b' }, // Amber
    friends: { icon: Users, color: '#ec4899' }, // Pink
    grooming: { icon: Sparkles, color: '#8b5cf6' }, // Violet
    workout: { icon: Dumbbell, color: '#ef4444' }, // Red
    reels: { icon: Film, color: '#f43f5e' }, // Rose
    family: { icon: Home, color: '#10b981' }, // Emerald
    idle: { icon: Coffee, color: '#64748b' }, // Slate
    creative: { icon: Palette, color: '#d946ef' }, // Fuchsia
    travelling: { icon: Plane, color: '#06b6d4' }, // Cyan
    errand: { icon: ShoppingBag, color: '#f97316' }, // Orange
    rest: { icon: Sofa, color: '#84cc16' }, // Lime
    entertainment: { icon: Gamepad2, color: '#a855f7' }, // Purple
    office: { icon: Briefcase, color: '#0f766e' }, // Teal
};

const STORAGE_KEY = 'growth-tracker-tile-order';
const SIZE_STORAGE_KEY = 'growth-tracker-tile-sizes';

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

export const Dashboard: React.FC = () => {
    const { user } = useAuth();
    const { username: routeUsername } = useParams<{ username: string }>();
    const navigate = useNavigate();
    const [currentDate, setCurrentDate] = useState(new Date());
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
    
    // Store original values when entering edit mode (for cancel)
    const [originalTileOrder, setOriginalTileOrder] = useState<ActivityName[]>([]);
    const [originalTileSizes, setOriginalTileSizes] = useState<Record<ActivityName, TileSize>>({} as Record<ActivityName, TileSize>);

    // Determine if we are viewing another user's profile
    const targetUsername = routeUsername || user?.username;
    const isReadOnly = routeUsername && routeUsername !== user?.username;

    // Modal State
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [selectedActivity, setSelectedActivity] = useState<ActivityName | null>(null);

    // Toast State
    const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

    // Private account state (when viewing someone else's private profile)
    const [isPrivateAccount, setIsPrivateAccount] = useState(false);

    // Target user's profile pic and bio (when viewing another user's dashboard)
    const [targetProfilePic, setTargetProfilePic] = useState<string | null>(null);
    const [targetBio, setTargetBio] = useState<string | null>(null);
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
                const oldIndex = items.indexOf(active.id as ActivityName);
                const newIndex = items.indexOf(over.id as ActivityName);
                const newOrder = arrayMove(items, oldIndex, newIndex);
                saveTileOrder(newOrder);
                return newOrder;
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

    const fetchActivities = useCallback(async () => {
        if (!targetUsername) return;
        setLoading(true);
        try {
            const dateStr = formatDateForApi(currentDate);
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
            } else if (res.error_code === 'ACCOUNT_PRIVATE') {
                setIsPrivateAccount(true);
            }
        } catch (err) {
            console.error('Failed to fetch activities', err);
            setToast({ message: 'Failed to load activities', type: 'error' });
        } finally {
            setLoading(false);
        }
    }, [currentDate, targetUsername]);

    useEffect(() => {
        fetchActivities();
    }, [fetchActivities]);

    // Fetch target user's profile pic and bio when viewing another user's dashboard
    useEffect(() => {
        const fetchTargetUserProfile = async () => {
            if (isReadOnly && targetUsername) {
                // Reset state when switching users
                setTargetProfilePic(null);
                setTargetBio(null);
                
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
                        }
                    }
                } catch (err) {
                    console.error('Failed to fetch target user profile', err);
                }
            }
        };
        fetchTargetUserProfile();
    }, [isReadOnly, targetUsername]);

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
                    const { order, sizes } = res.data;
                    
                    // Validate and apply order
                    if (order && Array.isArray(order) && 
                        order.length === ACTIVITY_NAMES.length &&
                        ACTIVITY_NAMES.every((name: ActivityName) => order.includes(name))) {
                        setTileOrder(order);
                        if (!isReadOnly) saveTileOrder(order);
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
                    // No config - use defaults
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

    // Save tile config to backend
    const saveTileConfigToBackend = async (order: ActivityName[], sizes: Record<ActivityName, TileSize>) => {
        try {
            await api.post('/tile-config', {
                config: { order, sizes }
            });
        } catch (err) {
            console.error('Failed to save tile config to backend', err);
        }
    };

    // Listen for edit mode toggle from nav bar
    useEffect(() => {
        const handleToggleEditMode = () => {
            if (!isReadOnly) {
                if (!isEditMode) {
                    setOriginalTileOrder([...tileOrder]);
                    setOriginalTileSizes({...tileSizes});
                }
                setIsEditMode(prev => !prev);
                setSelectedTile(null);
            }
        };
        
        window.addEventListener('toggleEditMode', handleToggleEditMode);
        return () => window.removeEventListener('toggleEditMode', handleToggleEditMode);
    }, [isEditMode, isReadOnly, tileOrder, tileSizes]);

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

    return (
        <div className="container" style={{ paddingBottom: '2rem' }}>
            {isReadOnly && (
                <div style={{
                    background: 'var(--tile-glass-bg)',
                    backdropFilter: 'blur(var(--tile-glass-blur))',
                    WebkitBackdropFilter: 'blur(var(--tile-glass-blur))',
                    padding: '0.875rem 1rem',
                    marginBottom: '1rem',
                    borderRadius: '20px',
                    border: '1px solid var(--tile-glass-border)',
                    boxShadow: 'var(--tile-glass-shadow), var(--tile-glass-inner-glow)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.75rem'
                }}>
                    <div 
                        onClick={() => targetProfilePic && setShowTargetFullscreenPic(true)}
                        style={{
                            width: '40px',
                            height: '40px',
                            borderRadius: '50%',
                            backgroundColor: 'var(--avatar-bg)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontWeight: 700,
                            fontSize: '1rem',
                            color: 'var(--text-primary)',
                            textTransform: 'uppercase',
                            overflow: 'hidden',
                            flexShrink: 0,
                            cursor: targetProfilePic ? 'zoom-in' : 'default',
                            border: '2px solid var(--border)'
                        }}>
                        {targetProfilePic ? (
                            <img
                                src={targetProfilePic}
                                alt={targetUsername}
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
                    <div style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ 
                            display: 'block', 
                            fontWeight: 600,
                            fontSize: '0.9rem',
                            color: 'var(--text-primary)'
                        }}>
                            @{targetUsername}
                        </span>
                        {targetBio && (
                            <span style={{
                                display: 'block',
                                fontSize: '0.8rem',
                                color: 'var(--text-secondary)',
                                marginTop: '0.125rem',
                                lineHeight: 1.4,
                                wordBreak: 'break-word'
                            }}>
                                {targetBio}
                            </span>
                        )}
                    </div>
                    {/* Analytics button */}
                    <button
                        onClick={() => navigate(`/analytics?user=${targetUsername}`)}
                        style={{
                            padding: '0.5rem',
                            backgroundColor: 'transparent',
                            color: 'var(--text-secondary)',
                            border: '1px solid var(--border)',
                            borderRadius: '8px',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            transition: 'all 0.2s ease',
                            flexShrink: 0
                        }}
                        onMouseEnter={(e) => {
                            e.currentTarget.style.backgroundColor = 'var(--accent)';
                            e.currentTarget.style.borderColor = 'var(--accent)';
                            e.currentTarget.style.color = 'white';
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.style.backgroundColor = 'transparent';
                            e.currentTarget.style.borderColor = 'var(--border)';
                            e.currentTarget.style.color = 'var(--text-secondary)';
                        }}
                        title="View Analytics"
                    >
                        <BarChart3 size={16} />
                    </button>
                </div>
            )}

            {!isPrivateAccount && (
                <DaySummaryCard
                    username={targetUsername || ''}
                    currentDate={currentDate}
                    onPrev={handlePrevDay}
                    onNext={handleNextDay}
                    isNextDisabled={isNextDisabled()}
                    activities={activities}
                    loading={loading}
                />
            )}

            {/* Edit Mode Bar - only show when in edit mode */}
            {!isReadOnly && isEditMode && (
                <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '0.5rem 0.75rem',
                    backgroundColor: 'var(--bg-secondary)',
                    borderRadius: '8px',
                    marginBottom: '0.5rem',
                    border: '1px solid var(--border)',
                    animation: 'editBarSlideIn 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)',
                    transformOrigin: 'top center',
                }}>
                    <style>{`
                        @keyframes editBarSlideIn {
                            0% {
                                opacity: 0;
                                transform: translateY(-10px) scale(0.95);
                            }
                            100% {
                                opacity: 1;
                                transform: translateY(0) scale(1);
                            }
                        }
                    `}</style>
                    <span style={{
                        fontSize: '0.7rem',
                        color: 'var(--text-secondary)',
                    }}>
                        Tap to resize • Drag to reorder
                    </span>
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                        <button
                            onClick={() => {
                                setTileOrder(originalTileOrder);
                                setTileSizes(originalTileSizes);
                                saveTileOrder(originalTileOrder);
                                saveTileSizes(originalTileSizes);
                                setIsEditMode(false);
                                setSelectedTile(null);
                            }}
                            style={{
                                padding: '0.35rem 0.75rem',
                                backgroundColor: 'transparent',
                                color: 'var(--text-secondary)',
                                border: '1px solid var(--border)',
                                borderRadius: '4px',
                                cursor: 'pointer',
                                fontSize: '0.75rem',
                                fontWeight: 400,
                            }}
                        >
                            Cancel
                        </button>
                        <button
                            onClick={() => {
                                // Save to backend when clicking Done
                                saveTileConfigToBackend(tileOrder, tileSizes);
                                setIsEditMode(false);
                                setSelectedTile(null);
                            }}
                            style={{
                                padding: '0.35rem 0.75rem',
                                backgroundColor: '#0095f6',
                                color: '#ffffff',
                                border: 'none',
                                borderRadius: '4px',
                                cursor: 'pointer',
                                fontSize: '0.75rem',
                                fontWeight: 500,
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
                    padding: '48px 24px',
                    textAlign: 'center',
                    backgroundColor: 'var(--bg-primary)',
                    minHeight: '300px',
                }}>
                    <div style={{
                        width: '80px',
                        height: '80px',
                        borderRadius: '50%',
                        border: '2px solid var(--border)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        marginBottom: '16px',
                    }}>
                        <Lock size={32} style={{ color: 'var(--text-secondary)' }} />
                    </div>
                    <h3 style={{
                        margin: '0 0 8px 0',
                        fontSize: '1.1rem',
                        fontWeight: 600,
                        color: 'var(--text-primary)',
                    }}>
                        This Account is Private
                    </h3>
                    <p style={{
                        margin: 0,
                        fontSize: '0.9rem',
                        color: 'var(--text-secondary)',
                    }}>
                        @{targetUsername}'s activity data is not visible to others.
                    </p>
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
                        <SortableContext items={tileOrder} strategy={rectSortingStrategy}>
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
                            {tileOrder.map((name) => {
                                const config = ACTIVITY_CONFIG[name] || { icon: Sparkles, color: '#000' };
                                return (
                                    <ActivityTile
                                        key={name}
                                        name={name}
                                        hours={activities[name] || 0}
                                        onClick={() => handleActivityClick(name)}
                                        icon={config.icon}
                                        color={config.color}
                                        isDraggable={isEditMode && !isReadOnly}
                                        size={tileSizes[name]}
                                        onResize={handleTileResize}
                                        isSelected={selectedTile === name}
                                        onSelect={setSelectedTile}
                                        isOtherSelected={selectedTile !== null && selectedTile !== name}
                                        isDragging={activeDragId === name}
                                        hasNote={!isReadOnly && !!activityNotes[name]}
                                    />
                                );
                            })}
                        </div>
                    </SortableContext>
                    <DragOverlay>
                        {activeDragId ? (
                            <div
                                style={{
                                    backgroundColor: ACTIVITY_CONFIG[activeDragId]?.color || 'var(--bg-tertiary)',
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
                        ) : null}
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
            />

            {toast && (
                <Toast
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
                    <img
                        src={targetProfilePic}
                        alt={targetUsername || ''}
                        onClick={(e) => e.stopPropagation()}
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
                        @{targetUsername}
                    </div>
                </div>
            )}
        </div>
    );
};
