/**
 * CommentPreview Component
 *
 * Shows top 2 comments below the day summary card content, Instagram-style.
 * Renders bold username + body text (single line, truncated).
 * Clicking any comment opens the full CommentSheet.
 * Hidden when there are no comments.
 */

import { Heart } from 'lucide-react';
import React, { useCallback, useEffect } from 'react';

import { useCommentStore } from '../../../store/useCommentStore';
import styles from './CommentPreview.module.css';

interface CommentPreviewProps {
  username: string;
  date: string;
  onOpenSheet: () => void;
}

export const CommentPreview: React.FC<CommentPreviewProps> = ({ username, date, onOpenSheet }) => {
  const dayKey = `${username}:${date}`;
  const previews = useCommentStore((s) => s.previewsByDay[dayKey]);
  const fetchPreviewComments = useCommentStore((s) => s.fetchPreviewComments);
  const likeComment = useCommentStore((s) => s.likeComment);
  const unlikeComment = useCommentStore((s) => s.unlikeComment);

  useEffect(() => {
    fetchPreviewComments(username, date);
  }, [username, date, fetchPreviewComments]);

  const handleLikeToggle = useCallback(
    (e: React.MouseEvent, commentId: number, liked: boolean) => {
      e.stopPropagation();
      if (liked) {
        unlikeComment(commentId, dayKey);
      } else {
        likeComment(commentId, dayKey);
      }
    },
    [dayKey, likeComment, unlikeComment]
  );

  if (!previews || previews.length === 0) {
    return null;
  }

  return (
    <div className={styles.previewSection}>
      {previews.map((comment) => (
        <div
          key={comment.id}
          className={styles.previewComment}
          onClick={onOpenSheet}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
              e.preventDefault();
              onOpenSheet();
            }
          }}
          aria-label={`Comment by ${comment.author_username}: ${comment.body}`}
        >
          <span className={styles.previewUsername}>{comment.author_username}</span>
          <span className={styles.previewBody}>{comment.body}</span>
          <button
            className={`${styles.likeButton} ${comment.liked_by_me ? styles.liked : ''}`}
            onClick={(e) => handleLikeToggle(e, comment.id, comment.liked_by_me)}
            aria-label={comment.liked_by_me ? 'Unlike comment' : 'Like comment'}
          >
            <Heart size={12} fill={comment.liked_by_me ? 'currentColor' : 'none'} />
          </button>
        </div>
      ))}
    </div>
  );
};
