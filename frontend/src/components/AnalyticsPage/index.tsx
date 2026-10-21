/**
 * AnalyticsPage Component ("Insights")
 *
 * Displays weekly analytics with charts, activity breakdown, and streak stats.
 * Supports viewing own analytics or another user's (if not private).
 */

import {
  AlertTriangle,
  BarChart3,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Flame,
  Lock,
  RefreshCw,
  TrendingDown,
  TrendingUp,
  Trophy,
  Users,
  UserX,
  X,
} from 'lucide-react';
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { getActivityConfig, STORAGE_KEYS } from '../../constants';
import { APP_ROUTES } from '../../constants/routes';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import { useSmartBack } from '../../hooks/useSmartBack';
import { api, ApiError, userApi } from '../../services/api';
import { useAuth } from '../../store';
import type { ActivityName, CustomTile, DayAnalytics, WeekAnalyticsResponse } from '../../types';
import type { AutocompleteSuggestion } from '../../types/autocomplete';
import { EmptyState, PageHeader, Skeleton, VerifiedBadge } from '../ui';
import { Autocomplete } from '../ui/Autocomplete';
import styles from './AnalyticsPage.module.css';
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
    return `${startMonth} ${startDay} – ${endDay}, ${year}`;
  }
  return `${startMonth} ${startDay} – ${endMonth} ${endDay}, ${year}`;
};

/**
 * Parses a backend calendar date ("YYYY-MM-DD", optionally with a time part) as a local date.
 * `new Date('2025-03-03')` is UTC midnight, which shows the previous day west of UTC.
 */
const parseCalendarDate = (value: string): Date | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (match) return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

/** Compact streak range: "Mar 3 – 9", "Feb 27 – Mar 4" or "Mar 3" */
const formatStreakRange = (start?: string, end?: string): string | null => {
  if (!start || !end) return null;
  const startDate = parseCalendarDate(start);
  const endDate = parseCalendarDate(end);
  if (!startDate || !endDate) return null;

  const startMonth = startDate.toLocaleDateString('en-US', { month: 'short' });
  const endMonth = endDate.toLocaleDateString('en-US', { month: 'short' });
  if (startDate.getTime() === endDate.getTime()) {
    return `${startMonth} ${startDate.getDate()}`;
  }
  if (startMonth === endMonth && startDate.getFullYear() === endDate.getFullYear()) {
    return `${startMonth} ${startDate.getDate()} – ${endDate.getDate()}`;
  }
  return `${startMonth} ${startDate.getDate()} – ${endMonth} ${endDate.getDate()}`;
};

const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

/** "This week", "Last week" or "3 weeks ago" relative to the current week */
const getWeekBadge = (weekStart: Date): string => {
  const weeksAgo = Math.round(
    (getWeekStart(new Date()).getTime() - weekStart.getTime()) / MS_PER_WEEK
  );
  if (weeksAgo <= 0) return 'This week';
  if (weeksAgo === 1) return 'Last week';
  return `${weeksAgo} weeks ago`;
};

const MAX_DAY_HOURS = 24;
/** Y-axis maxima (split into 4 equal steps); the smallest one that fits the tallest bar wins */
const CHART_SCALES = [2, 4, 8, 12, 16, 20, MAX_DAY_HOURS];
const CHART_STEPS = 4;

const getChartScale = (maxHours: number): number =>
  CHART_SCALES.find((scale) => maxHours <= scale) ?? MAX_DAY_HOURS;

const getChartTicks = (scaleMax: number): number[] =>
  Array.from({ length: CHART_STEPS + 1 }, (_, i) => (scaleMax * (CHART_STEPS - i)) / CHART_STEPS);

type LoadError = 'not_found' | 'failed';

