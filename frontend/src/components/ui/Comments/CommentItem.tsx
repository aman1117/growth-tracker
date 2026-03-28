/**
 * CommentItem Component
 *
 * Individual comment row with avatar, body, actions, and expandable replies.
 * Supports @mention highlighting, URL linking, truncation, and deleted state.
 */

import { Check, Heart, Pencil, Reply, Trash2, X } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useAuthStore } from '../../../store/useAuthStore';
import { useCommentStore } from '../../../store/useCommentStore';
import type { Comment } from '../../../types/comment';
import { Avatar } from '../Avatar';
import { VerifiedBadge } from '../VerifiedBadge';
import styles from './CommentItem.module.css';

interface CommentItemProps {
  comment: Comment;
  dayKey: string;
  username: string;
  date: string;
  onReply: (commentId: number, authorUsername: string) => void;
  isTopLevel?: boolean;
}

const TRUNCATE_LENGTH = 200;
const INITIAL_REPLIES_SHOWN = 3;
const MAX_COMMENT_LENGTH = 200;
const CHAR_COUNTER_THRESHOLD = 0.8;
const EDIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// Format relative time: "2h", "3d", "1w"
function formatRelativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);
  const diffWeek = Math.floor(diffDay / 7);

  if (diffSec < 60) return 'now';
  if (diffMin < 60) return `${diffMin}m`;
  if (diffHr < 24) return `${diffHr}h`;
  if (diffDay < 7) return `${diffDay}d`;
  if (diffWeek < 52) return `${diffWeek}w`;
  return `${Math.floor(diffWeek / 52)}y`;
}

// Parse comment body into React nodes with @mention highlighting and URL linking
function renderBody(
  body: string,
  mentions: Comment['mentions'],
  onMentionClick?: (username: string) => void
): React.ReactNode {
  const mentionUsernames = new Set(mentions.map((m) => m.username));
  // Match @username or URLs
  const regex = /(@[a-z0-9_.]{3,20})|(https?:\/\/[^\s<]+)/gi;
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(body)) !== null) {
    // Text before match
    if (match.index > lastIndex) {
      parts.push(body.slice(lastIndex, match.index));
    }

    if (match[1]) {
      // @mention
      const rawUsername = match[1].slice(1);
      if (mentionUsernames.has(rawUsername)) {
        parts.push(
          <span
            key={match.index}
            className={styles.mention}
            onClick={(e) => {
              e.stopPropagation();
              onMentionClick?.(rawUsername);
            }}
            role="link"
            tabIndex={0}
          >
            {match[1]}
          </span>
        );
      } else {
        parts.push(match[1]);
      }
    } else if (match[2]) {
      // URL
      parts.push(
        <a
          key={match.index}
          href={match[2]}
          target="_blank"
          rel="noopener noreferrer"
          className={styles.link}
          onClick={(e) => e.stopPropagation()}
        >
          {match[2].length > 40 ? match[2].slice(0, 40) + '…' : match[2]}
        </a>
      );
    }
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < body.length) {
    parts.push(body.slice(lastIndex));
  }

  return parts.length > 0 ? parts : body;
}

