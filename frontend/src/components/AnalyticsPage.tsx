import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
    ArrowLeft, ChevronLeft, ChevronRight, TrendingUp, TrendingDown,
    ArrowUpDown, ChevronDown, Users, Check, Search, X, Lock, Coffee
} from 'lucide-react';
import { useAuth } from '../store';
import { APP_ROUTES } from '../constants/routes';
import { api, ApiError } from '../services/api';
import { ACTIVITY_CONFIG } from '../constants';
import { ProtectedImage } from './ui';
import type { WeekAnalyticsResponse, DayAnalytics, ActivitySummary } from '../types';

interface SearchResult {
    id: number;
    username: string;
    email: string;
    profile_pic?: string;
    is_private: boolean;
}

// Get Monday of the week for a given date
const getWeekStart = (date: Date): Date => {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    d.setDate(diff);
    d.setHours(0, 0, 0, 0);
    return d;
};

const formatDateForApi = (date: Date): string => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
};

const formatWeekRange = (weekStart: Date): string => {
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 6);
    
    const startMonth = weekStart.toLocaleDateString('en-US', { month: 'short' });
    const endMonth = weekEnd.toLocaleDateString('en-US', { month: 'short' });
    const startDay = weekStart.getDate();
    const endDay = weekEnd.getDate();
    const year = weekEnd.getFullYear();
    
    if (startMonth === endMonth) {
        return `${startMonth} ${startDay} - ${endDay}, ${year}`;
    }
    return `${startMonth} ${startDay} - ${endMonth} ${endDay}, ${year}`;
};

