import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { api } from '../utils/api';
import { ACTIVITY_NAMES } from '../types';
import type { ActivityName, Activity } from '../types';
import { DateNavigator } from './DateNavigator';
import { ActivityTile } from './ActivityTile';
import { ActivityModal } from './ActivityModal';
import { Toast } from './Toast';
import { useParams } from 'react-router-dom';
import {
    Moon, BookOpen, Utensils, Users, Sparkles,
    Dumbbell, Film, Home, Coffee, Palette,
    Plane, ShoppingBag, Sofa, Gamepad2
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
};

export const Dashboard: React.FC = () => {
    const { user } = useAuth();
    const { username: routeUsername } = useParams<{ username: string }>();
    const [currentDate, setCurrentDate] = useState(new Date());
    const [activities, setActivities] = useState<Record<string, number>>({});
    const [loading, setLoading] = useState(true);

    // Determine if we are viewing another user's profile
    const targetUsername = routeUsername || user?.username;
    const isReadOnly = routeUsername && routeUsername !== user?.username;

    // Modal State
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [selectedActivity, setSelectedActivity] = useState<ActivityName | null>(null);

    // Toast State
    const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

    const formatDateForApi = (date: Date) => {
        return date.toISOString().split('T')[0];
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
                setToast({ message: 'Activity saved successfully', type: 'success' });
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

            <DateNavigator
                currentDate={currentDate}
                onPrev={handlePrevDay}
                onNext={handleNextDay}
                isNextDisabled={isNextDisabled()}
            />

            {loading ? (
                <div style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                    gap: '0',
                    backgroundColor: 'var(--bg-secondary)'
                }}>
                    {Array.from({ length: 9 }).map((_, i) => (
                        <div
                            key={i}
                            className="skeleton"
                            style={{
                                aspectRatio: '1',
                                width: '100%',
                                borderRight: '1px solid var(--bg-secondary)',
                                borderBottom: '1px solid var(--bg-secondary)'
                            }}
                        />
                    ))}
                </div>
            ) : (
                <div style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                    gap: '0',
                    borderTop: '1px solid var(--border)',
                    borderLeft: '1px solid var(--border)',
                    backgroundColor: 'var(--bg-secondary)'
                }}>
                    {ACTIVITY_NAMES.map((name) => {
                        const config = ACTIVITY_CONFIG[name] || { icon: Sparkles, color: '#000' };
                        return (
                            <ActivityTile
                                key={name}
                                name={name}
                                hours={activities[name] || 0}
                                onClick={() => handleActivityClick(name)}
                                icon={config.icon}
                                color={config.color}
                            />
                        );
                    })}
                </div>
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
