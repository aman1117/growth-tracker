/**
 * FollowButton Component
 *
 * Clean Instagram-style follow button with state management.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Loader2 } from 'lucide-react';
import { useFollowStore, useRelationship, useAuth } from '../../../store';
import type { RelationshipState, FollowButtonProps } from '../../../types/follow';
import styles from './FollowButton.module.css';

export const FollowButton: React.FC<FollowButtonProps> = ({
  userId,
  username: _username,
  isPrivate,
  initialState,
  size = 'md',
  fullWidth = false,
  onStateChange,
}) => {
  const { user } = useAuth();
  const cachedState = useRelationship(userId);
  const { followUser, unfollowUser, cancelRequest, acceptRequest, declineRequest, setRelationship } = useFollowStore();
  
  const [isLoading, setIsLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<'accept' | 'decline' | null>(null);
  const [localState, setLocalState] = useState<RelationshipState | null>(initialState || null);

  // Use cached state if available, otherwise use local state
  const currentState = cachedState || localState;

  // Initialize cache with initial state
  useEffect(() => {
    if (initialState && !cachedState) {
      setRelationship(userId, initialState);
    }
  }, [initialState, cachedState, userId, setRelationship]);

  // Don't show button for own profile
  if (user?.id === userId) {
    return null;
  }

  const handleClick = useCallback(async () => {
    if (isLoading) return;
    setIsLoading(true);

    try {
      let response;

      if (currentState?.pending) {
        // Cancel pending request
        response = await cancelRequest(userId);
      } else if (currentState?.following) {
        // Unfollow
        response = await unfollowUser(userId);
      } else {
        // Follow (or send request for private accounts)
        response = await followUser(userId, isPrivate);
      }

      if (response.success && response.new_state) {
        setLocalState(response.new_state);
        onStateChange?.(response.new_state);
      }
    } catch (error) {
      console.error('Follow action failed:', error);
    } finally {
      setIsLoading(false);
    }
  }, [
    isLoading,
    currentState,
    userId,
    isPrivate,
    followUser,
    unfollowUser,
    cancelRequest,
    onStateChange,
  ]);

  const handleAccept = useCallback(async () => {
    if (actionLoading) return;
    setActionLoading('accept');

    try {
      const response = await acceptRequest(userId);
      if (response.success && response.new_state) {
        setLocalState(response.new_state);
        onStateChange?.(response.new_state);
      }
    } catch (error) {
      console.error('Accept request failed:', error);
    } finally {
      setActionLoading(null);
    }
  }, [actionLoading, userId, acceptRequest, onStateChange]);

  const handleDecline = useCallback(async () => {
    if (actionLoading) return;
    setActionLoading('decline');

    try {
      const response = await declineRequest(userId);
      if (response.success && response.new_state) {
        setLocalState(response.new_state);
        onStateChange?.(response.new_state);
      }
    } catch (error) {
      console.error('Decline request failed:', error);
    } finally {
      setActionLoading(null);
    }
  }, [actionLoading, userId, declineRequest, onStateChange]);

  // Show Follow/Following + Accept/Decline buttons when there's an incoming pending request
  if (currentState?.incoming_pending) {
    const alreadyFollowing = currentState?.following;
    return (
      <div className={styles.incomingActions}>
        <button
          className={`${alreadyFollowing ? styles.followingButton : styles.followBackButton} ${styles[size]}`}
          onClick={handleClick}
          disabled={isLoading || actionLoading !== null}
        >
          {isLoading ? (
            <Loader2 className={styles.spinner} size={14} />
          ) : alreadyFollowing ? (
            'Following'
          ) : (
            'Follow'
          )}
        </button>
        <button
          className={`${styles.acceptButton} ${styles[size]}`}
          onClick={handleAccept}
          disabled={actionLoading !== null || isLoading}
        >
          {actionLoading === 'accept' ? (
            <Loader2 className={styles.spinner} size={14} />
          ) : (
            'Accept'
          )}
        </button>
        <button
          className={`${styles.declineButton} ${styles[size]}`}
          onClick={handleDecline}
          disabled={actionLoading !== null || isLoading}
        >
          {actionLoading === 'decline' ? (
            <Loader2 className={styles.spinner} size={14} />
          ) : (
            'Decline'
          )}
        </button>
      </div>
    );
  }

  // Determine button appearance based on state
  const getButtonConfig = () => {
    if (currentState?.pending) {
      return {
        label: 'Requested',
        variant: 'pending' as const,
        hoverLabel: 'Cancel',
      };
    }
    
    if (currentState?.following) {
      return {
        label: 'Following',
        variant: 'following' as const,
        hoverLabel: 'Unfollow',
      };
    }

    if (currentState?.followed_by) {
      return {
        label: 'Follow',
        variant: 'default' as const,
        hoverLabel: 'Follow',
      };
    }

    return {
      label: 'Follow',
      variant: 'default' as const,
      hoverLabel: 'Follow',
    };
  };

  const config = getButtonConfig();

  return (
    <button
      className={`${styles.button} ${styles[config.variant]} ${styles[size]} ${fullWidth ? styles.fullWidth : ''}`}
      onClick={handleClick}
      disabled={isLoading}
    >
      {isLoading ? (
        <Loader2 className={styles.spinner} size={14} />
      ) : (
        <>
          <span className={styles.label}>{config.label}</span>
          <span className={styles.hoverLabel}>{config.hoverLabel}</span>
        </>
      )}
    </button>
  );
};

export default FollowButton;
