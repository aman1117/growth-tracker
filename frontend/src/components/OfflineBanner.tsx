/**
 * Offline Banner Component
 *
 * Shows a notice while the user is offline, then a brief "Back online"
 * confirmation that fades away once the connection is restored.
 * Works on all platforms including iOS Safari.
 */

import { Wifi, WifiOff } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';

import { useOfflineStatus } from '../hooks/useOfflineStatus';
import { Notice } from './ui';

type BannerState = 'hidden' | 'offline' | 'online' | 'fading';

/** How long "Back online" stays fully visible before fading */
const ONLINE_VISIBLE_MS = 1500;
/** Must match the Notice exit transition */
const FADE_MS = 500;

export const OfflineBanner: React.FC = () => {
  const isOffline = useOfflineStatus();
  const [bannerState, setBannerState] = useState<BannerState>('hidden');
  const [isDismissed, setIsDismissed] = useState(false);
  const wasOfflineRef = useRef(false);

  useEffect(() => {
    if (isOffline) {
      // Going offline
      wasOfflineRef.current = true;
      setIsDismissed(false);
      setBannerState('offline');
    } else if (wasOfflineRef.current) {
      // Coming back online (was previously offline)
      wasOfflineRef.current = false;
      setBannerState('online');

      const fadeTimer = setTimeout(() => setBannerState('fading'), ONLINE_VISIBLE_MS);
      const hideTimer = setTimeout(() => setBannerState('hidden'), ONLINE_VISIBLE_MS + FADE_MS);

      return () => {
        clearTimeout(fadeTimer);
        clearTimeout(hideTimer);
      };
    }
  }, [isOffline]);

  const handleDismiss = () => {
    if (bannerState === 'offline') {
      setIsDismissed(true);
    } else {
      setBannerState('fading');
      setTimeout(() => setBannerState('hidden'), FADE_MS);
    }
  };

  if (bannerState === 'hidden' || (bannerState === 'offline' && isDismissed)) {
    return null;
  }

  const isOnlineState = bannerState === 'online' || bannerState === 'fading';

  return isOnlineState ? (
    <Notice
      tone="success"
      icon={<Wifi size={18} />}
      title="You're back online!"
      leaving={bannerState === 'fading'}
      onDismiss={handleDismiss}
      dismissLabel="Dismiss notification"
    />
  ) : (
    <Notice
      tone="warning"
      icon={<WifiOff size={18} />}
      title="You're offline"
      description="Some features may be unavailable until you reconnect."
      onDismiss={handleDismiss}
      dismissLabel="Dismiss notification"
    />
  );
};
