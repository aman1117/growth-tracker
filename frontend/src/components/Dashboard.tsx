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
import { useParams } from 'react-router-dom';
import { playActivitySound, playCompletionSound } from '../utils/sounds';
import {
    Moon, BookOpen, Utensils, Users, Sparkles,
    Dumbbell, Film, Home, Coffee, Palette,
    Plane, ShoppingBag, Sofa, Gamepad2, Briefcase
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
    const [currentDate, setCurrentDate] = useState(new Date());
    const [activities, setActivities] = useState<Record<string, number>>({});
    const [loading, setLoading] = useState(true);
    const [configLoading, setConfigLoading] = useState(!hasLocalConfig());
    const [tileOrder, setTileOrder] = useState<ActivityName[]>(loadTileOrder);
    const [tileSizes, setTileSizes] = useState<Record<ActivityName, TileSize>>(loadTileSizes);
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
                const activityMap: Record<string, number> = {};
                // Initialize all activities with 0
                ACTIVITY_NAMES.forEach(name => {
                    activityMap[name] = 0;
                });

                // Update with actual data from backend
                res.data.forEach((a: Activity) => {
                    activityMap[a.name] = a.hours;
                });
                setActivities(activityMap);
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

    // Fetch tile config from backend if not in localStorage
    useEffect(() => {
        const fetchTileConfig = async () => {
            // If localStorage already has config, no need to fetch
            if (hasLocalConfig()) {
                setConfigLoading(false);
                return;
            }

            try {
                const res = await api.get('/tile-config');
                if (res.success && res.data) {
                    const { order, sizes } = res.data;
                    
                    // Validate and apply order
                    if (order && Array.isArray(order) && 
                        order.length === ACTIVITY_NAMES.length &&
                        ACTIVITY_NAMES.every((name: ActivityName) => order.includes(name))) {
                        setTileOrder(order);
                        saveTileOrder(order);
                    }
                    
                    // Apply sizes
                    if (sizes && typeof sizes === 'object') {
                        setTileSizes(sizes);
                        saveTileSizes(sizes);
                    }
                }
            } catch (err) {
                console.error('Failed to fetch tile config from backend', err);
                // Use defaults - already loaded
            } finally {
                setConfigLoading(false);
            }
        };

        fetchTileConfig();
    }, []);

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
        const newDate = new Date(currentDate);
        newDate.setDate(newDate.getDate() - 1);
        setCurrentDate(newDate);
    };

    const handleNextDay = () => {
        const newDate = new Date(currentDate);
        newDate.setDate(newDate.getDate() + 1);
        setCurrentDate(newDate);
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

    const handleSaveActivity = async (hours: number) => {
        if (!user || !selectedActivity) return;

        try {
            const res = await api.post('/create-activity', {
                username: targetUsername,
                activity: selectedActivity,
                hours: hours,
                date: formatDateForApi(currentDate)
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
                    backgroundColor: 'var(--bg-secondary)',
                    padding: '1rem',
                    marginBottom: '1rem',
                    borderRadius: '8px',
                    textAlign: 'center',
                    border: '1px solid var(--border)',
                    fontWeight: 600,
                    color: 'var(--text-primary)'
                }}>
                    Viewing {targetUsername}'s Dashboard
                </div>
            )}

            <DaySummaryCard
                username={targetUsername || ''}
                currentDate={currentDate}
                onPrev={handlePrevDay}
                onNext={handleNextDay}
                isNextDisabled={isNextDisabled()}
                activities={activities}
                loading={loading}
            />

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
                }}>
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
                                fontWeight: 500,
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
                                backgroundColor: 'var(--accent)',
                                color: 'var(--text-primary)',
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
                    padding: '8px',
                    backgroundColor: 'var(--bg-primary)'
                }}>
                    {Array.from({ length: 8 }).map((_, i) => (
                        <div
                            key={i}
                            className="skeleton"
                            style={{
                                gridColumn: i < 2 ? 'span 2' : 'span 1',
                                gridRow: i === 0 ? 'span 2' : 'span 1',
                                width: '100%',
                                height: '100%',
                                borderRadius: '4px',
                            }}
                        />
                    ))}
                </div>
            ) : (
                <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    onDragStart={handleDragStart}
                    onDragEnd={handleDragEnd}
                >
                    <SortableContext items={tileOrder} strategy={rectSortingStrategy}>
                        <div 
                            style={{
                                display: 'grid',
                                gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
                                gridAutoRows: '100px',
                                gap: '8px',
                                padding: '8px',
                                backgroundColor: 'var(--bg-primary)',
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
            )}

            <ActivityModal
                isOpen={isModalOpen}
                onClose={() => setIsModalOpen(false)}
                onSave={handleSaveActivity}
                activityName={selectedActivity}
                currentHours={selectedActivity ? (activities[selectedActivity] || 0) : 0}
            />

            {toast && (
                <Toast
                    message={toast.message}
                    type={toast.type}
                    onClose={() => setToast(null)}
                />
            )}
        </div>
    );
};
