import React, { useEffect, useState } from 'react';
import { api } from '../services/api';
import { Flame, ChevronLeft, ChevronRight, Trophy } from 'lucide-react';
import { LikeButton, CalendarPicker } from './ui';
import { renderBadgeIcon } from '../utils/badgeIcons';
import type { Badge } from '../types/api';

interface DaySummaryCardProps {
    username: string;
    currentDate: Date;
    onPrev: () => void;
    onNext: () => void;
    onDateChange: (date: Date) => void;
    isNextDisabled: boolean;
    activities: Record<string, number>;
    loading?: boolean;
    onNewBadges?: (badges: Badge[]) => void;
    onBadgesLoaded?: (badges: Badge[]) => void;
}

interface StreakData {
    current: number;
    longest: number;
    new_badges?: Badge[];
}

export const DaySummaryCard: React.FC<DaySummaryCardProps> = ({
    username,
    currentDate,
    onPrev,
    onNext,
    onDateChange,
    isNextDisabled,
    activities,
    loading = false,
    onNewBadges,
    onBadgesLoaded,
}) => {
    const [streak, setStreak] = useState<StreakData>({ current: 0, longest: 0 });
    const [streakLoading, setStreakLoading] = useState(true);
    const [badges, setBadges] = useState<Badge[]>([]);
    const [badgesLoading, setBadgesLoading] = useState(true);
    const [isCalendarOpen, setIsCalendarOpen] = useState(false);

    const formatDateForApi = (date: Date) => {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    };

    const date = formatDateForApi(currentDate);
    const todayDate = formatDateForApi(new Date());

    useEffect(() => {
        const fetchStreak = async () => {
            setStreakLoading(true);
            try {
                // Always fetch best streak from today's date
                const res = await api.post('/get-streak', { username, date: todayDate });
                if (res.success && res.data) {
                    setStreak({ current: res.data.current, longest: res.data.longest });
                    
                    // Check for new badges
                    if (res.data.new_badges && res.data.new_badges.length > 0 && onNewBadges) {
                        onNewBadges(res.data.new_badges);
                    }
                } else {
                    setStreak({ current: 0, longest: 0 });
                }
            } catch (error) {
                console.error('Failed to fetch streak:', error);
                setStreak({ current: 0, longest: 0 });
            } finally {
                setStreakLoading(false);
            }
        };
        fetchStreak();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [username, todayDate]);

    // Fetch badges
    useEffect(() => {
        const fetchBadges = async () => {
            setBadgesLoading(true);
            try {
                const res = await api.post('/badges/user', { username });
                if (res.success && res.badges) {
                    setBadges(res.badges);
                    if (onBadgesLoaded) {
                        onBadgesLoaded(res.badges);
                    }
                }
            } catch (error) {
                console.error('Failed to fetch badges:', error);
            } finally {
                setBadgesLoading(false);
            }
        };
        fetchBadges();
        // eslint-disable-next-line react-hooks-deps
    }, [username]);

    const formatDate = (d: Date) => {
        const today = new Date();
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);

        if (d.toDateString() === today.toDateString()) {
            return 'Today';
        } else if (d.toDateString() === yesterday.toDateString()) {
            return 'Yesterday';
        }
        return d.toLocaleDateString('en-US', {
            weekday: 'short',
            month: 'short',
            day: 'numeric'
        });
    };

    const isToday = () => {
        const today = new Date();
        return currentDate.toDateString() === today.toDateString();
    };

    const handleGoToToday = () => {
        onDateChange(new Date());
    };

    // Hours calculation
    const totalHours = Object.values(activities).reduce<number>((sum, hours) => sum + hours, 0);
    const maxHours = 24;
    const percentage = Math.min((totalHours / maxHours) * 100, 100);
    const isComplete = totalHours >= maxHours;

    // Badge counts
    const earnedBadges = badges.filter(b => b.earned);
    // Get highest earned badge (highest threshold)
    const currentBadge = earnedBadges.length > 0 
        ? earnedBadges.reduce((prev, curr) => curr.threshold > prev.threshold ? curr : prev)
        : null;

    if (loading || streakLoading || badgesLoading) {
        return (
            <div
                className="skeleton-glass"
                style={{
                    height: '88px',
                    marginBottom: '1rem',
                    borderRadius: '20px',
                    background: 'var(--tile-glass-bg)',
                    backdropFilter: 'blur(var(--tile-glass-blur))',
                    WebkitBackdropFilter: 'blur(var(--tile-glass-blur))',
                    border: '1px solid var(--tile-glass-border)',
                    boxShadow: 'var(--tile-glass-shadow), var(--tile-glass-inner-glow)',
                }}
            />
        );
    }

    return (
        <div
            style={{
                background: isComplete 
                    ? 'linear-gradient(135deg, rgba(34, 197, 94, 0.15) 0%, rgba(16, 185, 129, 0.08) 100%)'
                    : 'var(--tile-glass-bg)',
                backdropFilter: 'blur(var(--tile-glass-blur))',
                WebkitBackdropFilter: 'blur(var(--tile-glass-blur))',
                border: isComplete 
                    ? '1px solid rgba(34, 197, 94, 0.3)' 
                    : '1px solid var(--tile-glass-border)',
                boxShadow: isComplete 
                    ? 'var(--tile-glass-shadow), var(--tile-glass-inner-glow), 0 0 20px rgba(34, 197, 94, 0.1)'
                    : 'var(--tile-glass-shadow), var(--tile-glass-inner-glow)',
                borderRadius: '20px',
                marginBottom: '1rem',
                padding: '0.75rem 1rem',
                overflow: 'hidden',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.5rem',
            }}
        >
            {/* Row 1: Date Navigation + Hours */}
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                }}
            >
                {/* Date Navigation */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                    <button
                        onClick={onPrev}
                        style={{
                            background: 'none',
                            border: 'none',
                            color: 'var(--text-secondary)',
                            cursor: 'pointer',
                            padding: '0.25rem',
                            display: 'flex',
                            alignItems: 'center',
                        }}
                    >
                        <ChevronLeft size={18} />
                    </button>
                    <button
                        onClick={() => setIsCalendarOpen(true)}
                        style={{
                            fontSize: '0.85rem',
                            fontWeight: 500,
                            color: 'var(--text-primary)',
                            background: 'var(--tile-glass-bg)',
                            backdropFilter: 'blur(8px)',
                            WebkitBackdropFilter: 'blur(8px)',
                            border: '1px solid var(--tile-glass-border)',
                            boxShadow: '0 2px 8px rgba(0, 0, 0, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.1)',
                            cursor: 'pointer',
                            padding: '0.35rem 0.75rem',
                            borderRadius: '8px',
                            transition: 'all 0.2s ease',
                            whiteSpace: 'nowrap',
                        }}
                    >
                        {formatDate(currentDate)}
                    </button>
                    <button
                        onClick={onNext}
                        disabled={isNextDisabled}
                        style={{
                            background: 'none',
                            border: 'none',
                            color: 'var(--text-secondary)',
                            cursor: isNextDisabled ? 'not-allowed' : 'pointer',
                            padding: '0.25rem',
                            display: 'flex',
                            alignItems: 'center',
                            opacity: isNextDisabled ? 0.3 : 1,
                        }}
                    >
                        <ChevronRight size={18} />
                    </button>
                    {!isToday() && (
                        <button
                            onClick={handleGoToToday}
                            style={{
                                fontSize: '0.8rem',
                                fontWeight: 500,
                                color: 'var(--text-primary)',
                                background: 'var(--tile-glass-bg)',
                                backdropFilter: 'blur(8px)',
                                WebkitBackdropFilter: 'blur(8px)',
                                border: '1px solid var(--tile-glass-border)',
                                boxShadow: '0 2px 8px rgba(0, 0, 0, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.1)',
                                cursor: 'pointer',
                                padding: '0.3rem 0.6rem',
                                marginLeft: '0.25rem',
                                borderRadius: '8px',
                                transition: 'all 0.2s ease',
                                whiteSpace: 'nowrap',
                            }}
                            onMouseEnter={(e) => {
                                e.currentTarget.style.background = 'var(--tile-glass-bg-active)';
                                e.currentTarget.style.borderColor = 'var(--tile-glass-border-active)';
                                e.currentTarget.style.transform = 'translateY(-1px)';
                                e.currentTarget.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.12), inset 0 1px 0 rgba(255, 255, 255, 0.15)';
                            }}
                            onMouseLeave={(e) => {
                                e.currentTarget.style.background = 'var(--tile-glass-bg)';
                                e.currentTarget.style.borderColor = 'var(--tile-glass-border)';
                                e.currentTarget.style.transform = 'translateY(0)';
                                e.currentTarget.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.1)';
                            }}
                            title="Go to today"
                        >
                            Today
                        </button>
                    )}
                </div>

                {/* Hours Display with Progress */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    {isToday() && !isComplete && (
                        <div
                            style={{
                                width: '40px',
                                height: '4px',
                                backgroundColor: 'var(--progress-track)',
                                borderRadius: '2px',
                                overflow: 'hidden',
                            }}
                        >
                            <div
                                style={{
                                    width: `${percentage}%`,
                                    height: '100%',
                                    backgroundColor: 'var(--accent)',
                                    borderRadius: '2px',
                                    transition: 'width 0.4s ease',
                                }}
                            />
                        </div>
                    )}
                    <span
                        style={{
                            fontSize: '0.85rem',
                            fontWeight: isComplete ? 600 : 500,
                            color: isComplete ? 'var(--success)' : 'var(--text-primary)',
                            whiteSpace: 'nowrap',
                        }}
                    >
                        {isComplete && '✓ '}{totalHours}/{maxHours}h
                    </span>
                </div>
            </div>

            {/* Row 2: Streaks + Likes */}
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    paddingTop: '0.5rem',
                    borderTop: '1px solid var(--tile-glass-border)',
                }}
            >
                {/* Streaks */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                    {/* Current Streak - only show on Today */}
                    {isToday() && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                            <Flame size={18} fill="#f87171" color="#ef4444" style={{ display: 'block' }} />
                            <span style={{ fontSize: '0.85rem', fontWeight: 500, color: 'var(--text-primary)', lineHeight: 1 }}>
                                {streak.current}
                            </span>
                            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: 1 }}>
                                streak
                            </span>
                        </div>
                    )}

                    {/* Best Streak */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                        <Trophy size={18} fill="#fbbf24" color="#f59e0b" style={{ display: 'block' }} />
                        <span style={{ fontSize: '0.85rem', fontWeight: 500, color: 'var(--text-primary)', lineHeight: 1 }}>
                            {streak.longest}
                        </span>
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: 1 }}>
                            best
                        </span>
                    </div>

                    {/* Current Badge */}
                    {currentBadge && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                            {renderBadgeIcon(currentBadge.icon, currentBadge.color)}
                            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: 1 }}>
                                {currentBadge.name}
                            </span>
                        </div>
                    )}
                </div>

                {/* Like Button */}
                <LikeButton
                    username={username}
                    date={date}
                    size="sm"
                    showCount={true}
                />
            </div>

            {/* Custom Calendar Picker */}
            <CalendarPicker
                isOpen={isCalendarOpen}
                onClose={() => setIsCalendarOpen(false)}
                selectedDate={currentDate}
                onDateSelect={onDateChange}
                maxDate={new Date()}
            />
        </div>
    );
};
