/**
 * FollowListModal Component
 *
 * Modal for displaying followers, following, or mutual lists.
 * Uses shared styling and infinite scroll hook for consistency.
 */

import React, { useState, useCallback } from 'react';
import { Users, UserCheck, Heart, Loader2, AlertCircle } from 'lucide-react';
import { Modal } from '../../ui/Modal';
import { UserCard } from '../UserCard';
import { useFollowStore, useAuth } from '../../../store';
import { useInfiniteScrollModal } from '../../../hooks/useInfiniteScrollModal';
import type { FollowUser, FollowListModalProps, RelationshipState } from '../../../types/follow';
import styles from '../shared/ModalList.module.css';

// Modal configuration by type
const MODAL_CONFIG = {
  followers: {
    icon: Users,
    getTitle: (username: string) => `${username}'s Followers`,
    emptyMessage: 'No followers yet',
  },
  following: {
    icon: UserCheck,
    getTitle: (username: string) => `${username} is Following`,
    emptyMessage: 'Not following anyone yet',
  },
  mutuals: {
    icon: Heart,
    getTitle: (username: string) => `Mutual Friends with ${username}`,
    emptyMessage: 'No mutual friends',
  },
} as const;

// Default relationship state
const DEFAULT_RELATIONSHIP: RelationshipState = {
  following: false,
  followed_by: false,
  pending: false,
  incoming_pending: false,
  is_mutual: false,
};

export const FollowListModal: React.FC<FollowListModalProps> = ({
  isOpen,
  onClose,
  userId,
  username,
  type,
  title,
}) => {
  const { user: currentUser } = useAuth();
  const { getFollowers, getFollowing, getMutuals, removeFollower, lookupRelationships } = useFollowStore();
  const [removingUserId, setRemovingUserId] = useState<number | null>(null);

  const config = MODAL_CONFIG[type];
  const Icon = config.icon;
  const isOwnList = currentUser?.id === userId;

  // Infer relationship state based on list type when API doesn't provide it
  const inferRelationshipState = useCallback((listType: typeof type): RelationshipState => {
    if (!isOwnList) {
      return DEFAULT_RELATIONSHIP;
    }
    
    switch (listType) {
      case 'following':
        return { ...DEFAULT_RELATIONSHIP, following: true };
      case 'followers':
        return { ...DEFAULT_RELATIONSHIP, followed_by: true };
      case 'mutuals':
        return { ...DEFAULT_RELATIONSHIP, following: true, followed_by: true, is_mutual: true };
      default:
        return DEFAULT_RELATIONSHIP;
    }
  }, [isOwnList]);

  // Fetch function for the infinite scroll hook
  const fetchUsers = useCallback(async (cursor?: string) => {
    let response;
    
    switch (type) {
      case 'followers':
        response = await getFollowers(userId, cursor);
        break;
      case 'following':
        response = await getFollowing(userId, cursor);
        break;
      case 'mutuals':
        response = await getMutuals(userId, cursor);
        break;
    }

    if (!response.success) {
      throw new Error(response.error || 'Failed to load');
    }

    const userList = response.users || [];
    
    // Bulk lookup relationships for all users in the list
    const userIds = userList
      .map((u: FollowUser) => u.id)
      .filter((id: number) => id !== currentUser?.id);
    
    let relationshipMap: Record<string, RelationshipState> = {};
    
    if (userIds.length > 0) {
      try {
        relationshipMap = await lookupRelationships(userIds);
      } catch (err) {
        console.warn('Failed to lookup relationships:', err);
        // Continue without relationship data - will use inferred state
      }
    }
    
    // Merge relationship states into user objects
    // Note: We clear incoming_pending flag so we only show Follow/Following button
    // Accept/Decline should only be shown in FollowRequestsModal
    const items = userList.map((user: FollowUser) => {
      const apiState = relationshipMap[String(user.id)] || user.relationship_state;
      const state = apiState || inferRelationshipState(type);
      return {
        ...user,
        relationship_state: {
          ...state,
          incoming_pending: false, // Don't show Accept/Decline in this list
        },
      };
    });

    return {
      items,
      nextCursor: response.next_cursor,
      totalCount: 'total_count' in response ? response.total_count : undefined,
    };
  }, [type, userId, currentUser?.id, getFollowers, getFollowing, getMutuals, lookupRelationships, inferRelationshipState]);

  // Use the shared infinite scroll hook
  const {
    items: users,
    isLoading,
    isLoadingMore,
    error,
    loadMoreRef,
    refetch,
    removeItem,
  } = useInfiniteScrollModal<FollowUser>({
    isOpen,
    fetchFn: fetchUsers,
    deps: [type, userId],
  });

  // Handle removing a follower
  const handleRemoveFollower = useCallback(async (followerId: number) => {
    setRemovingUserId(followerId);
    try {
      const result = await removeFollower(followerId);
      if (result.success) {
        removeItem(followerId);
      }
    } catch (err) {
      console.error('Failed to remove follower:', err);
    } finally {
      setRemovingUserId(null);
    }
  }, [removeFollower, removeItem]);

  const modalTitle = title || config.getTitle(username);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={modalTitle}
      maxWidth="360px"
    >
      <div className={styles.container}>
        <div className={styles.list}>
          {/* Loading state */}
          {isLoading && (
            <div className={styles.loadingState}>
              <Loader2 className={styles.spinner} size={24} />
              <span>Loading...</span>
            </div>
          )}

          {/* Error state */}
          {error && !isLoading && (
            <div className={styles.errorState}>
              <AlertCircle size={24} className={styles.errorIcon} />
              <span>{error}</span>
              <button onClick={refetch} className={styles.retryButton}>
                Try Again
              </button>
            </div>
          )}

          {/* Empty state */}
          {!isLoading && !error && users.length === 0 && (
            <div className={styles.emptyState}>
              <Icon size={32} className={styles.emptyIcon} />
              <span>{config.emptyMessage}</span>
            </div>
          )}

          {/* User list */}
          {!isLoading && !error && users.length > 0 && (
            <>
              {users.map((user) => {
                const showRemove = isOwnList && type === 'followers';
                return (
                  <UserCard
                    key={user.id}
                    user={user}
                    showFollowButton={true}
                    showRemoveButton={showRemove}
                    onRemove={handleRemoveFollower}
                    isRemoving={removingUserId === user.id}
                    onUserClick={onClose}
                  />
                );
              })}

              {/* Load more trigger */}
              <div ref={loadMoreRef} className={styles.loadMoreTrigger}>
                {isLoadingMore && (
                  <div className={styles.loadingMore}>
                    <Loader2 className={styles.spinner} size={18} />
                    <span>Loading more...</span>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
};

export default FollowListModal;
