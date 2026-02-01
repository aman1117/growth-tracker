/**
 * Notifications Blocked Dialog
 *
 * Help dialog showing how to enable blocked notifications.
 */

import { BellOff } from 'lucide-react';
import React from 'react';
import { createPortal } from 'react-dom';

import type { NotificationsBlockedDialogProps } from '../SettingsPage.types';

export const NotificationsBlockedDialog: React.FC<NotificationsBlockedDialogProps> = ({
  isOpen,
  onClose,
}) => {
  if (!isOpen) return null;

  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const isAndroid = /Android/.test(navigator.userAgent);
  const isPWA = window.matchMedia('(display-mode: standalone)').matches;
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';

  let title: string;
  let steps: string[];

  if (isIOS) {
    if (isPWA) {
      title = 'Reset Notification Permission';
      steps = [
        'Remove app from Home Screen (long press > Remove)',
        'Open Safari and visit this site again',
        'Tap Share > "Add to Home Screen"',
        'Open app and tap "Enable" when prompted',
        'Select "Allow" in the permission dialog',
      ];
    } else {
      title = 'Enable on iOS';
      steps = [
        'Tap the Share button below',
        'Select "Add to Home Screen"',
        'Open the app from Home Screen',
        'Tap Enable and allow notifications',
      ];
    }
  } else if (isAndroid) {
    if (isPWA) {
      title = 'Enable on Android';
      steps = [
        'Open Settings > Apps',
        'Tap "Growth Tracker"',
        'Tap "Notifications"',
        'Turn on notifications',
      ];
    } else {
      title = 'Enable in Browser';
      steps = [
        'Tap ⋮ menu in browser',
        'Go to Settings > Site settings',
        'Tap "Notifications"',
        'Allow for this site',
      ];
    }
  } else {
    title = 'Enable Notifications';
    steps = [
      'Click lock icon in address bar',
      'Find "Notifications"',
      'Change to "Allow"',
      'Refresh the page',
    ];
  }

  return createPortal(
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: isDark ? 'rgba(0, 0, 0, 0.7)' : 'rgba(0, 0, 0, 0.4)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1.5rem',
        zIndex: 9999,
        animation: 'fadeIn 0.2s ease',
      }}
    >
      <style>{`
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes slideUp { from { opacity: 0; transform: translateY(20px) scale(0.95); } to { opacity: 1; transform: translateY(0) scale(1); } }
      `}</style>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: isDark ? 'rgba(30, 30, 35, 0.85)' : 'rgba(255, 255, 255, 0.75)',
          backdropFilter: 'blur(40px) saturate(180%)',
          WebkitBackdropFilter: 'blur(40px) saturate(180%)',
          borderRadius: '20px',
          border: isDark
            ? '1px solid rgba(255, 255, 255, 0.1)'
            : '1px solid rgba(255, 255, 255, 0.6)',
          boxShadow: isDark
            ? '0 25px 50px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.05)'
            : '0 25px 50px rgba(0, 0, 0, 0.15), inset 0 1px 0 rgba(255, 255, 255, 0.8)',
          maxWidth: '320px',
          width: '100%',
          animation: 'slideUp 0.3s ease',
        }}
      >
        {/* Header with icon */}
        <div
          style={{
            padding: '1.5rem 1.5rem 0',
            textAlign: 'center',
          }}
        >
          <div
            style={{
              width: '56px',
              height: '56px',
              borderRadius: '16px',
              background: isDark ? 'rgba(239, 68, 68, 0.2)' : 'rgba(239, 68, 68, 0.1)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto 1rem',
              color: '#ef4444',
            }}
          >
            <BellOff size={28} />
          </div>
          <h3
            style={{
              fontSize: '1.125rem',
              fontWeight: 700,
              color: isDark ? '#fff' : '#1a1a1a',
              margin: 0,
            }}
          >
            {title}
          </h3>
          <p
            style={{
              fontSize: '0.8125rem',
              color: isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)',
              margin: '0.375rem 0 0',
            }}
          >
            Follow these steps
          </p>
        </div>

        {/* Steps */}
        <div style={{ padding: '1.25rem 1.5rem' }}>
          {steps.map((step, index) => (
            <div
              key={index}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: '0.75rem',
                padding: '0.625rem 0',
                borderBottom:
                  index < steps.length - 1
                    ? `1px solid ${isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)'}`
                    : 'none',
              }}
            >
              <span
                style={{
                  minWidth: '22px',
                  height: '22px',
                  borderRadius: '50%',
                  background: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.06)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '0.6875rem',
                  fontWeight: 600,
                  color: isDark ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.5)',
                }}
              >
                {index + 1}
              </span>
              <span
                style={{
                  fontSize: '0.875rem',
                  color: isDark ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.75)',
                  lineHeight: 1.4,
                  paddingTop: '0.0625rem',
                }}
              >
                {step}
              </span>
            </div>
          ))}
        </div>

        {/* Button */}
        <div style={{ padding: '0 1.5rem 1.5rem' }}>
          <button
            onClick={onClose}
            style={{
              width: '100%',
              padding: '0.875rem',
              borderRadius: '12px',
              border: 'none',
              background: '#0095f6',
              color: 'white',
              fontSize: '0.9375rem',
              fontWeight: 600,
              cursor: 'pointer',
              transition: 'transform 0.1s, opacity 0.1s',
            }}
            onMouseDown={(e) => (e.currentTarget.style.transform = 'scale(0.98)')}
            onMouseUp={(e) => (e.currentTarget.style.transform = 'scale(1)')}
            onMouseLeave={(e) => (e.currentTarget.style.transform = 'scale(1)')}
          >
            Got it
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
