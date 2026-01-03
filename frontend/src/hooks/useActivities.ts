/**
 * useActivities Hook
 * 
 * Handles activity data fetching, logging, and state management.
 * Extracted from Dashboard.tsx to separate concerns.
 */

import { useState, useCallback } from 'react';
import { api } from '../services/api';
import { ACTIVITY_NAMES } from '../types';
import type { ActivityName, Activity } from '../types';

interface ActivitiesState {
  /** Activity hours by name */
  hours: Record<string, number>;
  /** Activity notes by name */
  notes: Record<string, string>;
  /** Whether data is loading */
  loading: boolean;
  /** Error message if fetch failed */
  error: string | null;
  /** Whether account is private */
  isPrivateAccount: boolean;
}

interface UseActivitiesOptions {
  /** Target username */
  username: string;
  /** Callback on successful activity log */
  onLogSuccess?: () => void;
  /** Callback on error */
  onError?: (message: string) => void;
}

interface UseActivitiesReturn extends ActivitiesState {
  /** Fetch activities for a specific date */
  fetchActivities: (date: Date) => Promise<void>;
  /** Log activity hours */
  logActivity: (
    name: ActivityName,
    hours: number,
    date: Date,
    note?: string
  ) => Promise<boolean>;
  /** Update local activity state (optimistic update) */
  setActivityHours: (name: ActivityName, hours: number) => void;
  /** Update local note state */
  setActivityNote: (name: ActivityName, note: string) => void;
}

/**
 * Format date for API calls (YYYY-MM-DD)
 */
const formatDateForApi = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

/**
 * Initialize empty activity map
 */
const getEmptyActivityMap = (): Record<string, number> => {
  return ACTIVITY_NAMES.reduce(
    (acc, name) => {
      acc[name] = 0;
      return acc;
    },
    {} as Record<string, number>
  );
};

/**
 * Hook for managing activity data
 * 
 * @example
 * ```tsx
 * const {
 *   hours,
 *   notes,
 *   loading,
 *   fetchActivities,
 *   logActivity,
 * } = useActivities({
 *   username: user.username,
 *   onLogSuccess: () => showToast('Activity logged!', 'success'),
 *   onError: (msg) => showToast(msg, 'error'),
 * });
 * 
 * useEffect(() => {
 *   fetchActivities(currentDate);
 * }, [currentDate, fetchActivities]);
 * ```
 */
export function useActivities(
  options: UseActivitiesOptions
): UseActivitiesReturn {
  const { username, onLogSuccess, onError } = options;

  const [hours, setHours] = useState<Record<string, number>>(getEmptyActivityMap);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isPrivateAccount, setIsPrivateAccount] = useState(false);

  /**
   * Fetch activities for a specific date
   */
  const fetchActivities = useCallback(
    async (date: Date): Promise<void> => {
      if (!username) return;

      setLoading(true);
      setError(null);
      setIsPrivateAccount(false);

      try {
        const dateStr = formatDateForApi(date);
        const res = await api.post<{
          success: boolean;
          data: Activity[];
          error?: string;
          error_code?: string;
        }>('/get-activities', {
          username,
          start_date: dateStr,
          end_date: dateStr,
        });

        if (res.success) {
          const activityMap = getEmptyActivityMap();
          const notesMap: Record<string, string> = {};

          res.data?.forEach((a: Activity) => {
            activityMap[a.name] = a.hours;
            if (a.note) {
              notesMap[a.name] = a.note;
            }
          });

          setHours(activityMap);
          setNotes(notesMap);
        } else if (res.error_code === 'ACCOUNT_PRIVATE') {
          setIsPrivateAccount(true);
        } else {
          setError(res.error || 'Failed to fetch activities');
          onError?.(res.error || 'Failed to fetch activities');
        }
      } catch (err) {
        console.error('Failed to fetch activities', err);
        const message = 'Failed to load activities';
        setError(message);
        onError?.(message);
      } finally {
        setLoading(false);
      }
    },
    [username, onError]
  );

  /**
   * Log activity hours
   */
  const logActivity = useCallback(
    async (
      name: ActivityName,
      activityHours: number,
      date: Date,
      note?: string
    ): Promise<boolean> => {
      try {
        const dateStr = formatDateForApi(date);
        const res = await api.post<{ success: boolean; error?: string }>(
          '/log-activity',
          {
            name,
            hours: activityHours,
            date: dateStr,
            note: note || '',
          }
        );

        if (res.success) {
          // Update local state
          setHours((prev) => ({ ...prev, [name]: activityHours }));
          if (note) {
            setNotes((prev) => ({ ...prev, [name]: note }));
          } else {
            setNotes((prev) => {
              const newNotes = { ...prev };
              delete newNotes[name];
              return newNotes;
            });
          }
          onLogSuccess?.();
          return true;
        } else {
          onError?.(res.error || 'Failed to log activity');
          return false;
        }
      } catch (err) {
        console.error('Failed to log activity', err);
        onError?.('Failed to log activity');
        return false;
      }
    },
    [onLogSuccess, onError]
  );

  /**
   * Update local activity hours (for optimistic updates)
   */
  const setActivityHours = useCallback((name: ActivityName, newHours: number) => {
    setHours((prev) => ({ ...prev, [name]: newHours }));
  }, []);

  /**
   * Update local activity note
   */
  const setActivityNote = useCallback((name: ActivityName, note: string) => {
    setNotes((prev) => ({ ...prev, [name]: note }));
  }, []);

  return {
    hours,
    notes,
    loading,
    error,
    isPrivateAccount,
    fetchActivities,
    logActivity,
    setActivityHours,
    setActivityNote,
  };
}
