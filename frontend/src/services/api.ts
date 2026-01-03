/**
 * API Service
 * 
 * Professional API layer with TypeScript generics, centralized error handling,
 * and proper authentication management.
 */

import { env } from '../config/env';
import { STORAGE_KEYS } from '../constants/storage';

// ============================================================================
// Types
// ============================================================================

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

interface RequestOptions {
  /** Skip adding authorization header */
  skipAuth?: boolean;
  /** Custom headers to add */
  headers?: Record<string, string>;
  /** AbortController signal for request cancellation */
  signal?: AbortSignal;
}

// ============================================================================
// API Client Class
// ============================================================================

class ApiClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  /**
   * Get authorization headers if token exists
   */
  private getAuthHeaders(): Record<string, string> {
    const token = localStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN);
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  /**
   * Handle 401 unauthorized responses
   */
  private handleUnauthorized(): void {
    localStorage.removeItem(STORAGE_KEYS.ACCESS_TOKEN);
    localStorage.removeItem(STORAGE_KEYS.USERNAME);
    localStorage.removeItem(STORAGE_KEYS.USER_ID);
    localStorage.removeItem(STORAGE_KEYS.PROFILE_PIC);
    localStorage.removeItem(STORAGE_KEYS.BIO);

    // Use window.location for a full page redirect to clear all state
    window.location.href = '/login';
  }

  /**
   * Make a typed HTTP request
   */
  private async request<T>(
    method: HttpMethod,
    endpoint: string,
    body?: unknown,
    options: RequestOptions = {}
  ): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(!options.skipAuth ? this.getAuthHeaders() : {}),
      ...options.headers,
    };

    const config: RequestInit = {
      method,
      headers,
      signal: options.signal,
    };

    if (body && method !== 'GET') {
      config.body = JSON.stringify(body);
    }

    const response = await fetch(`${this.baseUrl}${endpoint}`, config);

    if (response.status === 401) {
      this.handleUnauthorized();
      throw new ApiError('Unauthorized', 401, 'UNAUTHORIZED');
    }

    const data = await response.json();

    if (!response.ok) {
      throw new ApiError(
        data.error || 'Request failed',
        response.status,
        data.error_code
      );
    }

    return data as T;
  }

  /**
   * HTTP GET request
   */
  async get<T>(endpoint: string, options?: RequestOptions): Promise<T> {
    return this.request<T>('GET', endpoint, undefined, options);
  }

  /**
   * HTTP POST request
   */
  async post<T, B = unknown>(
    endpoint: string,
    body?: B,
    options?: RequestOptions
  ): Promise<T> {
    return this.request<T>('POST', endpoint, body, options);
  }

  /**
   * HTTP PUT request
   */
  async put<T, B = unknown>(
    endpoint: string,
    body?: B,
    options?: RequestOptions
  ): Promise<T> {
    return this.request<T>('PUT', endpoint, body, options);
  }

  /**
   * HTTP DELETE request
   */
  async delete<T>(endpoint: string, options?: RequestOptions): Promise<T> {
    return this.request<T>('DELETE', endpoint, undefined, options);
  }

  /**
   * Upload a file (multipart/form-data)
   */
  async uploadFile<T>(
    endpoint: string,
    file: File,
    fieldName: string = 'image',
    options?: RequestOptions
  ): Promise<T> {
    const formData = new FormData();
    formData.append(fieldName, file);

    const headers: Record<string, string> = {
      // Don't set Content-Type - browser will set it with boundary
      ...(!options?.skipAuth ? this.getAuthHeaders() : {}),
      ...options?.headers,
    };

    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      method: 'POST',
      headers,
      body: formData,
      signal: options?.signal,
    });

    if (response.status === 401) {
      this.handleUnauthorized();
      throw new ApiError('Unauthorized', 401, 'UNAUTHORIZED');
    }

    const data = await response.json();

    if (!response.ok) {
      throw new ApiError(
        data.error || 'Upload failed',
        response.status,
        data.error_code
      );
    }

    return data as T;
  }
}

// ============================================================================
// Custom Error Class
// ============================================================================

export class ApiError extends Error {
  public readonly statusCode: number;
  public readonly errorCode?: string;

  constructor(message: string, statusCode: number, errorCode?: string) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.errorCode = errorCode;
  }

  /**
   * Check if error is due to unauthorized access
   */
  isUnauthorized(): boolean {
    return this.statusCode === 401;
  }

  /**
   * Check if error is a network/connection error
   */
  isNetworkError(): boolean {
    return this.statusCode === 0 || this.message.includes('fetch');
  }

  /**
   * Check if account is private
   */
  isPrivateAccount(): boolean {
    return this.errorCode === 'ACCOUNT_PRIVATE';
  }
}

// ============================================================================
// API Instance Export
// ============================================================================

/**
 * Pre-configured API client instance
 */
export const apiClient = new ApiClient(env.apiUrl);

// ============================================================================
// Backwards-Compatible API Object
// ============================================================================

