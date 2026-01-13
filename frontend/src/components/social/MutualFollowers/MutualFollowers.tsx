/**
 * MutualFollowers Component
 *
 * Displays "Followed by X, Y and N others" like Instagram.
 * Shows users that the current user follows who also follow this profile.
 */

import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useFollowStore, useAuth } from '../../../store';
import type { FollowUser } from '../../../types/follow';
import styles from './MutualFollowers.module.css';

interface MutualFollowersProps {
  userId: number;
  username: string;
  onShowAll?: () => void;
}

export const MutualFollowers: React.FC<MutualFollowersProps> = ({
  userId,
  username: _username,
  onShowAll,
}) => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { getMutuals } = useFollowStore();
  
  const [mutuals, setMutuals] = useState<FollowUser[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Don't show for own profile
    if (user?.id === userId) {
      setLoading(false);
      return;
    }

    const fetchMutuals = async () => {
      setLoading(true);
      try {
        const response = await getMutuals(userId, undefined, 3);
        if (response.success) {
          const users = response.users || [];
          setMutuals(users);
          setTotalCount(response.has_more ? users.length + 1 : users.length);
        }
      } catch (error) {
        console.error('Failed to fetch mutuals:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchMutuals();
  }, [userId, user?.id, getMutuals]);

  // Don't render if loading, no mutuals, or viewing own profile
  if (loading || mutuals.length === 0 || user?.id === userId) {
    return null;
  }

  const handleUserClick = (username: string, e: React.MouseEvent) => {
    e.stopPropagation();
    navigate(`/user/${username}`);
  };

  const handleContainerClick = () => {
    onShowAll?.();
  };

  // Get display names (up to 2 shown by name)
  const displayUsers = mutuals.slice(0, 2);
  const othersCount = totalCount - displayUsers.length;

  return (
    <div className={styles.container} onClick={handleContainerClick}>
      {/* Stacked Avatars */}
      <div className={styles.avatars}>
        {mutuals.slice(0, 3).map((mutual, index) => (
          <div
            key={mutual.id}
            className={styles.avatarWrapper}
            style={{ zIndex: 3 - index }}
            onClick={(e) => handleUserClick(mutual.username, e)}
          >
            {mutual.profile_pic ? (
              <img
                src={mutual.profile_pic}
                alt={mutual.username}
                className={styles.avatar}
              />
            ) : (
              <div className={styles.avatarPlaceholder}>
                {mutual.username.charAt(0).toUpperCase()}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Text */}
      <span className={styles.text}>
        Followed by{' '}
        {displayUsers.map((user, index) => (
          <React.Fragment key={user.id}>
            <span
              className={styles.username}
              onClick={(e) => handleUserClick(user.username, e)}
            >
              {user.username}
            </span>
            {index < displayUsers.length - 1 && ', '}
          </React.Fragment>
        ))}
        {othersCount > 0 && (
          <>
            {displayUsers.length > 0 && ' and '}
            <span className={styles.others}>{othersCount} {othersCount === 1 ? 'other' : 'others'}</span>
          </>
        )}
      </span>
    </div>
  );
};

export default MutualFollowers;
