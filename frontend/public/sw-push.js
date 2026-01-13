/**
 * Service Worker - Push Notification Handler
 * 
 * Handles push events, notification clicks, and subscription changes.
 * Imported into the Workbox-generated service worker via importScripts.
 */

// ============================================================================
// Push Event Handler
// ============================================================================

self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = {
      title: 'Growth Tracker',
      body: event.data.text(),
    };
  }

  const {
    title = 'Growth Tracker',
    body = '',
    icon = '/pwa-192x192.png',
    badge = '/pwa-192x192.png',
    tag,
    deepLink,
    data = {},
    actions = [],
    requireInteraction = false,
    silent = false,
  } = payload;

  const options = {
    body,
    icon,
    badge,
    tag: tag || `notification-${Date.now()}`,
    data: {
      deepLink: deepLink || data.url || '/',
      url: deepLink || data.url || '/',
      notification_id: data.notification_id,
      type: payload.type || data.type,
      timestamp: Date.now(),
    },
    actions,
    requireInteraction,
    silent,
    vibrate: silent ? [] : [100, 50, 100],
    renotify: true,
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// ============================================================================
// Notification Click Handler
// ============================================================================

/**
 * Mark notification as read via app window or direct API call
 */
async function markNotificationAsRead(notificationId) {
  if (notificationId == null) return;

  try {
    const windowClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    
    // Prefer sending to app window (has auth context)
    for (const client of windowClients) {
      if (client.url.includes(self.location.origin)) {
        client.postMessage({
          type: 'MARK_NOTIFICATION_READ',
          notification_id: notificationId,
        });
        return;
      }
    }

    // Fallback: direct API call (relies on cookies)
    await fetch(`/api/notifications/${notificationId}/read`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    });
  } catch {
    // Silent fail - notification will sync on next fetch
  }
}

/**
 * Handle follow request accept/decline actions via app window
 */
async function handleFollowRequestAction(action, data) {
  try {
    const windowClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    
    // Send to app window to handle (has auth context)
    for (const client of windowClients) {
      if (client.url.includes(self.location.origin)) {
        client.postMessage({
          type: 'FOLLOW_REQUEST_ACTION',
          action: action, // 'accept' or 'decline'
          actor_id: data.actor_id,
          notification_id: data.notification_id,
        });
        return;
      }
    }
  } catch {
    // Silent fail - user can handle in app
  }
}

self.addEventListener('notificationclick', (event) => {
  const notification = event.notification;
  const action = event.action;
  const data = notification.data || {};

  // Close the notification
  notification.close();

  // Determine URL to open (backend sends "deepLink" field)
  let url = data.deepLink || data.url || '/';
  
  // Handle action buttons
  if (action === 'accept' && data.type === 'follow_request') {
    // Accept follow request - navigate to notifications to handle it
    url = '/notifications';
    // Also try to call the accept API
    handleFollowRequestAction('accept', data);
  } else if (action === 'decline' && data.type === 'follow_request') {
    // Decline follow request
    handleFollowRequestAction('decline', data);
    // Don't navigate, just close
    return;
  } else if (action === 'view' && (data.deepLink || data.url)) {
    url = data.deepLink || data.url;
  } else if (action === 'dismiss') {
    // Just close, don't open anything
    return;
  }

  // Mark notification as read and navigate
  event.waitUntil(
    Promise.all([
      // Mark the notification as read in the backend
      markNotificationAsRead(data.notification_id),
      // Focus existing window or open new one
      clients.matchAll({ type: 'window', includeUncontrolled: true })
        .then((windowClients) => {
          // Check if there's already a window open
          for (const client of windowClients) {
            if (client.url.includes(self.location.origin)) {
              // Focus existing window and tell it to navigate via postMessage
              return client.focus().then((focusedClient) => {
                if (focusedClient) {
                  // Send message to the app to navigate
                  focusedClient.postMessage({
                    type: 'NAVIGATE_TO',
                    url: url,
                  });
                }
              });
            }
          }
          // No existing window, open new one
          return clients.openWindow(url);
        })
    ])
  );
});

// ============================================================================
// Notification Close Handler
// ============================================================================

self.addEventListener('notificationclose', () => {
  // Analytics hook - notification was dismissed without interaction
});

// ============================================================================
// Push Subscription Change Handler
// ============================================================================

self.addEventListener('pushsubscriptionchange', (event) => {
  // Subscription expired or was revoked - notify open windows to re-sync
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((windowClients) => {
        windowClients.forEach((client) => {
          client.postMessage({ type: 'PUSH_SUBSCRIPTION_CHANGED' });
        });
      })
  );
});