export const AnalyticsPage: React.FC = () => {
    const navigate = useNavigate();
    const { user } = useAuth();
    const { username: routeUsername } = useParams<{ username: string }>();
    const [searchParams] = useSearchParams();
    
    const [isExiting, setIsExiting] = useState(false);
    const [loading, setLoading] = useState(true);
    const [weekStart, setWeekStart] = useState(() => getWeekStart(new Date()));
    const [analytics, setAnalytics] = useState<WeekAnalyticsResponse | null>(null);
    const [isPrivateAccount, setIsPrivateAccount] = useState(false);
    const [sortOrder, setSortOrder] = useState<'desc' | 'asc'>('desc');
    const [activityFilter, setActivityFilter] = useState<string>('all');
    const [showActivityFilter, setShowActivityFilter] = useState(false);
    const activityFilterRef = useRef<HTMLDivElement>(null);
    const [animateStats, setAnimateStats] = useState(false);
    const [animateBars, setAnimateBars] = useState(false);
    
    // User selector state
    const [showUserSelector, setShowUserSelector] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
    const [isSearching, setIsSearching] = useState(false);
    const searchInputRef = useRef<HTMLInputElement>(null);
    const userSelectorRef = useRef<HTMLDivElement>(null);
    
    // Target username
    const targetUsername = searchParams.get('user') || routeUsername || user?.username || '';

    // Close user selector when clicking outside
    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (userSelectorRef.current && !userSelectorRef.current.contains(e.target as Node)) {
                setShowUserSelector(false);
            }
            if (activityFilterRef.current && !activityFilterRef.current.contains(e.target as Node)) {
                setShowActivityFilter(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    // Focus search input when user selector opens
    useEffect(() => {
        if (showUserSelector && searchInputRef.current) {
            setTimeout(() => searchInputRef.current?.focus(), 100);
        }
    }, [showUserSelector]);

    // Debounced user search
    useEffect(() => {
        if (!searchQuery.trim()) {
            setSearchResults([]);
            return;
        }

        const timer = setTimeout(async () => {
            setIsSearching(true);
            try {
                const res = await api.post('/users', { username: searchQuery });
                if (res.success) {
                    setSearchResults(res.data);
                }
            } catch (err) {
                console.error('Search failed:', err);
            } finally {
                setIsSearching(false);
            }
        }, 300);

        return () => clearTimeout(timer);
    }, [searchQuery]);

    const fetchAnalytics = useCallback(async () => {
        if (!targetUsername) return;
        
        setLoading(true);
        setAnimateStats(false);
        setAnimateBars(false);
        setIsPrivateAccount(false);
        
        try {
            const res = await api.getWeekAnalytics(targetUsername, formatDateForApi(weekStart));
            if (res.success) {
                const analyticsData = res as WeekAnalyticsResponse;
                setAnalytics(analyticsData);
                
                // Reset activity filter if selected activity doesn't exist in new week's data
                setActivityFilter(prev => {
                    if (prev === 'all') return 'all';
                    const activityExists = analyticsData.activity_summary?.some(a => a.name === prev);
                    return activityExists ? prev : 'all';
                });
                
                // Trigger animations after data loads
                setTimeout(() => setAnimateStats(true), 100);
                setTimeout(() => setAnimateBars(true), 300);
            } else if (res.error_code === 'ACCOUNT_PRIVATE') {
                setIsPrivateAccount(true);
                setAnalytics(null);
            } else {
                setAnalytics(null);
            }
        } catch (err) {
            // Check if it's a private account error
            if (err instanceof ApiError && err.errorCode === 'ACCOUNT_PRIVATE') {
                setIsPrivateAccount(true);
                setAnalytics(null);
            } else {
                console.error('Failed to fetch analytics', err);
                setAnalytics(null);
            }
        } finally {
            setLoading(false);
        }
    }, [targetUsername, weekStart]);

    useEffect(() => {
        fetchAnalytics();
    }, [fetchAnalytics]);

    const handlePrevWeek = () => {
        const newWeekStart = new Date(weekStart);
        newWeekStart.setDate(newWeekStart.getDate() - 7);
        setWeekStart(newWeekStart);
    };

    const handleNextWeek = () => {
        const newWeekStart = new Date(weekStart);
        newWeekStart.setDate(newWeekStart.getDate() + 7);
        const today = getWeekStart(new Date());
        if (newWeekStart <= today) {
            setWeekStart(newWeekStart);
        }
    };

    const isNextDisabled = () => {
        const today = getWeekStart(new Date());
        return weekStart >= today;
    };

    const handleBack = () => {
        setIsExiting(true);
        setTimeout(() => {
            // Safe navigation: use history if available, otherwise go home
            if (window.history.length > 2 && window.history.state?.idx > 0) {
                navigate(-1);
            } else {
                navigate(APP_ROUTES.HOME, { replace: true });
            }
        }, 200);
    };

    const handleUserSelect = (username: string) => {
        setShowUserSelector(false);
        setSearchQuery('');
        // Replace instead of push to avoid polluting history stack
        // Back button will go to where user was before analytics, not between user switches
        navigate(APP_ROUTES.USER_ANALYTICS(username), { replace: true });
    };

    const toggleSortOrder = () => {
        setSortOrder(prev => prev === 'desc' ? 'asc' : 'desc');
    };

    const sortedActivitySummary = analytics?.activity_summary 
        ? [...analytics.activity_summary].sort((a, b) => 
            sortOrder === 'desc' ? b.total_hours - a.total_hours : a.total_hours - b.total_hours
          )
        : [];

    if (!user) {
        navigate(APP_ROUTES.LOGIN);
        return null;
    }

    return (
        <>
            <style>{`
                @keyframes slideInFromRight {
                    from { transform: translateX(100%); opacity: 0; }
                    to { transform: translateX(0); opacity: 1; }
                }
                @keyframes slideOutToRight {
                    from { transform: translateX(0); opacity: 1; }
                    to { transform: translateX(100%); opacity: 0; }
                }
                @keyframes fadeInUp {
                    from { opacity: 0; transform: translateY(20px); }
                    to { opacity: 1; transform: translateY(0); }
                }
                @keyframes countUp {
                    from { opacity: 0; transform: scale(0.8); }
                    to { opacity: 1; transform: scale(1); }
                }
                @keyframes barGrow {
                    from { height: 0; }
                    to { height: var(--target-height); }
                }
                @keyframes shimmer {
                    0% { background-position: -200% 0; }
                    100% { background-position: 200% 0; }
                }
                @keyframes pulse {
                    0%, 100% { opacity: 1; }
                    50% { opacity: 0.5; }
                }
                @keyframes dropdownSlide {
                    from { opacity: 0; transform: translateY(-10px) scale(0.95); }
                    to { opacity: 1; transform: translateY(0) scale(1); }
                }
                @keyframes spin {
                    from { transform: rotate(0deg); }
                    to { transform: rotate(360deg); }
                }
                .stat-card {
                    transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1), box-shadow 0.3s ease;
                }
                .stat-card:hover {
                    transform: translateY(-2px);
                    box-shadow: 0 8px 25px rgba(0, 0, 0, 0.15);
                }
                .glass-card {
                    background: var(--tile-glass-bg) !important;
                    backdrop-filter: blur(var(--tile-glass-blur)) !important;
                    -webkit-backdrop-filter: blur(var(--tile-glass-blur)) !important;
                    border: 1px solid var(--tile-glass-border) !important;
                    box-shadow: var(--tile-glass-shadow), var(--tile-glass-inner-glow) !important;
                    border-radius: 20px !important;
                }
                .glass-card:hover {
                    transform: translateY(-2px);
                    box-shadow: var(--tile-glass-shadow-active), var(--tile-glass-inner-glow) !important;
                }
                .bar-segment {
                    transition: opacity 0.2s ease, transform 0.2s ease;
                }
                .bar-segment:hover {
                    opacity: 0.85;
                    transform: scaleX(1.02);
                }
                .activity-row {
                    transition: background-color 0.2s ease, transform 0.15s ease;
                }
                .activity-row:hover {
                    background-color: var(--bg-secondary);
                    transform: translateX(4px);
                }
                .skeleton {
                    background: var(--tile-glass-bg);
                    backdrop-filter: blur(var(--tile-glass-blur));
                    -webkit-backdrop-filter: blur(var(--tile-glass-blur));
                    border: 1px solid var(--tile-glass-border);
                    box-shadow: var(--tile-glass-shadow), var(--tile-glass-inner-glow);
                    border-radius: 20px;
                    position: relative;
                    overflow: hidden;
                }
                .skeleton::before {
                    content: '';
                    position: absolute;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    background: linear-gradient(90deg, transparent 0%, rgba(255, 255, 255, 0.1) 50%, transparent 100%);
                    background-size: 200% 100%;
                    animation: shimmer 2s ease-in-out infinite;
                }
            `}</style>
            
            <div 
                className="container" 
                style={{ 
                    maxWidth: '600px', 
                    padding: '0.5rem 1rem', 
                    paddingBottom: '2rem',
                    animation: isExiting ? 'slideOutToRight 0.2s ease-in forwards' : 'slideInFromRight 0.25s ease-out'
                }}
            >
                {/* Header */}
                <div style={{ 
                    display: 'flex', 
                    alignItems: 'center', 
                    gap: '0.5rem',
                    marginBottom: '1rem'
                }}>
                    <button
                        onClick={handleBack}
                        style={{
                            background: 'none',
                            border: 'none',
                            color: 'var(--text-secondary)',
                            cursor: 'pointer',
                            padding: '0.25rem',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            borderRadius: '8px',
                            transition: 'background-color 0.2s'
                        }}
                        onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-secondary)'}
                        onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                    >
                        <ArrowLeft size={20} />
                    </button>
                    <h1 style={{ 
                        fontSize: '1.25rem', 
                        fontWeight: 700, 
                        color: 'var(--text-primary)',
                        margin: 0,
                        flex: 1
                    }}>
                        Analytics
                    </h1>
                </div>

                {/* User Selector */}
                <div ref={userSelectorRef} style={{ position: 'relative', marginBottom: '1rem' }}>
                    <button
                        onClick={() => setShowUserSelector(!showUserSelector)}
                        style={{
                            width: '100%',
                            padding: '0.75rem 1rem',
                            background: 'var(--tile-glass-bg)',
                            backdropFilter: 'blur(var(--tile-glass-blur))',
                            WebkitBackdropFilter: 'blur(var(--tile-glass-blur))',
                            border: '1px solid var(--tile-glass-border)',
                            boxShadow: 'var(--tile-glass-shadow), var(--tile-glass-inner-glow)',
                            borderRadius: '20px',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            cursor: 'pointer',
                            transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)'
                        }}
                    >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <Users size={18} color="var(--text-secondary)" />
                            <span style={{ color: 'var(--text-primary)', fontWeight: 500, fontSize: '0.95rem' }}>
                                {targetUsername}
                            </span>
                        </div>
                        <ChevronDown 
                            size={16} 
                            color="var(--text-secondary)"
                            style={{ 
                                transition: 'transform 0.2s ease',
                                transform: showUserSelector ? 'rotate(180deg)' : 'rotate(0deg)'
                            }}
                        />
                    </button>

                    {showUserSelector && (
                        <div style={{
                            position: 'absolute',
                            top: 'calc(100% + 4px)',
                            left: 0,
                            right: 0,
                            background: 'var(--tile-glass-bg)',
                            backdropFilter: 'blur(16px)',
                            WebkitBackdropFilter: 'blur(16px)',
                            border: '1px solid var(--tile-glass-border)',
                            borderRadius: '20px',
                            boxShadow: 'var(--tile-glass-shadow-active)',
                            zIndex: 100,
                            overflow: 'hidden',
                            animation: 'dropdownSlide 0.2s ease-out'
                        }}>
                            {/* Search Input */}
                            <div style={{ padding: '0.75rem', borderBottom: '1px solid var(--tile-glass-border)' }}>
                                <div style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '0.5rem',
                                    padding: '0.5rem 0.75rem',
                                    background: 'rgba(255, 255, 255, 0.1)',
                                    borderRadius: '12px',
                                    border: '1px solid var(--tile-glass-border)'
                                }}>
                                    <Search size={14} color="var(--text-secondary)" />
                                    <input
                                        ref={searchInputRef}
                                        type="text"
                                        placeholder="Search users..."
                                        value={searchQuery}
                                        onChange={(e) => setSearchQuery(e.target.value)}
                                        style={{
                                            flex: 1,
                                            border: 'none',
                                            background: 'transparent',
                                            outline: 'none',
                                            fontSize: '16px',
                                            color: 'var(--text-primary)'
                                        }}
                                    />
                                    {searchQuery && (
                                        <button
                                            onClick={() => setSearchQuery('')}
                                            style={{
                                                background: 'none',
                                                border: 'none',
                                                padding: 0,
                                                cursor: 'pointer',
                                                display: 'flex'
                                            }}
                                        >
                                            <X size={14} color="var(--text-secondary)" />
                                        </button>
                                    )}
                                </div>
                            </div>

                            {/* Current User Option */}
                            {user && (
                                <div
                                    onClick={() => handleUserSelect(user.username)}
                                    style={{
                                        padding: '0.75rem 1rem',
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '0.75rem',
                                        cursor: 'pointer',
                                        transition: 'background-color 0.15s',
                                        borderBottom: searchResults.length > 0 ? '1px solid var(--border)' : 'none'
                                    }}
                                    onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-secondary)'}
                                    onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                                >
                                    <div style={{
                                        width: '32px',
                                        height: '32px',
                                        borderRadius: '50%',
                                        backgroundColor: 'var(--accent)',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        color: 'white',
                                        fontWeight: 600,
                                        fontSize: '0.875rem',
                                        overflow: 'hidden'
                                    }}>
                                        {user.profilePic ? (
                                            <ProtectedImage 
                                                src={user.profilePic} 
                                                alt={user.username}
                                                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                                            />
                                        ) : (
                                            user.username.charAt(0).toUpperCase()
                                        )}
                                    </div>
                                    <div style={{ flex: 1 }}>
                                        <div style={{ color: 'var(--text-primary)', fontWeight: 500, fontSize: '0.9rem' }}>
                                            {user.username}
                                        </div>
                                        <div style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>
                                            Your profile
                                        </div>
                                    </div>
                                    {targetUsername === user.username && (
                                        <Check size={16} color="var(--accent)" />
                                    )}
                                </div>
                            )}

                            {/* Search Results */}
                            <div style={{ maxHeight: '200px', overflowY: 'auto' }}>
                                {isSearching ? (
                                    <div style={{ padding: '1rem', textAlign: 'center' }}>
                                        <div style={{
                                            width: '20px',
                                            height: '20px',
                                            border: '2px solid var(--text-secondary)',
                                            borderTopColor: 'var(--accent)',
                                            borderRadius: '50%',
                                            animation: 'spin 0.8s linear infinite',
                                            margin: '0 auto'
                                        }} />
                                    </div>
                                ) : searchResults.filter(r => r.username !== user?.username).map((result) => (
                                    <div
                                        key={result.id}
                                        onClick={() => handleUserSelect(result.username)}
                                        style={{
                                            padding: '0.75rem 1rem',
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '0.75rem',
                                            cursor: 'pointer',
                                            transition: 'background-color 0.15s'
                                        }}
                                        onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-secondary)'}
                                        onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                                    >
                                        <div style={{
                                            width: '32px',
                                            height: '32px',
                                            borderRadius: '50%',
                                            backgroundColor: 'var(--avatar-bg)',
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                            overflow: 'hidden'
                                        }}>
                                            {result.profile_pic ? (
                                                <ProtectedImage 
                                                    src={result.profile_pic} 
                                                    alt={result.username}
                                                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                                                />
                                            ) : (
                                                <span style={{ fontWeight: 600, fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
                                                    {result.username.charAt(0).toUpperCase()}
                                                </span>
                                            )}
                                        </div>
                                        <div style={{ flex: 1 }}>
                                            <div style={{ color: 'var(--text-primary)', fontWeight: 500, fontSize: '0.9rem' }}>
                                                {result.username}
                                            </div>
                                        </div>
                                        {result.is_private ? (
                                            <Lock size={14} color="var(--text-secondary)" />
                                        ) : targetUsername === result.username ? (
                                            <Check size={16} color="var(--accent)" />
                                        ) : null}
                                    </div>
                                ))}
                                {searchQuery && !isSearching && searchResults.length === 0 && (
                                    <div style={{ 
                                        padding: '1rem', 
                                        textAlign: 'center', 
                                        color: 'var(--text-secondary)',
                                        fontSize: '0.875rem'
                                    }}>
                                        No users found
                                    </div>
                                )}
                            </div>
                        </div>
                    )}
                </div>

                {/* Week Navigator */}
                <div className="card glass-card" style={{ 
                    padding: '0.75rem 1rem', 
                    marginBottom: '1rem',
                    transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)'
                }}>
                    {/* Date Navigation Row */}
                    <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        paddingBottom: loading ? '0' : '0.75rem',
                        borderBottom: loading ? 'none' : '1px solid var(--border)'
                    }}>
                        <button
                            onClick={handlePrevWeek}
                            style={{
                                background: 'none',
                                border: 'none',
                                color: 'var(--text-secondary)',
                                cursor: 'pointer',
                                padding: '0.5rem',
                                borderRadius: '8px',
                                display: 'flex',
                                alignItems: 'center',
                                transition: 'all 0.2s'
                            }}
                            onMouseEnter={(e) => {
                                e.currentTarget.style.backgroundColor = 'var(--bg-secondary)';
                                e.currentTarget.style.color = 'var(--text-primary)';
                            }}
                            onMouseLeave={(e) => {
                                e.currentTarget.style.backgroundColor = 'transparent';
                                e.currentTarget.style.color = 'var(--text-secondary)';
                            }}
                        >
                            <ChevronLeft size={20} />
                        </button>
                        <span style={{ 
                            fontWeight: 600, 
                            color: 'var(--text-primary)',
                            fontSize: '0.9rem'
                        }}>
                            {formatWeekRange(weekStart)}
                        </span>
                        <button
                            onClick={handleNextWeek}
                            disabled={isNextDisabled()}
                            style={{
                                background: 'none',
                                border: 'none',
                                color: isNextDisabled() ? 'var(--text-tertiary)' : 'var(--text-secondary)',
                                cursor: isNextDisabled() ? 'not-allowed' : 'pointer',
                                padding: '0.5rem',
                                borderRadius: '8px',
                                display: 'flex',
                                alignItems: 'center',
                                opacity: isNextDisabled() ? 0.4 : 1,
                                transition: 'all 0.2s'
                            }}
                            onMouseEnter={(e) => {
                                if (!isNextDisabled()) {
                                    e.currentTarget.style.backgroundColor = 'var(--bg-secondary)';
                                    e.currentTarget.style.color = 'var(--text-primary)';
                                }
                            }}
                            onMouseLeave={(e) => {
                                e.currentTarget.style.backgroundColor = 'transparent';
                                e.currentTarget.style.color = isNextDisabled() ? 'var(--text-tertiary)' : 'var(--text-secondary)';
                            }}
                        >
                            <ChevronRight size={20} />
                        </button>
                    </div>

                    {/* Stats Row */}
                    {!loading && analytics && (
                        <div style={{ 
                            display: 'flex', 
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: '0.5rem',
                            paddingTop: '0.75rem',
                            animation: animateStats ? 'fadeInUp 0.4s ease-out forwards' : 'none',
                            opacity: animateStats ? 1 : 0
                        }}>
                            {/* Total Hours */}
                            <div style={{ flex: 1, textAlign: 'center' }}>
                                <div style={{ 
                                    fontSize: '0.95rem', 
                                    fontWeight: 600, 
                                    color: 'var(--text-primary)',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    gap: '0.25rem'
                                }}>
                                    {analytics.total_hours_this_week.toFixed(1)}h
                                    {(analytics.is_current_week ?? true) ? (
                                        <span style={{ 
                                            fontSize: '0.65rem', 
                                            color: (analytics.percentage_change ?? 0) >= 0 ? '#10b981' : '#ef4444',
                                            fontWeight: 500,
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '0.1rem'
                                        }}>
                                            {(analytics.percentage_change ?? 0) >= 0 ? (
                                                <TrendingUp size={10} color="#10b981" />
                                            ) : (
                                                <TrendingDown size={10} color="#ef4444" />
                                            )}
                                            {(analytics.percentage_change ?? 0) >= 0 ? '+' : ''}{(analytics.percentage_change ?? 0).toFixed(0)}%
                                        </span>
                                    ) : (
                                        <span style={{ 
                                            fontSize: '0.65rem', 
                                            color: (analytics.percentage_vs_current ?? 0) >= 0 ? '#10b981' : '#ef4444',
                                            fontWeight: 500,
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '0.1rem'
                                        }}>
                                            {(analytics.percentage_vs_current ?? 0) >= 0 ? (
                                                <TrendingUp size={10} color="#10b981" />
                                            ) : (
                                                <TrendingDown size={10} color="#ef4444" />
                                            )}
                                            {(analytics.percentage_vs_current ?? 0) >= 0 ? '+' : ''}{(analytics.percentage_vs_current ?? 0).toFixed(0)}%
                                        </span>
                                    )}
                                </div>
                                <div style={{ fontSize: '0.65rem', color: 'var(--text-tertiary)', marginTop: '0.2rem' }}>
                                    {(analytics.is_current_week ?? true) ? 'vs last week' : 'vs this week'}
                                </div>
                            </div>

                            {/* Divider */}
                            <div style={{ width: '1px', height: '32px', backgroundColor: 'var(--border)' }} />

                            {/* Current Streak */}
                            <div style={{ flex: 1, textAlign: 'center' }}>
                                <div style={{ 
                                    fontSize: '0.95rem', 
                                    fontWeight: 600, 
                                    color: 'var(--text-primary)',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    gap: '0.25rem'
                                }}>
                                    <span style={{ fontSize: '1rem' }}>🔥</span>
                                    {analytics.streak.current}
                                </div>
                                <div style={{ fontSize: '0.65rem', color: 'var(--text-tertiary)', marginTop: '0.2rem' }}>
                                    Current Streak
                                </div>
                            </div>

                            {/* Divider */}
                            <div style={{ width: '1px', height: '32px', backgroundColor: 'var(--border)' }} />

                            {/* Longest Streak */}
                            <div style={{ flex: 1, textAlign: 'center' }}>
                                <div style={{ 
                                    fontSize: '0.95rem', 
                                    fontWeight: 600, 
                                    color: 'var(--text-primary)',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    gap: '0.25rem'
                                }}>
                                    <span style={{ fontSize: '1rem' }}>🏆</span>
                                    {analytics.streak.longest}
                                </div>
                                <div style={{ fontSize: '0.65rem', color: 'var(--text-tertiary)', marginTop: '0.2rem' }}>
                                    {analytics.streak.longest_start && analytics.streak.longest_end ? (
                                        <span>{new Date(analytics.streak.longest_start).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - {new Date(analytics.streak.longest_end).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                                    ) : 'Best Streak'}
                                </div>
                            </div>
                        </div>
                    )}
                </div>

                {loading ? (
                    // Skeleton Loaders
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                        {/* Stats Skeleton */}
                        <div className="skeleton" style={{ height: '70px' }} />
                        {/* Chart Skeleton */}
                        <div className="skeleton" style={{ height: '240px' }} />
                        {/* Activity List Skeleton */}
                        <div className="skeleton" style={{ height: '200px' }} />
                    </div>
                ) : analytics ? (
                    <>
                        {/* Weekly Bar Chart */}
                        <div 
                            className="card glass-card" 
                            style={{ 
                                padding: '1rem', 
                                marginBottom: '1rem',
                                animation: animateBars ? 'fadeInUp 0.4s ease-out forwards' : 'none',
                                opacity: animateBars ? 1 : 0,
                                transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)'
                            }}
                        >
                            <div style={{ 
                                display: 'flex', 
                                alignItems: 'center', 
                                justifyContent: 'space-between',
                                marginBottom: '1rem'
                            }}>
                                <h3 style={{ 
                                    fontSize: '0.9rem', 
                                    fontWeight: 600, 
                                    color: 'var(--text-primary)',
                                    margin: 0
                                }}>
                                    Weekly Overview
                                </h3>
                                <div ref={activityFilterRef} style={{ position: 'relative' }}>
                                    <button
                                        onClick={() => setShowActivityFilter(!showActivityFilter)}
                                        style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '0.25rem',
                                            padding: '0.3rem 0.5rem',
                                            background: 'var(--tile-glass-bg)',
                                            backdropFilter: 'blur(8px)',
                                            WebkitBackdropFilter: 'blur(8px)',
                                            border: '1px solid var(--tile-glass-border)',
                                            borderRadius: '10px',
                                            cursor: 'pointer',
                                            fontSize: '0.7rem',
                                            color: 'var(--text-secondary)',
                                            transition: 'all 0.2s'
                                        }}
                                    >
                                        {activityFilter === 'all' ? 'All Activities' : ACTIVITY_CONFIG[activityFilter as keyof typeof ACTIVITY_CONFIG]?.label}
                                        <ChevronDown size={12} style={{ 
                                            transition: 'transform 0.2s',
                                            transform: showActivityFilter ? 'rotate(180deg)' : 'rotate(0deg)'
                                        }} />
                                    </button>
                                    {showActivityFilter && (
                                        <div style={{
                                            position: 'absolute',
                                            top: '100%',
                                            right: 0,
                                            marginTop: '0.25rem',
                                            background: 'var(--tile-glass-bg)',
                                            backdropFilter: 'blur(16px)',
                                            WebkitBackdropFilter: 'blur(16px)',
                                            border: '1px solid var(--tile-glass-border)',
                                            borderRadius: '12px',
                                            boxShadow: 'var(--tile-glass-shadow-active)',
                                            zIndex: 100,
                                            minWidth: '140px',
                                            maxHeight: '200px',
                                            overflowY: 'auto'
                                        }}>
                                            <div
                                                onClick={() => { setActivityFilter('all'); setShowActivityFilter(false); }}
                                                style={{
                                                    padding: '0.5rem 0.75rem',
                                                    fontSize: '0.75rem',
                                                    color: activityFilter === 'all' ? 'var(--accent)' : 'var(--text-primary)',
                                                    cursor: 'pointer',
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    justifyContent: 'space-between',
                                                    transition: 'background 0.15s'
                                                }}
                                                onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)'}
                                                onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                                            >
                                                All Activities
                                                {activityFilter === 'all' && <Check size={12} />}
                                            </div>
                                            {analytics.activity_summary.map(activity => (
                                                <div
                                                    key={activity.name}
                                                    onClick={() => { setActivityFilter(activity.name); setShowActivityFilter(false); }}
                                                    style={{
                                                        padding: '0.5rem 0.75rem',
                                                        fontSize: '0.75rem',
                                                        color: activityFilter === activity.name ? 'var(--accent)' : 'var(--text-primary)',
                                                        cursor: 'pointer',
                                                        display: 'flex',
                                                        alignItems: 'center',
                                                        justifyContent: 'space-between',
                                                        gap: '0.5rem',
                                                        transition: 'background 0.15s'
                                                    }}
                                                    onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)'}
                                                    onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                                                >
                                                    <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                                        <span style={{ 
                                                            width: '8px', 
                                                            height: '8px', 
                                                            borderRadius: '2px', 
                                                            backgroundColor: ACTIVITY_CONFIG[activity.name]?.color 
                                                        }} />
                                                        {ACTIVITY_CONFIG[activity.name]?.label || activity.name}
                                                    </span>
                                                    {activityFilter === activity.name && <Check size={12} />}
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            </div>
                            
                            {(() => {
                                // Calculate average based on filter
                                let avgHours: number;
                                if (activityFilter === 'all') {
                                    avgHours = analytics.daily_breakdown.reduce((sum, d) => sum + d.total_hours, 0) / 7;
                                } else {
                                    avgHours = analytics.daily_breakdown.reduce((sum, d) => {
                                        const activity = d.activities.find(a => a.name === activityFilter);
                                        return sum + (activity?.hours || 0);
                                    }, 0) / 7;
                                }
                                // Bar area is 140px, labels below take ~30px, chart height is 180px with 24px paddingTop
                                // Position from bottom: bar area starts at ~30px from bottom
                                const barAreaBottom = 30; // space for day labels and hours labels
                                const barAreaHeight = 140;
                                const avgLinePosition = barAreaBottom + (avgHours / 24) * barAreaHeight;
                                return (
                                    <div style={{ 
                                        display: 'flex', 
                                        alignItems: 'flex-end', 
                                        justifyContent: 'space-between',
                                        height: '180px',
                                        gap: '0.5rem',
                                        paddingTop: '1.5rem',
                                        position: 'relative'
                                    }}>
                                        {/* Y-axis labels */}
                                        <div style={{
                                            position: 'absolute',
                                            left: 0,
                                            top: 0,
                                            bottom: '24px',
                                            width: '30px',
                                            display: 'flex',
                                            flexDirection: 'column',
                                            justifyContent: 'space-between',
                                            pointerEvents: 'none'
                                        }}>
                                            {[24, 18, 12, 6, 0].map(h => (
                                                <span key={h} style={{ 
                                                    fontSize: '0.65rem', 
                                                    color: 'var(--text-tertiary)',
                                                    textAlign: 'right',
                                                    paddingRight: '4px'
                                                }}>
                                                    {h}h
                                                </span>
                                            ))}
                                        </div>

                                        {/* Average line */}
                                        {avgHours > 0 && (
                                            <div style={{
                                                position: 'absolute',
                                                left: '30px',
                                                right: 0,
                                                bottom: `${avgLinePosition}px`,
                                                height: '1px',
                                                background: 'repeating-linear-gradient(to right, rgba(234, 179, 8, 0.6) 0px, rgba(234, 179, 8, 0.6) 8px, transparent 8px, transparent 12px)',
                                                pointerEvents: 'none',
                                                zIndex: 10
                                            }}>
                                                <span style={{
                                                    position: 'absolute',
                                                    right: 0,
                                                    top: '-14px',
                                                    fontSize: '0.55rem',
                                                    color: '#eab308',
                                                    backgroundColor: 'rgba(255, 255, 255, 0.1)',
                                                    backdropFilter: 'blur(8px)',
                                                    WebkitBackdropFilter: 'blur(8px)',
                                                    padding: '2px 6px',
                                                    borderRadius: '4px',
                                                    fontWeight: 500,
                                                    border: '1px solid rgba(234, 179, 8, 0.2)'
                                                }}>
                                                    avg {avgHours.toFixed(1)}h
                                                </span>
                                            </div>
                                        )}
                                        
                                        {/* Bars */}
                                        <div style={{
                                            display: 'flex',
                                            alignItems: 'flex-end',
                                            justifyContent: 'space-around',
                                            flex: 1,
                                            marginLeft: '30px',
                                            height: '100%',
                                            gap: '0.5rem'
                                        }}>
                                            {analytics.daily_breakdown.map((day, index) => (
                                                <DayBar 
                                                    key={day.date} 
                                                    day={day} 
                                                    animate={animateBars}
                                                    delay={index * 0.05}
                                                    activityFilter={activityFilter}
                                                />
                                            ))}
                                        </div>
                                    </div>
                                );
                            })()}
                        </div>

                        {/* Activity Summary List */}
                        <div 
                            className="card glass-card" 
                            style={{ 
                                padding: '1rem',
                                animation: animateBars ? 'fadeInUp 0.4s ease-out 0.1s forwards' : 'none',
                                opacity: animateBars ? 1 : 0,
                                transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)'
                            }}
                        >
                            <div style={{ 
                                display: 'flex', 
                                alignItems: 'center', 
                                justifyContent: 'space-between',
                                marginBottom: '0.75rem'
                            }}>
                                <h3 style={{ 
                                    fontSize: '0.9rem', 
                                    fontWeight: 600, 
                                    color: 'var(--text-primary)',
                                    margin: 0
                                }}>
                                    Activity Breakdown
                                </h3>
                                <button
                                    onClick={toggleSortOrder}
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '0.25rem',
                                        padding: '0.375rem 0.625rem',
                                        background: 'var(--tile-glass-bg)',
                                        backdropFilter: 'blur(8px)',
                                        WebkitBackdropFilter: 'blur(8px)',
                                        border: '1px solid var(--tile-glass-border)',
                                        borderRadius: '10px',
                                        cursor: 'pointer',
                                        fontSize: '0.75rem',
                                        color: 'var(--text-secondary)',
                                        transition: 'all 0.2s'
                                    }}
                                    onMouseEnter={(e) => {
                                        e.currentTarget.style.transform = 'translateY(-1px)';
                                        e.currentTarget.style.borderColor = 'var(--accent)';
                                    }}
                                    onMouseLeave={(e) => {
                                        e.currentTarget.style.transform = 'translateY(0)';
                                        e.currentTarget.style.borderColor = 'var(--tile-glass-border)';
                                    }}
                                >
                                    <ArrowUpDown size={12} />
                                    {sortOrder === 'desc' ? 'High to Low' : 'Low to High'}
                                </button>
                            </div>

                            {sortedActivitySummary.length > 0 ? (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                                    {sortedActivitySummary.map((activity, index) => (
                                        <ActivityRow 
                                            key={activity.name} 
                                            activity={activity}
                                            maxHours={Math.max(...sortedActivitySummary.map(a => a.total_hours))}
                                            delay={index * 0.03}
                                            animate={animateBars}
                                        />
                                    ))}
                                </div>
                            ) : (
                                <div style={{ 
                                    padding: '2rem', 
                                    textAlign: 'center', 
                                    color: 'var(--text-secondary)' 
                                }}>
                                    No activities logged this week
                                </div>
                            )}
                        </div>
                    </>
                ) : isPrivateAccount ? (
                    <div className="card glass-card" style={{
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        padding: '2rem 1.5rem',
                        textAlign: 'center',
                    }}>
                        <div style={{
                            width: '56px',
                            height: '56px',
                            borderRadius: '50%',
                            background: 'linear-gradient(135deg, rgba(255,255,255,0.15) 0%, rgba(255,255,255,0.05) 100%)',
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
                            margin: 0,
                            fontSize: '0.8rem',
                            color: 'var(--text-secondary)',
                        }}>
                            @{targetUsername}'s analytics are hidden
                        </p>
                    </div>
                ) : (
                    <div className="card glass-card" style={{ padding: '3rem', textAlign: 'center' }}>
                        <p style={{ color: 'var(--text-secondary)' }}>
                            Unable to load analytics
                        </p>
                    </div>
                )}
            </div>
        </>
    );
};

