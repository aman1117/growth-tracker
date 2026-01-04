/**
 * LikeButton Component
 *
 * A heart-shaped like button with count, featuring glassmorphism design.
 * Allows users to like/unlike another user's day.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Heart } from 'lucide-react';
import { likeApi } from '../../../services/api';
import LikersModal from './LikersModal';

export interface LikeButtonProps {
  /** Username of the profile being viewed */
  username: string;
  /** Date in YYYY-MM-DD format */
  date: string;
  /** Initial like count (optional, will fetch if not provided) */
  initialCount?: number;
  /** Initial liked state (optional, will fetch if not provided) */
  initialLiked?: boolean;
  /** Size variant */
  size?: 'sm' | 'md';
  /** Whether to show the count */
  showCount?: boolean;
  /** Callback when like state changes */
  onLikeChange?: (liked: boolean, count: number) => void;
}

export const LikeButton: React.FC<LikeButtonProps> = ({
  username,
  date,
  initialCount,
  initialLiked,
  size = 'sm',
  showCount = true,
  onLikeChange,
}) => {
  const [liked, setLiked] = useState(initialLiked ?? false);
  const [count, setCount] = useState(initialCount ?? 0);
  const [loading, setLoading] = useState(false);
  const [showLikersModal, setShowLikersModal] = useState(false);
  const [initialized, setInitialized] = useState(
    initialCount !== undefined && initialLiked !== undefined
  );

  // Fetch initial like state if not provided
  useEffect(() => {
    if (initialized) return;

    const fetchLikeState = async () => {
      try {
        const response = await likeApi.getLikes(username, date);
        if (response.success) {
          setCount(response.count);
          setLiked(response.user_has_liked);
          setInitialized(true);
        }
      } catch (error) {
        console.error('Failed to fetch like state:', error);
        setInitialized(true);
      }
    };

    fetchLikeState();
  }, [username, date, initialized]);

  // Update state when props change
  useEffect(() => {
    if (initialCount !== undefined) setCount(initialCount);
    if (initialLiked !== undefined) setLiked(initialLiked);
  }, [initialCount, initialLiked]);

  const handleClick = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();

    if (loading) return;

    setLoading(true);
    const previousLiked = liked;
    const previousCount = count;

    // Optimistic update
    const newLiked = !liked;
    const newCount = newLiked ? count + 1 : Math.max(0, count - 1);
    setLiked(newLiked);
    setCount(newCount);

    try {
      const response = newLiked
        ? await likeApi.likeDay(username, date)
        : await likeApi.unlikeDay(username, date);

      if (response.success) {
        setLiked(response.liked);
        setCount(response.new_count);
        onLikeChange?.(response.liked, response.new_count);
      } else {
        // Revert on failure
        setLiked(previousLiked);
        setCount(previousCount);
      }
    } catch (error) {
      console.error('Failed to toggle like:', error);
      // Revert on error
      setLiked(previousLiked);
      setCount(previousCount);
    } finally {
      setLoading(false);
    }
  }, [liked, count, loading, username, date, onLikeChange]);

  const iconSize = size === 'sm' ? 14 : 18;
  const fontSize = size === 'sm' ? '0.75rem' : '0.875rem';
  const gap = size === 'sm' ? '0.25rem' : '0.375rem';

  const handleCountClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (count > 0) {
      setShowLikersModal(true);
    }
  }, [count]);

  return (
    <>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap,
        }}
      >
        <button
          onClick={handleClick}
          disabled={loading}
          style={{
            display: 'flex',
            alignItems: 'center',
            padding: 0,
            background: 'transparent',
            border: 'none',
            cursor: loading ? 'wait' : 'pointer',
            transition: 'all 0.2s ease',
            color: liked ? '#ef4444' : 'var(--text-secondary)',
            opacity: loading ? 0.7 : 1,
          }}
          onMouseEnter={(e) => {
            if (!loading) {
              e.currentTarget.style.transform = 'scale(1.1)';
            }
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = 'scale(1)';
          }}
          title={liked ? 'Unlike this day' : 'Like this day'}
        >
          <Heart
            size={iconSize}
            fill={liked ? '#ef4444' : 'none'}
            color={liked ? '#ef4444' : 'currentColor'}
            style={{
              transition: 'all 0.2s ease',
              transform: liked ? 'scale(1.1)' : 'scale(1)',
            }}
          />
        </button>
        {showCount && (
          <span 
            onClick={handleCountClick}
            style={{ 
              fontSize, 
              fontWeight: 500,
              color: liked ? '#ef4444' : 'var(--text-secondary)',
              cursor: count > 0 ? 'pointer' : 'default',
            }}
            onMouseEnter={(e) => {
              if (count > 0) {
                e.currentTarget.style.textDecoration = 'underline';
              }
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.textDecoration = 'none';
            }}
          >
            {count}
          </span>
        )}
      </div>

      <LikersModal
        username={username}
        date={date}
        isOpen={showLikersModal}
        onClose={() => setShowLikersModal(false)}
      />
    </>
  );
};

export default LikeButton;
