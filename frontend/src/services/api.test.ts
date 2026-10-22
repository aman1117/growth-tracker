import { describe, expect, it, vi } from 'vitest';

import { STORAGE_KEYS } from '../constants/storage';
import { makeFile } from '../test/fixtures/core';
import { jsonResponse, mockFetch } from '../test/utils';
import {
  activityApi,
  activityPhotoApi,
  analyticsApi,
  api,
  apiClient,
  ApiError,
  authApi,
  challengeApi,
  commentApi,
  likeApi,
  searchApi,
  streakApi,
  tileConfigApi,
  userApi,
} from './api';
import { gl } from './goodlogs';
import * as services from './index';

const BASE_URL = 'http://localhost:8000/api';

type FetchMock = ReturnType<typeof mockFetch>;

/** URL, method, headers, body and signal of the last fetch call. */
function lastRequest(fetchMock: FetchMock) {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) throw new Error('fetch was not called');
  const [input, init = {}] = call;
  return {
    url: String(input),
    method: init.method,
    headers: (init.headers ?? {}) as Record<string, string>,
    body: init.body,
    signal: init.signal,
  };
}

const parseBody = (body: unknown) => (typeof body === 'string' ? JSON.parse(body) : body);

const AUTH_KEYS = [
  STORAGE_KEYS.ACCESS_TOKEN,
  STORAGE_KEYS.USERNAME,
  STORAGE_KEYS.USER_ID,
  STORAGE_KEYS.PROFILE_PIC,
  STORAGE_KEYS.BIO,
];

function storeSession() {
  localStorage.setItem(STORAGE_KEYS.ACCESS_TOKEN, 'expired-token');
  localStorage.setItem(STORAGE_KEYS.USERNAME, 'alice');
  localStorage.setItem(STORAGE_KEYS.USER_ID, '7');
  localStorage.setItem(STORAGE_KEYS.PROFILE_PIC, 'https://cdn.example/alice.png');
  localStorage.setItem(STORAGE_KEYS.BIO, 'Early riser');
  localStorage.setItem(STORAGE_KEYS.THEME, 'dark');
}

/** Replaces `window.location` so a full-page redirect can be observed. */
function stubLocation(pathname: string) {
  const location = { pathname, href: `http://localhost:3000${pathname}` };
  vi.stubGlobal('location', location);
  return location;
}

