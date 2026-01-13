/**
 * FollowButton Component
 *
 * Clean Instagram-style follow button built on the base Button component.
 * Uses design tokens for consistent styling.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useFollowStore, useRelationship, useAuth } from '../../../store';
import { Button } from '../../ui/Button';
import type { ButtonSize } from '../../ui/Button';
import type { RelationshipState, FollowButtonProps } from '../../../types/follow';
import styles from './FollowButton.module.css';

// Map FollowButton sizes to Button sizes
const sizeMap: Record<'sm' | 'md' | 'lg', ButtonSize> = {
  sm: 'xs',
  md: 'sm',
  lg: 'md',
};

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

  const buttonSize = sizeMap[size];
  const isDisabled = isLoading || actionLoading !== null;

  // Show Follow/Following + Accept/Decline buttons when there's an incoming pending request
  if (currentState?.incoming_pending) {
    const alreadyFollowing = currentState?.following;
    return (
      <div className={styles.incomingActions}>
        <Button
          variant={alreadyFollowing ? 'glass' : 'primary'}
          size={buttonSize}
          onClick={handleClick}
          disabled={isDisabled}
          loading={isLoading}
          className={styles.actionButton}
        >
          {alreadyFollowing ? 'Following' : 'Follow'}
        </Button>
        <Button
          variant="primary"
          size={buttonSize}
          onClick={handleAccept}
          disabled={isDisabled}
          loading={actionLoading === 'accept'}
          className={styles.actionButton}
        >
          Accept
        </Button>
        <Button
          variant="glass"
          size={buttonSize}
          onClick={handleDecline}
          disabled={isDisabled}
          loading={actionLoading === 'decline'}
          className={styles.actionButton}
        >
          Decline
        </Button>
      </div>
    );
  }

  // Determine button appearance based on state
  const getButtonConfig = () => {
    if (currentState?.pending) {
      return {
        label: 'Requested',
        variant: 'glass' as const,
        hoverLabel: 'Cancel',
        hoverVariant: 'danger' as const,
      };
    }
    
    if (currentState?.following) {
      return {
        label: 'Following',
        variant: 'glass' as const,
        hoverLabel: 'Unfollow',
        hoverVariant: 'danger' as const,
      };
    }

    return {
      label: 'Follow',
      variant: 'primary' as const,
      hoverLabel: undefined,
      hoverVariant: undefined,
    };
  };

  const config = getButtonConfig();

  return (
    <Button
      variant={config.variant}
      size={buttonSize}
      onClick={handleClick}
      disabled={isLoading}
      loading={isLoading}
      fullWidth={fullWidth}
      hoverLabel={config.hoverLabel}
      hoverVariant={config.hoverVariant}
      className={styles.followButton}
    >
      {config.label}
    </Button>
  );
};

export default FollowButton;
