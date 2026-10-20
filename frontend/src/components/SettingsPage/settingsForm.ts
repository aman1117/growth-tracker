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

const encoder = new TextEncoder();

/** UTF-8 length, which is what the server measures for text limits */
export const utf8Length = (value: string): number => encoder.encode(value).length;

/** Longest prefix of `value` that fits in `maxBytes` UTF-8 bytes, never splitting a character */
export const clampToUtf8Bytes = (value: string, maxBytes: number): string => {
  if (utf8Length(value) <= maxBytes) return value;
  let result = '';
  let bytes = 0;
  for (const char of value) {
    const size = utf8Length(char);
    if (bytes + size > maxBytes) break;
    result += char;
    bytes += size;
  }
  return result;
};