describe('apiClient', () => {
  it('sends GET requests to the API base URL with JSON headers and returns the parsed body', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ success: true, value: 42 }));

    await expect(apiClient.get('/profile')).resolves.toEqual({ success: true, value: 42 });

    expect(lastRequest(fetchMock)).toEqual({
      url: `${BASE_URL}/profile`,
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: undefined,
      signal: undefined,
    });
  });

  it('authenticates with the stored access token', async () => {
    localStorage.setItem(STORAGE_KEYS.ACCESS_TOKEN, 'abc.def.ghi');
    const fetchMock = mockFetch(() => jsonResponse({}));

    await apiClient.get('/profile');

    expect(lastRequest(fetchMock).headers.Authorization).toBe('Bearer abc.def.ghi');
  });

  it('skips the token when asked and forwards custom headers and the abort signal', async () => {
    localStorage.setItem(STORAGE_KEYS.ACCESS_TOKEN, 'abc.def.ghi');
    const fetchMock = mockFetch(() => jsonResponse({}));
    const controller = new AbortController();

    await apiClient.get('/public', {
      skipAuth: true,
      headers: { 'X-Trace-Id': 'trace-1' },
      signal: controller.signal,
    });

    expect(lastRequest(fetchMock)).toMatchObject({
      headers: { 'Content-Type': 'application/json', 'X-Trace-Id': 'trace-1' },
      signal: controller.signal,
    });
    expect(lastRequest(fetchMock).headers).not.toHaveProperty('Authorization');
  });

  it.each([
    ['post', () => apiClient.post('/items', { name: 'a' }), 'POST', { name: 'a' }],
    ['put', () => apiClient.put('/items/1', { name: 'b' }), 'PUT', { name: 'b' }],
    ['patch', () => apiClient.patch('/items/1', { done: true }), 'PATCH', { done: true }],
    [
      'deleteWithBody',
      () => apiClient.deleteWithBody('/items', { ids: [1] }),
      'DELETE',
      { ids: [1] },
    ],
  ])('%s sends the body as JSON', async (_name, send, method, body) => {
    const fetchMock = mockFetch(() => jsonResponse({ success: true }));

    await send();

    expect(lastRequest(fetchMock).method).toBe(method);
    expect(lastRequest(fetchMock).body).toBe(JSON.stringify(body));
  });

  it.each([
    ['post without a body', () => apiClient.post('/items'), 'POST'],
    ['delete', () => apiClient.delete('/items/1'), 'DELETE'],
  ])('%s sends no body', async (_name, send, method) => {
    const fetchMock = mockFetch(() => jsonResponse({ success: true }));

    await send();

    expect(lastRequest(fetchMock)).toMatchObject({ method, body: undefined });
  });

  it('turns error responses into an ApiError with the server message and code', async () => {
    mockFetch(() =>
      jsonResponse(
        { success: false, error: 'Username taken', error_code: 'USERNAME_TAKEN' },
        { status: 409 }
      )
    );

    const error = await apiClient.post('/update-username', { username: 'bob' }).catch((e) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      name: 'ApiError',
      message: 'Username taken',
      statusCode: 409,
      errorCode: 'USERNAME_TAKEN',
    });
    expect(gl.warn).toHaveBeenCalledWith('API error', {
      metadata: {
        endpoint: '/update-username',
        method: 'POST',
        statusCode: 409,
        errorCode: 'USERNAME_TAKEN',
        message: 'Username taken',
      },
    });
  });

  it('uses a generic message when an error response has none', async () => {
    mockFetch(() => jsonResponse({}, { status: 500 }));

    await expect(apiClient.get('/profile')).rejects.toMatchObject({
      message: 'Request failed',
      statusCode: 500,
      errorCode: undefined,
    });
  });

  it('reports a non-JSON error page as an ApiError with its HTTP status', async () => {
    mockFetch(
      () =>
        new Response('<html>Bad gateway</html>', {
          status: 502,
          headers: { 'Content-Type': 'text/html' },
        })
    );

    await expect(apiClient.get('/profile')).rejects.toMatchObject({
      name: 'ApiError',
      message: 'Request failed',
      statusCode: 502,
      errorCode: undefined,
    });
    expect(gl.warn).toHaveBeenCalledWith('API error', {
      metadata: {
        endpoint: '/profile',
        method: 'GET',
        statusCode: 502,
        errorCode: undefined,
        message: undefined,
      },
    });
  });

  it('reports an error response with an empty body as an ApiError with its HTTP status', async () => {
    mockFetch(() => new Response(null, { status: 503 }));

    await expect(apiClient.post('/activities', {})).rejects.toMatchObject({
      name: 'ApiError',
      message: 'Request failed',
      statusCode: 503,
    });
  });

  it('resolves an empty success response (204 No Content) with the success envelope', async () => {
    mockFetch(() => new Response(null, { status: 204 }));

    await expect(apiClient.delete('/items/1')).resolves.toEqual({ success: true });
    expect(gl.warn).not.toHaveBeenCalled();
  });

  it('rejects a success status whose body is not JSON instead of resolving it', async () => {
    mockFetch(
      () =>
        new Response('<!doctype html><title>Growth Tracker</title>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        })
    );

    await expect(apiClient.get('/profile')).rejects.toMatchObject({
      name: 'ApiError',
      message: 'Request failed',
      statusCode: 200,
    });
    expect(gl.warn).toHaveBeenCalledWith(
      'API error',
      expect.objectContaining({ metadata: expect.objectContaining({ statusCode: 200 }) })
    );
  });

  it('logs and rethrows network failures', async () => {
    const failure = new TypeError('Failed to fetch');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(failure));

    await expect(apiClient.get('/profile')).rejects.toBe(failure);
    expect(gl.error).toHaveBeenCalledWith('Network error', {
      metadata: { endpoint: '/profile', method: 'GET', message: 'Failed to fetch' },
    });
  });

  it('describes network failures that are not Error objects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue('offline'));

    await expect(apiClient.delete('/items/1')).rejects.toBe('offline');
    expect(gl.error).toHaveBeenCalledWith('Network error', {
      metadata: { endpoint: '/items/1', method: 'DELETE', message: 'offline' },
    });
  });

  describe('when the session has expired (401)', () => {
    it('clears the stored session, tracks it and redirects to the login page', async () => {
      storeSession();
      const location = stubLocation('/settings');
      mockFetch(() => jsonResponse({ error: 'token expired' }, { status: 401 }));

      const error = (await apiClient.get('/profile').catch((e: unknown) => e)) as ApiError;

      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({
        message: 'Unauthorized',
        statusCode: 401,
        errorCode: 'UNAUTHORIZED',
      });
      expect(error.isUnauthorized()).toBe(true);
      AUTH_KEYS.forEach((key) => expect(localStorage.getItem(key)).toBeNull());
      expect(localStorage.getItem(STORAGE_KEYS.THEME)).toBe('dark');
      expect(gl.track).toHaveBeenCalledWith('session_expired');
      expect(location.href).toBe('/login');
    });

    it('does not reload the login page itself', async () => {
      storeSession();
      const location = stubLocation('/login');
      mockFetch(() => jsonResponse({}, { status: 401 }));

      await expect(apiClient.post('/login', {})).rejects.toMatchObject({ statusCode: 401 });

      expect(location.href).toBe('http://localhost:3000/login');
      expect(localStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN)).toBeNull();
    });

    it('handles a 401 from a file upload the same way', async () => {
      storeSession();
      const location = stubLocation('/settings');
      mockFetch(() => jsonResponse({}, { status: 401 }));

      await expect(
        apiClient.uploadFile('/profile/upload-picture', makeFile())
      ).rejects.toMatchObject({ statusCode: 401, errorCode: 'UNAUTHORIZED' });

      AUTH_KEYS.forEach((key) => expect(localStorage.getItem(key)).toBeNull());
      expect(location.href).toBe('/login');
    });
  });

  describe('uploadFile', () => {
    it('posts multipart form data with the token but without a JSON content type', async () => {
      localStorage.setItem(STORAGE_KEYS.ACCESS_TOKEN, 'tok');
      const fetchMock = mockFetch(() => jsonResponse({ success: true, url: 'https://cdn/x.jpg' }));

      await expect(
        apiClient.uploadFile('/profile/upload-picture', makeFile('me.png'), 'avatar')
      ).resolves.toEqual({ success: true, url: 'https://cdn/x.jpg' });

      const request = lastRequest(fetchMock);
      expect(request).toMatchObject({
        url: `${BASE_URL}/profile/upload-picture`,
        method: 'POST',
        headers: { Authorization: 'Bearer tok' },
      });
      expect(request.headers).not.toHaveProperty('Content-Type');
      expect(request.body).toBeInstanceOf(FormData);
      expect((request.body as FormData).get('avatar')).toMatchObject({
        name: 'me.png',
        type: 'image/png',
      });
    });

    it('uses the "image" field by default and honours request options', async () => {
      localStorage.setItem(STORAGE_KEYS.ACCESS_TOKEN, 'tok');
      const fetchMock = mockFetch(() => jsonResponse({ success: true }));
      const controller = new AbortController();

      await apiClient.uploadFile('/upload', makeFile(), undefined, {
        skipAuth: true,
        headers: { 'X-Upload': '1' },
        signal: controller.signal,
      });

      const request = lastRequest(fetchMock);
      expect(request.headers).toEqual({ 'X-Upload': '1' });
      expect(request.signal).toBe(controller.signal);
      expect((request.body as FormData).has('image')).toBe(true);
    });

    it.each([
      [
        { error: 'File too large', error_code: 'FILE_TOO_LARGE' },
        'File too large',
        'FILE_TOO_LARGE',
      ],
      [{}, 'Upload failed', undefined],
    ])('rejects failed uploads with an ApiError (%o)', async (body, message, errorCode) => {
      mockFetch(() => jsonResponse(body, { status: 413 }));

      await expect(apiClient.uploadFile('/upload', makeFile())).rejects.toMatchObject({
        name: 'ApiError',
        message,
        statusCode: 413,
        errorCode,
      });
    });

    it('reports a non-JSON upload failure as an ApiError with its HTTP status', async () => {
      mockFetch(() => new Response('<html>Request Entity Too Large</html>', { status: 413 }));

      await expect(apiClient.uploadFile('/upload', makeFile())).rejects.toMatchObject({
        name: 'ApiError',
        message: 'Upload failed',
        statusCode: 413,
      });
    });

    it('resolves an empty successful upload with the success envelope', async () => {
      mockFetch(() => new Response(null, { status: 204 }));

      await expect(apiClient.uploadFile('/upload', makeFile())).resolves.toEqual({
        success: true,
      });
    });
  });
});

