/**
 * CommentButton Component
 *
 * MessageCircle icon with comment count, placed next to LikeButton on DaySummaryCard.
 * Clicking opens the CommentSheet.
 */

import { MessageCircle } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { useCommentStore } from '../../../store/useCommentStore';
import styles from './CommentButton.module.css';
import { CommentSheet } from './CommentSheet';

export interface CommentButtonProps {
  username: string;
  date: string;
  size?: 'sm' | 'md';
  showCount?: boolean;
}

export const CommentButton: React.FC<CommentButtonProps> = ({
  username,
  date,
  size = 'sm',
  showCount = true,
}) => {
  const [isSheetOpen, setIsSheetOpen] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const dayKey = `${username}:${date}`;
  const count = useCommentStore((s) => s.counts[dayKey] ?? 0);
  const fetchCommentCount = useCommentStore((s) => s.fetchCommentCount);

  useEffect(() => {
    fetchCommentCount(username, date);
  }, [username, date, fetchCommentCount]);

  // Deep link: auto-open comment sheet when URL has ?comments=true
  useEffect(() => {
    if (searchParams.get('comments') === 'true') {
      setIsSheetOpen(true);
      // Remove the param — this updates both the URL and React Router's state,
      // so the param won't persist through pull-to-refresh or remounts.
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.delete('comments');
        return next;
      }, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      setIsSheetOpen(true);
    },
    []
  );

  const iconSize = size === 'sm' ? 16 : 20;
  const hasComments = count > 0;
  const containerClasses = [styles.container, styles[size]].join(' ');

  return (
    <>
      <div className={containerClasses}>
        <button
          onClick={handleClick}
          className={`${styles.button} ${hasComments ? styles.hasComments : ''}`}
          title="View comments"
          aria-label={`${count} comments`}
        >
          <MessageCircle size={iconSize} fill={hasComments ? 'currentColor' : 'none'} />
        </button>
        {showCount && (
          <span onClick={handleClick} className={`${styles.count} ${hasComments ? styles.hasComments : ''}`}>
            {count}
          </span>
        )}
      </div>

      <CommentSheet
        isOpen={isSheetOpen}
        onClose={() => setIsSheetOpen(false)}
        username={username}
        date={date}
      />
    </>
  );
};
