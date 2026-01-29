/**
 * Follow Store
 *
 * Global state management for the social follow system using Zustand.
 * Manages follow relationships, counts, and pending requests.
 */

import { create } from 'zustand';

import { API_ROUTES } from '../constants';
import { api } from '../services/api';
import type {
  FollowActionResponse,
  FollowCounts,
  FollowCountsResponse,
  FollowListResponse,
  FollowRequestsResponse,
  MutualsResponse,
  RelationshipLookupResponse,
  RelationshipState,
} from '../types/follow';

// ============================================================================
// Store Types
// ============================================================================

interface FollowState {
  // Cached relationship states (keyed by string-converted userId)
  relationships: Record<string, RelationshipState>;

  // Cached follow counts (keyed by string-converted userId)
  counts: Record<string, FollowCounts>;

  // Pending follow requests count for current user
  pendingRequestsCount: number;

  // Loading states - per user to prevent race conditions
  loadingActions: Set<string>;

  // Global loading indicator (true if any action in progress)
  isLoading: boolean;

  // Actions
  followUser: (userId: number, isPrivate: boolean) => Promise<FollowActionResponse>;
  unfollowUser: (userId: number) => Promise<FollowActionResponse>;
  cancelRequest: (userId: number) => Promise<FollowActionResponse>;
  acceptRequest: (userId: number) => Promise<FollowActionResponse>;
  declineRequest: (userId: number) => Promise<FollowActionResponse>;
  removeFollower: (userId: number) => Promise<FollowActionResponse>;

  // Data fetching
  getFollowers: (userId: number, cursor?: string, limit?: number) => Promise<FollowListResponse>;
  getFollowing: (userId: number, cursor?: string, limit?: number) => Promise<FollowListResponse>;
  getIncomingRequests: (cursor?: string, limit?: number) => Promise<FollowRequestsResponse>;
  getMutuals: (userId: number, cursor?: string, limit?: number) => Promise<MutualsResponse>;
  getCounts: (userId: number) => Promise<FollowCounts | null>;
  lookupRelationships: (userIds: number[]) => Promise<Record<string, RelationshipState>>;

  // Cache management
  setRelationship: (userId: number, state: RelationshipState) => void;
  setCounts: (userId: number, counts: FollowCounts) => void;
  getRelationship: (userId: number) => RelationshipState | undefined;
  invalidateCache: (userId: number) => void;
  clearCache: () => void;

  // Request count management
  setPendingRequestsCount: (count: number) => void;
  decrementPendingRequests: () => void;

  // Loading state helpers
  isActionLoading: (userId: number, action: string) => boolean;
}

// ============================================================================
// Default Relationship State
// ============================================================================

const defaultRelationshipState: RelationshipState = {
  following: false,
  followed_by: false,
  pending: false,
  incoming_pending: false,
  is_mutual: false,
};

// Helper to convert backend state string to RelationshipState
const stateStringToRelationship = (
  state: string | undefined,
  existingState?: RelationshipState
): RelationshipState => {
  const base = existingState || defaultRelationshipState;

  switch (state?.toUpperCase()) {
    case 'ACTIVE':
    case 'FOLLOWING':
      return {
        ...base,
        following: true,
        pending: false,
        incoming_pending: false,
      };
    case 'PENDING':
    case 'REQUESTED':
      return {
        ...base,
        following: false,
        pending: true,
        incoming_pending: false,
      };
    case 'INCOMING_PENDING':
      return {
        ...base,
        following: false,
        pending: false,
        incoming_pending: true,
      };
    case 'REMOVED':
    case 'NONE':
    default:
      return {
        ...base,
        following: false,
        pending: false,
        incoming_pending: false,
      };
  }
};

// ============================================================================
// Store Implementation
// ============================================================================

