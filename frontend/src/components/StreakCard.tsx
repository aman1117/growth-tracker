import React, { useEffect, useState } from 'react';
import { api } from '../services/api';
import { Flame } from 'lucide-react';

interface StreakCardProps {
    username: string;
    date: string; // YYYY-MM-DD
}

interface StreakData {
    current: number;
    longest: number;
}

export const StreakCard: React.FC<StreakCardProps> = ({ username, date }) => {
    const [streak, setStreak] = useState<StreakData>({ current: 0, longest: 0 });
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetchStreak = async () => {
            setLoading(true);
            try {
                const res = await api.post('/get-streak', {
                    username,
                    date
                });
                if (res.success && res.data) {
                    setStreak({
                        current: res.data.current,
                        longest: res.data.longest
                    });
                } else {
                    setStreak({ current: 0, longest: 0 });
                }
            } catch (error) {
                console.error('Failed to fetch streak:', error);
                setStreak({ current: 0, longest: 0 });
            } finally {
                setLoading(false);
            }
        };

        fetchStreak();
    }, [username, date]);

    if (loading) {
        return (
            <div className="skeleton" style={{
                height: '60px',
                width: '100%',
                marginBottom: '1rem',
                borderRadius: '8px'
            }} />
        );
    }

    const isToday = () => {
        const today = new Date();
        const year = today.getFullYear();
        const month = String(today.getMonth() + 1).padStart(2, '0');
        const day = String(today.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}` === date;
    };

    const showCurrentStreak = isToday();

    return (
        <div style={{
            backgroundColor: 'var(--bg-secondary)',
            padding: '1rem',
            marginBottom: '1rem',
            borderRadius: '8px',
            border: '1px solid var(--border-strong)',
            color: 'var(--text-primary)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '0.75rem',
            boxShadow: '0 1px 3px var(--shadow-sm)',
            flexWrap: 'wrap'
        }}>
            {showCurrentStreak && (
                <>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <div
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                width: '32px',
                                height: '32px',
                                borderRadius: '50%',
                                backgroundColor: 'rgba(239, 68, 68, 0.1)',
                            }}
                        >
                            <Flame size={18} style={{ color: '#ef4444' }} />
                        </div>
                        <span style={{ fontWeight: 600, fontSize: '0.9rem', whiteSpace: 'nowrap' }}>
                            Current Streak: {streak.current}
                        </span>
                    </div>
                    <div style={{ width: '1px', height: '20px', backgroundColor: 'var(--text-primary)', opacity: 0.2, display: 'none' }} className="desktop-divider" />
                    <span style={{ opacity: 0.5, display: 'inline-block', fontSize: '0.9rem' }} className="mobile-divider">|</span>
                </>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span style={{ fontWeight: 600, fontSize: '0.9rem', whiteSpace: 'nowrap' }}>
                    Longest Streak: {streak.longest}
                </span>
            </div>
            <style>{`
                @media (max-width: 640px) {
                    .desktop-divider { display: none !important; }
                    .mobile-divider { display: inline-block !important; }
                }
                @media (min-width: 641px) {
                    .desktop-divider { display: block !important; }
                    .mobile-divider { display: none !important; }
                }
            `}</style>
        </div>
    );
};
