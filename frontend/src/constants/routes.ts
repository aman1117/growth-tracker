/**
 * API Routes Constants
 * 
 * Centralized definition of all API endpoints used in the application.
 * This prevents typos and makes endpoint changes easier to manage.
 */

export const API_ROUTES = {
  // ============================================================================
  // Authentication
  // ============================================================================
  AUTH: {
    LOGIN: '/login',
    SIGNUP: '/signup',
    FORGOT_PASSWORD: '/forgot-password',
    RESET_PASSWORD: '/reset-password',
  },

  // ============================================================================
  // User Management
  // ============================================================================
  USER: {
    SEARCH: '/users',
    PROFILE: '/profile',
    UPDATE_PROFILE: '/update-profile',
    UPLOAD_PICTURE: '/profile/upload-picture',
    DELETE_PICTURE: '/profile/picture',
    CHANGE_PASSWORD: '/change-password',
    DELETE_ACCOUNT: '/delete-account',
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
    GET: '/get-activities',
    LOG: '/log-activity',
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
    INSIGHTS: '/get-insights',
  },

  // ============================================================================
  // Tile Configuration
  // ============================================================================
  TILE_CONFIG: {
    GET: '/get-tile-config',
    SAVE: '/save-tile-config',
  },
} as const;

// Type for route values
export type ApiRoute = 
  | typeof API_ROUTES.AUTH[keyof typeof API_ROUTES.AUTH]
  | typeof API_ROUTES.USER[keyof typeof API_ROUTES.USER]
  | typeof API_ROUTES.PRIVACY[keyof typeof API_ROUTES.PRIVACY]
  | typeof API_ROUTES.ACTIVITY[keyof typeof API_ROUTES.ACTIVITY]
  | typeof API_ROUTES.STREAK[keyof typeof API_ROUTES.STREAK]
  | typeof API_ROUTES.ANALYTICS[keyof typeof API_ROUTES.ANALYTICS]
  | typeof API_ROUTES.TILE_CONFIG[keyof typeof API_ROUTES.TILE_CONFIG];
