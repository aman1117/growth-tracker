import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

import { api } from '../services/api';
import { gl } from '../services/goodlogs';
import { deferred, makeFollowUser, makeRelationship } from '../test/fixtures/shell';
import type { FollowActionResponse } from '../types/follow';
import {
  useFollowCounts,
  useFollowStore,
  usePendingRequestsCount,
  useRelationship,
} from './useFollowStore';

vi.mock('../services/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));

const get = vi.mocked(api.get);
const post = vi.mocked(api.post);
const del = vi.mocked(api.delete);
const store = () => useFollowStore.getState();

describe('useFollowStore', () => {
  let consoleError: MockInstance<typeof console.error>;

  beforeEach(() => {
    get.mockReset();
    post.mockReset();
    del.mockReset();
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  describe('followUser', () => {
    it('follows a public user and caches the new relationship and counts', async () => {
      const response = {
        success: true,
        action: 'followed',
        state: 'ACTIVE',
        updated_counts: { followers: 11, following: 4 },
      };
      post.mockResolvedValue(response);

      const result = await store().followUser(2, false);

      expect(post).toHaveBeenCalledWith('/users/2/follow');
      expect(result).toEqual({ ...response, new_state: makeRelationship({ following: true }) });
      expect(store().getRelationship(2)).toEqual(makeRelationship({ following: true }));
      expect(store().counts['2']).toEqual({ followers: 11, following: 4 });
      expect(gl.track).toHaveBeenCalledWith('follow_sent', {
        properties: { targetUserId: 2, isPrivate: false },
      });
    });

    it('marks a request to a private user as pending, keeping what else is known', async () => {
      store().setRelationship(2, makeRelationship({ followed_by: true }));
      post.mockResolvedValue({ success: true, action: 'requested', state: 'REQUESTED' });

      const result = await store().followUser(2, true);

      const expected = makeRelationship({ followed_by: true, pending: true });
      expect(result.new_state).toEqual(expected);
      expect(store().getRelationship(2)).toEqual(expected);
      expect(store().counts['2']).toBeUndefined();
    });

    it('prefers the relationship object returned by the server', async () => {
      const serverState = makeRelationship({ following: true, followed_by: true, is_mutual: true });
      post.mockResolvedValue({ success: true, state: 'PENDING', new_state: serverState });

      await store().followUser(2, false);

      expect(store().getRelationship(2)).toEqual(serverState);
    });

    it('returns an unsuccessful response untouched', async () => {
      const response = { success: false, error: 'You are blocked' };
      post.mockResolvedValue(response);

      await expect(store().followUser(2, false)).resolves.toBe(response);
      expect(store().getRelationship(2)).toBeUndefined();
      expect(gl.track).not.toHaveBeenCalled();
    });

    it('reports a network failure without throwing', async () => {
      const error = new Error('Network down');
      post.mockRejectedValue(error);

      await expect(store().followUser(2, true)).resolves.toEqual({
        success: false,
        action: 'requested',
        new_state: makeRelationship(),
        error: 'Network down',
      });
      expect(consoleError).toHaveBeenCalledWith('Failed to follow user:', error);
    });

    it('keeps the known relationship and uses a default message for unknown failures', async () => {
      const known = makeRelationship({ followed_by: true });
      store().setRelationship(2, known);
      post.mockRejectedValue('offline');

      await expect(store().followUser(2, false)).resolves.toEqual({
        success: false,
        action: 'followed',
        new_state: known,
        error: 'Failed to follow user',
      });
    });

    it('tracks loading per user and action', async () => {
      const follow = deferred<FollowActionResponse>();
      const unfollow = deferred<FollowActionResponse>();
      post.mockReturnValue(follow.promise);
      del.mockReturnValue(unfollow.promise);

      const following = store().followUser(2, false);
      const unfollowing = store().unfollowUser(3);

      expect(store().isActionLoading(2, 'follow')).toBe(true);
      expect(store().isActionLoading(3, 'unfollow')).toBe(true);
      expect(store().isActionLoading(2, 'unfollow')).toBe(false);
      expect(store().isLoading).toBe(true);

      follow.resolve({ success: true, state: 'ACTIVE' });
      await following;
      expect(store().isActionLoading(2, 'follow')).toBe(false);
      expect(store().isLoading).toBe(true);

      unfollow.reject(new Error('Network down'));
      await unfollowing;
      expect(store().isActionLoading(3, 'unfollow')).toBe(false);
      expect(store().isLoading).toBe(false);
    });
  });

  describe('unfollowUser', () => {
    it('stops following while keeping whether they follow back', async () => {
      store().setRelationship(2, makeRelationship({ following: true, followed_by: true }));
      del.mockResolvedValue({
        success: true,
        action: 'unfollowed',
        updated_counts: { followers: 9, following: 4 },
      });

      await store().unfollowUser(2);

      expect(del).toHaveBeenCalledWith('/users/2/follow');
      expect(store().getRelationship(2)).toEqual(makeRelationship({ followed_by: true }));
      expect(store().counts['2']).toEqual({ followers: 9, following: 4 });
      expect(gl.track).toHaveBeenCalledWith('unfollowed', { properties: { targetUserId: 2 } });
    });

    it('applies the server state or relationship when provided', async () => {
      del.mockResolvedValueOnce({ success: true, state: 'NONE' });
      await store().unfollowUser(2);
      expect(store().getRelationship(2)).toEqual(makeRelationship());

      const serverState = makeRelationship({ followed_by: true });
      del.mockResolvedValueOnce({ success: true, new_state: serverState });
      await store().unfollowUser(3);
      expect(store().getRelationship(3)).toEqual(serverState);
    });
  });

  describe('cancelRequest', () => {
    it('withdraws a pending request', async () => {
      store().setRelationship(2, makeRelationship({ pending: true }));
      post.mockResolvedValue({ success: true, action: 'cancelled' });

      await store().cancelRequest(2);

      expect(post).toHaveBeenCalledWith('/follow-requests/2/cancel');
      expect(store().getRelationship(2)).toEqual(makeRelationship());
      expect(gl.track).toHaveBeenCalledWith('follow_cancelled', {
        properties: { targetUserId: 2 },
      });
    });

    it('uses the server relationship when provided', async () => {
      const serverState = makeRelationship({ followed_by: true });
      post.mockResolvedValue({ success: true, state: 'REMOVED', new_state: serverState });

      await store().cancelRequest(2);

      expect(store().getRelationship(2)).toEqual(serverState);
    });
  });

  describe('acceptRequest', () => {
    it('turns the requester into a follower and decrements pending requests', async () => {
      store().setPendingRequestsCount(2);
      store().setRelationship(4, makeRelationship({ incoming_pending: true }));
      post.mockResolvedValue({ success: true, action: 'accepted' });

      await store().acceptRequest(4);

      expect(post).toHaveBeenCalledWith('/me/follow-requests/4/accept');
      expect(store().getRelationship(4)).toEqual(makeRelationship({ followed_by: true }));
      expect(store().pendingRequestsCount).toBe(1);
      expect(gl.track).toHaveBeenCalledWith('follow_accepted', { properties: { userId: 4 } });
    });

    it('marks the relationship mutual when we already follow them', async () => {
      store().setRelationship(4, makeRelationship({ following: true, incoming_pending: true }));
      post.mockResolvedValue({ success: true });

      await store().acceptRequest(4);

      expect(store().getRelationship(4)).toEqual(
        makeRelationship({ following: true, followed_by: true, is_mutual: true })
      );
    });

    it('works without a cached relationship', async () => {
      post.mockResolvedValue({ success: true });

      await store().acceptRequest(4);

      expect(store().getRelationship(4)).toEqual(makeRelationship({ followed_by: true }));
      expect(store().pendingRequestsCount).toBe(0);
    });
  });

  describe('declineRequest', () => {
    it('clears the incoming request and decrements pending requests', async () => {
      store().setPendingRequestsCount(3);
      store().setRelationship(4, makeRelationship({ incoming_pending: true }));
      post.mockResolvedValue({ success: true, action: 'declined' });

      await store().declineRequest(4);

      expect(post).toHaveBeenCalledWith('/me/follow-requests/4/decline');
      expect(store().getRelationship(4)).toEqual(makeRelationship());
      expect(store().pendingRequestsCount).toBe(2);
      expect(gl.track).toHaveBeenCalledWith('follow_declined', { properties: { userId: 4 } });
    });

    it('works without a cached relationship', async () => {
      post.mockResolvedValue({ success: true });

      await store().declineRequest(4);

      expect(store().getRelationship(4)).toEqual(makeRelationship());
    });
  });

  describe('removeFollower', () => {
    it('removes them as a follower', async () => {
      store().setRelationship(
        5,
        makeRelationship({ following: true, followed_by: true, is_mutual: true })
      );
      del.mockResolvedValue({ success: true });

      await store().removeFollower(5);

      expect(del).toHaveBeenCalledWith('/me/followers/5');
      expect(store().getRelationship(5)).toEqual(makeRelationship({ following: true }));
      expect(gl.track).toHaveBeenCalledWith('follower_removed', { properties: { userId: 5 } });
    });

    it('works without a cached relationship', async () => {
      del.mockResolvedValue({ success: true });

      await store().removeFollower(5);

      expect(store().getRelationship(5)).toEqual(makeRelationship());
    });

    it('reports failures without throwing', async () => {
      const error = new Error('Server error');
      del.mockRejectedValueOnce(error);
      await expect(store().removeFollower(5)).resolves.toEqual({
        success: false,
        error: 'Server error',
      });
      expect(consoleError).toHaveBeenCalledWith('Failed to remove follower:', error);

      del.mockRejectedValueOnce(null);
      await expect(store().removeFollower(5)).resolves.toEqual({
        success: false,
        error: 'Failed to remove follower',
      });
      expect(store().isActionLoading(5, 'remove')).toBe(false);
    });
  });

  describe.each([
    {
      name: 'unfollowUser',
      run: () => store().unfollowUser(6),
      request: () => del,
      action: 'unfollowed',
      logged: 'Failed to unfollow user:',
      fallback: 'Failed to unfollow user',
    },
    {
      name: 'cancelRequest',
      run: () => store().cancelRequest(6),
      request: () => post,
      action: 'cancelled',
      logged: 'Failed to cancel request:',
      fallback: 'Failed to cancel request',
    },
    {
      name: 'acceptRequest',
      run: () => store().acceptRequest(6),
      request: () => post,
      action: 'accepted',
      logged: 'Failed to accept request:',
      fallback: 'Failed to accept request',
    },
    {
      name: 'declineRequest',
      run: () => store().declineRequest(6),
      request: () => post,
      action: 'declined',
      logged: 'Failed to decline request:',
      fallback: 'Failed to decline request',
    },
  ])('$name failures', ({ run, request, action, logged, fallback }) => {
    it('return a failed response with the cached relationship', async () => {
      const known = makeRelationship({ followed_by: true });
      store().setRelationship(6, known);
      const error = new Error('Network down');
      request().mockRejectedValue(error);

      await expect(run()).resolves.toEqual({
        success: false,
        action,
        new_state: known,
        error: 'Network down',
      });
      expect(consoleError).toHaveBeenCalledWith(logged, error);
      expect(store().isLoading).toBe(false);
    });

    it('fall back to a default relationship and message', async () => {
      request().mockRejectedValue('timeout');

      await expect(run()).resolves.toEqual({
        success: false,
        action,
        new_state: makeRelationship(),
        error: fallback,
      });
    });

    it('leave the cache alone when the server refuses', async () => {
      store().setPendingRequestsCount(1);
      const response = { success: false, error: 'Not allowed' };
      request().mockResolvedValue(response);

      await expect(run()).resolves.toBe(response);
      expect(store().getRelationship(6)).toBeUndefined();
      expect(store().pendingRequestsCount).toBe(1);
      expect(gl.track).not.toHaveBeenCalled();
    });
  });

  describe('follow lists', () => {
    it.each([
      ['getFollowers', 'followers'],
      ['getFollowing', 'following'],
    ] as const)('%s pages through the list and caches relationships', async (method, path) => {
      const withState = makeFollowUser({
        id: 21,
        relationship_state: makeRelationship({ following: true }),
      });
      const withoutState = makeFollowUser({ id: 22 });
      const response = { success: true, users: [withState, withoutState], has_more: true };
      get.mockResolvedValue(response);

      await expect(store()[method](9, 'cursor-1', 10)).resolves.toBe(response);

      expect(get).toHaveBeenCalledWith(`/users/9/${path}?cursor=cursor-1&limit=10`);
      expect(store().getRelationship(21)).toEqual(makeRelationship({ following: true }));
      expect(store().getRelationship(22)).toBeUndefined();
    });

    it.each([
      ['getFollowers', 'followers', 'Failed to get followers'],
      ['getFollowing', 'following', 'Failed to get following'],
    ] as const)(
      '%s defaults to 20 per page and survives errors',
      async (method, path, fallback) => {
        get.mockResolvedValueOnce({ success: false, users: [] });
        await store()[method](9);
        expect(get).toHaveBeenCalledWith(`/users/9/${path}?limit=20`);

        get.mockRejectedValueOnce(new Error('Server error'));
        await expect(store()[method](9)).resolves.toEqual({
          success: false,
          users: [],
          total_count: 0,
          error: 'Server error',
        });

        get.mockRejectedValueOnce(undefined);
        await expect(store()[method](9)).resolves.toMatchObject({ error: fallback });
      }
    );

    it('getIncomingRequests updates the pending request badge', async () => {
      const response = { success: true, requests: [makeFollowUser()], total_count: 3 };
      get.mockResolvedValue(response);

      await expect(store().getIncomingRequests('next', 5)).resolves.toBe(response);

      expect(get).toHaveBeenCalledWith('/me/follow-requests/incoming?cursor=next&limit=5');
      expect(store().pendingRequestsCount).toBe(3);
    });

    it('getIncomingRequests keeps the badge when the request fails', async () => {
      store().setPendingRequestsCount(2);

      get.mockResolvedValueOnce({ success: false, requests: [], total_count: 0 });
      await store().getIncomingRequests();
      expect(get).toHaveBeenCalledWith('/me/follow-requests/incoming?limit=20');
      expect(store().pendingRequestsCount).toBe(2);

      get.mockRejectedValueOnce(new Error('Server error'));
      await expect(store().getIncomingRequests()).resolves.toEqual({
        success: false,
        requests: [],
        total_count: 0,
        error: 'Server error',
      });

      get.mockRejectedValueOnce(42);
      await expect(store().getIncomingRequests()).resolves.toMatchObject({
        error: 'Failed to get requests',
      });
      expect(store().pendingRequestsCount).toBe(2);
    });

    it('getMutuals requests mutual followers and survives errors', async () => {
      const response = { success: true, users: [makeFollowUser()], has_more: false };
      get.mockResolvedValueOnce(response);
      await expect(store().getMutuals(9, 'c', 3)).resolves.toBe(response);
      expect(get).toHaveBeenCalledWith('/users/9/mutuals?cursor=c&limit=3');

      get.mockRejectedValueOnce(new Error('Server error'));
      await expect(store().getMutuals(9)).resolves.toEqual({
        success: false,
        users: [],
        has_more: false,
        error: 'Server error',
      });
      expect(get).toHaveBeenLastCalledWith('/users/9/mutuals?limit=20');

      get.mockRejectedValueOnce('nope');
      await expect(store().getMutuals(9)).resolves.toMatchObject({
        error: 'Failed to get mutuals',
      });
    });
  });

  describe('getCounts', () => {
    it('fetches, maps and caches the counts', async () => {
      get.mockResolvedValue({ success: true, counts: { followers_count: 12, following_count: 7 } });

      await expect(store().getCounts(9)).resolves.toEqual({ followers: 12, following: 7 });
      await expect(store().getCounts(9)).resolves.toEqual({ followers: 12, following: 7 });

      expect(get).toHaveBeenCalledTimes(1);
      expect(get).toHaveBeenCalledWith('/users/9/follow-counts');
    });

    it('returns null when the counts are unavailable', async () => {
      get.mockResolvedValueOnce({ success: false });
      await expect(store().getCounts(9)).resolves.toBeNull();

      const error = new Error('Server error');
      get.mockRejectedValueOnce(error);
      await expect(store().getCounts(9)).resolves.toBeNull();
      expect(consoleError).toHaveBeenCalledWith('Failed to get counts:', error);
    });
  });

  describe('lookupRelationships', () => {
    it('answers from the cache when every user is known', async () => {
      store().setRelationship(1, makeRelationship({ following: true }));

      await expect(store().lookupRelationships([1])).resolves.toEqual({
        '1': makeRelationship({ following: true }),
      });
      expect(post).not.toHaveBeenCalled();
    });

    it('looks up unknown users only and returns every requested relationship', async () => {
      store().setRelationship(1, makeRelationship({ followed_by: true }));
      const objectState = makeRelationship({ following: true, is_mutual: true });
      post.mockResolvedValue({
        success: true,
        relationships: {
          '2': 'ACTIVE',
          '3': 'following',
          '4': 'PENDING',
          '5': 'INCOMING_PENDING',
          '6': 'NONE',
          '7': 'SOMETHING_NEW',
          '8': objectState,
        },
      });

      const result = await store().lookupRelationships([1, 2, 3, 4, 5, 6, 7, 8, 9]);

      expect(post).toHaveBeenCalledWith('/relationships/lookup', {
        target_ids: [2, 3, 4, 5, 6, 7, 8, 9],
      });
      expect(result).toEqual({
        '1': makeRelationship({ followed_by: true }),
        '2': makeRelationship({ following: true }),
        '3': makeRelationship({ following: true }),
        '4': makeRelationship({ pending: true }),
        '5': makeRelationship({ incoming_pending: true }),
        '6': makeRelationship(),
        '7': makeRelationship(),
        '8': objectState,
      });
      expect(store().getRelationship(4)).toEqual(makeRelationship({ pending: true }));
    });

    it('returns an empty map when the lookup fails', async () => {
      post.mockResolvedValueOnce({ success: false });
      await expect(store().lookupRelationships([2])).resolves.toEqual({});

      const error = new Error('Server error');
      post.mockRejectedValueOnce(error);
      await expect(store().lookupRelationships([2])).resolves.toEqual({});
      expect(consoleError).toHaveBeenCalledWith('Failed to lookup relationships:', error);
    });
  });

  describe('cache management', () => {
    it('stores and reads relationships and counts', () => {
      store().setRelationship(3, makeRelationship({ pending: true }));
      store().setCounts(3, { followers: 1, following: 2 });

      expect(store().getRelationship(3)).toEqual(makeRelationship({ pending: true }));
      expect(store().counts['3']).toEqual({ followers: 1, following: 2 });
      expect(store().getRelationship(4)).toBeUndefined();
    });

    it('invalidateCache forgets one user', () => {
      store().setRelationship(3, makeRelationship());
      store().setCounts(3, { followers: 1, following: 2 });
      store().setRelationship(4, makeRelationship());

      store().invalidateCache(3);

      expect(store().relationships).toEqual({ '4': makeRelationship() });
      expect(store().counts).toEqual({});
    });

    it('clearCache forgets everyone but keeps the request badge', () => {
      store().setRelationship(3, makeRelationship());
      store().setCounts(3, { followers: 1, following: 2 });
      store().setPendingRequestsCount(5);

      store().clearCache();

      expect(store()).toMatchObject({ relationships: {}, counts: {}, pendingRequestsCount: 5 });
    });

    it('never lets the pending request count go below zero', () => {
      store().setPendingRequestsCount(1);
      store().decrementPendingRequests();
      store().decrementPendingRequests();

      expect(store().pendingRequestsCount).toBe(0);
    });
  });

  describe('selector hooks', () => {
    it('follow relationship, counts and pending requests', () => {
      const relationship = renderHook(() => useRelationship(3));
      const counts = renderHook(() => useFollowCounts(3));
      const pending = renderHook(() => usePendingRequestsCount());

      expect(relationship.result.current).toBeUndefined();
      expect(counts.result.current).toBeUndefined();
      expect(pending.result.current).toBe(0);

      act(() => {
        store().setRelationship(3, makeRelationship({ following: true }));
        store().setCounts(3, { followers: 8, following: 1 });
        store().setPendingRequestsCount(2);
      });

      expect(relationship.result.current).toEqual(makeRelationship({ following: true }));
      expect(counts.result.current).toEqual({ followers: 8, following: 1 });
      expect(pending.result.current).toBe(2);
    });
  });
});
