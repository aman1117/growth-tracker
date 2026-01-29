/**
 * PWAUpdatePrompt Component
 *
 * Shows a toast/banner when a new version of the app is available.
 * User can choose to update immediately or dismiss.
 */

import { RefreshCw, X } from 'lucide-react';
import React from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';

export const PWAUpdatePrompt: React.FC = () => {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(swUrl: string, r: ServiceWorkerRegistration | undefined) {
      // Check for updates every hour
      if (r) {
        setInterval(
          () => {
            r.update();
          },
          60 * 60 * 1000
        );
      }
      console.log('SW registered:', swUrl);
    },
    onRegisterError(error: Error) {
      console.error('SW registration error:', error);
    },
  });

  const handleUpdate = () => {
    updateServiceWorker(true);
  };

  const handleDismiss = () => {
    setNeedRefresh(false);
  };

  // DEV: Set to true to test the UI, change back to needRefresh for production
  const showPrompt = needRefresh;

  if (!showPrompt) return null;

  return (
    <div
      style={{
        position: 'fixed',
        top: 'calc(env(safe-area-inset-top, 0px) + 1rem)',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 10000,
        animation: 'pwaSlideIn 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
      }}
    >
      <style>{`
        @keyframes pwaSlideIn {
          0% {
            opacity: 0;
            transform: translateX(-50%) translateY(-30px) scale(0.9);
          }
          60% {
            opacity: 1;
            transform: translateX(-50%) translateY(4px) scale(1.02);
          }
          100% {
            opacity: 1;
            transform: translateX(-50%) translateY(0) scale(1);
          }
        }
      `}</style>

      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '0.625rem',
          padding: '0.5rem 0.75rem 0.5rem 0.875rem',
          background: 'rgba(0, 0, 0, 0.8)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          borderRadius: '100px',
          border: '1px solid rgba(255, 255, 255, 0.1)',
          boxShadow: '0 4px 24px rgba(0, 0, 0, 0.25), 0 2px 8px rgba(0, 0, 0, 0.15)',
          maxWidth: 'calc(100vw - 3rem)',
          whiteSpace: 'nowrap',
        }}
      >
        {/* Icon */}
        <div
          style={{
            width: '24px',
            height: '24px',
            borderRadius: '50%',
            background: 'linear-gradient(135deg, #0095f6 0%, #0077e6 100%)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <RefreshCw size={13} color="white" />
        </div>

        {/* Text */}
        <span
          style={{
            fontWeight: 500,
            fontSize: '0.9rem',
            color: 'white',
          }}
        >
          New update available
        </span>

        {/* Update button */}
        <button
          onClick={handleUpdate}
          style={{
            padding: '0.375rem 0.875rem',
            borderRadius: '100px',
            border: 'none',
            background: 'linear-gradient(135deg, #0095f6 0%, #0077e6 100%)',
            color: 'white',
            fontWeight: 600,
            fontSize: '0.8rem',
            cursor: 'pointer',
            transition: 'transform 0.15s',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.transform = 'scale(1.05)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = 'scale(1)';
          }}
        >
          Refresh
        </button>

        {/* Dismiss button */}
        <button
          onClick={handleDismiss}
          style={{
            padding: '0.3rem',
            borderRadius: '50%',
            border: 'none',
            background: 'rgba(255, 255, 255, 0.15)',
            color: 'rgba(255, 255, 255, 0.7)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'background-color 0.15s',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.25)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.15)';
          }}
          aria-label="Dismiss"
        >
          <X size={13} />
        </button>
      </div>
    </div>
  );
};

export default PWAUpdatePrompt;
