/**
 * AnalyticsPage Component
 *
 * Displays weekly analytics with charts, activity breakdown, and streak stats.
 * Supports viewing own analytics or another user's (if not private).
 */

import {
  ArrowLeft,
  ArrowUpDown,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Flame,
  Lock,
  TrendingDown,
  TrendingUp,
  Trophy,
  Users,
  X,
} from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { getActivityConfig, STORAGE_KEYS } from '../../constants';
import { APP_ROUTES } from '../../constants/routes';
import { api, ApiError, userApi } from '../../services/api';
import { useAuth } from '../../store';
import type { ActivityName, CustomTile, WeekAnalyticsResponse } from '../../types';
import type { AutocompleteSuggestion } from '../../types/autocomplete';
import { VerifiedBadge } from '../ui';
import { Autocomplete } from '../ui/Autocomplete';
import { ActivityRow, DayBar } from './components';

// Utility functions
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

// CSS Styles
const ANALYTICS_STYLES = `
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
`;

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
  const [activityFilter, setActivityFilter] = useState<string[]>([]);
  const [showActivityFilter, setShowActivityFilter] = useState(false);
  const activityFilterRef = useRef<HTMLDivElement>(null);
  const [animateStats, setAnimateStats] = useState(false);
  const [animateBars, setAnimateBars] = useState(false);

  // User selector state
  const [showUserSelector, setShowUserSelector] = useState(false);
  const userSelectorRef = useRef<HTMLDivElement>(null);

  // Target username and verification status
  const targetUsername = searchParams.get('user') || routeUsername || user?.username || '';
  const [targetIsVerified, setTargetIsVerified] = useState<boolean>(false);

  // Custom tiles and color overrides for activity display
  const [customTiles, setCustomTiles] = useState<CustomTile[]>([]);
  const [tileColors, setTileColors] = useState<Record<string, string>>({});

  // Load custom tiles and colors based on target user
  useEffect(() => {
    const loadTileConfig = async () => {
      const isViewingOwn = targetUsername === user?.username;

      if (isViewingOwn) {
        // Load own config from localStorage first (immediate)
        try {
          const localCustomTiles = localStorage.getItem(STORAGE_KEYS.CUSTOM_TILES);
          const localColors = localStorage.getItem(STORAGE_KEYS.TILE_COLORS);
          if (localCustomTiles) {
            const parsed = JSON.parse(localCustomTiles);
            if (Array.isArray(parsed)) setCustomTiles(parsed);
          }
          if (localColors) {
            const parsed = JSON.parse(localColors);
            if (parsed && typeof parsed === 'object') setTileColors(parsed);
          }
        } catch (e) {
          console.error('Failed to load tile config from localStorage', e);
        }

        // Then fetch from backend (may have more recent data)
        try {
          const res = await api.get('/tile-config');
          if (res.success && res.data) {
            if (res.data.customTiles && Array.isArray(res.data.customTiles)) {
              setCustomTiles(res.data.customTiles);
            }
            if (res.data.colors && typeof res.data.colors === 'object') {
              setTileColors(res.data.colors);
            }
          }
        } catch {
          // API failed, but we already loaded from localStorage
        }
      } else {
        // Viewing another user's analytics - fetch their tile config
        try {
          const res = await api.post('/tile-config/user', { username: targetUsername });
          if (res.success && res.data) {
            if (res.data.customTiles && Array.isArray(res.data.customTiles)) {
              setCustomTiles(res.data.customTiles);
            } else {
              setCustomTiles([]);
            }
            if (res.data.colors && typeof res.data.colors === 'object') {
              setTileColors(res.data.colors);
            } else {
              setTileColors({});
            }
          } else {
            setCustomTiles([]);
            setTileColors({});
          }
        } catch {
          setCustomTiles([]);
          setTileColors({});
        }
      }
    };

    if (targetUsername) {
      loadTileConfig();
    }
  }, [targetUsername, user?.username]);

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

  // Autocomplete fetch function
  const fetchSuggestions = useCallback(
    async (query: string, signal: AbortSignal): Promise<AutocompleteSuggestion[]> => {
      try {
        const response = await userApi.autocomplete(query, 12, signal);
        return response.suggestions || [];
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          throw error;
        }
        console.error('Autocomplete failed:', error);
        return [];
      }
    },
    []
  );

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

        // Reset activity filter if selected activities don't exist in new week's data
        setActivityFilter((prev) => {
          if (prev.length === 0) return [];
          const validActivities = prev.filter((p) =>
            analyticsData.activity_summary?.some((a) => a.name === p)
          );
          return validActivities;
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

  // Fetch target user's verification status
  useEffect(() => {
    const fetchTargetUserVerification = async () => {
      if (!targetUsername) return;

      try {
        const res = await api.post('/users', { username: targetUsername });
        if (res.success && res.data && res.data.length > 0) {
          const exactMatch = res.data.find(
            (u: { username: string }) => u.username.toLowerCase() === targetUsername.toLowerCase()
          );
          if (exactMatch) {
            setTargetIsVerified(exactMatch.is_verified || false);
          }
        }
      } catch (err) {
        console.error('Failed to fetch target user verification', err);
      }
    };
    fetchTargetUserVerification();
  }, [targetUsername]);

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
      if (window.history.length > 2 && window.history.state?.idx > 0) {
        navigate(-1);
      } else {
        navigate(APP_ROUTES.HOME, { replace: true });
      }
    }, 200);
  };

  const handleUserSelect = (username: string) => {
    setShowUserSelector(false);
    navigate(APP_ROUTES.USER_ANALYTICS(username), { replace: true });
  };

  const handleAutocompleteSelect = (suggestion: AutocompleteSuggestion) => {
    handleUserSelect(suggestion.text);
  };

  const toggleSortOrder = () => {
    setSortOrder((prev) => (prev === 'desc' ? 'asc' : 'desc'));
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

  // Calculate average for the chart
  const calculateAverage = () => {
    if (!analytics) return 0;
    if (activityFilter.length === 0) {
      return analytics.daily_breakdown.reduce((sum, d) => sum + d.total_hours, 0) / 7;
    }
    return (
      analytics.daily_breakdown.reduce((sum, d) => {
        const filteredHours = d.activities
          .filter((a) => activityFilter.includes(a.name))
          .reduce((h, a) => h + a.hours, 0);
        return sum + filteredHours;
      }, 0) / 7
    );
  };

  return (
    <>
      <style>{ANALYTICS_STYLES}</style>

      <div
        className="container"
        style={{
          maxWidth: '600px',
          padding: '0.5rem 1rem',
          paddingBottom: '2rem',
          animation: isExiting
            ? 'slideOutToRight 0.2s ease-in forwards'
            : 'slideInFromRight 0.25s ease-out',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            marginBottom: '1rem',
          }}
        >
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
              transition: 'background-color 0.2s',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--bg-secondary)')}
            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
          >
            <ArrowLeft size={20} />
          </button>
          <h1
            style={{
              fontSize: '1.25rem',
              fontWeight: 700,
              color: 'var(--text-primary)',
              margin: 0,
              flex: 1,
            }}
          >
            Analytics
          </h1>
        </div>

        {/* User Selector */}
        <div ref={userSelectorRef} style={{ position: 'relative', marginBottom: '1rem' }}>
          {showUserSelector ? (
            <Autocomplete
              placeholder="Search users..."
              onSelect={handleAutocompleteSelect}
              fetchSuggestions={fetchSuggestions}
              minChars={1}
              debounceMs={150}
              autoFocus
              onBlur={() => setShowUserSelector(false)}
            />
          ) : (
            <button
              onClick={() => setShowUserSelector(true)}
              style={{
                width: '100%',
                padding: '0.75rem 1rem',
                background: 'var(--tile-glass-bg)',
                backdropFilter: 'blur(var(--tile-glass-blur))',
                WebkitBackdropFilter: 'blur(var(--tile-glass-blur))',
                border: '1px solid var(--tile-glass-border)',
                boxShadow: 'var(--tile-glass-shadow), var(--tile-glass-inner-glow)',
                borderRadius: 'var(--radius-full)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                cursor: 'pointer',
                transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Users size={18} color="var(--text-secondary)" />
                <span
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '2px',
                    color: 'var(--text-primary)',
                    fontWeight: 500,
                    fontSize: '0.95rem',
                  }}
                >
                  {targetUsername}
                  {targetIsVerified && <VerifiedBadge size={14} />}
                </span>
              </div>
              <ChevronDown size={16} color="var(--text-secondary)" />
            </button>
          )}
        </div>

        {/* Week Navigator */}
        <div
          className="card glass-card"
          style={{
            padding: '0.75rem 1rem',
            marginBottom: '1rem',
            transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
          }}
        >
          {/* Date Navigation Row */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingBottom: loading ? '0' : '0.75rem',
              borderBottom: loading ? 'none' : '1px solid var(--border)',
            }}
          >
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
                transition: 'all 0.2s',
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
            <span
              style={{
                fontWeight: 600,
                color: 'var(--text-primary)',
                fontSize: '0.9rem',
              }}
            >
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
                transition: 'all 0.2s',
              }}
              onMouseEnter={(e) => {
                if (!isNextDisabled()) {
                  e.currentTarget.style.backgroundColor = 'var(--bg-secondary)';
                  e.currentTarget.style.color = 'var(--text-primary)';
                }
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = 'transparent';
                e.currentTarget.style.color = isNextDisabled()
                  ? 'var(--text-tertiary)'
                  : 'var(--text-secondary)';
              }}
            >
              <ChevronRight size={20} />
            </button>
          </div>

          {/* Stats Row */}
          {!loading && analytics && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '0.5rem',
                paddingTop: '0.75rem',
                animation: animateStats ? 'fadeInUp 0.4s ease-out forwards' : 'none',
                opacity: animateStats ? 1 : 0,
              }}
            >
              {/* Total Hours */}
              <div style={{ flex: 1, textAlign: 'center' }}>
                <div
                  style={{
                    fontSize: '0.95rem',
                    fontWeight: 600,
                    color: 'var(--text-primary)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '0.25rem',
                  }}
                >
                  {analytics.total_hours_this_week.toFixed(1)}h
                  {(analytics.is_current_week ?? true) ? (
                    <span
                      style={{
                        fontSize: '0.65rem',
                        color: (analytics.percentage_change ?? 0) >= 0 ? '#10b981' : '#ef4444',
                        fontWeight: 500,
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.1rem',
                      }}
                    >
                      {(analytics.percentage_change ?? 0) >= 0 ? (
                        <TrendingUp size={10} color="#10b981" />
                      ) : (
                        <TrendingDown size={10} color="#ef4444" />
                      )}
                      {(analytics.percentage_change ?? 0) >= 0 ? '+' : ''}
                      {(analytics.percentage_change ?? 0).toFixed(0)}%
                    </span>
                  ) : (
                    <span
                      style={{
                        fontSize: '0.65rem',
                        color: (analytics.percentage_vs_current ?? 0) >= 0 ? '#10b981' : '#ef4444',
                        fontWeight: 500,
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.1rem',
                      }}
                    >
                      {(analytics.percentage_vs_current ?? 0) >= 0 ? (
                        <TrendingUp size={10} color="#10b981" />
                      ) : (
                        <TrendingDown size={10} color="#ef4444" />
                      )}
                      {(analytics.percentage_vs_current ?? 0) >= 0 ? '+' : ''}
                      {(analytics.percentage_vs_current ?? 0).toFixed(0)}%
                    </span>
                  )}
                </div>
                <div
                  style={{
                    fontSize: '0.65rem',
                    color: 'var(--text-tertiary)',
                    marginTop: '0.2rem',
                  }}
                >
                  {(analytics.is_current_week ?? true) ? 'vs last week' : 'vs this week'}
                </div>
              </div>

              {/* Divider */}
              <div style={{ width: '1px', height: '32px', backgroundColor: 'var(--border)' }} />

              {/* Current Streak */}
              <div style={{ flex: 1, textAlign: 'center' }}>
                <div
                  style={{
                    fontSize: '0.95rem',
                    fontWeight: 600,
                    color: 'var(--text-primary)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '0.25rem',
                  }}
                >
                  <Flame size={16} fill="#f87171" color="#ef4444" />
                  {analytics.streak.current}
                </div>
                <div
                  style={{
                    fontSize: '0.65rem',
                    color: 'var(--text-tertiary)',
                    marginTop: '0.2rem',
                  }}
                >
                  Current Streak
                </div>
              </div>

              {/* Divider */}
              <div style={{ width: '1px', height: '32px', backgroundColor: 'var(--border)' }} />

              {/* Longest Streak */}
              <div style={{ flex: 1, textAlign: 'center' }}>
                <div
                  style={{
                    fontSize: '0.95rem',
                    fontWeight: 600,
                    color: 'var(--text-primary)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '0.25rem',
                  }}
                >
                  <Trophy size={16} fill="#fbbf24" color="#f59e0b" />
                  {analytics.streak.longest}
                </div>
                <div
                  style={{
                    fontSize: '0.65rem',
                    color: 'var(--text-tertiary)',
                    marginTop: '0.2rem',
                  }}
                >
                  {analytics.streak.longest_start && analytics.streak.longest_end ? (
                    <span>
                      {new Date(analytics.streak.longest_start).toLocaleDateString('en-US', {
                        month: 'short',
                        day: 'numeric',
                      })}{' '}
                      -{' '}
                      {new Date(analytics.streak.longest_end).toLocaleDateString('en-US', {
                        month: 'short',
                        day: 'numeric',
                      })}
                    </span>
                  ) : (
                    'Best Streak'
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {loading ? (
          // Skeleton Loaders
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div className="skeleton" style={{ height: '70px' }} />
            <div className="skeleton" style={{ height: '240px' }} />
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
                transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
                overflow: 'visible',
                position: 'relative',
                zIndex: 10,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: '1rem',
                }}
              >
                <h3
                  style={{
                    fontSize: '0.9rem',
                    fontWeight: 600,
                    color: 'var(--text-primary)',
                    margin: 0,
                  }}
                >
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
                      transition: 'all 0.2s',
                    }}
                  >
                    {activityFilter.length === 0
                      ? 'All Activities'
                      : activityFilter.length === 1
                        ? getActivityConfig(
                            activityFilter[0] as ActivityName,
                            customTiles,
                            tileColors
                          ).label
                        : `${activityFilter.length} Activities`}
                    <ChevronDown
                      size={12}
                      style={{
                        transition: 'transform 0.2s',
                        transform: showActivityFilter ? 'rotate(180deg)' : 'rotate(0deg)',
                      }}
                    />
                  </button>
                  {showActivityFilter && (
                    <div
                      style={{
                        position: 'absolute',
                        top: '100%',
                        right: 0,
                        marginTop: '0.25rem',
                        background: 'var(--tile-glass-bg)',
                        backdropFilter: 'blur(16px)',
                        WebkitBackdropFilter: 'blur(16px)',
                        border: '1px solid var(--tile-glass-border)',
                        borderRadius: '12px',
                        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.3)',
                        zIndex: 9999,
                        minWidth: '160px',
                        maxHeight: '250px',
                        overflowY: 'auto',
                      }}
                    >
                      <div
                        onClick={() => {
                          setActivityFilter([]);
                        }}
                        style={{
                          padding: '0.5rem 0.75rem',
                          fontSize: '0.75rem',
                          color:
                            activityFilter.length === 0 ? 'var(--accent)' : 'var(--text-primary)',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          transition: 'background 0.15s',
                          borderBottom: '1px solid var(--tile-glass-border)',
                        }}
                        onMouseEnter={(e) =>
                          (e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)')
                        }
                        onMouseLeave={(e) =>
                          (e.currentTarget.style.backgroundColor = 'transparent')
                        }
                      >
                        All Activities
                        {activityFilter.length === 0 && <Check size={12} />}
                      </div>
                      {activityFilter.length > 0 && (
                        <div
                          onClick={() => {
                            setActivityFilter([]);
                          }}
                          style={{
                            padding: '0.4rem 0.75rem',
                            fontSize: '0.7rem',
                            color: 'var(--text-tertiary)',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.25rem',
                            transition: 'background 0.15s',
                            borderBottom: '1px solid var(--tile-glass-border)',
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)';
                            e.currentTarget.style.color = 'var(--text-secondary)';
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.backgroundColor = 'transparent';
                            e.currentTarget.style.color = 'var(--text-tertiary)';
                          }}
                        >
                          <X size={10} />
                          Clear selection ({activityFilter.length})
                        </div>
                      )}
                      {analytics.activity_summary.map((activity) => {
                        const config = getActivityConfig(
                          activity.name as ActivityName,
                          customTiles,
                          tileColors
                        );
                        const isSelected = activityFilter.includes(activity.name);
                        return (
                          <div
                            key={activity.name}
                            onClick={(e) => {
                              e.stopPropagation();
                              setActivityFilter((prev) => {
                                if (prev.includes(activity.name)) {
                                  return prev.filter((a) => a !== activity.name);
                                } else {
                                  return [...prev, activity.name];
                                }
                              });
                            }}
                            style={{
                              padding: '0.5rem 0.75rem',
                              fontSize: '0.75rem',
                              color: isSelected ? 'var(--accent)' : 'var(--text-primary)',
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              gap: '0.5rem',
                              transition: 'background 0.15s',
                            }}
                            onMouseEnter={(e) =>
                              (e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)')
                            }
                            onMouseLeave={(e) =>
                              (e.currentTarget.style.backgroundColor = 'transparent')
                            }
                          >
                            <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                              <span
                                style={{
                                  width: '14px',
                                  height: '14px',
                                  borderRadius: '3px',
                                  backgroundColor: isSelected ? config.color : 'transparent',
                                  border: `2px solid ${config.color}`,
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  transition: 'all 0.15s',
                                }}
                              >
                                {isSelected && <Check size={10} color="white" strokeWidth={3} />}
                              </span>
                              {config.label || activity.name}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>

              {/* Chart Area */}
              {(() => {
                const avgHours = calculateAverage();
                const barAreaBottom = 30;
                const barAreaHeight = 140;
                const avgLinePosition = barAreaBottom + (avgHours / 24) * barAreaHeight;

                return (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'flex-end',
                      justifyContent: 'space-between',
                      height: '180px',
                      gap: '0.5rem',
                      paddingTop: '1.5rem',
                      position: 'relative',
                    }}
                  >
                    {/* Y-axis labels */}
                    <div
                      style={{
                        position: 'absolute',
                        left: 0,
                        top: 0,
                        bottom: '24px',
                        width: '30px',
                        display: 'flex',
                        flexDirection: 'column',
                        justifyContent: 'space-between',
                        pointerEvents: 'none',
                      }}
                    >
                      {[24, 18, 12, 6, 0].map((h) => (
                        <span
                          key={h}
                          style={{
                            fontSize: '0.65rem',
                            color: 'var(--text-tertiary)',
                            textAlign: 'right',
                            paddingRight: '4px',
                          }}
                        >
                          {h}h
                        </span>
                      ))}
                    </div>

                    {/* Average line */}
                    {avgHours > 0 && (
                      <div
                        style={{
                          position: 'absolute',
                          left: '30px',
                          right: 0,
                          bottom: `${avgLinePosition}px`,
                          height: '1px',
                          background:
                            'repeating-linear-gradient(to right, rgba(234, 179, 8, 0.6) 0px, rgba(234, 179, 8, 0.6) 8px, transparent 8px, transparent 12px)',
                          pointerEvents: 'none',
                          zIndex: 10,
                        }}
                      >
                        <span
                          style={{
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
                            border: '1px solid rgba(234, 179, 8, 0.2)',
                          }}
                        >
                          avg {avgHours.toFixed(1)}h
                        </span>
                      </div>
                    )}

                    {/* Bars */}
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'flex-end',
                        justifyContent: 'space-around',
                        flex: 1,
                        marginLeft: '30px',
                        height: '100%',
                        gap: '0.5rem',
                      }}
                    >
                      {analytics.daily_breakdown.map((day, index) => (
                        <DayBar
                          key={day.date}
                          day={day}
                          animate={animateBars}
                          delay={index * 0.05}
                          activityFilter={activityFilter}
                          customTiles={customTiles}
                          tileColors={tileColors}
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
                transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: '0.75rem',
                }}
              >
                <h3
                  style={{
                    fontSize: '0.9rem',
                    fontWeight: 600,
                    color: 'var(--text-primary)',
                    margin: 0,
                  }}
                >
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
                    transition: 'all 0.2s',
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
                      maxHours={Math.max(...sortedActivitySummary.map((a) => a.total_hours))}
                      delay={index * 0.03}
                      animate={animateBars}
                      customTiles={customTiles}
                      tileColors={tileColors}
                    />
                  ))}
                </div>
              ) : (
                <div
                  style={{
                    padding: '2rem',
                    textAlign: 'center',
                    color: 'var(--text-secondary)',
                  }}
                >
                  No activities logged this week
                </div>
              )}
            </div>
          </>
        ) : isPrivateAccount ? (
          <div
            className="card glass-card"
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '2rem 1.5rem',
              textAlign: 'center',
            }}
          >
            <div
              style={{
                width: '56px',
                height: '56px',
                borderRadius: '50%',
                background:
                  'linear-gradient(135deg, rgba(255,255,255,0.15) 0%, rgba(255,255,255,0.05) 100%)',
                border: '2px solid var(--tile-glass-border)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                marginBottom: '12px',
                boxShadow: '0 4px 16px rgba(0, 0, 0, 0.1)',
              }}
            >
              <Lock size={24} style={{ color: 'var(--text-secondary)' }} />
            </div>
            <h3
              style={{
                margin: '0 0 4px 0',
                fontSize: '1rem',
                fontWeight: 600,
                color: 'var(--text-primary)',
              }}
            >
              Private Account
            </h3>
            <p
              style={{
                margin: 0,
                fontSize: '0.8rem',
                color: 'var(--text-secondary)',
              }}
            >
              @{targetUsername}'s analytics are hidden
            </p>
          </div>
        ) : (
          <div className="card glass-card" style={{ padding: '3rem', textAlign: 'center' }}>
            <p style={{ color: 'var(--text-secondary)' }}>Unable to load analytics</p>
          </div>
        )}
      </div>
    </>
  );
};

export default AnalyticsPage;
