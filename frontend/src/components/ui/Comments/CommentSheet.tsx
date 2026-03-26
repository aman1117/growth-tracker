/**
 * CommentSheet Component
 *
 * Instagram-style comment sheet.
 * Mobile: bottom sheet sliding up from bottom (portal).
 * Desktop: centered glass modal.
 * Same animation pattern as NotificationPanel.
 */

import { RefreshCw, X } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useCommentStore } from '../../../store/useCommentStore';
import { CommentInput } from './CommentInput';
import { CommentItem } from './CommentItem';
import styles from './CommentSheet.module.css';

interface CommentSheetProps {
  isOpen: boolean;
  onClose: () => void;
  username: string;
  date: string;
}

const CLOSE_ANIMATION_MS = 200;

export const CommentSheet: React.FC<CommentSheetProps> = ({
  isOpen,
  onClose,
  username,
  date,
}) => {
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [isClosing, setIsClosing] = useState(false);
  const [shouldRender, setShouldRender] = useState(isOpen);
  const [replyTarget, setReplyTarget] = useState<{
    commentId: number;
    username: string;
  } | null>(null);
  const [listFading, setListFading] = useState(false);

  const dayKey = `${username}:${date}`;
  const comments = useCommentStore((s) => s.commentsByDay[dayKey]) ?? [];
  const loading = useCommentStore((s) => s.loading);
  const hasMore = useCommentStore((s) => s.hasMore);
  const sort = useCommentStore((s) => s.sort);
  const count = useCommentStore((s) => s.counts[dayKey] ?? 0);
  const fetchComments = useCommentStore((s) => s.fetchComments);
  const setSort = useCommentStore((s) => s.setSort);

  // Mobile detection
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth <= 640 : false
  );

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth <= 640);
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  // Open/close with animation
  useEffect(() => {
    if (isOpen) {
      setShouldRender(true);
      setIsClosing(false);
    } else if (shouldRender) {
      setIsClosing(true);
      const timer = setTimeout(() => {
        setShouldRender(false);
        setIsClosing(false);
      }, CLOSE_ANIMATION_MS);
      return () => clearTimeout(timer);
    }
  }, [isOpen, shouldRender]);

  // Fetch comments when opened
  useEffect(() => {
    if (isOpen) {
      fetchComments(username, date, sort, true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, username, date, fetchComments]);

  // Close on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleKeyDown);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  // Prevent body scroll when open on mobile
  useEffect(() => {
    if (isOpen && isMobile) {
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = ''; };
    }
  }, [isOpen, isMobile]);

  // Infinite scroll
  const handleScroll = useCallback(() => {
    if (!listRef.current || loading || !hasMore) return;
    const { scrollTop, scrollHeight, clientHeight } = listRef.current;
    if (scrollHeight - scrollTop - clientHeight < 100) {
      fetchComments(username, date, sort);
    }
  }, [loading, hasMore, fetchComments, username, date, sort]);

  const handleSortChange = useCallback(
    (newSort: 'top' | 'newest') => {
      if (newSort !== sort) {
        setListFading(true);
        setSort(newSort);
        fetchComments(username, date, newSort, true);
        setTimeout(() => setListFading(false), 200);
      }
    },
    [sort, setSort, fetchComments, username, date]
  );

  const handleReply = useCallback((commentId: number, authorUsername: string) => {
    setReplyTarget({ commentId, username: authorUsername });
  }, []);

  const handleCancelReply = useCallback(() => {
    setReplyTarget(null);
  }, []);

  const handleRefresh = useCallback(() => {
    if (comments.length > 0) {
      setListFading(true);
      setTimeout(() => setListFading(false), 200);
    }
    fetchComments(username, date, sort, true);
  }, [fetchComments, username, date, sort, comments.length]);

  const handleCommentPosted = useCallback(() => {
    setReplyTarget(null);
  }, []);

  if (!shouldRender) return null;

  const panelClasses = [
    styles.panel,
    isMobile ? styles.panelMobile : styles.panelDesktop,
    isClosing && isMobile && styles.panelMobileClosing,
    isClosing && !isMobile && styles.panelDesktopClosing,
  ]
    .filter(Boolean)
    .join(' ');

  const content = (
    <>
      <div
        className={`${styles.overlay} ${isClosing ? styles.overlayClosing : ''}`}
        onClick={onClose}
      />

      <div ref={panelRef} className={panelClasses}>
        {/* Drag handle (mobile only) */}
        {isMobile && (
          <div className={styles.dragHandle}>
            <div className={styles.dragBar} />
          </div>
        )}

        {/* Header */}
        <div className={styles.header}>
          <h3 className={styles.title}>Comments{count > 0 ? ` (${count})` : ''}</h3>
          <div className={styles.headerActions}>
            <button className={styles.headerButton} onClick={handleRefresh} title="Refresh" aria-label="Refresh comments">
              <RefreshCw size={16} />
            </button>
            <button className={styles.headerButton} onClick={onClose} title="Close" aria-label="Close comments">
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Sort Toggle */}
        <div className={styles.sortRow}>
          <button
            className={`${styles.sortButton} ${sort === 'top' ? styles.sortButtonActive : ''}`}
            onClick={() => handleSortChange('top')}
          >
            Top
          </button>
          <button
            className={`${styles.sortButton} ${sort === 'newest' ? styles.sortButtonActive : ''}`}
            onClick={() => handleSortChange('newest')}
          >
            Newest
          </button>
        </div>

        {/* Comment List */}
        <div ref={listRef} className={`${styles.commentList} ${listFading ? styles.commentListFading : ''}`} onScroll={handleScroll}>
          {loading && comments.length === 0 ? (
            <div className={styles.loading}>
              <RefreshCw size={18} className={styles.spinning} />
              <span>Loading comments...</span>
            </div>
          ) : comments.length === 0 ? (
            <div className={styles.emptyState}>
              <p className={styles.emptyTitle}>No comments yet</p>
              <p className={styles.emptySubtitle}>Start the conversation.</p>
            </div>
          ) : (
            <>
              {comments.map((comment) => (
                <CommentItem
                  key={comment.id}
                  comment={comment}
                  dayKey={dayKey}
                  username={username}
                  date={date}
                  onReply={handleReply}
                  isTopLevel
                />
              ))}
              {loading && (
                <div className={styles.loadingMore}>
                  <RefreshCw size={14} className={styles.spinning} />
                  <span>Loading...</span>
                </div>
              )}
            </>
          )}
        </div>

        {/* Comment Input */}
        <CommentInput
          username={username}
          date={date}
          replyTarget={replyTarget}
          onCancelReply={handleCancelReply}
          onCommentPosted={handleCommentPosted}
        />
      </div>
    </>
  );

  return createPortal(content, document.body);
};
