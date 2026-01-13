/**
 * CalendarPicker Component
 *
 * A professional calendar date picker with glassmorphism design.
 * Features day/month/year selection views with smooth animations.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import styles from './CalendarPicker.module.css';

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
  useEffect(() => {
    if (isOpen) {
      setViewDate(selectedDate);
      setView('days');
      setIsClosing(false);
    }
  }, [isOpen, selectedDate]);

  // Handle click outside
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent | TouchEvent) => {
      if (
        calendarRef.current &&
        !calendarRef.current.contains(e.target as Node)
      ) {
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
  }, [isOpen]);

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
  }, [isOpen]);

  const handleClose = useCallback(() => {
    setIsClosing(true);
    setTimeout(() => {
      onClose();
      setIsClosing(false);
    }, 150);
  }, [onClose]);

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
    setViewDate(
      (prev) => new Date(prev.getFullYear(), prev.getMonth() + delta, 1)
    );
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
    const nextMonth = new Date(
      viewDate.getFullYear(),
      viewDate.getMonth() + 1,
      1
    );
    return nextMonth <= maxDate;
  };

  if (!isOpen) return null;

  const getDayClassName = (day: {
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
    ]
      .filter(Boolean)
      .join(' ');
  };

  const calendarContent = (
    <div
      className={`${styles.overlay} ${isClosing ? styles.closing : ''}`}
      onClick={handleClose}
    >
      <div
        ref={calendarRef}
        className={`${styles.modal} ${isClosing ? styles.closing : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className={styles.header}>
          <button
            className={styles.navButton}
            onClick={() =>
              view === 'days' ? navigateMonth(-1) : setView('years')
            }
            disabled={view === 'years'}
          >
            <ChevronLeft size={16} />
          </button>

          <div className={styles.titleGroup}>
            {view === 'days' && (
              <>
                <button
                  className={styles.titleButton}
                  onClick={() => setView('months')}
                >
                  {MONTHS[viewDate.getMonth()]}
                </button>
                <button
                  className={styles.titleButton}
                  onClick={() => setView('years')}
                >
                  {viewDate.getFullYear()}
                </button>
              </>
            )}
            {view === 'months' && (
              <button
                className={styles.titleButton}
                onClick={() => setView('years')}
              >
                {viewDate.getFullYear()}
              </button>
            )}
            {view === 'years' && (
              <span className={styles.titleText}>Select Year</span>
            )}
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
                viewDate.getFullYear() === maxDate.getFullYear() &&
                idx > maxDate.getMonth();
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
