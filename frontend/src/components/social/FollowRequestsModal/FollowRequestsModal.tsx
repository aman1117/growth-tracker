/**
 * FollowRequestsModal Component
 *
 * Modal for managing incoming follow requests.
 * Uses shared styling for consistency with other follow modals.
 */

import { AlertCircle, Bell, Loader2 } from 'lucide-react';
import React, { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useInfiniteScrollModal } from '../../../hooks/useInfiniteScrollModal';
import { useFollowStore } from '../../../store';
import type { FollowRequestsModalProps, FollowUser } from '../../../types/follow';
import { Avatar, VerifiedBadge } from '../../ui';
import { Modal } from '../../ui/Modal';
import styles from '../shared/ModalList.module.css';

interface RequestCardProps {
  user: FollowUser;
  onAccept: () => void;
  onDecline: () => void;
  onUserClick: () => void;
  isProcessing: boolean;
}

/**
 * RequestCard - Concise horizontal request row with accept/decline buttons
 */
const RequestCard: React.FC<RequestCardProps> = ({
  user,
  onAccept,
  onDecline,
  onUserClick,
  isProcessing,
}) => {
  return (
    <div className={styles.card}>
      <Avatar src={user.profile_pic} name={user.username} size="sm" className={styles.avatar} />

      <div className={styles.userInfo} onClick={onUserClick} style={{ cursor: 'pointer' }}>
        <span className={styles.username}>
          {user.username}
          {user.is_verified && <VerifiedBadge size={12} />}
        </span>
      </div>

      <div className={styles.actions}>
        <button
          className={styles.primaryButton}
          onClick={(e) => {
            e.stopPropagation();
            onAccept();
          }}
          disabled={isProcessing}
        >
          {isProcessing ? <Loader2 className={styles.spinner} size={14} /> : 'Accept'}
        </button>
        <button
          className={styles.secondaryButton}
          onClick={(e) => {
            e.stopPropagation();
            onDecline();
          }}
          disabled={isProcessing}
        >
          Decline
        </button>
      </div>
    </div>
  );
};

export const FollowRequestsModal: React.FC<FollowRequestsModalProps> = ({
  isOpen,
  onClose,
  onRequestHandled,
}) => {
  const navigate = useNavigate();
  const { getIncomingRequests, acceptRequest, declineRequest } = useFollowStore();
  const [processingIds, setProcessingIds] = useState<Set<number>>(new Set());

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
  } = useInfiniteScrollModal<FollowUser>({
    isOpen,
    fetchFn: fetchRequests,
  });

  // Handle accept request
  const handleAccept = useCallback(
    async (userId: number) => {
      setProcessingIds((prev) => new Set(prev).add(userId));

      try {
        const response = await acceptRequest(userId);
        if (response.success) {
          removeItem(userId);
          onRequestHandled?.();
        }
      } catch (err) {
        console.error('Failed to accept request:', err);
      } finally {
        setProcessingIds((prev) => {
          const next = new Set(prev);
          next.delete(userId);
          return next;
        });
      }
    },
    [acceptRequest, removeItem, onRequestHandled]
  );

  // Handle decline request
  const handleDecline = useCallback(
    async (userId: number) => {
      setProcessingIds((prev) => new Set(prev).add(userId));

      try {
        const response = await declineRequest(userId);
        if (response.success) {
          removeItem(userId);
          onRequestHandled?.();
        }
      } catch (err) {
        console.error('Failed to decline request:', err);
      } finally {
        setProcessingIds((prev) => {
          const next = new Set(prev);
          next.delete(userId);
          return next;
        });
      }
    },
    [declineRequest, removeItem, onRequestHandled]
  );

  // Navigate to user profile
  const handleUserClick = useCallback(
    (username: string) => {
      onClose();
      navigate(`/user/${username}`);
    },
    [onClose, navigate]
  );

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Follow Requests" maxWidth="360px">
      <div className={styles.container}>
        <div className={styles.list}>
          {/* Loading state */}
          {isLoading && (
            <div className={styles.loadingState}>
              <Loader2 className={styles.spinner} size={24} />
              <span>Loading requests...</span>
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
          {!isLoading && !error && requests.length === 0 && (
            <div className={styles.emptyState}>
              <Bell size={32} className={styles.emptyIcon} />
              <span>No pending requests</span>
              <span style={{ fontSize: '0.75rem', opacity: 0.7 }}>
                When someone requests to follow you, you'll see it here.
              </span>
            </div>
          )}

          {/* Request list */}
          {!isLoading && !error && requests.length > 0 && (
            <>
              {requests.map((user) => (
                <RequestCard
                  key={user.id}
                  user={user}
                  onAccept={() => handleAccept(user.id)}
                  onDecline={() => handleDecline(user.id)}
                  onUserClick={() => handleUserClick(user.username)}
                  isProcessing={processingIds.has(user.id)}
                />
              ))}

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

export default FollowRequestsModal;
