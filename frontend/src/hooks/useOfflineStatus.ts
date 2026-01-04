/**
 * Offline Detection Hook
 * 
 * Detects online/offline status and works across all browsers including iOS Safari.
 * iOS Safari has limited service worker navigateFallback support, so we handle
 * offline detection at the app level.
 */

import { useState, useEffect } from 'react';

export function useOfflineStatus() {
  const [isOffline, setIsOffline] = useState(!navigator.onLine);

  useEffect(() => {
    const handleOnline = () => setIsOffline(false);
    const handleOffline = () => setIsOffline(true);

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
