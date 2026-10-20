import { CalendarDays, Check, ChevronLeft, ChevronRight, Flame, Trophy } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';

import { api } from '../services/api';
import { useCompletionStore } from '../store';
import { useCommentStore } from '../store/useCommentStore';
import type { Badge } from '../types/api';
import { renderBadgeIcon } from '../utils/badgeIcons';
import s from './DaySummaryCard.module.css';
import {
  CalendarPicker,
  CommentButton,
  CommentPreview,
  CommentSheet,
  LikeButton,
  Skeleton,
} from './ui';
import type { CompletionData } from './ui/CalendarPicker';

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
  /** Called when the calendar picker opens/closes */
  onCalendarOpenChange?: (isOpen: boolean) => void;
}

interface StreakData {
  current: number;
  longest: number;
  new_badges?: Badge[];
}

const MAX_HOURS = 24;

/** Avoid float noise (e.g. 20.999999) in the hours counter */
const formatHours = (hours: number) => Number(hours.toFixed(2));

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
  onCalendarOpenChange,
}) => {
  const [streak, setStreak] = useState<StreakData>({ current: 0, longest: 0 });
  const [streakLoading, setStreakLoading] = useState(true);
  const [badges, setBadges] = useState<Badge[]>([]);
  const [badgesLoading, setBadgesLoading] = useState(true);
  const [isCalendarOpen, setIsCalendarOpen] = useState(false);
  const [isCommentSheetOpen, setIsCommentSheetOpen] = useState(false);
  const [calendarViewMonth, setCalendarViewMonth] = useState<{ year: number; month: number }>({
    year: currentDate.getFullYear(),
    month: currentDate.getMonth(),
  });

  // Completion store for heat map
  const { fetchMonthData, getMonthData } = useCompletionStore();
  const fetchPreviewComments = useCommentStore((st) => st.fetchPreviewComments);

  // Notify parent when calendar open state changes (for pull-to-refresh disable)
  useEffect(() => {
    onCalendarOpenChange?.(isCalendarOpen);
  }, [isCalendarOpen, onCalendarOpenChange]);

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
    // onBadgesLoaded is intentionally excluded - callback reference may change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [username]);

  // Fetch heat map data when calendar view month changes
  useEffect(() => {
    if (isCalendarOpen && username) {
      fetchMonthData(username, calendarViewMonth.year, calendarViewMonth.month);
    }
  }, [isCalendarOpen, username, calendarViewMonth.year, calendarViewMonth.month, fetchMonthData]);

  // Handle calendar month navigation
  const handleCalendarMonthChange = useCallback((year: number, month: number) => {
    setCalendarViewMonth({ year, month });
  }, []);

  // Get completion data for current calendar view month
  const completionData: CompletionData | undefined = username
    ? (getMonthData(username, calendarViewMonth.year, calendarViewMonth.month) ?? undefined)
    : undefined;

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
      day: 'numeric',
    });
  };

  const viewingToday = currentDate.toDateString() === new Date().toDateString();

  const handleGoToToday = () => {
    onDateChange(new Date());
  };

  const handleCommentSheetClose = useCallback(() => {
    setIsCommentSheetOpen(false);
    fetchPreviewComments(username, date);
  }, [username, date, fetchPreviewComments]);

  // Hours calculation
  const totalHours = formatHours(
    Object.values(activities).reduce<number>((sum, hours) => sum + hours, 0)
  );
  const percentage = Math.min((totalHours / MAX_HOURS) * 100, 100);
  const isComplete = totalHours >= MAX_HOURS;

  // Badge counts
  const earnedBadges = badges.filter((b) => b.earned);
  // Get highest earned badge (highest threshold)
  const currentBadge =
    earnedBadges.length > 0
      ? earnedBadges.reduce((prev, curr) => (curr.threshold > prev.threshold ? curr : prev))
      : null;

  if (loading || streakLoading || badgesLoading) {
    return (
      <div className={`${s.card} ${s.cardDefault}`} aria-busy="true" aria-label="Loading day">
        <div className={s.headerRow}>
          <Skeleton width={148} height={34} radius="full" />
          <Skeleton width={64} height={26} radius="md" />
        </div>
        <Skeleton height={10} radius="full" />
        <div className={s.chipRow}>
          <Skeleton width={96} height={30} radius="full" />
          <Skeleton width={84} height={30} radius="full" />
        </div>
      </div>
    );
  }

  const dateLabel = formatDate(currentDate);

  return (
    <section
      className={`${s.card} ${isComplete ? s.cardComplete : s.cardDefault}`}
      aria-label={`${dateLabel} summary`}
    >
      {/* Header: date navigation + hours */}
      <div className={s.headerRow}>
        <div className={s.dateNav}>
          <button onClick={onPrev} className={s.navButton} aria-label="Previous day">
            <ChevronLeft size={18} strokeWidth={2.5} aria-hidden="true" />
          </button>
          <button
            onClick={() => setIsCalendarOpen(true)}
            className={s.dateButton}
            aria-label={`${dateLabel}, open calendar`}
            aria-haspopup="dialog"
          >
            <CalendarDays size={15} strokeWidth={2.25} aria-hidden="true" />
            {dateLabel}
          </button>
          <button
            onClick={onNext}
            disabled={isNextDisabled}
            className={s.navButton}
            aria-label="Next day"
          >
            <ChevronRight size={18} strokeWidth={2.5} aria-hidden="true" />
          </button>
          {!viewingToday && (
            <button onClick={handleGoToToday} className={s.todayButton} title="Go to today">
              Today
            </button>
          )}
        </div>

        <div className={`${s.hours} ${isComplete ? s.hoursComplete : ''}`}>
          {isComplete && (
            <span className={s.completeBadge} aria-hidden="true">
              <Check size={12} strokeWidth={3.5} />
            </span>
          )}
          <span className={s.hoursValue}>{totalHours}</span>
          <span className={s.hoursMax}>/{MAX_HOURS}h</span>
        </div>
      </div>

      {/* Progress */}
      <div
        className={s.progressTrack}
        role="progressbar"
        aria-label="Hours logged"
        aria-valuemin={0}
        aria-valuemax={MAX_HOURS}
        aria-valuenow={Math.min(totalHours, MAX_HOURS)}
        aria-valuetext={isComplete ? 'Day complete' : `${totalHours} of ${MAX_HOURS} hours logged`}
      >
        <div
          className={`${s.progressFill} ${isComplete ? s.progressComplete : ''}`}
          style={
            {
              width: `${percentage}%`,
              '--pct': Math.max(percentage, 0.01),
            } as React.CSSProperties
          }
        />
      </div>

      {/* Stat chips (wrap on narrow screens) */}
      <div className={s.chipRow}>
        {/* Current Streak - only show on Today */}
        {viewingToday && (
          <span className={`${s.chip} ${s.chipStreak}`}>
            <Flame
              size={15}
              fill="var(--color-streak-light)"
              color="var(--color-streak)"
              aria-hidden="true"
            />
            <span className={s.chipValue}>{streak.current}</span>
            <span className={s.chipLabel}>day streak</span>
          </span>
        )}

        {/* Best Streak */}
        <span className={`${s.chip} ${s.chipBest}`}>
          <Trophy size={15} fill="var(--amber-400)" color="var(--amber-600)" aria-hidden="true" />
          <span className={s.chipValue}>{streak.longest}</span>
          <span className={s.chipLabel}>best</span>
        </span>

        {/* Current Badge */}
        {currentBadge && (
          <span
            className={s.chip}
            style={{ '--chip-tone': currentBadge.color } as React.CSSProperties}
            title={`Current badge: ${currentBadge.name}`}
          >
            {renderBadgeIcon(currentBadge.icon, currentBadge.color, 15)}
            <span className={s.chipName}>{currentBadge.name}</span>
          </span>
        )}

        {/* Like & Comment (pushed to the end of the row; wraps gracefully) */}
        <div className={s.actionGroup}>
          <LikeButton username={username} date={date} size="sm" showCount={true} />
          <CommentButton
            username={username}
            date={date}
            size="sm"
            showCount={true}
            isOpen={isCommentSheetOpen}
            onOpenChange={setIsCommentSheetOpen}
            renderSheet={false}
          />
        </div>
      </div>

      {/* Comment previews (renders nothing when there are no comments) */}
      <CommentPreview
        username={username}
        date={date}
        onOpenSheet={() => setIsCommentSheetOpen(true)}
      />

      {/* Custom Calendar Picker with Heat Map */}
      <CalendarPicker
        isOpen={isCalendarOpen}
        onClose={() => setIsCalendarOpen(false)}
        selectedDate={currentDate}
        onDateSelect={onDateChange}
        maxDate={new Date()}
        completionData={completionData}
        onMonthChange={handleCalendarMonthChange}
      />

      {/* Comment Sheet */}
      <CommentSheet
        isOpen={isCommentSheetOpen}
        onClose={handleCommentSheetClose}
        username={username}
        date={date}
      />
    </section>
  );
};