describe('ApiError', () => {
  it.each([
    ['an unauthorized error', new ApiError('Unauthorized', 401), [true, false, false]],
    ['a status 0 error', new ApiError('Offline', 0), [false, true, false]],
    ['a failed fetch', new ApiError('Failed to fetch', 503), [false, true, false]],
    ['a private account', new ApiError('Private', 403, 'ACCOUNT_PRIVATE'), [false, false, true]],
    ['a validation error', new ApiError('Bad input', 400, 'INVALID'), [false, false, false]],
  ])('classifies %s', (_label, error, [unauthorized, network, privateAccount]) => {
    expect(error.isUnauthorized()).toBe(unauthorized);
    expect(error.isNetworkError()).toBe(network);
    expect(error.isPrivateAccount()).toBe(privateAccount);
  });
});

interface EndpointCase {
  call: () => Promise<unknown>;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  body?: unknown;
  /** Expected analytics event, as the arguments passed to `gl.track` */
  tracked?: unknown[];
}

async function expectEndpoint({ call, method, path, body, tracked }: EndpointCase) {
  const fetchMock = mockFetch(() => jsonResponse({ success: true }));

  await expect(call()).resolves.toEqual({ success: true });

  const request = lastRequest(fetchMock);
  expect(request.method).toBe(method);
  expect(request.url).toBe(`${BASE_URL}${path}`);
  expect(parseBody(request.body)).toEqual(body);
  if (tracked) {
    expect(gl.track).toHaveBeenCalledWith(...tracked);
  } else {
    expect(gl.track).not.toHaveBeenCalled();
  }
}

const anyUpload = expect.any(FormData);

