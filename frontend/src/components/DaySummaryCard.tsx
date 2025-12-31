import React, { useEffect, useState } from 'react';
import { api } from '../utils/api';
import { Flame, ChevronLeft, ChevronRight, Clock, CheckCircle2, Trophy } from 'lucide-react';

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
    const remainingHours = Math.max(maxHours - totalHours, 0);
    const isComplete = totalHours >= maxHours;

    if (loading || streakLoading) {
        return (
            <div
                className="skeleton"
                style={{
                    height: '140px',
                    marginBottom: '1rem',
                    borderRadius: '8px',
                }}
            />
        );
    }

    return (
        <div
            style={{
                backgroundColor: 'var(--bg-secondary)',
                border: '1px solid var(--border)',
                borderRadius: '8px',
                marginBottom: '1rem',
                overflow: 'hidden',
                transition: 'all 0.3s ease',
            }}
        >
            {/* Top Section: Date Navigator */}
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '0.75rem 1rem',
                    borderBottom: '1px solid var(--border)',
                }}
            >
                <button
                    onClick={onPrev}
                    style={{
                        background: 'none',
                        border: 'none',
                        color: 'var(--text-primary)',
                        cursor: 'pointer',
                        padding: '0.5rem',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderRadius: '8px',
                        transition: 'background-color 0.2s',
                    }}
                >
                    <ChevronLeft size={22} />
                </button>

                <span
                    style={{
                        fontSize: '1rem',
                        fontWeight: 700,
                        color: 'var(--text-primary)',
                        letterSpacing: '0.02em',
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
                        color: 'var(--text-primary)',
                        cursor: isNextDisabled ? 'not-allowed' : 'pointer',
                        padding: '0.5rem',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderRadius: '8px',
                        opacity: isNextDisabled ? 0.3 : 1,
                        transition: 'background-color 0.2s',
                    }}
                >
                    <ChevronRight size={22} />
                </button>
            </div>

            {/* Middle Section: Hours Progress */}
            <div style={{ padding: '1rem 1.25rem' }}>
                <div
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        marginBottom: '0.75rem',
                    }}
                >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        {isComplete ? (
                            <CheckCircle2 size={18} color="var(--success)" />
                        ) : (
                            <Clock size={18} color="var(--text-secondary)" />
                        )}
                        <span
                            style={{
                                fontSize: '0.875rem',
                                fontWeight: 600,
                                color: isComplete ? 'var(--success)' : 'var(--text-secondary)',
                            }}
                        >
                            {isComplete ? 'Day Complete!' : `${remainingHours}h remaining`}
                        </span>
                    </div>
                    <span
                        style={{
                            fontSize: '1.5rem',
                            fontWeight: 700,
                            color: 'var(--text-primary)',
                        }}
                    >
                        {totalHours}
                        <span style={{ fontSize: '0.875rem', fontWeight: 500, color: 'var(--text-secondary)' }}>
                            /{maxHours}h
                        </span>
                    </span>
                </div>

                {/* Progress Bar */}
                <div
                    style={{
                        width: '100%',
                        height: '8px',
                        backgroundColor: 'var(--progress-track)',
                        borderRadius: '4px',
                        overflow: 'hidden',
                    }}
                >
                    <div
                        style={{
                            width: `${percentage}%`,
                            height: '100%',
                            backgroundColor: isComplete ? 'var(--success)' : 'var(--accent)',
                            borderRadius: '4px',
                            transition: 'width 0.4s ease, background-color 0.3s ease',
                        }}
                    />
                </div>
            </div>

            {/* Bottom Section: Streaks */}
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '1.5rem',
                    padding: '0.75rem 1rem',
                    borderTop: '1px solid var(--border)',
                    backgroundColor: 'var(--icon-bg-muted)',
                }}
            >
                {isToday() && (
                    <>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <div
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    width: '28px',
                                    height: '28px',
                                    borderRadius: '50%',
                                    backgroundColor: 'rgba(245, 158, 11, 0.15)',
                                }}
                            >
                                <Flame size={16} color="#f59e0b" />
                            </div>
                            <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                                {streak.current}
                            </span>
                            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                                day streak
                            </span>
                        </div>

                        <div style={{ width: '1px', height: '16px', backgroundColor: 'var(--border)' }} />
                    </>
                )}

                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <div
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            width: '28px',
                            height: '28px',
                            borderRadius: '50%',
                            backgroundColor: 'rgba(234, 179, 8, 0.15)',
                        }}
                    >
                        <Trophy size={14} color="var(--accent)" />
                    </div>
                    <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                        {streak.longest}
                    </span>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                        best streak
                    </span>
                </div>
            </div>
        </div>
    );
};
