/**
 * FollowListModal Component
 *
 * Modal for displaying followers, following, or mutual lists.
 * Uses shared styling and infinite scroll hook for consistency.
 */

import type { LucideIcon } from 'lucide-react';
import {
  AlertCircle,
  AlertTriangle,
  Heart,
  Loader2,
  UserCheck,
  UserMinus,
  Users,
} from 'lucide-react';
import React, { useCallback, useState } from 'react';

import { useInfiniteScrollModal } from '../../../hooks/useInfiniteScrollModal';
import { useAuth, useFollowStore } from '../../../store';
import type { FollowListModalProps, FollowUser, RelationshipState } from '../../../types/follow';
import { ConfirmDialog, EmptyState, Skeleton } from '../../ui';
import { Modal } from '../../ui/Modal';
import styles from '../shared/ModalList.module.css';
import { UserCard } from '../UserCard';

interface ListConfig {
  icon: LucideIcon;
  toneClass: string;
  title: string;
  emptyTitle: string;
  emptyOwn: string;
  emptyOther: (username: string) => string;
}

// Modal configuration by type
const MODAL_CONFIG: Record<FollowListModalProps['type'], ListConfig> = {
  followers: {
    icon: Users,
    toneClass: styles.toneViolet,
    title: 'Followers',
    emptyTitle: 'No followers yet',
    emptyOwn: 'When people follow you, they’ll show up here.',
    emptyOther: (username) => `When people follow @${username}, they’ll show up here.`,
  },
  following: {
    icon: UserCheck,
    toneClass: styles.toneTeal,
    title: 'Following',
    emptyTitle: 'Not following anyone yet',
    emptyOwn: 'Use search to find people to follow.',
    emptyOther: (username) => `@${username} isn’t following anyone yet.`,
  },
  mutuals: {
    icon: Heart,
    toneClass: styles.tonePink,
    title: 'Mutual friends',
    emptyTitle: 'No mutual friends',
    emptyOwn: 'No mutual friends yet.',
    emptyOther: (username) => `You and @${username} have no mutual friends yet.`,
  },
};

const SKELETON_ROWS = 5;
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
  const { getFollowers, getFollowing, getMutuals, removeFollower, lookupRelationships } =
    useFollowStore();
  const [removingUserId, setRemovingUserId] = useState<number | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<FollowUser | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const config = MODAL_CONFIG[type];
  const Icon = config.icon;
  const isOwnList = currentUser?.id === userId;

  // Infer relationship state based on list type when API doesn't provide it
  const inferRelationshipState = useCallback(
    (listType: typeof type): RelationshipState => {
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
    },
    [isOwnList]
  );

  // Fetch function for the infinite scroll hook
  const fetchUsers = useCallback(
    async (cursor?: string) => {
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
    },
    [
      type,
      userId,
      currentUser?.id,
      getFollowers,
      getFollowing,
      getMutuals,
      lookupRelationships,
      inferRelationshipState,
    ]
  );

  // Use the shared infinite scroll hook
  const {
    items: users,
    isLoading,
    isLoadingMore,
    error,
    loadMoreRef,
    refetch,
    removeItem,
    totalCount,
  } = useInfiniteScrollModal<FollowUser>({
    isOpen,
    fetchFn: fetchUsers,
    deps: [type, userId],
  });

  // Removing a follower is destructive, so it goes through a confirmation first
  const requestRemoveFollower = useCallback(
    (followerId: number) => {
      setActionError(null);
      setPendingRemoval(users.find((u) => u.id === followerId) ?? null);
    },
    [users]
  );

  const confirmRemoveFollower = useCallback(async () => {
    const target = pendingRemoval;
    if (!target) return;
    setRemovingUserId(target.id);
    try {
      const result = await removeFollower(target.id);
      if (result.success) {
        removeItem(target.id);
      } else {
        console.warn('[Social] Remove follower rejected', { error: result.error });
        setActionError(`Couldn't remove ${target.username}. Try again.`);
      }
    } catch (err) {
      console.error('[Social] Failed to remove follower', err);
      setActionError(`Couldn't remove ${target.username}. Try again.`);
    } finally {
      setRemovingUserId(null);
      setPendingRemoval(null);
    }
  }, [pendingRemoval, removeFollower, removeItem]);

  const handleClose = () => {
    setActionError(null);
    setPendingRemoval(null);
    onClose();
  };

  const modalTitle = title || config.title;
  const subtitle = `@${username}${totalCount > 0 ? ` · ${totalCount.toLocaleString()}` : ''}`;
  const emptyDescription = isOwnList ? config.emptyOwn : config.emptyOther(username);

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={handleClose}
        title={modalTitle}
        subtitle={subtitle}
        icon={
          <span className={`${styles.headerIcon} ${config.toneClass}`}>
            <Icon size={20} strokeWidth={2.3} />
          </span>
        }
        maxWidth="400px"
      >
        <div className={styles.container}>
          <div className={styles.list} aria-busy={isLoading}>
            {actionError && (
              <div className={styles.banner} role="alert">
                <AlertCircle size={16} strokeWidth={2.4} aria-hidden="true" />
                <span>{actionError}</span>
              </div>
            )}

            {/* Loading state */}
            {isLoading &&
              Array.from({ length: SKELETON_ROWS }, (_, i) => (
                <div key={i} className={styles.skeletonRow} aria-hidden="true">
                  <Skeleton width={40} height={40} radius="full" />
                  <div className={styles.skeletonText}>
                    <Skeleton width={`${55 - i * 6}%`} height={12} radius="full" />
                    <Skeleton width="30%" height={10} radius="full" />
                  </div>
                  <Skeleton width={84} height={30} radius="full" />
                </div>
              ))}

            {/* Error state */}
            {error && !isLoading && (
              <div className={styles.stateWrap}>
                <EmptyState
                  size="sm"
                  icon={<AlertTriangle size={24} />}
                  title="Couldn't load this list"
                  description="Check your connection and try again."
                  action={{ label: 'Try again', onClick: refetch, variant: 'secondary' }}
                />
              </div>
            )}

            {/* Empty state */}
            {!isLoading && !error && users.length === 0 && (
              <div className={styles.stateWrap}>
                <EmptyState
                  size="sm"
                  icon={<Icon size={24} />}
                  title={config.emptyTitle}
                  description={emptyDescription}
                />
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
                      onRemove={requestRemoveFollower}
                      isRemoving={removingUserId === user.id}
                      onUserClick={handleClose}
                    />
                  );
                })}

                {/* Load more trigger */}
                <div ref={loadMoreRef} className={styles.loadMoreTrigger}>
                  {isLoadingMore && (
                    <div className={styles.loadingMore} role="status">
                      <Loader2 className={styles.spinner} size={18} aria-hidden="true" />
                      <span>Loading more…</span>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        isOpen={!!pendingRemoval}
        title={pendingRemoval ? `Remove ${pendingRemoval.username}?` : 'Remove follower?'}
        description="They'll be removed from your followers. They can follow you again later."
        icon={<UserMinus size={24} strokeWidth={2.25} />}
        tone="danger"
        confirmLabel="Remove"
        cancelLabel="Cancel"
        loading={removingUserId !== null}
        onConfirm={confirmRemoveFollower}
        onCancel={() => setPendingRemoval(null)}
      />
    </>
  );
};
export default FollowListModal;