describe('api (backwards-compatible object)', () => {
  it.each<[string, EndpointCase]>([
    ['get', { call: () => api.get('/anything'), method: 'GET', path: '/anything' }],
    [
      'post',
      {
        call: () => api.post('/anything', { a: 1 }),
        method: 'POST',
        path: '/anything',
        body: { a: 1 },
      },
    ],
    ['delete', { call: () => api.delete('/anything/1'), method: 'DELETE', path: '/anything/1' }],
    [
      'uploadFile',
      {
        call: () => api.uploadFile('/profile/upload-picture', makeFile()),
        method: 'POST',
        path: '/profile/upload-picture',
        body: anyUpload,
      },
    ],
    [
      'getWeekAnalytics',
      {
        call: () => api.getWeekAnalytics('alice', '2026-10-19'),
        method: 'POST',
        path: '/get-week-analytics',
        body: { username: 'alice', week_start: '2026-10-19' },
      },
    ],
  ])('%s', async (_name, endpoint) => {
    await expectEndpoint(endpoint);
  });
});

describe('authApi', () => {
  it.each<[string, EndpointCase]>([
    [
      'login',
      {
        call: () => authApi.login('alice@example.com', 's3cret!'),
        method: 'POST',
        path: '/login',
        body: { identifier: 'alice@example.com', password: 's3cret!' },
      },
    ],
    [
      'register',
      {
        call: () => authApi.register('alice', 'alice@example.com', 's3cret!'),
        method: 'POST',
        path: '/register',
        body: { username: 'alice', email: 'alice@example.com', password: 's3cret!' },
        tracked: ['signup', { properties: { method: 'email' } }],
      },
    ],
    [
      'forgotPassword',
      {
        call: () => authApi.forgotPassword('alice@example.com'),
        method: 'POST',
        path: '/auth/forgot-password',
        body: { email: 'alice@example.com' },
        tracked: ['password_reset_requested'],
      },
    ],
    [
      'resetPassword',
      {
        call: () => authApi.resetPassword('reset-token', 'n3w-pass'),
        method: 'POST',
        path: '/auth/reset-password',
        body: { token: 'reset-token', password: 'n3w-pass' },
        tracked: ['password_reset_completed'],
      },
    ],
    [
      'validateResetToken',
      {
        call: () => authApi.validateResetToken('reset-token'),
        method: 'GET',
        path: '/auth/reset-password/validate?token=reset-token',
      },
    ],
  ])('%s', async (_name, endpoint) => {
    await expectEndpoint(endpoint);
  });

  it('only tracks analytics once the request succeeded', async () => {
    mockFetch(() => jsonResponse({ error: 'Email in use' }, { status: 409 }));

    await expect(authApi.register('alice', 'alice@example.com', 'pw')).rejects.toThrow(
      'Email in use'
    );
    expect(gl.track).not.toHaveBeenCalled();
  });
});

describe('userApi', () => {
  it.each<[string, EndpointCase]>([
    [
      'search',
      {
        call: () => userApi.search('ali'),
        method: 'POST',
        path: '/users',
        body: { username: 'ali' },
      },
    ],
    [
      'autocomplete (default limit)',
      {
        call: () => userApi.autocomplete('ali'),
        method: 'GET',
        path: '/autocomplete/users?q=ali&limit=12',
      },
    ],
    [
      'autocomplete (encodes the query)',
      {
        call: () => userApi.autocomplete('a b&c', 5),
        method: 'GET',
        path: '/autocomplete/users?q=a%20b%26c&limit=5',
      },
    ],
    ['getProfile', { call: () => userApi.getProfile(), method: 'GET', path: '/profile' }],
    [
      'updateUsername',
      {
        call: () => userApi.updateUsername('alice2'),
        method: 'POST',
        path: '/update-username',
        body: { username: 'alice2' },
        tracked: ['profile_updated', { properties: { field: 'username' } }],
      },
    ],
    [
      'updateBio',
      {
        call: () => userApi.updateBio('Morning person'),
        method: 'POST',
        path: '/update-bio',
        body: { bio: 'Morning person' },
        tracked: ['profile_updated', { properties: { field: 'bio' } }],
      },
    ],
    ['getBio', { call: () => userApi.getBio(), method: 'GET', path: '/get-bio' }],
    ['getPrivacy', { call: () => userApi.getPrivacy(), method: 'GET', path: '/get-privacy' }],
    [
      'updatePrivacy',
      {
        call: () => userApi.updatePrivacy(true),
        method: 'POST',
        path: '/update-privacy',
        body: { is_private: true },
      },
    ],
    [
      'uploadProfilePic',
      {
        call: () => userApi.uploadProfilePic(makeFile()),
        method: 'POST',
        path: '/profile/upload-picture',
        body: anyUpload,
        tracked: ['profile_updated', { properties: { field: 'profile_pic' } }],
      },
    ],
    [
      'deleteProfilePic',
      {
        call: () => userApi.deleteProfilePic(),
        method: 'DELETE',
        path: '/profile/picture',
        tracked: ['profile_pic_removed'],
      },
    ],
    [
      'changePassword',
      {
        call: () => userApi.changePassword('old-pass', 'new-pass'),
        method: 'POST',
        path: '/change-password',
        body: { current_password: 'old-pass', new_password: 'new-pass' },
        tracked: ['password_changed'],
      },
    ],
  ])('%s', async (_name, endpoint) => {
    await expectEndpoint(endpoint);
  });

  it('lets autocomplete requests be cancelled', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ success: true }));
    const controller = new AbortController();

    await userApi.autocomplete('ali', 3, controller.signal);

    expect(lastRequest(fetchMock).signal).toBe(controller.signal);
  });
});