// Day Bar Component
const DayBar: React.FC<{ day: DayAnalytics; animate: boolean; delay: number; activityFilter?: string }> = ({ day, animate, delay, activityFilter = 'all' }) => {
    const maxHeight = 140;
    
    // Calculate hours based on filter
    let displayHours = day.total_hours;
    let barColor = 'var(--accent)';
    
    if (activityFilter !== 'all') {
        // Find the specific activity
        const filteredActivity = day.activities.find(a => a.name === activityFilter);
        displayHours = filteredActivity?.hours || 0;
        barColor = ACTIVITY_CONFIG[activityFilter as keyof typeof ACTIVITY_CONFIG]?.color || '#64748b';
    }
    
    const barHeight = Math.min((displayHours / 24) * maxHeight, maxHeight);
    
    // Get top 3 activities and others (for stacked view)
    const topActivities = day.activities.slice(0, 3);
    const othersHours = day.activities.slice(3).reduce((sum, a) => sum + a.hours, 0);
    
    return (
        <div style={{ 
            display: 'flex', 
            flexDirection: 'column', 
            alignItems: 'center',
            flex: 1,
            maxWidth: '36px'
        }}>
            {/* Bar */}
            <div 
                style={{ 
                    width: '100%',
                    height: `${maxHeight}px`,
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'flex-end',
                    position: 'relative'
                }}
            >
                {displayHours > 0 ? (
                    <div 
                        style={{
                            display: 'flex',
                            flexDirection: 'column',
                            height: animate ? `${barHeight}px` : '0px',
                            transition: `height 0.6s cubic-bezier(0.34, 1.56, 0.64, 1) ${delay}s`,
                            overflow: 'hidden'
                        }}
                    >
                        {activityFilter !== 'all' ? (
                            // Single activity filter - show single color bar
                            <div 
                                style={{
                                    flex: 1,
                                    backgroundColor: barColor,
                                    minHeight: '2px'
                                }}
                                title={`${ACTIVITY_CONFIG[activityFilter as keyof typeof ACTIVITY_CONFIG]?.label}: ${displayHours.toFixed(1)}h`}
                            />
                        ) : (
                            // All activities - stacked segments
                            (() => {
                                const segments: { name: string; hours: number; color: string }[] = [];
                                
                                // Others segment goes first (top)
                                if (othersHours > 0) {
                                    segments.push({ name: 'Others', hours: othersHours, color: 'var(--text-tertiary)' });
                                }
                                
                                // Top activities in reverse order (so highest hours appears lower in the bar)
                                [...topActivities].reverse().forEach((activity) => {
                                    segments.push({
                                        name: activity.name,
                                        hours: activity.hours,
                                        color: ACTIVITY_CONFIG[activity.name]?.color || '#64748b'
                                    });
                                });
                                
                                return segments.map((seg) => (
                                    <div 
                                        key={seg.name}
                                        style={{
                                            flex: seg.hours,
                                            backgroundColor: seg.color,
                                            minHeight: '2px'
                                        }}
                                        title={`${seg.name === 'Others' ? 'Others' : ACTIVITY_CONFIG[seg.name as keyof typeof ACTIVITY_CONFIG]?.label}: ${seg.hours.toFixed(1)}h`}
                                    />
                                ));
                            })()
                        )}
                    </div>
                ) : (
                    <div style={{
                        height: '4px',
                        backgroundColor: 'var(--bg-secondary)',
                        borderRadius: '2px'
                    }} />
                )}
            </div>
            
            {/* Day label */}
            <span style={{ 
                fontSize: '0.7rem', 
                color: 'var(--text-secondary)',
                marginTop: '0.5rem',
                fontWeight: 500
            }}>
                {day.day_name}
            </span>
            
            {/* Hours label */}
            <span style={{ 
                fontSize: '0.6rem', 
                color: 'var(--text-tertiary)',
                marginTop: '0.125rem'
            }}>
                {displayHours > 0 ? `${displayHours.toFixed(1)}h` : '-'}
            </span>
        </div>
    );
};

