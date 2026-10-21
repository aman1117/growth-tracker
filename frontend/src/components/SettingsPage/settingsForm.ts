/**
 * Settings form helpers shared by the settings dialogs.
 */

import { ApiError } from '../../services/api';

/**
 * User-facing message for a failed settings request. Client errors (4xx) carry a
 * specific server message ("Current password is incorrect", "Username already taken…");
 * network and server errors fall back to a generic hint.
 */
export const getRequestErrorMessage = (error: unknown, fallback: string): string => {
  if (
    error instanceof ApiError &&
    error.statusCode >= 400 &&
    error.statusCode < 500 &&
    error.statusCode !== 401 &&
    error.message
  ) {
    return error.message;
  }
  return fallback;
};

/** Error code from an API failure, safe to log */
export const getErrorCode = (error: unknown): string | undefined =>
  error instanceof ApiError ? error.errorCode || `HTTP_${error.statusCode}` : undefined;