describe('activity, streak, analytics, tile config and like APIs', () => {
  it.each<[string, EndpointCase]>([
    [
      'activityApi.getActivities',
      {
        call: () => activityApi.getActivities('alice', '2026-10-01', '2026-10-31'),
        method: 'POST',
        path: '/get-activities',
        body: { username: 'alice', start_date: '2026-10-01', end_date: '2026-10-31' },
      },
    ],
    [
      'activityApi.createActivity',
      {
        call: () => activityApi.createActivity('alice', 'sleep', 7.5, '2026-10-20', 'Deep sleep'),
        method: 'POST',
        path: '/create-activity',
        body: {
          username: 'alice',
          activity: 'sleep',
          hours: 7.5,
          date: '2026-10-20',
          note: 'Deep sleep',
        },
        tracked: ['activity_created', { properties: { activity: 'sleep' } }],
      },
    ],
    [
      'streakApi.getStreak',
      {
        call: () => streakApi.getStreak('alice', '2026-10-20'),
        method: 'POST',
        path: '/get-streak',
        body: { username: 'alice', date: '2026-10-20' },
      },
    ],
    [
      'analyticsApi.getWeekAnalytics',
      {
        call: () => analyticsApi.getWeekAnalytics('alice', '2026-10-19'),
        method: 'POST',
        path: '/get-week-analytics',
        body: { username: 'alice', week_start: '2026-10-19' },
      },
    ],
    [
      'tileConfigApi.getConfig',
      { call: () => tileConfigApi.getConfig(), method: 'GET', path: '/tile-config' },
    ],
    [
      'tileConfigApi.saveConfig',
      {
        call: () => tileConfigApi.saveConfig({ order: ['sleep'], sizes: { sleep: 'wide' } }),
        method: 'POST',
        path: '/tile-config',
        body: { config: { order: ['sleep'], sizes: { sleep: 'wide' } } },
      },
    ],
    [
      'tileConfigApi.getConfigByUsername',
      {
        call: () => tileConfigApi.getConfigByUsername('bob'),
        method: 'POST',
        path: '/tile-config/user',
        body: { username: 'bob' },
      },
    ],
    [
      'likeApi.likeDay',
      {
        call: () => likeApi.likeDay('bob', '2026-10-20'),
        method: 'POST',
        path: '/like-day',
        body: { username: 'bob', date: '2026-10-20' },
        tracked: ['day_liked', { properties: { date: '2026-10-20' } }],
      },
    ],
    [
      'likeApi.unlikeDay',
      {
        call: () => likeApi.unlikeDay('bob', '2026-10-20'),
        method: 'POST',
        path: '/unlike-day',
        body: { username: 'bob', date: '2026-10-20' },
        tracked: ['day_unliked', { properties: { date: '2026-10-20' } }],
      },
    ],
    [
      'likeApi.getLikes',
      {
        call: () => likeApi.getLikes('bob', '2026-10-20'),
        method: 'POST',
        path: '/get-likes',
        body: { username: 'bob', date: '2026-10-20' },
      },
    ],
  ])('%s', async (_name, endpoint) => {
    await expectEndpoint(endpoint);
  });
});

