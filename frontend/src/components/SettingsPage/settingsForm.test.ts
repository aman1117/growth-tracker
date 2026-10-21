import { describe, expect, it } from 'vitest';

import { ApiError } from '../../services/api';
import { getErrorCode, getRequestErrorMessage } from './settingsForm';

describe('getRequestErrorMessage', () => {
  it('shows the server message for client errors', () => {
    const error = new ApiError('Username already taken', 409, 'USERNAME_TAKEN');
    expect(getRequestErrorMessage(error, 'Try again')).toBe('Username already taken');
  });

  it.each([
    ['an expired session (401)', new ApiError('Unauthorized', 401, 'UNAUTHORIZED')],
    ['a server error (5xx)', new ApiError('Internal server error', 500)],
    ['a non-error status', new ApiError('Moved', 302)],
    ['a client error without a message', new ApiError('', 400)],
    ['a network failure', new TypeError('Failed to fetch')],
    ['a thrown non-error value', 'boom'],
  ])('falls back to the generic hint for %s', (_label, error) => {
    expect(getRequestErrorMessage(error, 'Try again')).toBe('Try again');
  });
});

describe('getErrorCode', () => {
  it('returns the API error code', () => {
    expect(getErrorCode(new ApiError('Nope', 400, 'INVALID_PASSWORD'))).toBe('INVALID_PASSWORD');
  });

  it('falls back to the HTTP status when the API sent no code', () => {
    expect(getErrorCode(new ApiError('Bad gateway', 502))).toBe('HTTP_502');
  });

  it('returns undefined for errors that did not come from the API', () => {
    expect(getErrorCode(new Error('offline'))).toBeUndefined();
  });
});
