/**
 * FollowStats Component
 *
 * Simple text-based follower/following counts.
 * Clickable to open respective list modals.
 */

import React, { useEffect, useRef, useState } from 'react';

import { useFollowCounts, useFollowStore } from '../../../store';
import type { FollowCounts } from '../../../types/follow';
import { FollowListModal } from '../FollowListModal';
import styles from './FollowStats.module.css';

interface FollowStatsProps {
  userId: number;
  username: string;
  initialCounts?: FollowCounts;
  isPrivate?: boolean;
  canView?: boolean;
}

export const FollowStats: React.FC<FollowStatsProps> = ({
  userId,
  username,
  initialCounts,
  isPrivate = false,
  canView = true,
}) => {
  const { getCounts, setCounts } = useFollowStore();
  const cachedCounts = useFollowCounts(userId);

  const [isLoading, setIsLoading] = useState(false);
  const [activeModal, setActiveModal] = useState<'followers' | 'following' | null>(null);
  const hasFetchedRef = useRef(false);

  // Use cached counts or initial counts
  const counts = cachedCounts || initialCounts;

  // Determine if lists should be clickable
  // Private accounts that the user can't view should have non-clickable stats
  const isClickable = !isPrivate || canView;

  // Fetch counts if not available - only once per userId
  useEffect(() => {
    hasFetchedRef.current = false;
  }, [userId]);

  useEffect(() => {
    if (!counts && !isLoading && !hasFetchedRef.current) {
      hasFetchedRef.current = true;
      setIsLoading(true);
      getCounts(userId).finally(() => setIsLoading(false));
    } else if (initialCounts && !cachedCounts) {
      setCounts(userId, initialCounts);
    }
  }, [userId, counts, isLoading, getCounts, initialCounts, cachedCounts, setCounts]);

  const formatCount = (count: number): string => {
    if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`;
    if (count >= 1000) return `${(count / 1000).toFixed(1)}K`;
    return count.toString();
  };

  const handleStatClick = (type: 'followers' | 'following') => {
    if (isClickable) {
      setActiveModal(type);
    }
  };

  return (
    <>
      <div className={styles.container}>
        <button
          className={`${styles.stat} ${!isClickable ? styles.notClickable : ''}`}
          onClick={() => handleStatClick('followers')}
          disabled={isLoading || !isClickable}
        >
          <span className={styles.count}>
            {isLoading ? '—' : formatCount(counts?.followers || 0)}
          </span>
          <span className={styles.label}>Followers</span>
        </button>

        <button
          className={`${styles.stat} ${!isClickable ? styles.notClickable : ''}`}
          onClick={() => handleStatClick('following')}
          disabled={isLoading || !isClickable}
        >
          <span className={styles.count}>
            {isLoading ? '—' : formatCount(counts?.following || 0)}
          </span>
          <span className={styles.label}>Following</span>
        </button>
      </div>

      <FollowListModal
        isOpen={activeModal === 'followers'}
        onClose={() => setActiveModal(null)}
        userId={userId}
        username={username}
        type="followers"
      />

      <FollowListModal
        isOpen={activeModal === 'following'}
        onClose={() => setActiveModal(null)}
        userId={userId}
        username={username}
        type="following"
      />
    </>
  );
};

export default FollowStats;
