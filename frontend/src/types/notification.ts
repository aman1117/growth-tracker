/**
 * Notification Types
 *
 * Type definitions for the notification system including
 * WebSocket messages, notification data, and metadata types.
 */

// ==================== Notification Types ====================

export type NotificationType =
  | 'like_received'
  | 'badge_unlocked'
  | 'streak_milestone'
  | 'streak_at_risk'
  | 'system_announcement';

export interface Notification {
  id: number;
  type: NotificationType;
  title: string;
  body: string;
  metadata: NotificationMetadata | null;
  read_at: string | null;
  created_at: string;
}

// ==================== Metadata Types ====================

export interface LikeMetadata {
  liker_id: number;
  liker_username: string;
  liker_avatar?: string;
  liked_date: string;
}

export interface BadgeMetadata {
  badge_id: string;
  badge_name: string;
  badge_icon: string;
}

export interface StreakMetadata {
  activity_type: string;
  streak_count: number;
}

export type NotificationMetadata = LikeMetadata | BadgeMetadata | StreakMetadata | Record<string, unknown>;

// ==================== API Response Types ====================

export interface NotificationsResponse {
  success: boolean;
  notifications: Notification[];
  total: number;
  page: number;
  page_size: number;
  has_more: boolean;
}

export interface UnreadCountResponse {
  success: boolean;
  unread_count: number;
}

export interface NotificationActionResponse {
  success: boolean;
  message?: string;
}

// ==================== WebSocket Types ====================

export type WSMessageType =
  | 'notification'
  | 'ping'
  | 'pong'
  | 'connected'
  | 'error'
  | 'pending_delivery';

export interface WSMessage<T = unknown> {
  type: WSMessageType;
  payload?: T;
}

export interface WSConnectedPayload {
  connection_id: string;
  user_id: number;
}

export type WSConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';

// ==================== Store Types ====================

export interface NotificationState {
  notifications: Notification[];
  unreadCount: number;
  wsStatus: WSConnectionStatus;
  isLoading: boolean;
  hasMore: boolean;
  page: number;
  error: string | null;
  deletingIds: Record<number, boolean>;
}

export interface NotificationActions {
  // Data fetching
  fetchNotifications: (reset?: boolean) => Promise<void>;
  fetchUnreadCount: () => Promise<void>;
  
  // Actions
  markAsRead: (id: number) => Promise<void>;
  markAllAsRead: () => Promise<void>;
  startDeleting: (id: number) => void;
  deleteNotification: (id: number) => Promise<void>;
  
  // WebSocket
  setWSStatus: (status: WSConnectionStatus) => void;
  addNotification: (notification: Notification) => void;
  addPendingNotifications: (notifications: Notification[]) => void;
  
  // State management
  clearError: () => void;
  reset: () => void;
}

// ==================== Helper Functions ====================

/**
 * Type guard to check if metadata is LikeMetadata
 */
export function isLikeMetadata(metadata: NotificationMetadata | null): metadata is LikeMetadata {
  return metadata !== null && 'liker_id' in metadata && 'liker_username' in metadata;
}

/**
 * Type guard to check if metadata is BadgeMetadata
 */
export function isBadgeMetadata(metadata: NotificationMetadata | null): metadata is BadgeMetadata {
  return metadata !== null && 'badge_id' in metadata && 'badge_name' in metadata;
}

/**
 * Type guard to check if metadata is StreakMetadata
 */
export function isStreakMetadata(metadata: NotificationMetadata | null): metadata is StreakMetadata {
  return metadata !== null && 'activity_type' in metadata && 'streak_count' in metadata;
}

/**
 * Format notification time relative to now
 */
export function formatNotificationTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