export const AnalyticsPage: React.FC = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { username: routeUsername } = useParams<{ username: string }>();
  const [searchParams] = useSearchParams();

  const [loading, setLoading] = useState(true);
  const [weekStart, setWeekStart] = useState(() => getWeekStart(new Date()));
  const [analytics, setAnalytics] = useState<WeekAnalyticsResponse | null>(null);
  const [isPrivateAccount, setIsPrivateAccount] = useState(false);
  const [loadError, setLoadError] = useState<LoadError | null>(null);
  const [sortOrder, setSortOrder] = useState<'desc' | 'asc'>('desc');
  const [activityFilter, setActivityFilter] = useState<string[]>([]);
  const [showActivityFilter, setShowActivityFilter] = useState(false);
  const activityFilterRef = useRef<HTMLDivElement>(null);
  const filterButtonRef = useRef<HTMLButtonElement>(null);
  const [animateStats, setAnimateStats] = useState(false);
  const [animateBars, setAnimateBars] = useState(false);

  const filterPanelId = useId();
  const chartTitleId = useId();
  const breakdownTitleId = useId();

  // User selector state
  const [showUserSelector, setShowUserSelector] = useState(false);
  const userSelectorRef = useRef<HTMLDivElement>(null);
  const userButtonRef = useRef<HTMLButtonElement>(null);
  // Set when Escape dismisses the search's suggestions (the search then blurs and closes),
  // so focus can return to the switcher
  const selectorEscapedRef = useRef(false);

  // Target username and verification status
  const targetUsername = searchParams.get('user') || routeUsername || user?.username || '';
  const isViewingOwnAnalytics =
    !!user && targetUsername.toLowerCase() === user.username.toLowerCase();
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
        selectorEscapedRef.current = false;
        setShowUserSelector(false);
      }
      if (activityFilterRef.current && !activityFilterRef.current.contains(e.target as Node)) {
        setShowActivityFilter(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const closeActivityFilter = useCallback((restoreFocus: boolean) => {
    setShowActivityFilter(false);
    if (restoreFocus) filterButtonRef.current?.focus({ preventScroll: true });
  }, []);

  useEscapeKey(showActivityFilter, () => closeActivityFilter(true));

  // Keyboard users tabbing out of the filter panel close it (pointer users are handled above)
  const handleFilterBlur = (e: React.FocusEvent<HTMLDivElement>) => {
    const next = e.relatedTarget as Node | null;
    if (next && !e.currentTarget.contains(next)) closeActivityFilter(false);
  };

  const handleUserSearchBlur = () => {
    setShowUserSelector(false);
    if (selectorEscapedRef.current) {
      selectorEscapedRef.current = false;
      // Wait for the switcher button to re-mount; never take focus the user has moved on
      requestAnimationFrame(() => {
        if (document.activeElement === document.body) {
          userButtonRef.current?.focus({ preventScroll: true });
        }
      });
    }
  };

  const handleSwitcherKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape' || !showUserSelector) return;
    if (e.defaultPrevented) {
      // The search closed its suggestions and blurred itself; its blur closes it
      selectorEscapedRef.current = true;
      return;
    }
    // Nothing else to dismiss: close the search now and return focus to the switcher
    e.preventDefault();
    selectorEscapedRef.current = false;
    flushSync(() => setShowUserSelector(false));
    userButtonRef.current?.focus({ preventScroll: true });
  };

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

  // Guards against out-of-order responses when switching user/week quickly
  const analyticsRequestIdRef = useRef(0);

  const fetchAnalytics = useCallback(async () => {
    if (!targetUsername) return;

    const requestId = ++analyticsRequestIdRef.current;
    const isStale = () => requestId !== analyticsRequestIdRef.current;

    setLoading(true);
    setAnimateStats(false);
    setAnimateBars(false);
    setIsPrivateAccount(false);
    setLoadError(null);

    const weekStartParam = formatDateForApi(weekStart);

    try {
      const res = await api.getWeekAnalytics(targetUsername, weekStartParam);
      if (isStale()) return;
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

        // Trigger animations after data loads (skipped if a newer request took over)
        setTimeout(() => !isStale() && setAnimateStats(true), 100);
        setTimeout(() => !isStale() && setAnimateBars(true), 300);
      } else if (res.error_code === 'ACCOUNT_PRIVATE') {
        setIsPrivateAccount(true);
        setAnalytics(null);
      } else {
        console.warn('[Insights] Week analytics request failed', {
          week: weekStartParam,
          code: res.error_code,
        });
        setLoadError(res.error_code === 'USER_NOT_FOUND' ? 'not_found' : 'failed');
        setAnalytics(null);
      }
    } catch (err) {
      if (isStale()) return;
      if (err instanceof ApiError && err.errorCode === 'ACCOUNT_PRIVATE') {
        setIsPrivateAccount(true);
        setAnalytics(null);
      } else {
        const isNotFound = err instanceof ApiError && err.errorCode === 'USER_NOT_FOUND';
        if (isNotFound) {
          console.warn('[Insights] Target user not found', { week: weekStartParam });
        } else {
          console.error('[Insights] Failed to fetch week analytics; showing retry', {
            week: weekStartParam,
            error: err,
          });
        }
        setLoadError(isNotFound ? 'not_found' : 'failed');
        setAnalytics(null);
      }
    } finally {
      if (!isStale()) setLoading(false);
    }
  }, [targetUsername, weekStart]);

  useEffect(() => {
    fetchAnalytics();
  }, [fetchAnalytics]);

  // Fetch target user's verification status
  useEffect(() => {
    let cancelled = false;

    const fetchTargetUserVerification = async () => {
      if (!targetUsername) return;

      try {
        const res = await api.post('/users', { username: targetUsername });
        if (cancelled) return;
        const exactMatch =
          res.success && Array.isArray(res.data)
            ? res.data.find(
                (u: { username: string }) =>
                  u.username.toLowerCase() === targetUsername.toLowerCase()
              )
            : undefined;
        // Always overwrite so a previous user's badge never lingers
        setTargetIsVerified(!!exactMatch?.is_verified);
      } catch (err) {
        if (cancelled) return;
        console.error('Failed to fetch target user verification', err);
        setTargetIsVerified(false);
      }
    };
    fetchTargetUserVerification();
    return () => {
      cancelled = true;
    };
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

  const smartBack = useSmartBack(APP_ROUTES.ANALYTICS);

  const handleUserSelect = (username: string) => {
    setShowUserSelector(false);
    const selectingSelf = username.toLowerCase() === user?.username.toLowerCase();
    if (selectingSelf) {
      navigate(APP_ROUTES.ANALYTICS, { replace: true });
      return;
    }
    // From your own analytics, another user's analytics is a new screen (Back returns);
    // switching between other users just swaps the content in place.
    navigate(APP_ROUTES.USER_ANALYTICS(username), { replace: !isViewingOwnAnalytics });
  };

  const handleAutocompleteSelect = (suggestion: AutocompleteSuggestion) => {
    handleUserSelect(suggestion.text);
  };

  const toggleActivity = (name: string) => {
    setActivityFilter((prev) =>
      prev.includes(name) ? prev.filter((a) => a !== name) : [...prev, name]
    );
  };

  // Hours a day contributes to the chart under the current activity filter
  const getVisibleDayHours = (day: DayAnalytics): number =>
    activityFilter.length === 0
      ? day.total_hours
      : day.activities
          .filter((a) => activityFilter.includes(a.name))
          .reduce((sum, a) => sum + a.hours, 0);

  const sortedActivitySummary = analytics?.activity_summary
    ? [...analytics.activity_summary].sort((a, b) =>
        sortOrder === 'desc' ? b.total_hours - a.total_hours : a.total_hours - b.total_hours
      )
    : [];

  if (!user) {
    return <Navigate to={APP_ROUTES.LOGIN} replace />;
  }

  // Calculate average for the chart
  // For the current week, divide by days elapsed so far (not 7)
  const getWeekDivisor = (): number => {
    const currentWeekStart = getWeekStart(new Date());
    if (weekStart.getTime() >= currentWeekStart.getTime()) {
      const today = new Date();
      const dayOfWeek = today.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
      const daysSinceMonday = dayOfWeek === 0 ? 7 : dayOfWeek; // Mon=1, Tue=2, ..., Sun=7
      return Math.max(1, daysSinceMonday);
    }
    return 7;
  };

  const calculateAverage = () => {
    if (!analytics) return 0;
    const divisor = getWeekDivisor();
    return analytics.daily_breakdown.reduce((sum, d) => sum + getVisibleDayHours(d), 0) / divisor;
  };

  const isCurrentWeek = isNextDisabled();
  const todayKey = formatDateForApi(new Date());
  const showWeekCard = loading || !!analytics || loadError === 'failed';

  const filterLabel =
    activityFilter.length === 0
      ? 'All activities'
      : activityFilter.length === 1
        ? getActivityConfig(activityFilter[0] as ActivityName, customTiles, tileColors).label
        : `${activityFilter.length} activities`;

  const summaryTotalHours = sortedActivitySummary.reduce((sum, a) => sum + a.total_hours, 0);
  const maxActivityHours = sortedActivitySummary.reduce(
    (max, a) => Math.max(max, a.total_hours),
    0
  );

  const renderWeekSummary = (data: WeekAnalyticsResponse) => {
    const isCurrent = data.is_current_week ?? true;
    const change = Math.round(
      (isCurrent ? data.percentage_change : data.percentage_vs_current) ?? 0
    );
    const trendClass =
      change > 0 ? styles.trendUp : change < 0 ? styles.trendDown : styles.trendFlat;
    const TrendIcon = change < 0 ? TrendingDown : TrendingUp;
    const bestRange = formatStreakRange(data.streak.longest_start, data.streak.longest_end);
    const dayUnit = (count: number) => (count === 1 ? 'day' : 'days');

    return (
      <div className={`${styles.summary} ${styles.reveal} ${animateStats ? styles.revealed : ''}`}>
        <div className={styles.hero}>
          <span className={styles.heroIcon} aria-hidden="true">
            <Clock size={22} strokeWidth={2.3} />
          </span>
          <div className={styles.heroText}>
            <span className={styles.heroValue}>
              {data.total_hours_this_week.toFixed(1)}
              <span className={styles.heroUnit}>h</span>
            </span>
            <span className={styles.heroLabel}>
              {isCurrent ? 'Logged this week' : 'Logged that week'}
            </span>
          </div>
          <div className={styles.heroTrend}>
            <span className={`${styles.trend} ${trendClass}`}>
              {change !== 0 && <TrendIcon size={12} strokeWidth={2.6} aria-hidden="true" />}
              {change > 0 ? '+' : ''}
              {change}%
            </span>
            <span className={styles.trendCaption}>
              {isCurrent ? 'vs last week' : 'vs this week'}
            </span>
          </div>
        </div>

        <div className={styles.streaks}>
          <div className={`${styles.stat} ${styles.statStreak}`}>
            <span className={styles.statIcon} aria-hidden="true">
              <Flame size={18} strokeWidth={2.3} />
            </span>
            <div className={styles.statText}>
              <span className={styles.statValue}>
                {data.streak.current}
                <span className={styles.statUnit}>{dayUnit(data.streak.current)}</span>
              </span>
              <span className={styles.statLabel}>Current streak</span>
            </div>
          </div>

          <div className={`${styles.stat} ${styles.statBest}`}>
            <span className={styles.statIcon} aria-hidden="true">
              <Trophy size={18} strokeWidth={2.3} />
            </span>
            <div className={styles.statText}>
              <span className={styles.statValue}>
                {data.streak.longest}
                <span className={styles.statUnit}>{dayUnit(data.streak.longest)}</span>
              </span>
              <span className={styles.statLabel}>Best streak</span>
              {bestRange && <span className={styles.statMeta}>{bestRange}</span>}
            </div>
          </div>
        </div>
      </div>
    );
  };

  const renderSummarySkeleton = () => (
    <div className={styles.summary} aria-hidden="true">
      <Skeleton height={72} radius="xl" />
      <div className={styles.skeletonStreaks}>
        <Skeleton height={58} radius="xl" />
        <Skeleton height={58} radius="xl" />
      </div>
    </div>
  );

  const renderLoadingCards = () => (
    <div aria-hidden="true">
      <div className={`${styles.card} ${styles.skeletonCard}`}>
        <Skeleton width="42%" height={18} radius="full" />
        <Skeleton height={190} radius="xl" />
      </div>
      <div className={`${styles.card} ${styles.skeletonCard}`}>
        <Skeleton width="48%" height={18} radius="full" />
        {[0, 1, 2].map((row) => (
          <div key={row} className={styles.skeletonRow}>
            <Skeleton width={38} height={38} radius="lg" />
            <div className={styles.skeletonRowText}>
              <Skeleton width={`${70 - row * 15}%`} height={12} radius="full" />
              <Skeleton height={8} radius="full" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  const renderChartCard = (data: WeekAnalyticsResponse) => {
    const avgHours = calculateAverage();
    const scaleMax = getChartScale(Math.max(0, ...data.daily_breakdown.map(getVisibleDayHours)));
    const avgPos = Math.min(avgHours / scaleMax, 1) * 100;
    const hasActivities = data.activity_summary.length > 0;

    return (
      <section
        className={`${styles.card} ${styles.chartCard} ${styles.reveal} ${
          animateBars ? styles.revealed : ''
        }`}
        aria-labelledby={chartTitleId}
      >
        <div className={styles.cardHeader}>
          <h2 id={chartTitleId} className={styles.cardTitle}>
            Weekly overview
          </h2>

          {hasActivities && (
            <div ref={activityFilterRef} className={styles.filter} onBlur={handleFilterBlur}>
              <button
                ref={filterButtonRef}
                type="button"
                className={`${styles.filterButton} ${
                  activityFilter.length > 0 ? styles.filterButtonActive : ''
                }`}
                onClick={() => setShowActivityFilter((open) => !open)}
                aria-expanded={showActivityFilter}
                aria-controls={filterPanelId}
                aria-label={`Filter chart: ${filterLabel}`}
              >
                <span className={styles.filterButtonLabel}>{filterLabel}</span>
                <ChevronDown
                  size={14}
                  strokeWidth={2.4}
                  className={`${styles.chevron} ${showActivityFilter ? styles.chevronOpen : ''}`}
                  aria-hidden="true"
                />
              </button>

              {showActivityFilter && (
                <div
                  id={filterPanelId}
                  className={styles.filterMenu}
                  role="group"
                  aria-label="Activities shown in the chart"
                >
                  <button
                    type="button"
                    className={styles.filterOption}
                    aria-pressed={activityFilter.length === 0}
                    onClick={() => setActivityFilter([])}
                  >
                    <span className={styles.filterOptionLabel}>All activities</span>
                    {activityFilter.length === 0 && (
                      <Check
                        size={16}
                        strokeWidth={2.6}
                        className={styles.allCheck}
                        aria-hidden="true"
                      />
                    )}
                  </button>
                  {activityFilter.length > 0 && (
                    <button
                      type="button"
                      className={`${styles.filterOption} ${styles.filterOptionMuted}`}
                      onClick={() => setActivityFilter([])}
                    >
                      <X size={14} strokeWidth={2.4} aria-hidden="true" />
                      <span className={styles.filterOptionLabel}>
                        Clear selection ({activityFilter.length})
                      </span>
                    </button>
                  )}
                  <div className={styles.filterDivider} role="separator" />
                  {data.activity_summary.map((activity) => {
                    const config = getActivityConfig(
                      activity.name as ActivityName,
                      customTiles,
                      tileColors
                    );
                    const isSelected = activityFilter.includes(activity.name);
                    return (
                      <button
                        key={activity.name}
                        type="button"
                        className={styles.filterOption}
                        style={{ '--option-color': config.color } as React.CSSProperties}
                        aria-pressed={isSelected}
                        onClick={() => toggleActivity(activity.name)}
                      >
                        <span
                          className={`${styles.checkbox} ${isSelected ? styles.checkboxChecked : ''}`}
                          aria-hidden="true"
                        >
                          {isSelected && <Check size={12} strokeWidth={3.2} />}
                        </span>
                        <span className={styles.filterOptionLabel}>
                          {config.label || activity.name}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        <div className={styles.chart}>
          {getChartTicks(scaleMax).map((hours) => {
            const pos = { '--pos': (hours / scaleMax) * 100 } as React.CSSProperties;
            return (
              <React.Fragment key={hours}>
                <span className={styles.yLabel} style={pos} aria-hidden="true">
                  {Number.isInteger(hours) ? hours : hours.toFixed(1)}h
                </span>
                <span className={styles.gridLine} style={pos} aria-hidden="true" />
              </React.Fragment>
            );
          })}

          {avgHours > 0 && (
            <div className={styles.avgLine} style={{ '--avg': avgPos } as React.CSSProperties}>
              <span className={styles.avgLabel} aria-hidden="true">
                avg {avgHours.toFixed(1)}h
              </span>
              <span className="sr-only">Daily average: {avgHours.toFixed(1)} hours</span>
            </div>
          )}

          <div className={styles.bars}>
            {data.daily_breakdown.map((day, index) => (
              <DayBar
                key={day.date}
                day={day}
                animate={animateBars}
                delay={index * 0.05}
                activityFilter={activityFilter}
                customTiles={customTiles}
                tileColors={tileColors}
                isToday={day.date === todayKey}
                scaleMax={scaleMax}
              />
            ))}
          </div>
        </div>
      </section>
    );
  };

  const renderBreakdownCard = () => (
    <section
      className={`${styles.card} ${styles.reveal} ${animateBars ? styles.revealedLate : ''}`}
      aria-labelledby={breakdownTitleId}
    >
      <div className={styles.cardHeader}>
        <h2 id={breakdownTitleId} className={styles.cardTitle}>
          Activity breakdown
        </h2>
        {sortedActivitySummary.length > 1 && (
          <div className={styles.sortToggle} role="group" aria-label="Sort activities">
            <button
              type="button"
              className={`${styles.sortOption} ${sortOrder === 'desc' ? styles.sortOptionActive : ''}`}
              aria-pressed={sortOrder === 'desc'}
              onClick={() => setSortOrder('desc')}
            >
              Most
            </button>
            <button
              type="button"
              className={`${styles.sortOption} ${sortOrder === 'asc' ? styles.sortOptionActive : ''}`}
              aria-pressed={sortOrder === 'asc'}
              onClick={() => setSortOrder('asc')}
            >
              Least
            </button>
          </div>
        )}
      </div>

      {sortedActivitySummary.length > 0 ? (
        <ul className={styles.list}>
          {sortedActivitySummary.map((activity, index) => (
            <ActivityRow
              key={activity.name}
              activity={activity}
              maxHours={maxActivityHours}
              delay={index * 0.03}
              animate={animateBars}
              customTiles={customTiles}
              tileColors={tileColors}
              totalHours={summaryTotalHours}
            />
          ))}
        </ul>
      ) : (
        <EmptyState
          size="sm"
          icon={<BarChart3 size={26} />}
          title={isCurrentWeek ? 'Nothing logged this week' : 'Nothing logged that week'}
          description={
            isViewingOwnAnalytics
              ? 'Activities you log on your dashboard will show up here.'
              : `@${targetUsername} didn't log any activities this week.`
          }
          action={
            isViewingOwnAnalytics && isCurrentWeek
              ? { label: 'Log an activity', onClick: () => navigate(APP_ROUTES.HOME) }
              : undefined
          }
        />
      )}
    </section>
  );

  const renderStateCard = () => {
    if (isPrivateAccount) {
      return (
        <section className={`${styles.card} ${styles.stateCard}`}>
          <EmptyState
            icon={<Lock size={26} />}
            title="This account is private"
            description={`Only approved followers can see @${targetUsername}'s insights.`}
            action={{
              label: 'View profile',
              variant: 'secondary',
              onClick: () => navigate(APP_ROUTES.USER_PROFILE(targetUsername)),
            }}
          />
        </section>
      );
    }

    if (loadError === 'not_found') {
      return (
        <section className={`${styles.card} ${styles.stateCard}`}>
          <EmptyState
            icon={<UserX size={26} />}
            title="User not found"
            description={`We couldn't find @${targetUsername}. They may have changed their username.`}
            action={
              isViewingOwnAnalytics
                ? undefined
                : {
                    label: 'Back to my insights',
                    variant: 'secondary',
                    onClick: () => navigate(APP_ROUTES.ANALYTICS, { replace: true }),
                  }
            }
          />
        </section>
      );
    }

    return (
      <section className={`${styles.card} ${styles.stateCard}`} role="alert">
        <EmptyState
          icon={<AlertTriangle size={26} />}
          title="Couldn't load insights"
          description="Check your connection and try again."
          action={{
            label: 'Try again',
            icon: <RefreshCw size={16} />,
            onClick: () => void fetchAnalytics(),
          }}
        />
      </section>
    );
  };

  return (
    <div
      className={`${styles.page} ${isViewingOwnAnalytics ? '' : styles.pagePushed}`}
      aria-busy={loading}
    >
      <PageHeader title="Insights" onBack={isViewingOwnAnalytics ? undefined : smartBack} />

      {/* User switcher */}
      <div ref={userSelectorRef} className={styles.userSwitcher} onKeyDown={handleSwitcherKeyDown}>
        {showUserSelector ? (
          <Autocomplete
            placeholder="Search people…"
            onSelect={handleAutocompleteSelect}
            fetchSuggestions={fetchSuggestions}
            minChars={1}
            debounceMs={150}
            autoFocus
            onBlur={handleUserSearchBlur}
          />
        ) : (
          <button
            ref={userButtonRef}
            type="button"
            className={styles.userButton}
            onClick={() => {
              selectorEscapedRef.current = false;
              setShowUserSelector(true);
            }}
          >
            <span className={styles.userIcon} aria-hidden="true">
              <Users size={18} strokeWidth={2.3} />
            </span>
            <span className={styles.userText}>
              <span className={styles.userEyebrow}>
                {isViewingOwnAnalytics ? 'Your insights' : 'Viewing insights for'}
              </span>
              <span className={styles.userName}>
                <span className={styles.userNameText}>{targetUsername}</span>
                {targetIsVerified && <VerifiedBadge size={14} />}
              </span>
            </span>
            <span className={styles.userSwitchHint}>
              Switch
              <ChevronDown size={14} strokeWidth={2.4} aria-hidden="true" />
            </span>
          </button>
        )}
      </div>

      {showWeekCard && (
        <section className={styles.card} aria-label="Week summary">
          <div className={styles.weekNav}>
            <button
              type="button"
              className={styles.navButton}
              onClick={handlePrevWeek}
              aria-label="Previous week"
            >
              <ChevronLeft size={20} strokeWidth={2.4} />
            </button>
            <div className={styles.weekLabel} aria-live="polite">
              <span className={styles.weekRange}>{formatWeekRange(weekStart)}</span>
              <span
                className={`${styles.weekBadge} ${isCurrentWeek ? styles.weekBadgeCurrent : ''}`}
              >
                {getWeekBadge(weekStart)}
              </span>
            </div>
            <button
              type="button"
              className={styles.navButton}
              onClick={handleNextWeek}
              disabled={isCurrentWeek}
              aria-label="Next week"
            >
              <ChevronRight size={20} strokeWidth={2.4} />
            </button>
          </div>

          {loading ? renderSummarySkeleton() : analytics && renderWeekSummary(analytics)}
        </section>
      )}

      {loading ? (
        renderLoadingCards()
      ) : analytics ? (
        <>
          {renderChartCard(analytics)}
          {renderBreakdownCard()}
        </>
      ) : (
        renderStateCard()
      )}
    </div>
  );
};
export default AnalyticsPage;