describe('activityPhotoApi', () => {
  it.each<[string, EndpointCase]>([
    [
      'deletePhoto',
      { call: () => activityPhotoApi.deletePhoto(5), method: 'DELETE', path: '/activity-photo/5' },
    ],
    [
      'getPhotos',
      {
        call: () => activityPhotoApi.getPhotos(3, '2026-10-20'),
        method: 'GET',
        path: '/activity-photos?user_id=3&date=2026-10-20',
      },
    ],
    [
      'getFollowingStories (default limit)',
      {
        call: () => activityPhotoApi.getFollowingStories('2026-10-20'),
        method: 'GET',
        path: '/activity-photos/following?date=2026-10-20&limit=20',
      },
    ],
    [
      'getFollowingStories (custom limit)',
      {
        call: () => activityPhotoApi.getFollowingStories('2026-10-20', 5),
        method: 'GET',
        path: '/activity-photos/following?date=2026-10-20&limit=5',
      },
    ],
    [
      'recordView',
      {
        call: () => activityPhotoApi.recordView(5),
        method: 'POST',
        path: '/activity-photo/5/view',
        body: {},
      },
    ],
    [
      'getPhotoViewers (default page)',
      {
        call: () => activityPhotoApi.getPhotoViewers(5),
        method: 'GET',
        path: '/activity-photo/5/viewers?limit=20&offset=0',
      },
    ],
    [
      'getPhotoViewers (custom page)',
      {
        call: () => activityPhotoApi.getPhotoViewers(5, 10, 30),
        method: 'GET',
        path: '/activity-photo/5/viewers?limit=10&offset=30',
      },
    ],
    [
      'likePhoto',
      {
        call: () => activityPhotoApi.likePhoto(5),
        method: 'POST',
        path: '/activity-photo/5/like',
        body: {},
      },
    ],
    [
      'unlikePhoto',
      {
        call: () => activityPhotoApi.unlikePhoto(5),
        method: 'DELETE',
        path: '/activity-photo/5/like',
      },
    ],
    [
      'getLikeStatus',
      {
        call: () => activityPhotoApi.getLikeStatus(5),
        method: 'GET',
        path: '/activity-photo/5/like-status',
      },
    ],
    [
      'getPhotoInteractions (default page)',
      {
        call: () => activityPhotoApi.getPhotoInteractions(5),
        method: 'GET',
        path: '/activity-photo/5/interactions?limit=20&offset=0',
      },
    ],
    [
      'getPhotoInteractions (custom page)',
      {
        call: () => activityPhotoApi.getPhotoInteractions(5, 10, 20),
        method: 'GET',
        path: '/activity-photo/5/interactions?limit=10&offset=20',
      },
    ],
  ])('%s', async (_name, endpoint) => {
    await expectEndpoint(endpoint);
  });

  describe('uploadPhoto', () => {
    it('uploads the photo with its activity, date and custom tile metadata', async () => {
      localStorage.setItem(STORAGE_KEYS.ACCESS_TOKEN, 'tok');
      const fetchMock = mockFetch(() => jsonResponse({ success: true, photo: { id: 9 } }));

      await expect(
        activityPhotoApi.uploadPhoto(
          makeFile('run.jpg', 'image/jpeg'),
          'custom:abc',
          '2026-10-20',
          {
            icon: 'Bike',
            color: '#10b981',
            label: 'Cycling',
          }
        )
      ).resolves.toEqual({ success: true, photo: { id: 9 } });

      const request = lastRequest(fetchMock);
      expect(request).toMatchObject({
        url: `${BASE_URL}/activity-photo`,
        method: 'POST',
        headers: { Authorization: 'Bearer tok' },
      });
      const form = request.body as FormData;
      expect(form.get('image')).toMatchObject({ name: 'run.jpg', type: 'image/jpeg' });
      expect(Object.fromEntries([...form.entries()].filter(([key]) => key !== 'image'))).toEqual({
        activity_name: 'custom:abc',
        photo_date: '2026-10-20',
        activity_icon: 'Bike',
        activity_color: '#10b981',
        activity_label: 'Cycling',
      });
      expect(gl.track).toHaveBeenCalledWith('photo_uploaded', {
        properties: { activityName: 'custom:abc' },
      });
    });

    it('omits missing metadata and the auth header when signed out', async () => {
      const fetchMock = mockFetch(() => jsonResponse({ success: true }));

      await activityPhotoApi.uploadPhoto(makeFile(), 'sleep', '2026-10-20', { color: '#6366f1' });

      const request = lastRequest(fetchMock);
      expect(request.headers).toEqual({});
      const form = request.body as FormData;
      expect([...form.keys()]).toEqual(['image', 'activity_name', 'photo_date', 'activity_color']);
    });

    it.each([
      [{ error: 'Upload window closed', error_code: 'DATE_OUT_OF_RANGE' }, 'Upload window closed'],
      [{}, 'Upload failed'],
    ])('rejects failed uploads with an ApiError and tracks nothing (%o)', async (body, message) => {
      mockFetch(() => jsonResponse(body, { status: 400 }));

      await expect(
        activityPhotoApi.uploadPhoto(makeFile(), 'sleep', '2026-10-01')
      ).rejects.toMatchObject({ name: 'ApiError', message, statusCode: 400 });
      expect(gl.track).not.toHaveBeenCalled();
    });

    it('treats a 401 as an expired session, like every other request', async () => {
      storeSession();
      const location = stubLocation('/history');
      mockFetch(() => jsonResponse({ error: 'token expired' }, { status: 401 }));

      await expect(
        activityPhotoApi.uploadPhoto(makeFile(), 'sleep', '2026-10-01')
      ).rejects.toMatchObject({ name: 'ApiError', statusCode: 401, errorCode: 'UNAUTHORIZED' });

      AUTH_KEYS.forEach((key) => expect(localStorage.getItem(key)).toBeNull());
      expect(gl.track).toHaveBeenCalledWith('session_expired');
      expect(gl.track).not.toHaveBeenCalledWith('photo_uploaded', expect.anything());
      expect(location.href).toBe('/login');
    });
  });
});

