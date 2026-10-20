/**
 * PWAUpdatePrompt Component
 *
 * Shows a notice when a new version of the app is available.
 * User can choose to update immediately or dismiss.
 */

import { RefreshCw, Sparkles } from 'lucide-react';
import React from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';

import { gl } from '../services/goodlogs';
import { Notice } from './ui';

const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

export const PWAUpdatePrompt: React.FC = () => {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(swUrl: string, r: ServiceWorkerRegistration | undefined) {
      // Check for updates every hour
      if (r) {
        setInterval(() => {
          r.update();
        }, UPDATE_CHECK_INTERVAL_MS);
      }
      console.log('SW registered:', swUrl);
    },
    onRegisterError(error: Error) {
      console.error('SW registration error:', error);
    },
  });

  const handleUpdate = () => {
    gl.track('pwa_update_accepted');
    updateServiceWorker(true);
  };

  const handleDismiss = () => {
    gl.track('pwa_update_dismissed');
    setNeedRefresh(false);
  };

  if (!needRefresh) return null;

  return (
    <Notice
      tone="brand"
      icon={<Sparkles size={18} />}
      title="A fresh update is ready"
      description="Refresh to get the latest improvements."
      action={{ label: 'Refresh', icon: <RefreshCw size={13} />, onClick: handleUpdate }}
      onDismiss={handleDismiss}
    />
  );
};

export default PWAUpdatePrompt;
