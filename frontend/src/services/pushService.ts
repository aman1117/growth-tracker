/**
 * Push Notification Service
 *
 * Handles Web Push subscription management:
 * - VAPID public key fetching
 * - Browser subscription creation
 * - Backend registration/unregistration
 * - Preferences management
 */

import { env } from '../config/env';
import type {
  PreferencesResponse,
  PushSubscriptionData,
  SubscribeRequest,
  SubscribeResponse,
  UnsubscribeResponse,
  UpdatePreferencesRequest,
  VapidKeyResponse,
} from '../types/push';
import { apiClient, ApiError } from './api';

// ============================================================================
// Constants
// ============================================================================

const PUSH_ROUTES = {
  VAPID_KEY: '/push/vapid-public-key',
  SUBSCRIBE: '/push/subscriptions',
  UNSUBSCRIBE: '/push/subscriptions',
  PREFERENCES: '/push/preferences',
} as const;

// Same base URL as apiClient, for the one request that must bypass it (unregisterDevice)
const API_BASE_URL = `${env.apiUrl}/api`;

// Cache VAPID key to avoid repeated API calls
let cachedVapidKey: string | null = null;

/** Outcome of confirming the browser's existing subscription with the server */
export type SubscriptionCheck = 'registered' | 'removed' | 'unchecked';

// ============================================================================
// Helper Functions
// ============================================================================

/** The server answers 409 when the endpoint is registered to another account */
const isEndpointConflict = (error: unknown): boolean =>
  error instanceof ApiError && error.statusCode === 409;

/**
 * Convert URL-safe base64 to Uint8Array for push subscription
 */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');

  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }

  return outputArray;
}

/**
 * Convert ArrayBuffer to URL-safe base64 string
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Detect browser and platform information
 */
function getBrowserInfo(): { browser: string; platform: string } {
  const ua = navigator.userAgent;
  let browser = 'unknown';
  let platform = 'unknown';

  // Detect browser
  if (ua.includes('Firefox')) {
    browser = 'firefox';
  } else if (ua.includes('Edg/')) {
    browser = 'edge';
  } else if (ua.includes('Chrome')) {
    browser = 'chrome';
  } else if (ua.includes('Safari')) {
    browser = 'safari';
  }

  // Detect platform
  if (ua.includes('Android')) {
    platform = 'android';
  } else if (ua.includes('iPhone') || ua.includes('iPad')) {
    platform = 'ios';
  } else if (ua.includes('Windows')) {
    platform = 'windows';
  } else if (ua.includes('Mac')) {
    platform = 'macos';
  } else if (ua.includes('Linux')) {
    platform = 'linux';
  }

  return { browser, platform };
}

// ============================================================================
// Push Service Class
// ============================================================================

class PushService {
  /**
   * Check if Web Push is supported in this browser
   */
  isSupported(): boolean {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  }

  /**
   * Get current notification permission state
   */
  getPermissionState(): NotificationPermission | 'unsupported' {
    if (!this.isSupported()) {
      return 'unsupported';
    }
    return Notification.permission;
  }

  /**
   * Request notification permission from the user
   */
  async requestPermission(): Promise<NotificationPermission> {
    if (!this.isSupported()) {
      throw new Error('Push notifications are not supported');
    }

    const permission = await Notification.requestPermission();
    return permission;
  }

  /**
   * Fetch VAPID public key from backend
   */
  async getVapidPublicKey(): Promise<string> {
    if (cachedVapidKey) {
      return cachedVapidKey;
    }

    const response = await apiClient.get<VapidKeyResponse>(PUSH_ROUTES.VAPID_KEY);

    if (!response.success || !response.publicKey) {
      throw new Error('Failed to fetch VAPID public key');
    }

    cachedVapidKey = response.publicKey;
    return response.publicKey;
  }

  /**
   * Get the active service worker registration
   */
  async getServiceWorkerRegistration(): Promise<ServiceWorkerRegistration> {
    const registration = await navigator.serviceWorker.ready;
    return registration;
  }

  /**
   * Check if there's an active push subscription
   */
  async getExistingSubscription(): Promise<PushSubscription | null> {
    const registration = await this.getServiceWorkerRegistration();
    const subscription = await registration.pushManager.getSubscription();
    return subscription;
  }

