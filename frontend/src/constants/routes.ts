/**
 * API Routes Constants
 *
 * Centralized definition of all API endpoints used in the application.
 * This prevents typos and makes endpoint changes easier to manage.
 *
 * These routes must match the backend routes defined in:
 * backend/internal/routes/routes.go
 */

export const API_ROUTES = {
  // ============================================================================
  // Authentication
  // ============================================================================
  AUTH: {
    REGISTER: '/register',
    LOGIN: '/login',
    FORGOT_PASSWORD: '/auth/forgot-password',
    RESET_PASSWORD: '/auth/reset-password',
    VALIDATE_RESET_TOKEN: '/auth/reset-password/validate',
    VERIFY_EMAIL: '/auth/verify-email',
    RESEND_VERIFICATION: '/auth/resend-verification',
  },

  // ============================================================================
  // User Management
  // ============================================================================
  USER: {
    SEARCH: '/users',
    PROFILE: '/profile',
    UPDATE_USERNAME: '/update-username',
    UPDATE_BIO: '/update-bio',
    GET_BIO: '/get-bio',
    UPLOAD_PICTURE: '/profile/upload-picture',
    DELETE_PICTURE: '/profile/picture',
    CHANGE_PASSWORD: '/change-password',
  },

  // ============================================================================
  // Privacy
  // ============================================================================
  PRIVACY: {
    GET: '/get-privacy',
    UPDATE: '/update-privacy',
  },

  // ============================================================================
  // Activities
  // ============================================================================
  ACTIVITY: {
    CREATE: '/create-activity',
    GET: '/get-activities',
  },

  // ============================================================================
  // Streaks
  // ============================================================================
  STREAK: {
    GET: '/get-streak',
  },

  // ============================================================================
  // Analytics
  // ============================================================================
  ANALYTICS: {
    WEEK: '/get-week-analytics',
  },

  // ============================================================================
  // Tile Configuration
  // ============================================================================
  TILE_CONFIG: {
    GET: '/tile-config',
    SAVE: '/tile-config',
    GET_BY_USER: '/tile-config/user',
  },

  // ============================================================================
  // Likes
  // ============================================================================
  LIKE: {
    LIKE_DAY: '/like-day',
    UNLIKE_DAY: '/unlike-day',
    GET_LIKES: '/get-likes',
  },

  // ============================================================================
  // Notifications
  // ============================================================================
  NOTIFICATION: {
    LIST: '/notifications',
    UNREAD_COUNT: '/notifications/unread-count',
    MARK_READ: (id: number) => `/notifications/${id}/read`,
    MARK_ALL_READ: '/notifications/read-all',
    DELETE: (id: number) => `/notifications/${id}`,
  },

  // ============================================================================
  // Push Notifications
  // ============================================================================
  PUSH: {
    VAPID_KEY: '/push/vapid-public-key',
    SUBSCRIPTIONS: '/push/subscriptions',
    PREFERENCES: '/push/preferences',
  },

  // ============================================================================
  // WebSocket
  // ============================================================================
  WS: {
    NOTIFICATIONS: '/ws/notifications',
  },

  // ============================================================================
  // Follow System
  // ============================================================================
  FOLLOW: {
    /** POST - Follow a user */
    FOLLOW_USER: (userId: number) => `/users/${userId}/follow`,
    /** DELETE - Unfollow a user */
    UNFOLLOW_USER: (userId: number) => `/users/${userId}/follow`,
    /** POST - Cancel pending follow request */
    CANCEL_REQUEST: (userId: number) => `/follow-requests/${userId}/cancel`,
    /** GET - Get incoming follow requests */
    INCOMING_REQUESTS: '/me/follow-requests/incoming',
    /** POST - Accept a follow request */
    ACCEPT_REQUEST: (userId: number) => `/me/follow-requests/${userId}/accept`,
    /** POST - Decline a follow request */
    DECLINE_REQUEST: (userId: number) => `/me/follow-requests/${userId}/decline`,
    /** DELETE - Remove a follower */
    REMOVE_FOLLOWER: (userId: number) => `/me/followers/${userId}`,
    /** GET - Get user's followers */
    GET_FOLLOWERS: (userId: number) => `/users/${userId}/followers`,
    /** GET - Get user's following */
    GET_FOLLOWING: (userId: number) => `/users/${userId}/following`,
    /** POST - Lookup relationships for multiple users */
    LOOKUP_RELATIONSHIPS: '/relationships/lookup',
    /** GET - Get mutual followers with a user */
    GET_MUTUALS: (userId: number) => `/users/${userId}/mutuals`,
    /** GET - Get follow counts for a user */
    GET_COUNTS: (userId: number) => `/users/${userId}/follow-counts`,
  },
} as const;

/**
 * Frontend Application Routes
 */
export const APP_ROUTES = {
  HOME: '/',
  LOGIN: '/login',
  FORGOT_PASSWORD: '/forgot-password',
  RESET_PASSWORD: '/reset-password',
  VERIFY_EMAIL: '/verify-email',
  SETTINGS: '/settings',
  ANALYTICS: '/analytics',
  USER_PROFILE: (username: string) => `/user/${username}`,
  USER_ANALYTICS: (username: string) => `/analytics?user=${username}`,
} as const;

// Type for API route values
export type ApiRoute =
  | (typeof API_ROUTES.AUTH)[keyof typeof API_ROUTES.AUTH]
  | (typeof API_ROUTES.USER)[keyof typeof API_ROUTES.USER]
  | (typeof API_ROUTES.PRIVACY)[keyof typeof API_ROUTES.PRIVACY]
  | (typeof API_ROUTES.ACTIVITY)[keyof typeof API_ROUTES.ACTIVITY]
  | (typeof API_ROUTES.STREAK)[keyof typeof API_ROUTES.STREAK]
  | (typeof API_ROUTES.ANALYTICS)[keyof typeof API_ROUTES.ANALYTICS]
  | (typeof API_ROUTES.TILE_CONFIG)[keyof typeof API_ROUTES.TILE_CONFIG]
  | (typeof API_ROUTES.LIKE)[keyof typeof API_ROUTES.LIKE];
