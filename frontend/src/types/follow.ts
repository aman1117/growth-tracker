/**
 * Follow System Types
 *
 * Type definitions for the social follow/relationship system.
 */

// ============================================================================
// Follow State Types
// ============================================================================

/** Possible relationship states between users */
export type FollowState = 'NONE' | 'FOLLOWING' | 'PENDING' | 'FOLLOWED_BY' | 'MUTUAL';

/** Detailed relationship info returned from API */
export interface RelationshipState {
  /** Current user follows target */
  following: boolean;
  /** Target follows current user */
  followed_by: boolean;
  /** Pending follow request to target */
  pending: boolean;
  /** Incoming pending request from target */
  incoming_pending: boolean;
  /** Users follow each other */
  is_mutual: boolean;
}

// ============================================================================
// Follow User Types
// ============================================================================

/** User data in follow lists */
export interface FollowUser {
  id: number;
  username: string;
  display_name?: string | null;
  profile_pic?: string | null;
  bio?: string | null;
  is_verified: boolean;
  is_private: boolean;
  followed_at?: string;
  relationship_state?: RelationshipState;
}

/** Follow counts for a user profile */
export interface FollowCounts {
  followers: number;
  following: number;
}

/** Follow counts as returned by API (different naming) */
export interface FollowCountsAPI {
  followers_count: number;
  following_count: number;
}

// ============================================================================
// API Request Types
// ============================================================================

export interface FollowListRequest {
  cursor?: string;
  limit?: number;
}

export interface RelationshipLookupRequest {
  target_ids: number[];
}

// ============================================================================
// API Response Types
// ============================================================================

export interface FollowActionResponse {
  success: boolean;
  action?: 'followed' | 'requested' | 'unfollowed' | 'cancelled' | 'accepted' | 'declined';
  state?: string; // Backend returns "ACTIVE", "PENDING", "REMOVED"
  new_state?: RelationshipState;
  message?: string;
  updated_counts?: FollowCounts;
  error?: string;
  error_code?: string;
}

export interface FollowListResponse {
  success: boolean;
  users: FollowUser[];
  next_cursor?: string;
  has_more?: boolean;
  total_count?: number;
  error?: string;
}

export interface FollowRequestsResponse {
  success: boolean;
  requests: FollowUser[];
  next_cursor?: string;
  has_more?: boolean;
  total_count?: number;
  error?: string;
}

export interface RelationshipLookupResponse {
  success: boolean;
  relationships: Record<string, RelationshipState>;
  error?: string;
}

export interface MutualsResponse {
  success: boolean;
  users: FollowUser[];
  next_cursor?: string;
  has_more: boolean;
  error?: string;
}

export interface FollowCountsResponse {
  success: boolean;
  counts: FollowCountsAPI;
  error?: string;
}

// ============================================================================
// Component Props Types
// ============================================================================

export interface FollowButtonProps {
  userId: number;
  username: string;
  isPrivate: boolean;
  initialState?: RelationshipState;
  size?: 'sm' | 'md' | 'lg';
  fullWidth?: boolean;
  onStateChange?: (newState: RelationshipState) => void;
}

export interface FollowListModalProps {
  isOpen: boolean;
  onClose: () => void;
  userId: number;
  username: string;
  type: 'followers' | 'following' | 'mutuals';
  title?: string;
}

export interface FollowRequestsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onRequestHandled?: () => void;
}

export interface UserCardProps {
  user: FollowUser;
  showFollowButton?: boolean;
  showRemoveButton?: boolean;
  onRemove?: (userId: number) => void;
  isRemoving?: boolean;
  onUserClick?: (username: string) => void;
}
