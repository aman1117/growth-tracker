/**
 * UserCard Component
 *
 * Clean Instagram-style user row for follow lists.
 */

import { Loader2 } from 'lucide-react';
import React from 'react';
import { useNavigate } from 'react-router-dom';

import { useAuth } from '../../../store';
import type { UserCardProps } from '../../../types/follow';
import { Avatar, VerifiedBadge } from '../../ui';
import { FollowButton } from '../FollowButton';
import styles from './UserCard.module.css';

export const UserCard: React.FC<UserCardProps> = ({
  user,
  showFollowButton = true,
  showRemoveButton = false,
  onRemove,
  isRemoving = false,
  onUserClick,
}) => {
  const navigate = useNavigate();
  const { user: currentUser } = useAuth();

  const isOwnProfile = currentUser?.id === user.id;

  const handleUserClick = () => {
    navigate(`/user/${user.username}`);
    onUserClick?.(user.username);
  };

  const handleRemove = (e: React.MouseEvent) => {
    e.stopPropagation();
    onRemove?.(user.id);
  };

  return (
    <div className={styles.card} onClick={handleUserClick}>
      <Avatar src={user.profile_pic} name={user.username} size="md" className={styles.avatar} />

      <div className={styles.userInfo}>
        <span className={styles.username}>
          {user.username}
          {user.is_verified && <VerifiedBadge size={12} />}
        </span>
        {user.display_name && <span className={styles.displayName}>{user.display_name}</span>}
      </div>

      <div className={styles.actions} onClick={(e) => e.stopPropagation()}>
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
              />
            )}

            {showRemoveButton && (
              <button
                className={styles.removeButton}
                onClick={handleRemove}
                disabled={isRemoving}
                title="Remove follower"
              >
                {isRemoving ? <Loader2 size={14} className={styles.spinner} /> : 'Remove'}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default UserCard;