export const CommentItem: React.FC<CommentItemProps> = ({
  comment,
  dayKey,
  username,
  date,
  onReply,
  isTopLevel = false,
}) => {
  const [expanded, setExpanded] = useState(false);
  const [showAllReplies, setShowAllReplies] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editBody, setEditBody] = useState('');
  const [editSubmitting, setEditSubmitting] = useState(false);
  const deleteTimer = useRef<number>(0);
  const editTextareaRef = useRef<HTMLTextAreaElement>(null);
  const navigate = useNavigate();
  const currentUser = useAuthStore((s) => s.user);
  const likeComment = useCommentStore((s) => s.likeComment);
  const unlikeComment = useCommentStore((s) => s.unlikeComment);
  const deleteComment = useCommentStore((s) => s.deleteComment);
  const editComment = useCommentStore((s) => s.editComment);
  const fetchReplies = useCommentStore((s) => s.fetchReplies);
  const repliesState = useCommentStore((s) => s.repliesByRoot[comment.id]);

  // Cleanup delete timer on unmount
  useEffect(() => {
    return () => {
      window.clearTimeout(deleteTimer.current);
    };
  }, []);

  const isMe = currentUser?.id === comment.author_id;

  const navigateToProfile = useCallback(
    (targetUsername: string) => {
      navigate(`/user/${targetUsername}?date=${date}`);
    },
    [navigate, date]
  );

  const canDelete = useMemo(() => {
    if (!currentUser) return false;
    // Author of the comment or owner of the day
    return currentUser.id === comment.author_id || currentUser.username === username;
  }, [currentUser, comment.author_id, username]);

  const canEdit = useMemo(() => {
    if (!currentUser || comment.is_deleted) return false;
    if (currentUser.id !== comment.author_id) return false;
    return true;
  }, [currentUser, comment.author_id, comment.is_deleted]);

  // Check edit window on mount and periodically — Date.now() is impure so keep it in an effect
  const [withinEditWindow, setWithinEditWindow] = useState(() => {
    const elapsed = Date.now() - new Date(comment.created_at).getTime();
    return elapsed < EDIT_WINDOW_MS;
  });

  useEffect(() => {
    if (!canEdit) return;
    const elapsed = Date.now() - new Date(comment.created_at).getTime();
    if (elapsed >= EDIT_WINDOW_MS) {
      setWithinEditWindow(false);
      return;
    }
    setWithinEditWindow(true);
    const remaining = EDIT_WINDOW_MS - elapsed;
    const timer = window.setTimeout(() => {
      setWithinEditWindow(false);
      if (editing) setEditing(false);
    }, remaining);
    return () => window.clearTimeout(timer);
  }, [canEdit, comment.created_at, editing]);

  // Auto-resize edit textarea
  useEffect(() => {
    const textarea = editTextareaRef.current;
    if (textarea && editing) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
    }
  }, [editBody, editing]);

  // Focus textarea when entering edit mode
  useEffect(() => {
    if (editing && editTextareaRef.current) {
      editTextareaRef.current.focus();
      editTextareaRef.current.setSelectionRange(editBody.length, editBody.length);
    }
  }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleLikeToggle = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (comment.liked_by_me) {
        unlikeComment(comment.id, dayKey);
      } else {
        likeComment(comment.id, dayKey);
      }
    },
    [comment.id, comment.liked_by_me, dayKey, likeComment, unlikeComment]
  );

  const handleDelete = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      if (deleteConfirm) {
        window.clearTimeout(deleteTimer.current);
        setDeleteConfirm(false);
        await deleteComment(comment.id, dayKey);
      } else {
        setDeleteConfirm(true);
        window.clearTimeout(deleteTimer.current);
        deleteTimer.current = window.setTimeout(() => {
          setDeleteConfirm(false);
        }, 5000);
      }
    },
    [comment.id, dayKey, deleteComment, deleteConfirm]
  );

  const handleEditStart = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      setEditBody(comment.body);
      setEditing(true);
    },
    [comment.body]
  );

  const handleEditCancel = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setEditing(false);
    setEditBody('');
  }, []);

  const handleEditSave = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      const trimmed = editBody.trim();
      if (!trimmed || editSubmitting) return;
      if (trimmed === comment.body) {
        setEditing(false);
        return;
      }

      setEditSubmitting(true);
      const result = await editComment(comment.id, trimmed, dayKey);
      setEditSubmitting(false);

      if (result) {
        setEditing(false);
        setEditBody('');
      }
    },
    [editBody, editSubmitting, comment.body, comment.id, dayKey, editComment]
  );

  const handleEditKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        setEditing(false);
        setEditBody('');
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleEditSave(e as unknown as React.MouseEvent);
      }
    },
    [handleEditSave]
  );

  const handleReply = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onReply(comment.id, comment.author_username);
    },
    [comment.id, comment.author_username, onReply]
  );

  const handleViewReplies = useCallback(() => {
    if (!repliesState) {
      fetchReplies(comment.id, true);
    }
    setShowAllReplies(true);
  }, [comment.id, repliesState, fetchReplies]);

  const handleLoadMoreReplies = useCallback(() => {
    fetchReplies(comment.id);
  }, [comment.id, fetchReplies]);

  const needsTruncation = !comment.is_deleted && comment.body.length > TRUNCATE_LENGTH;
  const displayBody =
    needsTruncation && !expanded ? comment.body.slice(0, TRUNCATE_LENGTH) + '...' : comment.body;

  const replies = repliesState?.comments || [];
  const visibleReplies = showAllReplies ? replies : replies.slice(0, INITIAL_REPLIES_SHOWN);
  const hasHiddenReplies =
    !showAllReplies &&
    (comment.reply_count > INITIAL_REPLIES_SHOWN || replies.length > INITIAL_REPLIES_SHOWN);
  const totalReplyCount = comment.reply_count;

  return (
    <>
      <div
        className={`${styles.comment} ${comment.is_deleted ? styles.deleted : ''} ${isTopLevel ? styles.topLevel : ''}`}
      >
        {/* Avatar */}
        {!comment.is_deleted && (
          <div
            className={styles.avatarWrap}
            onClick={() => navigateToProfile(comment.author_username)}
          >
            <Avatar name={comment.author_username} src={comment.author_avatar} size="sm" />
          </div>
        )}

        {/* Content */}
        <div className={styles.content}>
          {comment.is_deleted ? (
            <p className={`${styles.body} ${styles.deletedBody}`}>[Deleted]</p>
          ) : (
            <>
              {/* Username row */}
              <div className={styles.usernameRow}>
                <span
                  className={styles.username}
                  onClick={(e) => {
                    e.stopPropagation();
                    navigateToProfile(comment.author_username);
                  }}
                >
                  {isMe ? 'You' : comment.author_username}
                </span>
                {comment.author_verified && <VerifiedBadge size={14} />}
                <span className={styles.timestamp}>
                  {formatRelativeTime(comment.created_at)}
                  {comment.is_edited && <span className={styles.editedLabel}> (edited)</span>}
                </span>
              </div>

              {/* Reply indicator */}
              {comment.reply_to_username && (
                <div className={styles.replyIndicator}>
                  Replying to{' '}
                  <span
                    className={styles.replyUsername}
                    onClick={(e) => {
                      e.stopPropagation();
                      navigateToProfile(comment.reply_to_username!);
                    }}
                  >
                    @
                    {currentUser?.username === comment.reply_to_username
                      ? 'You'
                      : comment.reply_to_username}
                  </span>
                </div>
              )}

              {/* Body */}
              {editing ? (
                <div className={styles.editContainer}>
                  <textarea
                    ref={editTextareaRef}
                    className={styles.editTextarea}
                    value={editBody}
                    onChange={(e) => {
                      if (e.target.value.length <= MAX_COMMENT_LENGTH) {
                        setEditBody(e.target.value);
                      }
                    }}
                    onKeyDown={handleEditKeyDown}
                    maxLength={MAX_COMMENT_LENGTH}
                    rows={1}
                    aria-label="Edit comment"
                  />
                  <div className={styles.editFooter}>
                    {editBody.length > MAX_COMMENT_LENGTH * CHAR_COUNTER_THRESHOLD && (
                      <span className={styles.charCounter}>
                        {editBody.length}/{MAX_COMMENT_LENGTH}
                      </span>
                    )}
                    <div className={styles.editActions}>
                      <button
                        className={styles.editCancelBtn}
                        onClick={handleEditCancel}
                        aria-label="Cancel edit"
                        disabled={editSubmitting}
                      >
                        <X size={14} />
                      </button>
                      <button
                        className={styles.editSaveBtn}
                        onClick={handleEditSave}
                        aria-label="Save edit"
                        disabled={editSubmitting || !editBody.trim() || editBody.trim() === comment.body}
                      >
                        <Check size={14} />
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <p className={styles.body}>
                  {renderBody(displayBody, comment.mentions, navigateToProfile)}
                  {needsTruncation && !expanded && (
                    <>
                      {' '}
                      <button
                        className={styles.moreButton}
                        onClick={(e) => {
                          e.stopPropagation();
                          setExpanded(true);
                        }}
                      >
                        more
                      </button>
                    </>
                  )}
                </p>
              )}

              {/* Actions */}
              {!editing && (
              <div className={styles.actions}>
                {canEdit && withinEditWindow && (
                  <button
                    className={styles.editAction}
                    onClick={handleEditStart}
                    aria-label="Edit comment"
                    title="Edit"
                  >
                    <Pencil size={14} />
                  </button>
                )}

                {canDelete && (
                  <button
                    className={`${styles.deleteAction} ${deleteConfirm ? styles.deleteConfirm : ''}`}
                    onClick={handleDelete}
                    aria-label={deleteConfirm ? 'Tap again to delete' : 'Delete comment'}
                    title={deleteConfirm ? 'Tap again to delete' : 'Delete'}
                  >
                    <Trash2 size={14} />
                  </button>
                )}

                <button
                  className={`${styles.actionButton} ${comment.liked_by_me ? styles.liked : ''}`}
                  onClick={handleLikeToggle}
                  aria-label={comment.liked_by_me ? 'Unlike' : 'Like'}
                >
                  <Heart size={14} fill={comment.liked_by_me ? 'currentColor' : 'none'} />
                  {comment.like_count > 0 && <span>{comment.like_count}</span>}
                </button>

                <button className={styles.actionButton} onClick={handleReply} aria-label="Reply">
                  <Reply size={14} />
                  <span>Reply</span>
                </button>
              </div>
              )}
            </>
          )}

          {/* Replies section (top-level only) */}
          {isTopLevel && totalReplyCount > 0 && (
            <div className={styles.repliesSection}>
              {!showAllReplies && !repliesState ? (
                <button className={styles.viewRepliesBtn} onClick={handleViewReplies}>
                  <span className={styles.repliesLine} />
                  View {totalReplyCount} {totalReplyCount === 1 ? 'reply' : 'replies'}
                </button>
              ) : (
                <div className={styles.repliesContainer}>
                  {visibleReplies.map((reply) => (
                    <CommentItem
                      key={reply.id}
                      comment={reply}
                      dayKey={dayKey}
                      username={username}
                      date={date}
                      onReply={onReply}
                    />
                  ))}

                  {hasHiddenReplies && (
                    <button className={styles.viewRepliesBtn} onClick={handleViewReplies}>
                      <span className={styles.repliesLine} />
                      View {Math.max(1, totalReplyCount - INITIAL_REPLIES_SHOWN)} more{' '}
                      {Math.max(1, totalReplyCount - INITIAL_REPLIES_SHOWN) === 1
                        ? 'reply'
                        : 'replies'}
                    </button>
                  )}

                  {showAllReplies && repliesState?.hasMore && (
                    <button
                      className={styles.loadMoreReplies}
                      onClick={handleLoadMoreReplies}
                      disabled={repliesState.loading}
                    >
                      {repliesState.loading ? 'Loading...' : 'Load more replies'}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
};
