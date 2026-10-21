import { describe, expect, it } from 'vitest';

import { getAnalyticsUsername, getProfileUsername } from '../utils/navigation';
import { API_ROUTES, APP_ROUTES } from './routes';

/** Every fixed endpoint, keyed like "AUTH.LOGIN". */
const staticEndpoints = Object.entries(API_ROUTES).flatMap(([group, routes]) =>
  Object.entries(routes)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([name, path]) => [`${group}.${name}`, path] as const)
);

describe('API_ROUTES', () => {
  it.each(staticEndpoints)('%s (%s) is a clean path relative to the /api base', (_name, path) => {
    expect(path).toMatch(/^(\/[a-z0-9-]+)+$/);
    // ApiClient already prefixes /api.
    expect(path.startsWith('/api/')).toBe(false);
  });

  it.each([
    ['SEARCH.DELETE_RECENT', API_ROUTES.SEARCH.DELETE_RECENT(7), '/search/recent/7'],
    ['NOTIFICATION.MARK_READ', API_ROUTES.NOTIFICATION.MARK_READ(3), '/notifications/3/read'],
    ['NOTIFICATION.DELETE', API_ROUTES.NOTIFICATION.DELETE(3), '/notifications/3'],
    ['FOLLOW.FOLLOW_USER', API_ROUTES.FOLLOW.FOLLOW_USER(5), '/users/5/follow'],
    ['FOLLOW.CANCEL_REQUEST', API_ROUTES.FOLLOW.CANCEL_REQUEST(5), '/follow-requests/5/cancel'],
    ['FOLLOW.ACCEPT_REQUEST', API_ROUTES.FOLLOW.ACCEPT_REQUEST(5), '/me/follow-requests/5/accept'],
    [
      'FOLLOW.DECLINE_REQUEST',
      API_ROUTES.FOLLOW.DECLINE_REQUEST(5),
      '/me/follow-requests/5/decline',
    ],
    ['FOLLOW.REMOVE_FOLLOWER', API_ROUTES.FOLLOW.REMOVE_FOLLOWER(5), '/me/followers/5'],
    ['FOLLOW.GET_FOLLOWERS', API_ROUTES.FOLLOW.GET_FOLLOWERS(5), '/users/5/followers'],
    ['FOLLOW.GET_FOLLOWING', API_ROUTES.FOLLOW.GET_FOLLOWING(5), '/users/5/following'],
    ['FOLLOW.GET_MUTUALS', API_ROUTES.FOLLOW.GET_MUTUALS(5), '/users/5/mutuals'],
    ['FOLLOW.GET_COUNTS', API_ROUTES.FOLLOW.GET_COUNTS(5), '/users/5/follow-counts'],
    ['ACTIVITY_PHOTO.DELETE', API_ROUTES.ACTIVITY_PHOTO.DELETE(9), '/activity-photo/9'],
    [
      'ACTIVITY_PHOTO.RECORD_VIEW',
      API_ROUTES.ACTIVITY_PHOTO.RECORD_VIEW(9),
      '/activity-photo/9/view',
    ],
    [
      'ACTIVITY_PHOTO.GET_VIEWERS',
      API_ROUTES.ACTIVITY_PHOTO.GET_VIEWERS(9),
      '/activity-photo/9/viewers',
    ],
    ['ACTIVITY_PHOTO.LIKE', API_ROUTES.ACTIVITY_PHOTO.LIKE(9), '/activity-photo/9/like'],
    [
      'ACTIVITY_PHOTO.GET_LIKE_STATUS',
      API_ROUTES.ACTIVITY_PHOTO.GET_LIKE_STATUS(9),
      '/activity-photo/9/like-status',
    ],
    [
      'ACTIVITY_PHOTO.GET_INTERACTIONS',
      API_ROUTES.ACTIVITY_PHOTO.GET_INTERACTIONS(9),
      '/activity-photo/9/interactions',
    ],
    [
      'COMMENT.CREATE',
      API_ROUTES.COMMENT.CREATE('alice', '2026-10-20'),
      '/days/alice/2026-10-20/comments',
    ],
    [
      'COMMENT.CREATE_REPLY',
      API_ROUTES.COMMENT.CREATE_REPLY('alice', '2026-10-20', 4),
      '/days/alice/2026-10-20/comments/4/replies',
    ],
    [
      'COMMENT.COUNT',
      API_ROUTES.COMMENT.COUNT('alice', '2026-10-20'),
      '/days/alice/2026-10-20/comments/count',
    ],
    ['COMMENT.DELETE', API_ROUTES.COMMENT.DELETE(4), '/comments/4'],
    ['COMMENT.LIKE', API_ROUTES.COMMENT.LIKE(4), '/comments/4/like'],
    ['COMMENT.GET_REPLIES', API_ROUTES.COMMENT.GET_REPLIES(4), '/comments/4/replies'],
  ])('%s builds %s', (_name, actual, expected) => {
    expect(actual).toBe(expected);
  });

  it('addresses the same resource for each REST verb pair', () => {
    expect(API_ROUTES.FOLLOW.UNFOLLOW_USER(5)).toBe(API_ROUTES.FOLLOW.FOLLOW_USER(5));
    expect(API_ROUTES.ACTIVITY_PHOTO.UNLIKE(9)).toBe(API_ROUTES.ACTIVITY_PHOTO.LIKE(9));
    expect(API_ROUTES.COMMENT.UNLIKE(4)).toBe(API_ROUTES.COMMENT.LIKE(4));
    expect(API_ROUTES.COMMENT.EDIT(4)).toBe(API_ROUTES.COMMENT.DELETE(4));
    expect(API_ROUTES.COMMENT.LIST('alice', '2026-10-20')).toBe(
      API_ROUTES.COMMENT.CREATE('alice', '2026-10-20')
    );
    expect(API_ROUTES.TILE_CONFIG.SAVE).toBe(API_ROUTES.TILE_CONFIG.GET);
  });
});

describe('APP_ROUTES', () => {
  it('uses distinct absolute paths for every screen', () => {
    const paths = Object.values(APP_ROUTES).filter((value) => typeof value === 'string');

    expect(new Set(paths).size).toBe(paths.length);
    paths.forEach((path) => expect(path).toMatch(/^\//));
  });

  it('builds profile and analytics links that the navigation helpers read back', () => {
    expect(APP_ROUTES.USER_PROFILE('alice')).toBe('/user/alice');
    expect(getProfileUsername(APP_ROUTES.USER_PROFILE('alice'))).toBe('alice');

    const analytics = new URL(APP_ROUTES.USER_ANALYTICS('bob'), 'https://app.example');
    expect(analytics.pathname + analytics.search).toBe('/analytics?user=bob');
    expect(getAnalyticsUsername(analytics.pathname, analytics.search)).toBe('bob');
  });
});