// Activity Row Component
const ActivityRow: React.FC<{ 
    activity: ActivitySummary; 
    maxHours: number;
    delay: number;
    animate: boolean;
}> = ({ activity, maxHours, delay, animate }) => {
    const config = ACTIVITY_CONFIG[activity.name];
    const Icon = config?.icon || Coffee;
    const color = config?.color || '#64748b';
    const label = config?.label || activity.name;
    const percentage = maxHours > 0 ? (activity.total_hours / maxHours) * 100 : 0;
    
    return (
        <div 
            className="activity-row"
            style={{ 
                display: 'flex', 
                alignItems: 'center', 
                gap: '0.5rem',
                padding: '0.4rem 0.25rem',
                borderRadius: '6px',
                cursor: 'default',
                animation: animate ? `fadeInUp 0.3s ease-out ${delay}s forwards` : 'none',
                opacity: animate ? 1 : 0
            }}
        >
            {/* Icon */}
            <div style={{
                width: '28px',
                height: '28px',
                borderRadius: '6px',
                backgroundColor: `${color}20`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0
            }}>
                <Icon size={14} color={color} />
            </div>
            
            {/* Info */}
            <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ 
                    display: 'flex', 
                    alignItems: 'center', 
                    justifyContent: 'space-between',
                    marginBottom: '0.25rem'
                }}>
                    <span style={{ 
                        fontSize: '0.8rem', 
                        fontWeight: 500, 
                        color: 'var(--text-primary)'
                    }}>
                        {label}
                    </span>
                    <span style={{ 
                        fontSize: '0.8rem', 
                        fontWeight: 600, 
                        color: 'var(--text-primary)'
                    }}>
                        {activity.total_hours.toFixed(1)}h
                    </span>
                </div>
                
                {/* Progress bar */}
                <div style={{
                    height: '6px',
                    backgroundColor: 'var(--bg-secondary)',
                    borderRadius: '3px',
                    overflow: 'hidden'
                }}>
                    <div style={{
                        height: '100%',
                        width: animate ? `${percentage}%` : '0%',
                        backgroundColor: color,
                        borderRadius: '3px',
                        transition: `width 0.6s cubic-bezier(0.34, 1.56, 0.64, 1) ${delay}s`
                    }} />
                </div>
            </div>
        </div>
    );
};

export default AnalyticsPage;