export const useFollowStore = create<FollowState>((set, get) => ({
  relationships: {},
  counts: {},
  pendingRequestsCount: 0,
  loadingActions: new Set<string>(),
  isLoading: false,

  // Helper to check if specific action is loading
  isActionLoading: (userId: number, action: string) => {
    return get().loadingActions.has(`${userId}:${action}`);
  },

  // ============================================================================
  // Follow Actions
  // ============================================================================

  followUser: async (userId: number, isPrivate: boolean) => {
    const actionKey = `${userId}:follow`;
    set((state) => {
      const newLoadingActions = new Set(state.loadingActions);
      newLoadingActions.add(actionKey);
      return { loadingActions: newLoadingActions, isLoading: true };
    });

    try {
      const response = await api.post<FollowActionResponse>(API_ROUTES.FOLLOW.FOLLOW_USER(userId));

      if (response.success) {
        // Convert backend state to RelationshipState
        const newState =
          response.new_state ||
          stateStringToRelationship(response.state, get().getRelationship(userId));
        get().setRelationship(userId, newState);

        // Update counts if provided
        if (response.updated_counts) {
          get().setCounts(userId, response.updated_counts);
        }

        // Return with computed new_state
        return { ...response, new_state: newState };
      }

      return response;
    } catch (error) {
      console.error('Failed to follow user:', error);
      return {
        success: false,
        action: isPrivate ? 'requested' : 'followed',
        new_state: get().getRelationship(userId) || defaultRelationshipState,
        error: error instanceof Error ? error.message : 'Failed to follow user',
      } as FollowActionResponse;
    } finally {
      set((state) => {
        const newLoadingActions = new Set(state.loadingActions);
        newLoadingActions.delete(`${userId}:follow`);
        return { loadingActions: newLoadingActions, isLoading: newLoadingActions.size > 0 };
      });
    }
  },

  unfollowUser: async (userId: number) => {
    const actionKey = `${userId}:unfollow`;
    set((state) => {
      const newLoadingActions = new Set(state.loadingActions);
      newLoadingActions.add(actionKey);
      return { loadingActions: newLoadingActions, isLoading: true };
    });

    try {
      const response = await api.delete<FollowActionResponse>(
        API_ROUTES.FOLLOW.UNFOLLOW_USER(userId)
      );

      if (response.success) {
        // Convert backend state to RelationshipState
        const newState =
          response.new_state ||
          stateStringToRelationship(response.state || 'REMOVED', get().getRelationship(userId));
        get().setRelationship(userId, newState);

        if (response.updated_counts) {
          get().setCounts(userId, response.updated_counts);
        }
      }

      return response;
    } catch (error) {
      console.error('Failed to unfollow user:', error);
      return {
        success: false,
        action: 'unfollowed',
        new_state: get().getRelationship(userId) || defaultRelationshipState,
        error: error instanceof Error ? error.message : 'Failed to unfollow user',
      } as FollowActionResponse;
    } finally {
      set((state) => {
        const newLoadingActions = new Set(state.loadingActions);
        newLoadingActions.delete(`${userId}:unfollow`);
        return { loadingActions: newLoadingActions, isLoading: newLoadingActions.size > 0 };
      });
    }
  },

  cancelRequest: async (userId: number) => {
    const actionKey = `${userId}:cancel`;
    set((state) => {
      const newLoadingActions = new Set(state.loadingActions);
      newLoadingActions.add(actionKey);
      return { loadingActions: newLoadingActions, isLoading: true };
    });

    try {
      const response = await api.post<FollowActionResponse>(
        API_ROUTES.FOLLOW.CANCEL_REQUEST(userId)
      );

      if (response.success) {
        const newState =
          response.new_state ||
          stateStringToRelationship(response.state || 'REMOVED', get().getRelationship(userId));
        get().setRelationship(userId, newState);
      }

      return response;
    } catch (error) {
      console.error('Failed to cancel request:', error);
      return {
        success: false,
        action: 'cancelled',
        new_state: get().getRelationship(userId) || defaultRelationshipState,
        error: error instanceof Error ? error.message : 'Failed to cancel request',
      } as FollowActionResponse;
    } finally {
      set((state) => {
        const newLoadingActions = new Set(state.loadingActions);
        newLoadingActions.delete(`${userId}:cancel`);
        return { loadingActions: newLoadingActions, isLoading: newLoadingActions.size > 0 };
      });
    }
  },

  acceptRequest: async (userId: number) => {
    const actionKey = `${userId}:accept`;
    set((state) => {
      const newLoadingActions = new Set(state.loadingActions);
      newLoadingActions.add(actionKey);
      return { loadingActions: newLoadingActions, isLoading: true };
    });

    try {
      const response = await api.post<FollowActionResponse>(
        API_ROUTES.FOLLOW.ACCEPT_REQUEST(userId)
      );

      if (response.success) {
        // When accepting, they become a follower (followed_by = true)
        const existingState = get().getRelationship(userId);
        const newState: RelationshipState = {
          ...(existingState || defaultRelationshipState),
          followed_by: true,
          incoming_pending: false,
          is_mutual: existingState?.following || false,
        };
        get().setRelationship(userId, newState);
        get().decrementPendingRequests();
      }

      return response;
    } catch (error) {
      console.error('Failed to accept request:', error);
      return {
        success: false,
        action: 'accepted',
        new_state: get().getRelationship(userId) || defaultRelationshipState,
        error: error instanceof Error ? error.message : 'Failed to accept request',
      } as FollowActionResponse;
    } finally {
      set((state) => {
        const newLoadingActions = new Set(state.loadingActions);
        newLoadingActions.delete(`${userId}:accept`);
        return { loadingActions: newLoadingActions, isLoading: newLoadingActions.size > 0 };
      });
    }
  },

  declineRequest: async (userId: number) => {
    const actionKey = `${userId}:decline`;
    set((state) => {
      const newLoadingActions = new Set(state.loadingActions);
      newLoadingActions.add(actionKey);
      return { loadingActions: newLoadingActions, isLoading: true };
    });

    try {
      const response = await api.post<FollowActionResponse>(
        API_ROUTES.FOLLOW.DECLINE_REQUEST(userId)
      );

      if (response.success) {
        // When declining, remove the incoming pending
        const existingState = get().getRelationship(userId);
        const newState: RelationshipState = {
          ...(existingState || defaultRelationshipState),
          incoming_pending: false,
        };
        get().setRelationship(userId, newState);
        get().decrementPendingRequests();
      }

      return response;
    } catch (error) {
      console.error('Failed to decline request:', error);
      return {
        success: false,
        action: 'declined',
        new_state: get().getRelationship(userId) || defaultRelationshipState,
        error: error instanceof Error ? error.message : 'Failed to decline request',
      } as FollowActionResponse;
    } finally {
      set((state) => {
        const newLoadingActions = new Set(state.loadingActions);
        newLoadingActions.delete(`${userId}:decline`);
        return { loadingActions: newLoadingActions, isLoading: newLoadingActions.size > 0 };
      });
    }
  },

  removeFollower: async (userId: number) => {
    const actionKey = `${userId}:remove`;
    set((state) => {
      const newLoadingActions = new Set(state.loadingActions);
      newLoadingActions.add(actionKey);
      return { loadingActions: newLoadingActions, isLoading: true };
    });

    try {
      const response = await api.delete<FollowActionResponse>(
        API_ROUTES.FOLLOW.REMOVE_FOLLOWER(userId)
      );

      if (response.success) {
        // When removing a follower, update their relationship state
        const existingState = get().getRelationship(userId);
        const newState: RelationshipState = {
          ...(existingState || defaultRelationshipState),
          followed_by: false,
          is_mutual: false,
        };
        get().setRelationship(userId, newState);
      }

      return response;
    } catch (error) {
      console.error('Failed to remove follower:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to remove follower',
      } as FollowActionResponse;
    } finally {
      set((state) => {
        const newLoadingActions = new Set(state.loadingActions);
        newLoadingActions.delete(`${userId}:remove`);
        return { loadingActions: newLoadingActions, isLoading: newLoadingActions.size > 0 };
      });
    }
  },

  // ============================================================================
  // Data Fetching
  // ============================================================================

  getFollowers: async (userId: number, cursor?: string, limit = 20) => {
    try {
      const params = new URLSearchParams();
      if (cursor) params.set('cursor', cursor);
      params.set('limit', limit.toString());

      const url = `${API_ROUTES.FOLLOW.GET_FOLLOWERS(userId)}?${params.toString()}`;
      const response = await api.get<FollowListResponse>(url);

      // Cache relationship states for returned users
      if (response.success && response.users) {
        response.users.forEach((user) => {
          if (user.relationship_state) {
            get().setRelationship(user.id, user.relationship_state);
          }
        });
      }

      return response;
    } catch (error) {
      console.error('Failed to get followers:', error);
      return {
        success: false,
        users: [],
        total_count: 0,
        error: error instanceof Error ? error.message : 'Failed to get followers',
      };
    }
  },

  getFollowing: async (userId: number, cursor?: string, limit = 20) => {
    try {
      const params = new URLSearchParams();
      if (cursor) params.set('cursor', cursor);
      params.set('limit', limit.toString());

      const url = `${API_ROUTES.FOLLOW.GET_FOLLOWING(userId)}?${params.toString()}`;
      const response = await api.get<FollowListResponse>(url);

      // Cache relationship states for returned users
      if (response.success && response.users) {
        response.users.forEach((user) => {
          if (user.relationship_state) {
            get().setRelationship(user.id, user.relationship_state);
          }
        });
      }

      return response;
    } catch (error) {
      console.error('Failed to get following:', error);
      return {
        success: false,
        users: [],
        total_count: 0,
        error: error instanceof Error ? error.message : 'Failed to get following',
      };
    }
  },

  getIncomingRequests: async (cursor?: string, limit = 20) => {
    try {
      const params = new URLSearchParams();
      if (cursor) params.set('cursor', cursor);
      params.set('limit', limit.toString());

      const url = `${API_ROUTES.FOLLOW.INCOMING_REQUESTS}?${params.toString()}`;
      const response = await api.get<FollowRequestsResponse>(url);

      // Update pending requests count
      if (response.success) {
        set({ pendingRequestsCount: response.total_count });
      }

      return response;
    } catch (error) {
      console.error('Failed to get incoming requests:', error);
      return {
        success: false,
        requests: [],
        total_count: 0,
        error: error instanceof Error ? error.message : 'Failed to get requests',
      };
    }
  },

  getMutuals: async (userId: number, cursor?: string, limit = 20) => {
    try {
      const params = new URLSearchParams();
      if (cursor) params.set('cursor', cursor);
      params.set('limit', limit.toString());

      const url = `${API_ROUTES.FOLLOW.GET_MUTUALS(userId)}?${params.toString()}`;
      const response = await api.get<MutualsResponse>(url);

      return response;
    } catch (error) {
      console.error('Failed to get mutuals:', error);
      return {
        success: false,
        users: [],
        has_more: false,
        error: error instanceof Error ? error.message : 'Failed to get mutuals',
      };
    }
  },

  getCounts: async (userId: number) => {
    try {
      // Check cache first
      const cached = get().counts[userId.toString()];
      if (cached) return cached;

      const response = await api.get<FollowCountsResponse>(API_ROUTES.FOLLOW.GET_COUNTS(userId));

      if (response.success && response.counts) {
        // Map API response to frontend format
        const counts: FollowCounts = {
          followers: response.counts.followers_count,
          following: response.counts.following_count,
        };
        get().setCounts(userId, counts);
        return counts;
      }

      return null;
    } catch (error) {
      console.error('Failed to get counts:', error);
      return null;
    }
  },

  lookupRelationships: async (userIds: number[]) => {
    try {
      // Filter out already cached relationships
      const uncachedIds = userIds.filter((id) => !get().relationships[id.toString()]);

      if (uncachedIds.length === 0) {
        // All cached, return from cache
        const result: Record<string, RelationshipState> = {};
        userIds.forEach((id) => {
          const state = get().relationships[id.toString()];
          if (state) result[id.toString()] = state;
        });
        return result;
      }

      const response = await api.post<RelationshipLookupResponse>(
        API_ROUTES.FOLLOW.LOOKUP_RELATIONSHIPS,
        { target_ids: uncachedIds }
      );

      if (response.success && response.relationships) {
        // Cache the results - convert string state to RelationshipState object
        Object.entries(response.relationships).forEach(([id, state]) => {
          const relationshipState =
            typeof state === 'string' ? stateStringToRelationship(state) : state;
          get().setRelationship(parseInt(id, 10), relationshipState);
        });

        // Return all requested relationships (including previously cached)
        const result: Record<string, RelationshipState> = {};
        userIds.forEach((id) => {
          const state = get().relationships[id.toString()];
          if (state) result[id.toString()] = state;
        });
        return result;
      }

      return {};
    } catch (error) {
      console.error('Failed to lookup relationships:', error);
      return {};
    }
  },

  // ============================================================================
  // Cache Management
  // ============================================================================

  setRelationship: (userId: number, state: RelationshipState) => {
    set((s) => ({
      relationships: {
        ...s.relationships,
        [userId.toString()]: state,
      },
    }));
  },

  setCounts: (userId: number, counts: FollowCounts) => {
    set((s) => ({
      counts: {
        ...s.counts,
        [userId.toString()]: counts,
      },
    }));
  },

  getRelationship: (userId: number) => {
    return get().relationships[userId.toString()];
  },

  invalidateCache: (userId: number) => {
    set((s) => {
      const newRelationships = { ...s.relationships };
      const newCounts = { ...s.counts };
      delete newRelationships[userId.toString()];
      delete newCounts[userId.toString()];
      return { relationships: newRelationships, counts: newCounts };
    });
  },

  clearCache: () => {
    set({
      relationships: {},
      counts: {},
    });
  },

  // ============================================================================
  // Request Count Management
  // ============================================================================

  setPendingRequestsCount: (count: number) => {
    set({ pendingRequestsCount: count });
  },

  decrementPendingRequests: () => {
    set((s) => ({
      pendingRequestsCount: Math.max(0, s.pendingRequestsCount - 1),
    }));
  },
}));

// ============================================================================
// Selector Hooks
// ============================================================================

export const useRelationship = (userId: number) => {
  return useFollowStore((state) => state.relationships[userId.toString()]);
};

export const useFollowCounts = (userId: number) => {
  return useFollowStore((state) => state.counts[userId.toString()]);
};

export const usePendingRequestsCount = () => {
  return useFollowStore((state) => state.pendingRequestsCount);
};
