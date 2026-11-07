/**
 * MessageBubble
 *
 * One message in a thread, WhatsApp-style: my messages on the right in the accent color,
 * the peer's on the left on glass; grouped runs get tighter spacing and corners. Shows the
 * quoted message (tap to jump to it), the time and ticks inside the bubble, reactions as a
 * chip on its edge, and a retry affordance when sending failed.
 *
 * Interactions: long-press (touch), right-click, the "more" button (hover/focus) or
 * Enter / the context-menu key on the focused bubble open the actions menu; swiping right
 * replies; double-tapping a peer's message reacts with ❤️.
 */

import { Ban, CircleAlert, Ellipsis, Reply } from 'lucide-react';
import React, { memo, useEffect, useRef, useState } from 'react';

import type { ChatThreadMessage, ChatTickStatus } from '../../types/chat';
import {
  CHAT_DELETED_TEXT,
  formatClockTime,
  getQuoteText,
  isEmojiOnly,
  isPendingMessage,
  summarizeReactions,
} from '../../utils/chat';
import { getMessageElementId } from './chatHelpers';
import styles from './MessageBubble.module.css';
import { MessageTicks } from './MessageTicks';

export const LONG_PRESS_MS = 400;
export const SWIPE_REPLY_THRESHOLD_PX = 60;
const SWIPE_MAX_PX = 90;
const MOVE_TOLERANCE_PX = 10;
export const DOUBLE_TAP_MS = 300;

export type MenuSource = 'long_press' | 'context_menu' | 'keyboard' | 'button';

export interface MessageBubbleProps {
  message: ChatThreadMessage;
  isMine: boolean;
  isFirstInGroup: boolean;
  isLastInGroup: boolean;
  meId: number;
  peerName: string;
  /** Ticks for my messages; null for the peer's */
  tickStatus: ChatTickStatus | null;
  highlighted?: boolean;
  /** Replying is possible (confirmed, not deleted, conversation open for messages) */
  canReply: boolean;
  onOpenMenu: (message: ChatThreadMessage, anchor: DOMRect | null, source: MenuSource) => void;
  onReply: (message: ChatThreadMessage) => void;
  onQuoteClick: (messageId: number) => void;
  onReactionsClick: (message: ChatThreadMessage) => void;
  onDoubleTap: (message: ChatThreadMessage) => void;
  onRetry: (message: ChatThreadMessage) => void;
}

