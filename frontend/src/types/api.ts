/**
 * API Types
 * 
 * Type definitions for API requests and responses.
 */

import type { Activity, WeekAnalyticsResponse, ActivityName } from './index';

// ============================================================================
// Base Response Types
// ============================================================================

/** Base API response structure */
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  error_code?: string;
}

/** Error response from API */
export interface ApiError {
  success: false;
  error: string;
  error_code?: string;
}

// ============================================================================
// Auth Types
// ============================================================================

export interface LoginRequest {
  email: string;
  password: string;
}

export interface RegisterRequest {
  username: string;
  email: string;
  password: string;
}

export interface AuthResponse {
  success: boolean;
  access_token?: string;
  user_id?: number;
  username?: string;
  profile_pic?: string | null;
  bio?: string | null;
  error?: string;
}

export interface ForgotPasswordRequest {
  email: string;
}

export interface ResetPasswordRequest {
  token: string;
  password: string;
}

// ============================================================================
// User Types
// ============================================================================

export interface UserSearchRequest {
  username: string;
}

export interface UserSearchResult {
  id: number;
  username: string;
  email: string;
  profile_pic?: string;
  is_private: boolean;
  bio?: string;
}

export interface UserSearchResponse extends ApiResponse<UserSearchResult[]> {}

export interface ProfileResponse {
  success: boolean;
  profile_pic?: string | null;
  bio?: string | null;
  error?: string;
}

export interface UpdateProfileRequest {
  username?: string;
  bio?: string;
}

export interface PrivacyResponse {
  success: boolean;
  is_private: boolean;
  error?: string;
}

export interface UpdatePrivacyRequest {
  is_private: boolean;
}

// ============================================================================
// Activity Types
// ============================================================================

export interface GetActivitiesRequest {
  username: string;
  start_date: string;
  end_date: string;
}

export interface GetActivitiesResponse extends ApiResponse<Activity[]> {}

export interface LogActivityRequest {
  name: ActivityName;
  hours: number;
  date: string;
  note?: string;
}

export interface LogActivityResponse {
  success: boolean;
  error?: string;
}

// ============================================================================
// Streak Types
// ============================================================================

export interface GetStreakRequest {
  username: string;
  date: string;
}

export interface StreakData {
  current: number;
  longest: number;
  longest_start?: string;
  longest_end?: string;
}

export interface GetStreakResponse extends ApiResponse<StreakData> {}

// ============================================================================
// Analytics Types
// ============================================================================

export interface GetWeekAnalyticsRequest {
  username: string;
  week_start: string;
}

// WeekAnalyticsResponse is already defined in types/index.ts
export type { WeekAnalyticsResponse };

export interface GetInsightsRequest {
  username: string;
}

export interface InsightsResponse {
  success: boolean;
  insights?: string;
  error?: string;
}

// ============================================================================
// Tile Config Types
// ============================================================================

export interface TileConfig {
  order: ActivityName[];
  sizes: Record<ActivityName, string>;
}

export interface GetTileConfigResponse extends ApiResponse<TileConfig> {}

export interface SaveTileConfigRequest {
  order: ActivityName[];
  sizes: Record<ActivityName, string>;
}

// ============================================================================
// File Upload Types
// ============================================================================

export interface UploadResponse {
  success: boolean;
  profile_pic?: string;
  error?: string;
}

// ============================================================================
// Like Types
// ============================================================================

export interface LikeDayRequest {
  username: string;
  date: string;
}

export interface GetLikesRequest {
  username: string;
  date: string;
}

export interface LikerDTO {
  id: number;
  username: string;
  profile_pic?: string;
  liked_at: string;
}

export interface LikesResponse {
  success: boolean;
  data: LikerDTO[];
  count: number;
  user_has_liked: boolean;
  error?: string;
}

export interface LikeActionResponse {
  success: boolean;
  liked: boolean;
  new_count: number;
  error?: string;
}

// ============================================================================
// Badge Types
// ============================================================================

export interface Badge {
  key: string;
  name: string;
  icon: string;
  color: string;
  threshold: number;
  earned: boolean;
  earned_at?: string;
}

export interface NextBadge {
  key: string;
  name: string;
  icon: string;
  color: string;
  threshold: number;
  progress: number;
}

export interface BadgesResponse {
  success: boolean;
  badges: Badge[];
  next_badge?: NextBadge;
  error?: string;
}

export interface GetBadgesByUsernameRequest {
  username: string;
}

export interface StreakDataWithBadges extends StreakData {
  new_badges?: Badge[];
}

