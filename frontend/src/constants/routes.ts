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
} as const;

/**
 * Frontend Application Routes
 */
export const APP_ROUTES = {
  HOME: '/',
  LOGIN: '/login',
  FORGOT_PASSWORD: '/forgot-password',
  RESET_PASSWORD: '/reset-password',
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
