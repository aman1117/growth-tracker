import React, { useEffect, useState } from 'react';
import { api } from '../utils/api';
import { Flame, ChevronLeft, ChevronRight, Trophy } from 'lucide-react';

interface DaySummaryCardProps {
    username: string;
    currentDate: Date;
    onPrev: () => void;
    onNext: () => void;
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
    isNextDisabled,
    activities,
    loading = false
}) => {
    const [streak, setStreak] = useState<StreakData>({ current: 0, longest: 0 });
    const [streakLoading, setStreakLoading] = useState(true);

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

    // Hours calculation
    const totalHours = Object.values(activities).reduce<number>((sum, hours) => sum + hours, 0);
    const maxHours = 24;
    const percentage = Math.min((totalHours / maxHours) * 100, 100);
    const isComplete = totalHours >= maxHours;

    if (loading || streakLoading) {
        return (
            <div
                className="skeleton"
                style={{
                    height: '56px',
                    marginBottom: '1rem',
                    borderRadius: '8px',
                }}
            />
        );
    }

    return (
        <div
            style={{
                background: isComplete 
                    ? 'linear-gradient(135deg, rgba(34, 197, 94, 0.12) 0%, rgba(16, 185, 129, 0.08) 100%)'
                    : 'linear-gradient(135deg, rgba(251, 191, 36, 0.1) 0%, rgba(245, 158, 11, 0.06) 100%)',
                border: isComplete 
                    ? '1px solid rgba(34, 197, 94, 0.2)' 
                    : '1px solid rgba(251, 191, 36, 0.2)',
                borderRadius: '8px',
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
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
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
                    <span
                        style={{
                            fontSize: '0.875rem',
                            fontWeight: 600,
                            color: 'var(--text-primary)',
                            minWidth: '80px',
                            textAlign: 'center',
                        }}
                    >
                        {formatDate(currentDate)}
                    </span>
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
                            fontWeight: 700,
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
                            <Flame size={14} fill="#fcd34d" color="#f59e0b" />
                            <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                                {streak.current}
                            </span>
                        </div>
                    )}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                        <Trophy size={13} fill="#fef08a" color="#eab308" />
                        <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                            {streak.longest}
                        </span>
                    </div>
                </div>
            </div>
        </div>
    );
};
