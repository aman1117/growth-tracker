import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// Service worker message handlers for push notifications
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', async (event) => {
    const { type, notification_id, url } = event.data || {};
    
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
  </StrictMode>,
)
