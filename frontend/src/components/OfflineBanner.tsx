/**
 * Offline Banner Component
 *
 * Shows a banner when the user is offline.
 * Shows green "Back online" message with fade animation when connection restored.
 * Works on all platforms including iOS Safari.
 */

import { Wifi, WifiOff, X } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';

import { useOfflineStatus } from '../hooks/useOfflineStatus';

type BannerState = 'hidden' | 'offline' | 'online' | 'fading';

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

      // Start fade after showing "Back online" for 1.5s
      const fadeTimer = setTimeout(() => {
        setBannerState('fading');
      }, 1500);

      // Hide completely after fade animation (0.5s)
      const hideTimer = setTimeout(() => {
        setBannerState('hidden');
      }, 2000);

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
      setTimeout(() => setBannerState('hidden'), 500);
    }
  };

  if (bannerState === 'hidden' || (bannerState === 'offline' && isDismissed)) {
    return null;
  }

  const isOnlineState = bannerState === 'online' || bannerState === 'fading';
  const backgroundColor = isOnlineState ? '#22c55e' : '#ef4444';
  const Icon = isOnlineState ? Wifi : WifiOff;
  const message = isOnlineState
    ? "You're back online!"
    : "You're offline. Some features may be unavailable.";

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        backgroundColor,
        color: 'white',
        padding: '6px 40px 6px 16px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '6px',
        fontSize: '12px',
        fontWeight: 500,
        zIndex: 9999,
        fontFamily: "'Nunito Sans', sans-serif",
        transition: 'background-color 0.3s ease, opacity 0.5s ease, transform 0.5s ease',
        opacity: bannerState === 'fading' ? 0 : 1,
        transform: bannerState === 'fading' ? 'translateY(-100%)' : 'translateY(0)',
      }}
    >
      <Icon size={14} />
      <span style={{ textAlign: 'center' }}>{message}</span>
      <button
        onClick={handleDismiss}
        style={{
          position: 'absolute',
          right: '8px',
          background: 'none',
          border: 'none',
          color: 'white',
          cursor: 'pointer',
          padding: '4px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: '4px',
          opacity: 0.8,
        }}
        onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
        onMouseLeave={(e) => (e.currentTarget.style.opacity = '0.8')}
        aria-label="Dismiss notification"
      >
        <X size={16} />
      </button>
    </div>
  );
};
