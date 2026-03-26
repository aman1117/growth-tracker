/**
 * CommentInput Component
 *
 * Fixed bottom bar with auto-expanding textarea, reply mode, and @mention autocomplete.
 * Character counter shown when >80% of limit used.
 */

import { Send, X } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { useCommentStore } from '../../../store/useCommentStore';
import { showError } from '../../../store/useToastStore';
import { MentionAutocomplete } from './MentionAutocomplete';
import styles from './CommentInput.module.css';

const MAX_LENGTH = 200;
const CHAR_COUNTER_THRESHOLD = 0.8; // Show at 80%

interface CommentInputProps {
  username: string;
  date: string;
  replyTarget: { commentId: number; username: string } | null;
  onCancelReply: () => void;
  onCommentPosted: () => void;
}

export const CommentInput: React.FC<CommentInputProps> = ({
  username,
  date,
  replyTarget,
  onCancelReply,
  onCommentPosted,
}) => {
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionStartIdx, setMentionStartIdx] = useState(-1);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const createComment = useCommentStore((s) => s.createComment);
  const createReply = useCommentStore((s) => s.createReply);

  // Auto-focus when reply target changes
  useEffect(() => {
    if (replyTarget && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [replyTarget]);

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
    }
  }, [body]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    if (value.length <= MAX_LENGTH) {
      setBody(value);
    }

    // Detect @mention trigger
    const cursorPos = e.target.selectionStart;
    const textUpToCursor = value.slice(0, cursorPos);
    const atMatch = textUpToCursor.match(/@([a-z0-9_.]{0,20})$/i);
    if (atMatch) {
      setMentionQuery(atMatch[1]);
      setMentionStartIdx(cursorPos - atMatch[0].length);
    } else {
      setMentionQuery(null);
      setMentionStartIdx(-1);
    }
  }, []);

  const handleMentionSelect = useCallback(
    (selectedUsername: string) => {
      const before = body.slice(0, mentionStartIdx);
      const after = body.slice(
        mentionStartIdx + (mentionQuery ? mentionQuery.length + 1 : 1)
      );
      const newBody = `${before}@${selectedUsername} ${after}`;
      setBody(newBody);
      setMentionQuery(null);
      setMentionStartIdx(-1);

      // Focus back on input
      setTimeout(() => {
        if (textareaRef.current) {
          const pos = mentionStartIdx + selectedUsername.length + 2;
          textareaRef.current.focus();
          textareaRef.current.setSelectionRange(pos, pos);
        }
      }, 0);
    },
    [body, mentionStartIdx, mentionQuery]
  );

  const handleSubmit = useCallback(async () => {
    const trimmed = body.trim();
    if (!trimmed || submitting) return;

    setSubmitting(true);
    try {
      let result;
      if (replyTarget) {
        result = await createReply(username, date, replyTarget.commentId, trimmed);
      } else {
        result = await createComment(username, date, trimmed);
      }

      if (result) {
        setBody('');
        setMentionQuery(null);
        setMentionStartIdx(-1);
        onCommentPosted();
      } else {
        showError('Failed to post comment');
      }
    } catch {
      showError('Failed to post comment');
    } finally {
      setSubmitting(false);
    }
  }, [body, submitting, replyTarget, username, date, createComment, createReply, onCommentPosted]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
      if (e.key === 'Escape' && replyTarget) {
        onCancelReply();
      }
    },
    [handleSubmit, replyTarget, onCancelReply]
  );

  const showCharCounter = body.length > MAX_LENGTH * CHAR_COUNTER_THRESHOLD;
  const isOverLimit = body.length >= MAX_LENGTH;
  const canSubmit = body.trim().length > 0 && !submitting;

  return (
    <div className={styles.container}>
      {/* Reply chip */}
      {replyTarget && (
        <div className={styles.replyChip}>
          <span className={styles.replyChipText}>
            Replying to{' '}
            <span className={styles.replyChipUsername}>@{replyTarget.username}</span>
          </span>
          <button
            className={styles.replyChipCancel}
            onClick={onCancelReply}
            aria-label="Cancel reply"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* Mention autocomplete */}
      {mentionQuery !== null && (
        <MentionAutocomplete
          query={mentionQuery}
          onSelect={handleMentionSelect}
          onClose={() => {
            setMentionQuery(null);
            setMentionStartIdx(-1);
          }}
        />
      )}

      {/* Input row */}
      <div className={styles.inputRow}>
        <textarea
          ref={textareaRef}
          className={styles.textarea}
          placeholder={replyTarget ? `Reply to @${replyTarget.username}...` : 'Add a comment...'}
          value={body}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          rows={1}
          maxLength={MAX_LENGTH}
          disabled={submitting}
          aria-label="Comment input"
        />

        <button
          className={styles.sendButton}
          onClick={handleSubmit}
          disabled={!canSubmit}
          aria-label="Post comment"
        >
          <Send size={18} />
        </button>
      </div>

      {/* Character counter */}
      {showCharCounter && (
        <div className={`${styles.charCounter} ${isOverLimit ? styles.charCounterWarning : ''}`}>
          {body.length}/{MAX_LENGTH}
        </div>
      )}
    </div>
  );
};
