export interface User {
    id: number;
    username: string;
    email: string;
}

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
] as const;

export type ActivityName = typeof ACTIVITY_NAMES[number];
