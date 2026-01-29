import './index.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App.tsx';

// Service worker message handlers for push notifications
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', async (event) => {
    const { type, notification_id, url, action, actor_id } = event.data || {};

    switch (type) {
      case 'MARK_NOTIFICATION_READ':
        if (notification_id != null) {
          try {
            const { useNotificationStore } = await import('./store/useNotificationStore');
            await useNotificationStore.getState().markAsRead(notification_id);
          } catch {
            // Silent fail - notification will sync on next fetch
          }
        }
        break;

      case 'FOLLOW_REQUEST_ACTION':
        if (actor_id != null && action) {
          try {
            const { useFollowStore } = await import('./store/useFollowStore');
            const store = useFollowStore.getState();

            if (action === 'accept') {
              await store.acceptRequest(actor_id);
            } else if (action === 'decline') {
              await store.declineRequest(actor_id);
            }

            // Also mark notification as read
            if (notification_id != null) {
              const { useNotificationStore } = await import('./store/useNotificationStore');
              await useNotificationStore.getState().markAsRead(notification_id);
            }
          } catch {
            // Silent fail - user can handle in app
          }
        }
        break;

      case 'NAVIGATE_TO':
        if (url && window.location.pathname + window.location.search !== url) {
          window.location.href = url;
        }
        break;

      case 'PUSH_SUBSCRIPTION_CHANGED':
        try {
          const { usePushStore } = await import('./store/usePushStore');
          usePushStore.getState().checkSupport();
        } catch {
          // Silent fail - will re-check on next app load
        }
        break;
    }
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
