/**
 * Push Notification Types
 *
 * Type definitions for the Web Push notification system including
 * subscription data, preferences, and API responses.
 */

// ==================== Push Subscription Types ====================

export interface PushSubscriptionKeys {
  p256dh: string;
  auth: string;
}

export interface PushSubscriptionData {
  endpoint: string;
  keys: PushSubscriptionKeys;
}

// ==================== Push Preferences Types ====================

export interface PushPreferences {
  push_enabled: boolean;
  preferences: Record<string, boolean>;  // Simple boolean map
  quiet_hours_enabled: boolean;
  quiet_start: string | null; // HH:MM format
  quiet_end: string | null;   // HH:MM format
  timezone: string;
}

// ==================== API Request Types ====================

export interface PushDeviceInfo {
  userAgent?: string;
  platform?: string;
  browser?: string;
}

export interface SubscribeRequest {
  keyId?: string;
  subscription: PushSubscriptionData;
  device?: PushDeviceInfo;
}

export interface UnsubscribeRequest {
  endpoint: string;
}

export interface UpdatePreferencesRequest {
  push_enabled?: boolean;
  preferences?: Record<string, boolean>;  // Simple boolean map, e.g., { like_received: true }
  quiet_hours_enabled?: boolean;
  quiet_start?: string;
  quiet_end?: string;
  timezone?: string;
}

// ==================== API Response Types ====================

export interface VapidKeyResponse {
  success: boolean;
  publicKey: string;
  keyId: string;
}

export interface SubscribeResponse {
  success: boolean;
  message?: string;
  subscription_id?: number;
}

export interface UnsubscribeResponse {
  success: boolean;
  message?: string;
}

export interface PreferencesResponse {
  success: boolean;
  preferences?: PushPreferences;
  message?: string;
}

// ==================== Push Notification Payload Types ====================

export interface PushNotificationPayload {
  title: string;
  body: string;
  icon?: string;
  badge?: string;
  tag?: string;
  data?: {
    url?: string;
    notification_id?: number;
    type?: string;
  };
  actions?: Array<{
    action: string;
    title: string;
    icon?: string;
  }>;
  requireInteraction?: boolean;
  silent?: boolean;
}

// ==================== Push State Types ====================

export type PushPermissionState = 'default' | 'granted' | 'denied' | 'unsupported';

export interface PushState {
  isSupported: boolean;
  permission: PushPermissionState;
  isSubscribed: boolean;
  isLoading: boolean;
  error: string | null;
  preferences: PushPreferences | null;
}

export interface PushActions {
  checkSupport: () => boolean;
  requestPermission: () => Promise<NotificationPermission>;
  subscribe: () => Promise<boolean>;
  unsubscribe: () => Promise<boolean>;
  fetchPreferences: () => Promise<void>;
  updatePreferences: (updates: UpdatePreferencesRequest) => Promise<boolean>;
  reset: () => void;
}
