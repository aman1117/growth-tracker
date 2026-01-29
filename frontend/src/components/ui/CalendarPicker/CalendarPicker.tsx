/**
 * CalendarPicker Component
 *
 * A professional calendar date picker with glassmorphism design.
 * Features day/month/year selection views with smooth animations.
 * Includes optional heat map visualization for activity completion.
 */

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import styles from './CalendarPicker.module.css';

/** Map of date string (YYYY-MM-DD) to total hours logged */
export type CompletionData = Record<string, number>;

export interface CalendarPickerProps {
  /** Whether the calendar is open */
  isOpen: boolean;
  /** Callback when calendar closes */
  onClose: () => void;
  /** Currently selected date */
  selectedDate: Date;
  /** Callback when a date is selected */
  onDateSelect: (date: Date) => void;
  /** Maximum selectable date (defaults to today) */
  maxDate?: Date;
  /** Completion data for heat map (date string -> hours logged) */
  completionData?: CompletionData;
  /** Callback when viewed month changes (for fetching heat map data) */
  onMonthChange?: (year: number, month: number) => void;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

const isSameDay = (a: Date, b: Date) => {
  return (
    a.getDate() === b.getDate() &&
    a.getMonth() === b.getMonth() &&
    a.getFullYear() === b.getFullYear()
  );
};

export const CalendarPicker: React.FC<CalendarPickerProps> = ({
  isOpen,
  onClose,
  selectedDate,
  onDateSelect,
  maxDate = new Date(),
  completionData,
  onMonthChange,
}) => {
  const [isClosing, setIsClosing] = useState(false);
  const [viewDate, setViewDate] = useState(selectedDate);
  const [view, setView] = useState<'days' | 'months' | 'years'>('days');
  const calendarRef = useRef<HTMLDivElement>(null);

  // Generate years for year picker (2020 to current year)
  const years = useMemo(() => {
    const currentYear = maxDate.getFullYear();
    const result = [];
    for (let y = currentYear; y >= 2020; y--) {
      result.push(y);
    }
    return result;
  }, [maxDate]);

  // Reset view when calendar opens
  const handleClose = useCallback(() => {
    setIsClosing(true);
    setTimeout(() => {
      onClose();
      setIsClosing(false);
    }, 150);
  }, [onClose]);

  useEffect(() => {
    if (isOpen) {
      setViewDate(selectedDate);
      setView('days');
      setIsClosing(false);
    }
  }, [isOpen, selectedDate]);

  // Notify parent when viewed month changes (for fetching heat map data)
  useEffect(() => {
    if (isOpen && onMonthChange) {
      onMonthChange(viewDate.getFullYear(), viewDate.getMonth());
    }
  }, [isOpen, viewDate, onMonthChange]);

  // Handle click outside
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent | TouchEvent) => {
      if (calendarRef.current && !calendarRef.current.contains(e.target as Node)) {
        handleClose();
      }
    };

    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('touchstart', handleClickOutside);
    }, 10);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('touchstart', handleClickOutside);
    };
  }, [isOpen, handleClose]);

  // Handle escape key
  useEffect(() => {
    if (!isOpen) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleClose();
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, handleClose]);

  const handleDateClick = (date: Date) => {
    onDateSelect(date);
    handleClose();
  };

  const handleGoToToday = () => {
    const today = new Date();
    onDateSelect(today);
    handleClose();
  };

  const navigateMonth = (delta: number) => {
    setViewDate((prev) => new Date(prev.getFullYear(), prev.getMonth() + delta, 1));
  };

  const handleMonthSelect = (monthIndex: number) => {
    setViewDate(new Date(viewDate.getFullYear(), monthIndex, 1));
    setView('days');
  };

  const handleYearSelect = (year: number) => {
    setViewDate(new Date(year, viewDate.getMonth(), 1));
    setView('months');
  };

  // Generate calendar days
  const calendarDays = useMemo(() => {
    const year = viewDate.getFullYear();
    const month = viewDate.getMonth();

    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const startPadding = firstDay.getDay();
    const totalDays = lastDay.getDate();

    const days: {
      date: Date;
      isCurrentMonth: boolean;
      isToday: boolean;
      isSelected: boolean;
      isDisabled: boolean;
    }[] = [];

    // Previous month padding
    const prevMonth = new Date(year, month, 0);
    for (let i = startPadding - 1; i >= 0; i--) {
      const date = new Date(year, month - 1, prevMonth.getDate() - i);
      days.push({
        date,
        isCurrentMonth: false,
        isToday: isSameDay(date, new Date()),
        isSelected: isSameDay(date, selectedDate),
        isDisabled: date > maxDate,
      });
    }

    // Current month
    for (let d = 1; d <= totalDays; d++) {
      const date = new Date(year, month, d);
      days.push({
        date,
        isCurrentMonth: true,
        isToday: isSameDay(date, new Date()),
        isSelected: isSameDay(date, selectedDate),
        isDisabled: date > maxDate,
      });
    }

    // Next month padding (to fill 6 rows)
    const remaining = 42 - days.length;
    for (let i = 1; i <= remaining; i++) {
      const date = new Date(year, month + 1, i);
      days.push({
        date,
        isCurrentMonth: false,
        isToday: isSameDay(date, new Date()),
        isSelected: isSameDay(date, selectedDate),
        isDisabled: date > maxDate,
      });
    }

    return days;
  }, [viewDate, selectedDate, maxDate]);

  const canGoNext = () => {
    const nextMonth = new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 1);
    return nextMonth <= maxDate;
  };

  // Format date to YYYY-MM-DD for completion data lookup
  const formatDateKey = (date: Date): string => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  // Get heat level class based on hours logged
  const getHeatLevelClass = (date: Date): string | null => {
    if (!completionData) return null;

    const dateKey = formatDateKey(date);
    const hours = completionData[dateKey];

    if (hours === undefined || hours <= 0) return null;
    if (hours >= 24) return styles.heatComplete;
    if (hours >= 18) return styles.heatLevel4;
    if (hours >= 12) return styles.heatLevel3;
    if (hours >= 6) return styles.heatLevel2;
    return styles.heatLevel1;
  };

  // Get tooltip text for a day
  const getDayTooltip = (date: Date): string | undefined => {
    if (!completionData) return undefined;

    const dateKey = formatDateKey(date);
    const hours = completionData[dateKey];

    if (hours === undefined || hours <= 0) return undefined;
    if (hours >= 24) return '24/24 hours - Day complete! ✓';
    return `${hours}/24 hours logged`;
  };

  if (!isOpen) return null;

  const getDayClassName = (day: {
    date: Date;
    isCurrentMonth: boolean;
    isToday: boolean;
    isSelected: boolean;
    isDisabled: boolean;
  }) => {
    return [
      styles.day,
      !day.isCurrentMonth && styles.outside,
      day.isToday && styles.today,
      day.isSelected && styles.selected,
      day.isDisabled && styles.disabled,
      getHeatLevelClass(day.date),
    ]
      .filter(Boolean)
      .join(' ');
  };

  const calendarContent = (
    <div className={`${styles.overlay} ${isClosing ? styles.closing : ''}`} onClick={handleClose}>
      <div
        ref={calendarRef}
        className={`${styles.modal} ${isClosing ? styles.closing : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className={styles.header}>
          <button
            className={styles.navButton}
            onClick={() => (view === 'days' ? navigateMonth(-1) : setView('years'))}
            disabled={view === 'years'}
          >
            <ChevronLeft size={16} />
          </button>

          <div className={styles.titleGroup}>
            {view === 'days' && (
              <>
                <button className={styles.titleButton} onClick={() => setView('months')}>
                  {MONTHS[viewDate.getMonth()]}
                </button>
                <button className={styles.titleButton} onClick={() => setView('years')}>
                  {viewDate.getFullYear()}
                </button>
              </>
            )}
            {view === 'months' && (
              <button className={styles.titleButton} onClick={() => setView('years')}>
                {viewDate.getFullYear()}
              </button>
            )}
            {view === 'years' && <span className={styles.titleText}>Select Year</span>}
          </div>

          <button
            className={styles.navButton}
            onClick={() => (view === 'days' ? navigateMonth(1) : null)}
            disabled={view !== 'days' || !canGoNext()}
          >
            <ChevronRight size={16} />
          </button>
        </div>

        {/* Days View */}
        {view === 'days' && (
          <div className={styles.body}>
            <div className={styles.weekdays}>
              {WEEKDAYS.map((day) => (
                <div key={day} className={styles.weekday}>
                  {day}
                </div>
              ))}
            </div>
            <div className={styles.days}>
              {calendarDays.map((day, idx) => (
                <button
                  key={idx}
                  className={getDayClassName(day)}
                  onClick={() => !day.isDisabled && handleDateClick(day.date)}
                  disabled={day.isDisabled}
                  title={getDayTooltip(day.date)}
                >
                  {day.date.getDate()}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Months View */}
        {view === 'months' && (
          <div className={`${styles.grid} ${styles.monthsGrid}`}>
            {MONTHS.map((month, idx) => {
              const isDisabled =
                viewDate.getFullYear() === maxDate.getFullYear() && idx > maxDate.getMonth();
              return (
                <button
                  key={month}
                  className={`${styles.gridButton} ${viewDate.getMonth() === idx ? styles.selected : ''} ${isDisabled ? styles.disabled : ''}`}
                  onClick={() => !isDisabled && handleMonthSelect(idx)}
                  disabled={isDisabled}
                >
                  {month.slice(0, 3)}
                </button>
              );
            })}
          </div>
        )}

        {/* Years View */}
        {view === 'years' && (
          <div className={`${styles.grid} ${styles.yearsGrid}`}>
            {years.map((year) => (
              <button
                key={year}
                className={`${styles.gridButton} ${viewDate.getFullYear() === year ? styles.selected : ''}`}
                onClick={() => handleYearSelect(year)}
              >
                {year}
              </button>
            ))}
          </div>
        )}

        {/* Footer */}
        <div className={styles.footer}>
          <button className={styles.todayButton} onClick={handleGoToToday}>
            Today
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(calendarContent, document.body);
};

export default CalendarPicker;
