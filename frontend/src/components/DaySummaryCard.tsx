import React, { useEffect, useState, useRef } from 'react';
import { api } from '../services/api';
import { Flame, ChevronLeft, ChevronRight, Trophy } from 'lucide-react';

interface DaySummaryCardProps {
    username: string;
    currentDate: Date;
    onPrev: () => void;
    onNext: () => void;
    onDateChange: (date: Date) => void;
    isNextDisabled: boolean;
    activities: Record<string, number>;
    loading?: boolean;
}

interface StreakData {
    current: number;
    longest: number;
}

export const DaySummaryCard: React.FC<DaySummaryCardProps> = ({
    username,
    currentDate,
    onPrev,
    onNext,
    onDateChange,
    isNextDisabled,
    activities,
    loading = false
}) => {
    const [streak, setStreak] = useState<StreakData>({ current: 0, longest: 0 });
    const [streakLoading, setStreakLoading] = useState(true);
    const dateInputRef = useRef<HTMLInputElement>(null);

    const formatDateForApi = (date: Date) => {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    };

    const date = formatDateForApi(currentDate);

    useEffect(() => {
        const fetchStreak = async () => {
            setStreakLoading(true);
            try {
                const res = await api.post('/get-streak', { username, date });
                if (res.success && res.data) {
                    setStreak({ current: res.data.current, longest: res.data.longest });
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
    }, [username, date]);

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

    const handleDateClick = () => {
        dateInputRef.current?.showPicker();
    };

    const handleDateInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const selectedDate = new Date(e.target.value + 'T00:00:00');
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        if (selectedDate <= today) {
            onDateChange(selectedDate);
        }
    };

    const handleGoToToday = () => {
        onDateChange(new Date());
    };

    const formatDateForInput = (date: Date) => {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    };

    const getTodayForInput = () => {
        return formatDateForInput(new Date());
    };

    // Hours calculation
    const totalHours = Object.values(activities).reduce<number>((sum, hours) => sum + hours, 0);
    const maxHours = 24;
    const percentage = Math.min((totalHours / maxHours) * 100, 100);
    const isComplete = totalHours >= maxHours;

    if (loading || streakLoading) {
        return (
            <div
                className="skeleton-glass"
                style={{
                    height: '56px',
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
            }}
        >
            {/* Single Row: Navigation + Progress + Streaks */}
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '1rem',
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
                        onClick={handleDateClick}
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
                            padding: '0.4rem 0.85rem',
                            borderRadius: '10px',
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
                        title="Click to select date"
                    >
                        {formatDate(currentDate)}
                    </button>
                    <input
                        ref={dateInputRef}
                        type="date"
                        value={formatDateForInput(currentDate)}
                        max={getTodayForInput()}
                        onChange={handleDateInputChange}
                        style={{
                            position: 'absolute',
                            opacity: 0,
                            width: 0,
                            height: 0,
                            pointerEvents: 'none',
                        }}
                    />
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
                                fontSize: '0.85rem',
                                fontWeight: 500,
                                color: 'var(--text-primary)',
                                background: 'var(--tile-glass-bg)',
                                backdropFilter: 'blur(8px)',
                                WebkitBackdropFilter: 'blur(8px)',
                                border: '1px solid var(--tile-glass-border)',
                                boxShadow: '0 2px 8px rgba(0, 0, 0, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.1)',
                                cursor: 'pointer',
                                padding: '0.4rem 0.85rem',
                                marginLeft: '0.25rem',
                                borderRadius: '10px',
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

                {/* Progress Bar */}
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <div
                        style={{
                            flex: 1,
                            height: '6px',
                            backgroundColor: 'var(--progress-track)',
                            borderRadius: '3px',
                            overflow: 'hidden',
                        }}
                    >
                        <div
                            style={{
                                width: `${percentage}%`,
                                height: '100%',
                                backgroundColor: isComplete ? 'var(--success)' : 'var(--accent)',
                                borderRadius: '3px',
                                transition: 'width 0.4s ease',
                            }}
                        />
                    </div>
                    <span
                        style={{
                            fontSize: '0.8rem',
                            fontWeight: 400,
                            color: isComplete ? 'var(--success)' : 'var(--text-primary)',
                            minWidth: '45px',
                        }}
                    >
                        {totalHours}/{maxHours}h
                    </span>
                </div>

                {/* Streaks */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    {isToday() && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                            <Flame size={14} fill="#f87171" color="#ef4444" />
                            <span style={{ fontSize: '0.8rem', fontWeight: 400, color: 'var(--text-primary)' }}>
                                {streak.current}
                            </span>
                        </div>
                    )}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                        <Trophy size={13} fill="#fbbf24" color="#f59e0b" />
                        <span style={{ fontSize: '0.8rem', fontWeight: 400, color: 'var(--text-primary)' }}>
                            {streak.longest}
                        </span>
                    </div>
                </div>
            </div>

        </div>
    );
};
