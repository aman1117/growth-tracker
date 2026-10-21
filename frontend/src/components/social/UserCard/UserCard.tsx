/**
 * UserCard Component
 *
 * User row for follow lists: tappable identity (opens the profile) plus actions.
 */

import React from 'react';

import { useOverlayAwareNavigate } from '../../../hooks/useOverlayAwareNavigate';
import { useAuth } from '../../../store';
import type { UserCardProps } from '../../../types/follow';
import { Avatar, Button, VerifiedBadge } from '../../ui';
import { FollowButton } from '../FollowButton';
import styles from './UserCard.module.css';

export const UserCard: React.FC<UserCardProps> = ({
  user,
  showFollowButton = true,
  showRemoveButton = false,
  onRemove,
  isRemoving = false,
  onUserClick,
  showRequestActions = true,
}) => {
  const navigate = useOverlayAwareNavigate();
  const { user: currentUser } = useAuth();

  const isOwnProfile = currentUser?.id === user.id;
  const followsYou = !isOwnProfile && !!user.relationship_state?.followed_by;
  const secondary = user.display_name || (followsYou && !showRemoveButton ? 'Follows you' : '');

  const handleUserClick = () => {
    navigate(`/user/${user.username}`);
    onUserClick?.(user.username);
  };

  return (
    <div className={styles.card}>
      <button type="button" className={styles.identity} onClick={handleUserClick}>
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
          {secondary && <span className={styles.secondaryText}>{secondary}</span>}
        </span>
      </button>

      <div className={styles.actions}>
        {isOwnProfile ? (
          <span className={styles.youLabel}>You</span>
        ) : (
          <>
            {showFollowButton && (
              <FollowButton
                userId={user.id}
                username={user.username}
                isPrivate={user.is_private}
                initialState={user.relationship_state}
                size="sm"
                showRequestActions={showRequestActions}
              />
            )}

            {showRemoveButton && (
              <Button
                variant="glass"
                size="xs"
                onClick={() => onRemove?.(user.id)}
                loading={isRemoving}
                disabled={isRemoving}
                aria-label={`Remove ${user.username} from your followers`}
              >
                Remove
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default UserCard;