  /**
   * Create a new browser push subscription
   */
  async createBrowserSubscription(): Promise<PushSubscription> {
    const vapidPublicKey = await this.getVapidPublicKey();
    const registration = await this.getServiceWorkerRegistration();

    // Convert VAPID key to Uint8Array
    const applicationServerKey = urlBase64ToUint8Array(vapidPublicKey);

    // Subscribe to push notifications
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: applicationServerKey.buffer as ArrayBuffer,
    });

    return subscription;
  }

  /**
   * Extract subscription data for API request
   */
  extractSubscriptionData(subscription: PushSubscription): PushSubscriptionData {
    const key = subscription.getKey('p256dh');
    const auth = subscription.getKey('auth');

    if (!key || !auth) {
      throw new Error('Invalid push subscription: missing keys');
    }

    return {
      endpoint: subscription.endpoint,
      keys: {
        p256dh: arrayBufferToBase64(key),
        auth: arrayBufferToBase64(auth),
      },
    };
  }

  /**
   * Subscribe to push notifications (full flow)
   */
  async subscribe(): Promise<SubscribeResponse> {
    if (!this.isSupported()) {
      throw new Error('Push notifications are not supported');
    }

    // Check permission
    const permission = Notification.permission;
    if (permission === 'denied') {
      throw new Error('Notification permission denied');
    }

    // Request permission if needed
    if (permission === 'default') {
      const newPermission = await this.requestPermission();
      if (newPermission !== 'granted') {
        throw new Error('Notification permission not granted');
      }
    }

    // Create browser subscription
    const subscription = await this.createBrowserSubscription();
    try {
      return await this.registerSubscription(subscription);
    } catch (error) {
      if (!isEndpointConflict(error)) throw error;
      // The browser still holds a subscription registered to another account (its logout
      // could not unregister it): replace it with a fresh one and register that, once
      console.info('[Push] Replacing a subscription registered to another account');
      await subscription.unsubscribe();
      return this.registerSubscription(await this.createBrowserSubscription());
    }
  }

  /**
   * Register a browser subscription with the backend for the signed-in user. The server
   * upserts by endpoint, so registering the same subscription again is harmless.
   */
  async registerSubscription(subscription: PushSubscription): Promise<SubscribeResponse> {
    const subscriptionData = this.extractSubscriptionData(subscription);
    const { browser, platform } = getBrowserInfo();

    // Register with backend (format matches backend DTO)
    const request: SubscribeRequest = {
      subscription: {
        endpoint: subscriptionData.endpoint,
        keys: subscriptionData.keys,
      },
      device: {
        userAgent: navigator.userAgent,
        browser,
        platform,
      },
    };

    return apiClient.post<SubscribeResponse>(PUSH_ROUTES.SUBSCRIBE, request);
  }

  /**
   * Confirm that the browser's existing subscription belongs to the signed-in user by
   * registering it again. A 409 means another account registered it, so that account's
   * session on this browser is over: the subscription is removed. Never throws.
   *
   * @returns 'registered', 'removed' (it was another account's) or 'unchecked' (the server
   * could not be asked, e.g. offline)
   */
  async confirmSubscription(subscription: PushSubscription): Promise<SubscriptionCheck> {
    try {
      await this.registerSubscription(subscription);
      return 'registered';
    } catch (error) {
      if (!isEndpointConflict(error)) return 'unchecked';
    }

    console.info('[Push] This browser was subscribed for another account; removing it');
    try {
      await subscription.unsubscribe();
    } catch (error) {
      console.warn('[Push] Could not remove the other account’s subscription', error);
    }
    return 'removed';
  }

  /**
   * Stop this browser receiving the signed-out account's pushes (explicit logout only).
   *
   * The server is told with the token captured before logout cleared it, through a keepalive
   * fetch rather than apiClient, whose 401 handling would reload the app mid-logout. The
   * browser subscription is then removed whatever the server answered: if the request failed
   * (offline), the push service answers 410 for the dead endpoint and the server marks it
   * gone. Never throws, and never waits for a service worker that is not installed.
   */
  async unregisterDevice(token: string | null): Promise<void> {
    if (!this.isSupported()) return;

    try {
      // getRegistration(), unlike `ready`, resolves (to undefined) without a service worker
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = await registration?.pushManager.getSubscription();
      if (!subscription) return;

      if (token) {
        try {
          const response = await fetch(`${API_BASE_URL}${PUSH_ROUTES.UNSUBSCRIBE}`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ endpoint: subscription.endpoint }),
            keepalive: true,
          });
          if (!response.ok) {
            console.warn('[Push] Server did not unregister this device', {
              status: response.status,
            });
          }
        } catch (error) {
          console.warn('[Push] Could not reach the server to unregister this device', error);
        }
      }

      await subscription.unsubscribe();
    } catch (error) {
      console.warn('[Push] Could not remove this device’s push subscription', error);
    }
  }

  /**
   * Unsubscribe from push notifications
   */
  async unsubscribe(): Promise<UnsubscribeResponse> {
    // Get existing subscription
    const subscription = await this.getExistingSubscription();

    if (subscription) {
      const subscriptionData = this.extractSubscriptionData(subscription);

      // Unregister from backend first
      try {
        await apiClient.deleteWithBody<UnsubscribeResponse>(PUSH_ROUTES.UNSUBSCRIBE, {
          endpoint: subscriptionData.endpoint,
        });
      } catch {
        // Continue with local unsubscribe even if backend fails
      }

      // Unsubscribe from browser
      await subscription.unsubscribe();
    }

    return { success: true, message: 'Unsubscribed successfully' };
  }

  /**
   * Fetch user's push preferences
   */
  async getPreferences(): Promise<PreferencesResponse> {
    const response = await apiClient.get<PreferencesResponse>(PUSH_ROUTES.PREFERENCES);
    return response;
  }

  /**
   * Update user's push preferences
   */
  async updatePreferences(updates: UpdatePreferencesRequest): Promise<PreferencesResponse> {
    const response = await apiClient.put<PreferencesResponse>(PUSH_ROUTES.PREFERENCES, updates);
    return response;
  }

  /**
   * Send a test push notification (for debugging)
   */
  async sendTestNotification(): Promise<void> {
    const registration = await this.getServiceWorkerRegistration();

    await registration.showNotification('Test Notification', {
      body: 'Push notifications are working!',
      icon: '/pwa-192x192.png',
      badge: '/badge-96x96.png',
      tag: 'test',
      data: {
        url: '/',
      },
    });
  }
}

// Export singleton instance
export const pushService = new PushService();
