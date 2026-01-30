export interface User {
  id: number;
  username: string;
  email: string;
}

// Re-export notification types
export * from './notification';

// Re-export push notification types
export * from './push';

// Re-export follow types
export * from './follow';

// Re-export autocomplete types
export * from './autocomplete';

export interface AuthResponse {
  success: boolean;
  access_token?: string;
  user_id?: number;
  username?: string;
  error?: string;
}

export interface Activity {
  id: number;
  name: string;
  hours: number;
  note?: string;
}

export interface ActivityResponse {
  success: boolean;
  data: Activity[];
  error?: string;
}

// Predefined activity names
export const ACTIVITY_NAMES = [
  'sleep',
  'study',
  'book_reading',
  'eating',
  'friends',
  'grooming',
  'workout',
  'reels',
  'family',
  'idle',
  'creative',
  'travelling',
  'errand',
  'rest',
  'entertainment',
  'office',
] as const;

export type PredefinedActivityName = (typeof ACTIVITY_NAMES)[number];

// Custom tile prefix
export const CUSTOM_TILE_PREFIX = 'custom:';

// ActivityName can be predefined or custom (custom:<uuid>)
export type ActivityName = PredefinedActivityName | `custom:${string}`;

// Check if an activity name is a custom tile
export const isCustomTile = (name: string): name is `custom:${string}` => {
  return name.startsWith(CUSTOM_TILE_PREFIX);
};

// Extract custom tile ID from activity name
export const getCustomTileId = (name: string): string | null => {
  if (!isCustomTile(name)) return null;
  return name.slice(CUSTOM_TILE_PREFIX.length);
};

// Custom tile definition
export interface CustomTile {
  id: string; // UUID v4
  name: string; // Display name (max 20 chars)
  icon: string; // Lucide icon name
  color: string; // Hex color code
}

// Extended tile configuration
export interface TileConfig {
  order: ActivityName[];
  sizes: Record<ActivityName, string>;
  hidden?: ActivityName[];
  colors?: Record<ActivityName, string>;
  customTiles?: CustomTile[];
}

// Maximum custom tiles allowed
export const MAX_CUSTOM_TILES = 5;

// Analytics Types
export interface DayActivityBreakdown {
  name: ActivityName;
  hours: number;
}

export interface DayAnalytics {
  date: string;
  day_name: string;
  total_hours: number;
  activities: DayActivityBreakdown[];
}

export interface ActivitySummary {
  name: ActivityName;
  total_hours: number;
}

export interface StreakInfo {
  current: number;
  longest: number;
  longest_start?: string;
  longest_end?: string;
}

export interface WeekAnalyticsResponse {
  success: boolean;
  total_hours_this_week: number;
  total_hours_prev_week: number;
  total_hours_current_week: number;
  percentage_change: number;
  percentage_vs_current: number;
  is_current_week: boolean;
  streak: StreakInfo;
  daily_breakdown: DayAnalytics[];
  activity_summary: ActivitySummary[];
  error?: string;
  error_code?: string;
}

// Re-export API types for convenience
export * from './api';
