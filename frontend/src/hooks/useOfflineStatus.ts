/**
 * Offline Detection Hook
 *
 * Detects online/offline status and works across all browsers including iOS Safari.
 * iOS Safari has limited service worker navigateFallback support, so we handle
 * offline detection at the app level.
 */

import { useEffect, useState } from 'react';

import { gl } from '../services/goodlogs';

export function useOfflineStatus() {
  const [isOffline, setIsOffline] = useState(!navigator.onLine);

  useEffect(() => {
    const handleOnline = () => {
      gl.track('app_came_online');
      setIsOffline(false);
    };
    const handleOffline = () => {
      gl.track('app_went_offline');
      setIsOffline(true);
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    // Also check periodically for iOS which can be unreliable with these events
    const interval = setInterval(() => {
      setIsOffline(!navigator.onLine);
    }, 5000);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      clearInterval(interval);
    };
  }, []);

  return isOffline;
}