describe('searchApi', () => {
  it('returns recent and trending suggestions', async () => {
    const recent = [{ id: 1, username: 'bob' }];
    const trending = [{ id: 2, username: 'carol' }];
    const fetchMock = mockFetch(() => jsonResponse({ success: true, recent, trending }));

    await expect(searchApi.getSuggestions()).resolves.toEqual({ recent, trending });
    expect(lastRequest(fetchMock)).toMatchObject({
      url: `${BASE_URL}/search/suggestions`,
      method: 'GET',
    });
  });

  it('defaults missing suggestion lists to empty arrays', async () => {
    mockFetch(() => jsonResponse({ success: true, recent: null }));

    await expect(searchApi.getSuggestions()).resolves.toEqual({ recent: [], trending: [] });
  });

  it.each<[string, EndpointCase]>([
    [
      'deleteRecentSearch',
      { call: () => searchApi.deleteRecentSearch(7), method: 'DELETE', path: '/search/recent/7' },
    ],
    [
      'clearRecentSearches',
      { call: () => searchApi.clearRecentSearches(), method: 'DELETE', path: '/search/recent' },
    ],
  ])('%s', async (_name, endpoint) => {
    await expectEndpoint(endpoint);
  });

  it.each([0, -3, 1.5, Number.NaN])(
    'refuses to delete a recent search for the invalid user id %s',
    async (userId) => {
      const fetchMock = mockFetch(() => jsonResponse({ success: true }));

      await expect(searchApi.deleteRecentSearch(userId)).rejects.toThrow('Invalid user ID');
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );
});

describe('commentApi', () => {
  it.each<[string, EndpointCase]>([
    [
      'getComments (no paging)',
      {
        call: () => commentApi.getComments('alice', '2026-10-20'),
        method: 'GET',
        path: '/days/alice/2026-10-20/comments',
      },
    ],
    [
      'getComments (sort, cursor and limit)',
      {
        call: () => commentApi.getComments('alice', '2026-10-20', 'top', 15, 10),
        method: 'GET',
        path: '/days/alice/2026-10-20/comments?sort=top&cursor=15&limit=10',
      },
    ],
    [
      'getReplies (no paging)',
      { call: () => commentApi.getReplies(9), method: 'GET', path: '/comments/9/replies' },
    ],
    [
      'getReplies (cursor and limit)',
      {
        call: () => commentApi.getReplies(9, 4, 5),
        method: 'GET',
        path: '/comments/9/replies?cursor=4&limit=5',
      },
    ],
    [
      'deleteComment',
      { call: () => commentApi.deleteComment(9), method: 'DELETE', path: '/comments/9' },
    ],
    [
      'editComment',
      {
        call: () => commentApi.editComment(9, 'Edited'),
        method: 'PUT',
        path: '/comments/9',
        body: { body: 'Edited' },
      },
    ],
    [
      'likeComment',
      { call: () => commentApi.likeComment(9), method: 'POST', path: '/comments/9/like' },
    ],
    [
      'unlikeComment',
      { call: () => commentApi.unlikeComment(9), method: 'DELETE', path: '/comments/9/like' },
    ],
    [
      'getCommentCount',
      {
        call: () => commentApi.getCommentCount('alice', '2026-10-20'),
        method: 'GET',
        path: '/days/alice/2026-10-20/comments/count',
      },
    ],
  ])('%s', async (_name, endpoint) => {
    await expectEndpoint(endpoint);
  });

  it.each([
    [
      'createComment',
      () => commentApi.createComment('alice', '2026-10-20', 'Nice day!', 'key-1'),
      '/days/alice/2026-10-20/comments',
    ],
    [
      'createReply',
      () => commentApi.createReply('alice', '2026-10-20', 9, 'Nice day!', 'key-1'),
      '/days/alice/2026-10-20/comments/9/replies',
    ],
  ])('%s posts the body with an idempotency key', async (_name, send, path) => {
    const fetchMock = mockFetch(() => jsonResponse({ success: true }));

    await send();

    const request = lastRequest(fetchMock);
    expect(request).toMatchObject({
      url: `${BASE_URL}${path}`,
      method: 'POST',
      headers: { 'X-Idempotency-Key': 'key-1' },
    });
    expect(parseBody(request.body)).toEqual({ body: 'Nice day!' });
  });
});

describe('challengeApi', () => {
  it.each<[string, EndpointCase]>([
    ['list', { call: () => challengeApi.list(), method: 'GET', path: '/challenges' }],
    ['get', { call: () => challengeApi.get(42), method: 'GET', path: '/challenges/42' }],
    [
      'remove',
      {
        call: () => challengeApi.remove(42),
        method: 'DELETE',
        path: '/challenges/42',
        tracked: ['challenge_deleted', { properties: { challengeId: 42 } }],
      },
    ],
    [
      'leave',
      {
        call: () => challengeApi.leave(42),
        method: 'POST',
        path: '/challenges/42/leave',
        tracked: ['challenge_left', { properties: { challengeId: 42 } }],
      },
    ],
    [
      'cheer',
      {
        call: () => challengeApi.cheer(42, 7),
        method: 'POST',
        path: '/challenges/42/cheers',
        body: { user_id: 7 },
        tracked: [
          'challenge_cheered',
          { properties: { challengeId: 42, toUserId: 7, alreadyCheered: false } },
        ],
      },
    ],
    [
      'getInviteCandidates (no query)',
      {
        call: () => challengeApi.getInviteCandidates(42),
        method: 'GET',
        path: '/challenges/42/invite-candidates',
      },
    ],
    [
      'getInviteCandidates (blank query)',
      {
        call: () => challengeApi.getInviteCandidates(42, { q: '   ' }),
        method: 'GET',
        path: '/challenges/42/invite-candidates',
      },
    ],
    [
      'getInviteCandidates (query and limit)',
      {
        call: () => challengeApi.getInviteCandidates(42, { q: ' zoë&co ', limit: 50 }),
        method: 'GET',
        path: '/challenges/42/invite-candidates?q=zo%C3%AB%26co&limit=50',
      },
    ],
    [
      'getPreview',
      {
        call: () => challengeApi.getPreview('ABCD2345'),
        method: 'GET',
        path: '/challenge-codes/ABCD2345',
      },
    ],
    [
      'getPreview (encodes the code)',
      {
        call: () => challengeApi.getPreview('ab/c d?'),
        method: 'GET',
        path: '/challenge-codes/ab%2Fc%20d%3F',
      },
    ],
  ])('%s', async (_name, endpoint) => {
    await expectEndpoint(endpoint);
  });

  const challenge = { id: 42, title: 'Study 2h+ a day' };

  it('creates a challenge with the settings as the body and tracks it without the title', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ success: true, challenge }, { status: 201 }));
    const request = {
      title: 'Study 2h+ a day',
      activity: 'study' as const,
      goal_type: 'at_least' as const,
      target_hours: 2,
      duration_days: 21,
      start_date: '2026-10-23',
    };

    await expect(challengeApi.create(request)).resolves.toEqual({ success: true, challenge });

    expect(lastRequest(fetchMock)).toMatchObject({
      url: `${BASE_URL}/challenges`,
      method: 'POST',
    });
    expect(parseBody(lastRequest(fetchMock).body)).toEqual(request);
    expect(gl.track).toHaveBeenCalledExactlyOnceWith('challenge_created', {
      properties: {
        challengeId: 42,
        activity: 'study',
        goalType: 'at_least',
        targetHours: 2,
        durationDays: 21,
      },
    });
  });

  it('joins with the (encoded) invite code and tracks the joined challenge', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ success: true, challenge }));

    await challengeApi.join('abcd 2345');

    expect(lastRequest(fetchMock)).toMatchObject({
      url: `${BASE_URL}/challenge-codes/abcd%202345/join`,
      method: 'POST',
      body: undefined,
    });
    expect(gl.track).toHaveBeenCalledExactlyOnceWith('challenge_joined', {
      properties: { challengeId: 42 },
    });
  });

  it('invites people and tracks how many were asked, invited and skipped', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ success: true, invited: 2, skipped: 1 }));

    await expect(challengeApi.invite(42, [7, 8, 9])).resolves.toEqual({
      success: true,
      invited: 2,
      skipped: 1,
    });

    expect(lastRequest(fetchMock)).toMatchObject({
      url: `${BASE_URL}/challenges/42/invites`,
      method: 'POST',
    });
    expect(parseBody(lastRequest(fetchMock).body)).toEqual({ user_ids: [7, 8, 9] });
    expect(gl.track).toHaveBeenCalledExactlyOnceWith('challenge_invites_sent', {
      properties: { challengeId: 42, count: 3, invited: 2, skipped: 1 },
    });
  });

  it('tracks a repeated cheer as already cheered', async () => {
    mockFetch(() => jsonResponse({ success: true, already_cheered: true }));

    await challengeApi.cheer(42, 7);

    expect(gl.track).toHaveBeenCalledWith('challenge_cheered', {
      properties: { challengeId: 42, toUserId: 7, alreadyCheered: true },
    });
  });

  it('does not track actions that fail and passes the error code on', async () => {
    mockFetch(() =>
      jsonResponse(
        { success: false, error: 'This challenge is full', error_code: 'CHALLENGE_FULL' },
        { status: 409 }
      )
    );

    await expect(challengeApi.join('ABCD2345')).rejects.toMatchObject({
      name: 'ApiError',
      statusCode: 409,
      errorCode: 'CHALLENGE_FULL',
    });
    expect(gl.track).not.toHaveBeenCalled();
  });
});

describe('services barrel', () => {
  it('re-exports the API client and typed APIs', () => {
    expect(services.apiClient).toBe(apiClient);
    expect(services.ApiError).toBe(ApiError);
    expect(services.api).toBe(api);
    expect(services.authApi).toBe(authApi);
    expect(services.userApi).toBe(userApi);
    expect(services.activityApi).toBe(activityApi);
    expect(services.streakApi).toBe(streakApi);
    expect(services.analyticsApi).toBe(analyticsApi);
    expect(services.tileConfigApi).toBe(tileConfigApi);
    expect(services.challengeApi).toBe(challengeApi);
  });
});
