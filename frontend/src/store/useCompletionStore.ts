/**
 * Completion Store
 *
 * Global state management for calendar heat map data using Zustand.
 * Manages daily completion data (hours logged per day) with caching.
 */

import { create } from 'zustand';

import { API_ROUTES } from '../constants';
import { api } from '../services/api';

// ============================================================================
// Types
// ============================================================================

/** Map of date string (YYYY-MM-DD) to total hours logged */
export type MonthCompletionData = Record<string, number>;

/** Cache key format: "username:YYYY-MM" */
type CacheKey = string;

interface CompletionState {
  /** Cached monthly data: cacheKey -> { date: hours } */
  monthlyData: Record<CacheKey, MonthCompletionData>;

  /** Loading states per cache key */
  loadingStates: Record<CacheKey, boolean>;

  /** Error states per cache key */
  errorStates: Record<CacheKey, string | null>;

  // Actions
  /** Fetch completion data for a specific month */
  fetchMonthData: (
    username: string,
    year: number,
    month: number
  ) => Promise<MonthCompletionData | null>;

  /** Get cached data for a month (returns null if not cached) */
  getMonthData: (username: string, year: number, month: number) => MonthCompletionData | null;

  /** Check if month data is currently loading */
  isMonthLoading: (username: string, year: number, month: number) => boolean;

  /** Update a single day's completion (optimistic update after saving activities) */
  updateDay: (username: string, date: Date, totalHours: number) => void;

  /** Invalidate cache for a specific month */
  invalidateMonth: (username: string, year: number, month: number) => void;

  /** Clear all cached data */
  clearCache: () => void;
}

// ============================================================================
// Helpers
// ============================================================================

/** Generate cache key from username, year, and month */
const getCacheKey = (username: string, year: number, month: number): CacheKey => {
  return `${username.toLowerCase()}:${year}-${String(month + 1).padStart(2, '0')}`;
};

/** Format date to YYYY-MM-DD */
const formatDateForApi = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

/** Get first day of month */
const getMonthStart = (year: number, month: number): Date => {
  return new Date(year, month, 1);
};

/** Get last day of month */
const getMonthEnd = (year: number, month: number): Date => {
  return new Date(year, month + 1, 0);
};

// ============================================================================
// Store
// ============================================================================

export const useCompletionStore = create<CompletionState>((set, get) => ({
  monthlyData: {},
  loadingStates: {},
  errorStates: {},

  fetchMonthData: async (username, year, month) => {
    const cacheKey = getCacheKey(username, year, month);
    const state = get();

    // Return cached data if available
    if (state.monthlyData[cacheKey]) {
      return state.monthlyData[cacheKey];
    }

    // Don't fetch if already loading
    if (state.loadingStates[cacheKey]) {
      return null;
    }

    // Set loading state
    set((s) => ({
      loadingStates: { ...s.loadingStates, [cacheKey]: true },
      errorStates: { ...s.errorStates, [cacheKey]: null },
    }));

    try {
      const startDate = formatDateForApi(getMonthStart(year, month));
      const endDate = formatDateForApi(getMonthEnd(year, month));

      const res = await api.post(API_ROUTES.ACTIVITY.DAILY_TOTALS, {
        username,
        start_date: startDate,
        end_date: endDate,
      });

      if (res.success && res.data) {
        const completionData: MonthCompletionData = res.data;

        set((s) => ({
          monthlyData: { ...s.monthlyData, [cacheKey]: completionData },
          loadingStates: { ...s.loadingStates, [cacheKey]: false },
        }));

        return completionData;
      } else {
        throw new Error(res.error || 'Failed to fetch completion data');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[CompletionStore] Failed to fetch data for ${cacheKey}:`, errorMessage);

      set((s) => ({
        loadingStates: { ...s.loadingStates, [cacheKey]: false },
        errorStates: { ...s.errorStates, [cacheKey]: errorMessage },
      }));

      return null;
    }
  },

  getMonthData: (username, year, month) => {
    const cacheKey = getCacheKey(username, year, month);
    return get().monthlyData[cacheKey] || null;
  },

  isMonthLoading: (username, year, month) => {
    const cacheKey = getCacheKey(username, year, month);
    return get().loadingStates[cacheKey] || false;
  },

  updateDay: (username, date, totalHours) => {
    const year = date.getFullYear();
    const month = date.getMonth();
    const cacheKey = getCacheKey(username, year, month);
    const dateStr = formatDateForApi(date);

    set((s) => {
      const existingData = s.monthlyData[cacheKey];
      if (!existingData) {
        // If no cache exists, create new entry
        return {
          monthlyData: {
            ...s.monthlyData,
            [cacheKey]: { [dateStr]: totalHours },
          },
        };
      }

      // Update existing cache
      return {
        monthlyData: {
          ...s.monthlyData,
          [cacheKey]: {
            ...existingData,
            [dateStr]: totalHours,
          },
        },
      };
    });
  },

  invalidateMonth: (username, year, month) => {
    const cacheKey = getCacheKey(username, year, month);

    set((s) => {
      // Extract and discard the cache entries being invalidated
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [cacheKey]: _removed1, ...remainingData } = s.monthlyData;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [cacheKey]: _removed2, ...remainingLoading } = s.loadingStates;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [cacheKey]: _removed3, ...remainingErrors } = s.errorStates;

      return {
        monthlyData: remainingData,
        loadingStates: remainingLoading,
        errorStates: remainingErrors,
      };
    });
  },

  clearCache: () => {
    set({
      monthlyData: {},
      loadingStates: {},
      errorStates: {},
    });
  },
}));

// ============================================================================
// Selector Hooks
// ============================================================================

/** Hook to get completion data for a specific month */
export const useMonthCompletion = (
  username: string | undefined,
  year: number,
  month: number
): MonthCompletionData | null => {
  return useCompletionStore((state) =>
    username ? state.getMonthData(username, year, month) : null
  );
};

/** Hook to check if month data is loading */
export const useMonthCompletionLoading = (
  username: string | undefined,
  year: number,
  month: number
): boolean => {
  return useCompletionStore((state) =>
    username ? state.isMonthLoading(username, year, month) : false
  );
};