import type {
  AuthResponse,
  GetActivitiesResponse,
  GetStreakResponse,
  UserSearchResponse,
  ProfileResponse,
  PrivacyResponse,
  UploadResponse,
  LogActivityResponse,
  InsightsResponse,
} from '../types/api';
import type { WeekAnalyticsResponse } from '../types';

/**
 * Backwards-compatible API object
 * 
 * This maintains the same interface as the original api object
 * while using the new ApiClient under the hood.
 * 
 * @deprecated Prefer using apiClient directly with typed methods
 */
export const api = {
  /**
   * Generic GET request
   * @deprecated Use typed API methods (userApi, authApi, etc.) or provide a type parameter
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async get<T = any>(endpoint: string): Promise<T> {
    return apiClient.get<T>(endpoint);
  },

  /**
   * Generic POST request
   * @deprecated Use typed API methods (userApi, authApi, etc.) or provide a type parameter
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async post<T = any>(endpoint: string, body?: unknown): Promise<T> {
    return apiClient.post<T>(endpoint, body);
  },

  /**
   * Generic DELETE request
   * @deprecated Use typed API methods (userApi, authApi, etc.) or provide a type parameter
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async delete<T = any>(endpoint: string): Promise<T> {
    return apiClient.delete<T>(endpoint);
  },

  /**
   * Upload file
   */
  async uploadFile(endpoint: string, file: File): Promise<UploadResponse> {
    return apiClient.uploadFile<UploadResponse>(endpoint, file, 'image');
  },

  /**
   * Get AI insights for a user
   */
  async getInsights(username: string): Promise<InsightsResponse> {
    return apiClient.post<InsightsResponse>('/get-insights', { username });
  },

  /**
   * Get weekly analytics for a user
   */
  async getWeekAnalytics(
    username: string,
    weekStart: string
  ): Promise<WeekAnalyticsResponse> {
    return apiClient.post<WeekAnalyticsResponse>('/get-week-analytics', {
      username,
      week_start: weekStart,
    });
  },
};

// ============================================================================
// Typed API Methods (New Pattern)
// ============================================================================

/**
 * Type-safe API methods
 * 
 * Use these methods for new code - they provide full type safety
 * for both request and response types.
 */
export const authApi = {
  login: (email: string, password: string) =>
    apiClient.post<AuthResponse>('/login', { email, password }),

  register: (username: string, email: string, password: string) =>
    apiClient.post<AuthResponse>('/signup', { username, email, password }),

  forgotPassword: (email: string) =>
    apiClient.post<{ success: boolean; message?: string; error?: string }>(
      '/forgot-password',
      { email }
    ),

  resetPassword: (token: string, password: string) =>
    apiClient.post<{ success: boolean; error?: string }>('/reset-password', {
      token,
      password,
    }),
};

export const userApi = {
  search: (username: string) =>
    apiClient.post<UserSearchResponse>('/users', { username }),

  getProfile: () => apiClient.get<ProfileResponse>('/profile'),

  updateProfile: (data: { username?: string; bio?: string }) =>
    apiClient.post<ProfileResponse>('/update-profile', data),

  getPrivacy: () => apiClient.get<PrivacyResponse>('/get-privacy'),

  updatePrivacy: (isPrivate: boolean) =>
    apiClient.post<PrivacyResponse>('/update-privacy', { is_private: isPrivate }),

  uploadProfilePic: (file: File) =>
    apiClient.uploadFile<UploadResponse>('/profile/upload-picture', file, 'image'),

  deleteProfilePic: () =>
    apiClient.delete<{ success: boolean; error?: string }>('/profile/picture'),

  updatePassword: (currentPassword: string, newPassword: string) =>
    apiClient.post<{ success: boolean; error?: string }>('/change-password', {
      current_password: currentPassword,
      new_password: newPassword,
    }),

  deleteAccount: () =>
    apiClient.delete<{ success: boolean; error?: string }>('/delete-account'),
};

export const activityApi = {
  getActivities: (username: string, startDate: string, endDate: string) =>
    apiClient.post<GetActivitiesResponse>('/get-activities', {
      username,
      start_date: startDate,
      end_date: endDate,
    }),

  logActivity: (
    name: string,
    hours: number,
    date: string,
    note?: string
  ) =>
    apiClient.post<LogActivityResponse>('/log-activity', {
      name,
      hours,
      date,
      note,
    }),
};

export const streakApi = {
  getStreak: (username: string, date: string) =>
    apiClient.post<GetStreakResponse>('/get-streak', { username, date }),
};

export const analyticsApi = {
  getWeekAnalytics: (username: string, weekStart: string) =>
    apiClient.post<WeekAnalyticsResponse>('/get-week-analytics', {
      username,
      week_start: weekStart,
    }),

  getInsights: (username: string) =>
    apiClient.post<InsightsResponse>('/get-insights', { username }),
};

export const tileConfigApi = {
  getTileConfig: (username: string) =>
    apiClient.post<{
      success: boolean;
      data?: { order: string[]; sizes: Record<string, string> };
      error?: string;
    }>('/get-tile-config', { username }),

  saveTileConfig: (order: string[], sizes: Record<string, string>) =>
    apiClient.post<{ success: boolean; error?: string }>('/save-tile-config', {
      order,
      sizes,
    }),
};
