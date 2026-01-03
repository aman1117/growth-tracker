/**
 * useStreak Hook
 * 
 * Handles streak data fetching and state management.
 * Extracted from DaySummaryCard.tsx.
 */

import { useState, useCallback } from 'react';
import { api } from '../services/api';

export interface StreakData {
  current: number;
  longest: number;
  longestStart?: string;
  longestEnd?: string;
}

interface UseStreakOptions {
  /** Callback on error */
  onError?: (message: string) => void;
}

interface UseStreakReturn {
  /** Streak data */
  streak: StreakData;
  /** Whether data is loading */
  loading: boolean;
  /** Error message if fetch failed */
  error: string | null;
  /** Fetch streak data */
  fetchStreak: (username: string, date: Date) => Promise<void>;
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

const DEFAULT_STREAK: StreakData = {
  current: 0,
  longest: 0,
};

/**
 * Hook for managing streak data
 * 
 * @example
 * ```tsx
 * const { streak, loading, fetchStreak } = useStreak();
 * 
 * useEffect(() => {
 *   fetchStreak(username, currentDate);
 * }, [username, currentDate, fetchStreak]);
 * ```
 */
export function useStreak(options: UseStreakOptions = {}): UseStreakReturn {
  const { onError } = options;

  const [streak, setStreak] = useState<StreakData>(DEFAULT_STREAK);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /**
   * Fetch streak data for a user and date
   */
  const fetchStreak = useCallback(
    async (username: string, date: Date): Promise<void> => {
      if (!username) return;

      setLoading(true);
      setError(null);

      try {
        const dateStr = formatDateForApi(date);
        const res = await api.post<{
          success: boolean;
          data?: {
            current: number;
            longest: number;
            longest_start?: string;
            longest_end?: string;
          };
          error?: string;
        }>('/get-streak', { username, date: dateStr });

        if (res.success && res.data) {
          setStreak({
            current: res.data.current,
            longest: res.data.longest,
            longestStart: res.data.longest_start,
            longestEnd: res.data.longest_end,
          });
        } else {
          setStreak(DEFAULT_STREAK);
        }
      } catch (err) {
        console.error('Failed to fetch streak:', err);
        const message = 'Failed to load streak data';
        setError(message);
        setStreak(DEFAULT_STREAK);
        onError?.(message);
      } finally {
        setLoading(false);
      }
    },
    [onError]
  );

  return {
    streak,
    loading,
    error,
    fetchStreak,
  };
}
