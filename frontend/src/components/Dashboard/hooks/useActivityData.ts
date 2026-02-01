/**
 * useActivityData Hook
 *
 * Manages activity data fetching, caching, and state.
 * Handles offline support and private account detection.
 */

import { useCallback, useEffect, useState } from 'react';

import { api, ApiError } from '../../../services/api';
import type { Activity } from '../../../types';
import { ACTIVITY_NAMES } from '../../../types';
import type { Badge } from '../../../types/api';
import { cacheActivities, formatDateForApi, loadCachedActivities } from '../Dashboard.constants';

interface UseActivityDataProps {
  targetUsername: string | undefined;
  currentDate: Date;
  isReadOnly: boolean;
  onPrivateAccount: (isPrivate: boolean) => void;
  onPrivateAccountBadges: (badges: Badge[]) => void;
  onError: (message: string) => void;
}

interface UseActivityDataReturn {
  activities: Record<string, number>;
  setActivities: React.Dispatch<React.SetStateAction<Record<string, number>>>;
  activityNotes: Record<string, string>;
  setActivityNotes: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  loading: boolean;
  fetchActivities: () => Promise<void>;
}

export const useActivityData = ({
  targetUsername,
  currentDate,
  isReadOnly,
  onPrivateAccount,
  onPrivateAccountBadges,
  onError,
}: UseActivityDataProps): UseActivityDataReturn => {
  const [activities, setActivities] = useState<Record<string, number>>({});
  const [activityNotes, setActivityNotes] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  // Fetch badges for private accounts (badges are always public)
  const fetchBadgesForPrivateAccount = useCallback(
    async (username: string) => {
      try {
        const res = await api.post('/badges/user', { username });
        if (res.success && res.badges) {
          onPrivateAccountBadges(res.badges);
        }
      } catch (error) {
        console.error('[useActivityData] Failed to fetch badges for private account:', error);
      }
    },
    [onPrivateAccountBadges]
  );

  const fetchActivities = useCallback(async () => {
    if (!targetUsername) return;
    setLoading(true);
    const dateStr = formatDateForApi(currentDate);

    try {
      const res = await api.post('/get-activities', {
        username: targetUsername,
        start_date: dateStr,
        end_date: dateStr,
      });

      if (res.success) {
        onPrivateAccount(false);
        const activityMap: Record<string, number> = {};
        const notesMap: Record<string, string> = {};
        
        // Initialize all activities with 0
        ACTIVITY_NAMES.forEach((name) => {
          activityMap[name] = 0;
        });

        // Update with actual data from backend
        res.data.forEach((a: Activity) => {
          activityMap[a.name] = a.hours;
          if (a.note) {
            notesMap[a.name] = a.note;
          }
        });
        setActivities(activityMap);
        setActivityNotes(notesMap);

        // Cache for offline access (only cache own data)
        if (!isReadOnly) {
          cacheActivities(targetUsername, dateStr, activityMap, notesMap);
        }
      } else if (res.error_code === 'ACCOUNT_PRIVATE') {
        onPrivateAccount(true);
        // Fetch badges for private accounts (badges are always public)
        fetchBadgesForPrivateAccount(targetUsername);
      }
    } catch (err: unknown) {
      // Check if it's a private account error
      if (err instanceof ApiError && err.errorCode === 'ACCOUNT_PRIVATE') {
        onPrivateAccount(true);
        // Fetch badges for private accounts (badges are always public)
        fetchBadgesForPrivateAccount(targetUsername);
      } else {
        console.error('[useActivityData] Failed to fetch activities', err);

        // Try to load from cache when offline
        const cached = loadCachedActivities(targetUsername, dateStr);
        if (cached) {
          setActivities(cached.activities);
          setActivityNotes(cached.notes);
        } else {
          onError('Failed to load activities');
        }
      }
    } finally {
      setLoading(false);
    }
  }, [currentDate, targetUsername, isReadOnly, onPrivateAccount, fetchBadgesForPrivateAccount, onError]);

  useEffect(() => {
    fetchActivities();
  }, [fetchActivities]);

  return {
    activities,
    setActivities,
    activityNotes,
    setActivityNotes,
    loading,
    fetchActivities,
  };
};