interface PressState {
  pointerId: number;
  startX: number;
  startY: number;
  swiping: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

const vibrate = () => {
  try {
    navigator.vibrate?.(10);
  } catch {
    // Some browsers throw when vibration is blocked; feedback is optional
  }
};

/** Swipe distance shown for a finger movement: 1:1 up to the threshold, then resisting */
const toSwipeOffset = (dx: number): number => {
  if (dx <= 0) return 0;
  if (dx <= SWIPE_REPLY_THRESHOLD_PX) return dx;
  return Math.min(SWIPE_MAX_PX, SWIPE_REPLY_THRESHOLD_PX + (dx - SWIPE_REPLY_THRESHOLD_PX) * 0.3);
};

const MessageBubbleComponent: React.FC<MessageBubbleProps> = ({
  message,
  isMine,
  isFirstInGroup,
  isLastInGroup,
  meId,
  peerName,
  tickStatus,
  highlighted = false,
  canReply,
  onOpenMenu,
  onReply,
  onQuoteClick,
  onReactionsClick,
  onDoubleTap,
  onRetry,
}) => {
  const bubbleRef = useRef<HTMLDivElement>(null);
  const pressRef = useRef<PressState | null>(null);
  const longPressedRef = useRef(false);
  const lastTapRef = useRef(0);
  const [swipeOffset, setSwipeOffset] = useState(0);

  const deleted = message.is_deleted;
  const pending = isPendingMessage(message);
  const failed = message.send_status === 'failed';
  const hasMenu = !deleted;
  const reactions = summarizeReactions(message.reactions, meId);
  const totalReactions = message.reactions.length;
  const big = !deleted && isEmojiOnly(message.body);

  useEffect(
    () => () => {
      if (pressRef.current?.timer) clearTimeout(pressRef.current.timer);
    },
    []
  );

  const anchor = () => bubbleRef.current?.getBoundingClientRect() ?? null;

  const cancelPress = () => {
    const press = pressRef.current;
    if (press?.timer) clearTimeout(press.timer);
    pressRef.current = null;
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'touch' || deleted) return;
    cancelPress();
    longPressedRef.current = false;
    pressRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      swiping: false,
      timer: setTimeout(() => {
        if (!pressRef.current) return;
        pressRef.current.timer = null;
        longPressedRef.current = true;
        vibrate();
        onOpenMenu(message, anchor(), 'long_press');
      }, LONG_PRESS_MS),
    };
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const press = pressRef.current;
    if (!press || press.pointerId !== event.pointerId) return;
    const dx = event.clientX - press.startX;
    const dy = event.clientY - press.startY;
    if (!press.swiping) {
      if (Math.abs(dx) < MOVE_TOLERANCE_PX && Math.abs(dy) < MOVE_TOLERANCE_PX) return;
      if (press.timer) clearTimeout(press.timer);
      press.timer = null;
      // Only a mostly-horizontal drag to the right replies; anything else is a scroll
      if (!canReply || dx <= 0 || Math.abs(dx) <= Math.abs(dy)) {
        pressRef.current = null;
        return;
      }
      press.swiping = true;
    }
    setSwipeOffset(toSwipeOffset(dx));
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const press = pressRef.current;
    if (!press || press.pointerId !== event.pointerId) return;
    const dx = event.clientX - press.startX;
    cancelPress();
    if (press.swiping) {
      setSwipeOffset(0);
      if (dx >= SWIPE_REPLY_THRESHOLD_PX) {
        vibrate();
        onReply(message);
      }
    }
  };

  const handlePointerCancel = () => {
    cancelPress();
    setSwipeOffset(0);
  };

  const handleClick = () => {
    if (longPressedRef.current) {
      // The tap that ended a long-press already opened the menu
      longPressedRef.current = false;
      return;
    }
    if (isMine || deleted || pending) return;
    const now = Date.now();
    if (now - lastTapRef.current <= DOUBLE_TAP_MS) {
      lastTapRef.current = 0;
      onDoubleTap(message);
      return;
    }
    lastTapRef.current = now;
  };

  const handleContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!hasMenu) return;
    event.preventDefault();
    // A touch long-press opens the menu itself; the browser's contextmenu that follows is ignored
    if (longPressedRef.current) return;
    onOpenMenu(message, anchor(), 'context_menu');
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || !hasMenu) return;
    const opensMenu =
      event.key === 'Enter' ||
      event.key === ' ' ||
      event.key === 'ContextMenu' ||
      (event.key === 'F10' && event.shiftKey);
    if (!opensMenu) return;
    event.preventDefault();
    onOpenMenu(message, anchor(), 'keyboard');
  };

  const quote = message.reply_to;
  const quoteAuthor = quote ? (quote.sender_id === meId ? 'You' : peerName) : '';
  const time = pending ? '' : formatClockTime(message.created_at);
  const reactionLabel = `Reactions: ${reactions
    .map((reaction) => `${reaction.emoji} ${reaction.count}`)
    .join(', ')}`;

  const rowClasses = [
    styles.row,
    isMine ? styles.mine : styles.theirs,
    isFirstInGroup ? styles.first : '',
    isLastInGroup ? styles.last : '',
    totalReactions > 0 ? styles.hasReactions : '',
    highlighted ? styles.highlighted : '',
    swipeOffset > 0 ? styles.swiping : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={rowClasses} id={getMessageElementId(message.id)} data-message-id={message.id}>
      <span
        className={styles.swipeIcon}
        style={{
          opacity: Math.min(1, swipeOffset / SWIPE_REPLY_THRESHOLD_PX),
          transform: `scale(${swipeOffset >= SWIPE_REPLY_THRESHOLD_PX ? 1.15 : 0.85})`,
        }}
        aria-hidden="true"
      >
        <Reply size={18} />
      </span>

      <div
        className={styles.track}
        style={swipeOffset > 0 ? { transform: `translateX(${swipeOffset}px)` } : undefined}
      >
        <div
          ref={bubbleRef}
          className={`${styles.bubble} ${big ? styles.emojiBubble : ''} ${
            deleted ? styles.deletedBubble : ''
          } ${pending && !failed ? styles.pendingBubble : ''}`}
          tabIndex={0}
          role="article"
          aria-roledescription="message"
          aria-describedby={failed ? `${getMessageElementId(message.id)}-failed` : undefined}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          onClick={handleClick}
          onContextMenu={handleContextMenu}
          onKeyDown={handleKeyDown}
        >
          <span className="sr-only">{isMine ? 'You' : peerName}: </span>

          {quote && !deleted && (
            <button
              type="button"
              className={styles.quote}
              onClick={(event) => {
                event.stopPropagation();
                onQuoteClick(quote.id);
              }}
              aria-label={`Reply to ${quoteAuthor}: ${getQuoteText(quote)}. Show original message`}
            >
              <span className={styles.quoteAuthor}>{quoteAuthor}</span>
              <span className={`${styles.quoteText} ${quote.is_deleted ? styles.italic : ''}`}>
                {getQuoteText(quote)}
              </span>
            </button>
          )}

          <div className={styles.content}>
            {deleted ? (
              <span className={styles.deletedText}>
                <Ban size={14} aria-hidden="true" />
                {CHAT_DELETED_TEXT}
              </span>
            ) : (
              <span className={big ? styles.emojiText : styles.text}>{message.body}</span>
            )}
            <span className={isMine ? styles.metaSpacerMine : styles.metaSpacer} aria-hidden />
            <span className={styles.meta}>
              {time && (
                <time dateTime={message.created_at} className={styles.time}>
                  {time}
                </time>
              )}
              {isMine && tickStatus && !deleted && <MessageTicks status={tickStatus} size={15} />}
            </span>
          </div>
        </div>

        {hasMenu && (
          <button
            type="button"
            className={styles.moreButton}
            aria-label="Message actions"
            aria-haspopup="menu"
            onClick={(event) => {
              event.stopPropagation();
              onOpenMenu(message, anchor(), 'button');
            }}
          >
            <Ellipsis size={16} aria-hidden="true" />
          </button>
        )}

        {totalReactions > 0 && !deleted && (
          <button
            type="button"
            className={styles.reactions}
            onClick={(event) => {
              event.stopPropagation();
              onReactionsClick(message);
            }}
            aria-label={reactionLabel}
          >
            {reactions.slice(0, 3).map((reaction) => (
              <span
                key={reaction.emoji}
                className={reaction.mine ? styles.myReaction : undefined}
                aria-hidden="true"
              >
                {reaction.emoji}
              </span>
            ))}
            {totalReactions > 1 && (
              <span className={styles.reactionCount} aria-hidden="true">
                {totalReactions}
              </span>
            )}
          </button>
        )}
      </div>

      {failed && (
        <button
          type="button"
          id={`${getMessageElementId(message.id)}-failed`}
          className={styles.retry}
          onClick={() => onRetry(message)}
        >
          <CircleAlert size={14} strokeWidth={2.4} aria-hidden="true" />
          <span>{message.send_error ?? 'Not sent.'} Tap to retry</span>
        </button>
      )}
    </div>
  );
};

export const MessageBubble = memo(MessageBubbleComponent);

export default MessageBubble;
