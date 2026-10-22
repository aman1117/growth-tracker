/**
 * useRefreshOnFocus Hook
 *
 * Calls `onRefresh` when the user comes back to the app: the page becomes visible
 * again (tab switch, phone unlock, returning from a share sheet) or the window
 * regains focus. Both usually fire together, so calls closer than
 * `minIntervalMs` apart are merged into one.
 */

import { useEffect, useRef } from 'react';

export interface UseRefreshOnFocusOptions {
  /** Listen only while true (e.g. once the first load succeeded) */
  enabled?: boolean;
  /** Shortest time between two refreshes, in milliseconds */
  minIntervalMs?: number;
}

export function useRefreshOnFocus(
  onRefresh: () => void,
  { enabled = true, minIntervalMs = 2000 }: UseRefreshOnFocusOptions = {}
): void {
  const onRefreshRef = useRef(onRefresh);

  useEffect(() => {
    onRefreshRef.current = onRefresh;
  }, [onRefresh]);

  useEffect(() => {
    if (!enabled) return;

    let lastRefreshAt: number | null = null;

    const refresh = () => {
      if (document.visibilityState === 'hidden') return;
      const now = Date.now();
      if (lastRefreshAt !== null && Math.abs(now - lastRefreshAt) < minIntervalMs) return;
      lastRefreshAt = now;
      onRefreshRef.current();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') refresh();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', refresh);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', refresh);
    };
  }, [enabled, minIntervalMs]);
}
