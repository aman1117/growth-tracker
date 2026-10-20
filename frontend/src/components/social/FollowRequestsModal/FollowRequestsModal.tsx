/**
 * FollowRequestsModal Component
 *
 * Modal for managing incoming follow requests.
 * Uses shared styling for consistency with other follow modals.
 */

import { AlertCircle, AlertTriangle, Loader2, UserPlus } from 'lucide-react';
import React, { useCallback, useState } from 'react';

import { useInfiniteScrollModal } from '../../../hooks/useInfiniteScrollModal';
import { useOverlayAwareNavigate } from '../../../hooks/useOverlayAwareNavigate';
import { useFollowStore } from '../../../store';
import type { FollowRequestsModalProps, FollowUser } from '../../../types/follow';
import { Avatar, Button, EmptyState, Skeleton, VerifiedBadge } from '../../ui';
import { Modal } from '../../ui/Modal';
import styles from '../shared/ModalList.module.css';

const SKELETON_ROWS = 3;

interface RequestCardProps {
  user: FollowUser;
  onAccept: () => void;
  onDecline: () => void;
  onUserClick: () => void;
  processing: 'accept' | 'decline' | null;
}

/**
 * RequestCard - Concise horizontal request row with accept/decline buttons
 */
const RequestCard: React.FC<RequestCardProps> = ({
  user,
  onAccept,
  onDecline,
  onUserClick,
  processing,
}) => {
  const isProcessing = processing !== null;

  return (
    <div className={styles.card}>
      <button type="button" className={styles.identity} onClick={onUserClick}>
        <Avatar
          src={user.profile_pic}
          thumbnailSrc={user.profile_pic_thumb}
          name={user.username}
          size="md"
        />
        <span className={styles.userInfo}>
          <span className={styles.username}>
            <span className={styles.usernameText}>{user.username}</span>
            {user.is_verified && <VerifiedBadge size={13} />}
          </span>
          <span className={styles.secondaryText}>Wants to follow you</span>
        </span>
      </button>

      <div className={styles.actions}>
        <Button
          variant="primary"
          size="xs"
          onClick={onAccept}
          disabled={isProcessing}
          loading={processing === 'accept'}
          aria-label={`Accept ${user.username}`}
        >
          Accept
        </Button>
        <Button
          variant="glass"
          size="xs"
          onClick={onDecline}
          disabled={isProcessing}
          loading={processing === 'decline'}
          aria-label={`Decline ${user.username}`}
        >
          Decline
        </Button>
      </div>
    </div>
  );
};

export const FollowRequestsModal: React.FC<FollowRequestsModalProps> = ({
  isOpen,
  onClose,
  onRequestHandled,
}) => {
  const navigate = useOverlayAwareNavigate();
  const { getIncomingRequests, acceptRequest, declineRequest } = useFollowStore();
  const [processing, setProcessing] = useState<Map<number, 'accept' | 'decline'>>(new Map());
  const [actionError, setActionError] = useState<string | null>(null);

  // Fetch function for the infinite scroll hook
  const fetchRequests = useCallback(
    async (cursor?: string) => {
      const response = await getIncomingRequests(cursor);

      if (!response.success) {
        throw new Error(response.error || 'Failed to load requests');
      }

      return {
        items: response.requests || [],
        nextCursor: response.next_cursor,
        totalCount: response.total_count,
      };
    },
    [getIncomingRequests]
  );

  // Use the shared infinite scroll hook
  const {
    items: requests,
    isLoading,
    isLoadingMore,
    error,
    loadMoreRef,
    refetch,
    removeItem,
    totalCount,
  } = useInfiniteScrollModal<FollowUser>({
    isOpen,
    fetchFn: fetchRequests,
  });

  const setProcessingFor = (userId: number, action: 'accept' | 'decline' | null) =>
    setProcessing((prev) => {
      const next = new Map(prev);
      if (action) next.set(userId, action);
      else next.delete(userId);
      return next;
    });

  // Accept or decline a request; failures keep the row and explain what happened
  const handleRespond = async (user: FollowUser, action: 'accept' | 'decline') => {
    setActionError(null);
    setProcessingFor(user.id, action);

    try {
      const response =
        action === 'accept' ? await acceptRequest(user.id) : await declineRequest(user.id);
      if (response.success) {
        removeItem(user.id);
        onRequestHandled?.();
      } else {
        console.warn('[Social] Follow request response rejected', { action });
        setActionError(`Couldn't ${action} ${user.username}'s request. Try again.`);
      }
    } catch (err) {
      console.error(`[Social] Failed to ${action} follow request`, err);
      setActionError(`Couldn't ${action} ${user.username}'s request. Try again.`);
    } finally {
      setProcessingFor(user.id, null);
    }
  };

  const handleClose = () => {
    setActionError(null);
    onClose();
  };

  // Navigate to user profile
  const handleUserClick = (username: string) => {
    handleClose();
    navigate(`/user/${username}`);
  };

  const subtitle =
    totalCount > 0
      ? `${totalCount.toLocaleString()} waiting for your answer`
      : 'People who want to follow you';

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Follow requests"
      subtitle={isLoading ? 'People who want to follow you' : subtitle}
      icon={
        <span className={`${styles.headerIcon} ${styles.tonePink}`}>
          <UserPlus size={20} strokeWidth={2.3} />
        </span>
      }
      maxWidth="420px"
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
                  <Skeleton width={`${50 - i * 8}%`} height={12} radius="full" />
                  <Skeleton width="40%" height={10} radius="full" />
                </div>
                <Skeleton width={128} height={30} radius="full" />
              </div>
            ))}

          {/* Error state */}
          {error && !isLoading && (
            <div className={styles.stateWrap}>
              <EmptyState
                size="sm"
                icon={<AlertTriangle size={24} />}
                title="Couldn't load requests"
                description="Check your connection and try again."
                action={{ label: 'Try again', onClick: refetch, variant: 'secondary' }}
              />
            </div>
          )}

          {/* Empty state */}
          {!isLoading && !error && requests.length === 0 && (
            <div className={styles.stateWrap}>
              <EmptyState
                size="sm"
                icon={<UserPlus size={24} />}
                title="You're all caught up"
                description="When someone asks to follow you, you'll see it here."
              />
            </div>
          )}

          {/* Request list */}
          {!isLoading && !error && requests.length > 0 && (
            <>
              {requests.map((user) => (
                <RequestCard
                  key={user.id}
                  user={user}
                  onAccept={() => handleRespond(user, 'accept')}
                  onDecline={() => handleRespond(user, 'decline')}
                  onUserClick={() => handleUserClick(user.username)}
                  processing={processing.get(user.id) ?? null}
                />
              ))}

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
  );
};

export default FollowRequestsModal;
