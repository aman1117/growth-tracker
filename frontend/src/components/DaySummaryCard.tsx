import { ChevronLeft, ChevronRight, Flame, Trophy } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';

import { api } from '../services/api';
import { useCompletionStore } from '../store';
import { useCommentStore } from '../store/useCommentStore';
import type { Badge } from '../types/api';
import { renderBadgeIcon } from '../utils/badgeIcons';
import s from './DaySummaryCard.module.css';
import { CalendarPicker, CommentButton, CommentPreview, CommentSheet, LikeButton } from './ui';
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

  const isToday = () => {
    const today = new Date();
    return currentDate.toDateString() === today.toDateString();
  };

  const handleGoToToday = () => {
    onDateChange(new Date());
  };

  const handleCommentSheetClose = useCallback(() => {
    setIsCommentSheetOpen(false);
    fetchPreviewComments(username, date);
  }, [username, date, fetchPreviewComments]);

  // Hours calculation
  const totalHours = Object.values(activities).reduce<number>((sum, hours) => sum + hours, 0);
  const maxHours = 24;
  const percentage = Math.min((totalHours / maxHours) * 100, 100);
  const isComplete = totalHours >= maxHours;

  // Badge counts
  const earnedBadges = badges.filter((b) => b.earned);
  // Get highest earned badge (highest threshold)
  const currentBadge =
    earnedBadges.length > 0
      ? earnedBadges.reduce((prev, curr) => (curr.threshold > prev.threshold ? curr : prev))
      : null;

  if (loading || streakLoading || badgesLoading) {
    return <div className={`skeleton-glass ${s.skeleton}`} />;
  }

  return (
    <div className={`${s.card} ${isComplete ? s.cardComplete : s.cardDefault}`}>
      {/* Row 1: Date Navigation + Hours */}
      <div className={s.row}>
        {/* Date Navigation */}
        <div className={s.rowStart}>
          <button onClick={onPrev} className={s.navButton}>
            <ChevronLeft size={18} />
          </button>
          <button onClick={() => setIsCalendarOpen(true)} className={s.dateButton}>
            {formatDate(currentDate)}
          </button>
          <button
            onClick={onNext}
            disabled={isNextDisabled}
            className={`${s.navButton} ${isNextDisabled ? s.navButtonDisabled : ''}`}
          >
            <ChevronRight size={18} />
          </button>
          {!isToday() && (
            <button onClick={handleGoToToday} className={s.todayButton} title="Go to today">
              Today
            </button>
          )}
        </div>

        {/* Hours Display */}
        <div className={s.rowCenter}>
          <span className={`${s.hoursValue} ${isComplete ? s.hoursComplete : ''}`}>
            {isComplete && '✓ '}
            {totalHours}/{maxHours}h
          </span>
        </div>
      </div>

      {/* Progress Bar */}
      <div className={s.progressTrack}>
        <div
          className={s.progressFill}
          style={{
            width: `${percentage}%`,
            backgroundColor: totalHours >= maxHours ? 'var(--success)' : 'var(--accent)',
            boxShadow:
              percentage >= 75
                ? `0 0 8px ${totalHours >= maxHours ? 'rgba(34, 197, 94, 0.4)' : 'rgba(99, 102, 241, 0.3)'}`
                : 'none',
          }}
        />
      </div>

      {/* Row 2: Streaks + Likes */}
      <div className={s.streakRow}>
        {/* Streaks */}
        <div className={s.streakGroup}>
          {/* Current Streak - only show on Today */}
          {isToday() && (
            <div className={s.streakItem}>
              <Flame
                size={18}
                fill="var(--color-like-light)"
                color="var(--color-like)"
                style={{ display: 'block' }}
              />
              <span className={s.streakValue}>{streak.current}</span>
              <span className={s.streakLabel}>streak</span>
            </div>
          )}

          {/* Best Streak */}
          <div className={s.streakItem}>
            <Trophy
              size={18}
              fill="var(--color-streak-light)"
              color="var(--color-streak)"
              style={{ display: 'block' }}
            />
            <span className={s.streakValue}>{streak.longest}</span>
            <span className={s.streakLabel}>best</span>
          </div>

          {/* Current Badge */}
          {currentBadge && (
            <div className={s.streakItem}>
              {renderBadgeIcon(currentBadge.icon, currentBadge.color)}
              <span className={s.streakLabel}>{currentBadge.name}</span>
            </div>
          )}
        </div>

        {/* Like & Comment */}
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

      {/* Comment Preview */}
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
    </div>
  );
};
