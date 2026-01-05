export interface User {
    id: number;
    username: string;
    email: string;
}

// Re-export notification types
export * from './notification';

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

export const ACTIVITY_NAMES = [
    "sleep",
    "study",
    "book_reading",
    "eating",
    "friends",
    "grooming",
    "workout",
    "reels",
    "family",
    "idle",
    "creative",
    "travelling",
    "errand",
    "rest",
    "entertainment",
    "office",
] as const;

export type ActivityName = typeof ACTIVITY_NAMES[number];

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
