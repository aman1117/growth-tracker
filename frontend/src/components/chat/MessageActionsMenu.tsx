/**
 * MessageActionsMenu
 *
 * The overlay a long-press / right-click / "more" opens on a message: a quick-reaction bar
 * (❤️ 😂 😮 😢 🙏 👍) and actions — Reply, Copy, Unsend (mine only), or Retry / Delete for
 * a message that failed to send. Placed next to the message, keyboard navigable (arrow keys
 * move within the reaction bar and the action list), closed by Escape, Back or a tap outside.
 */

import { Copy, CornerUpLeft, RotateCcw, Trash2, Undo2 } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useBackDismiss } from '../../hooks/useBackDismiss';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import { CHAT_QUICK_REACTIONS } from '../../utils/chat';
import { handleRovingKeyDown } from '../../utils/rovingFocus';
import { getMenuPosition } from './chatHelpers';
import styles from './MessageActionsMenu.module.css';

export type MessageAction = 'reply' | 'copy' | 'unsend' | 'retry' | 'discard';

export interface MessageActionsMenuProps {
  /** Where the message is on screen; the menu is centered when unknown */
  anchor: DOMRect | null;
  isMine: boolean;
  /** My current reaction on the message */
  myReaction: string | null;
  canReact: boolean;
  actions: MessageAction[];
  onReact: (emoji: string | null) => void;
  onAction: (action: MessageAction) => void;
  onClose: () => void;
}

const ACTION_META: Record<MessageAction, { label: string; icon: React.ReactNode }> = {
  reply: { label: 'Reply', icon: <CornerUpLeft size={18} /> },
  copy: { label: 'Copy', icon: <Copy size={18} /> },
  unsend: { label: 'Unsend', icon: <Undo2 size={18} /> },
  retry: { label: 'Try again', icon: <RotateCcw size={18} /> },
  discard: { label: 'Delete', icon: <Trash2 size={18} /> },
};

export const MessageActionsMenu: React.FC<MessageActionsMenuProps> = ({
  anchor,
  isMine,
  myReaction,
  canReact,
  actions,
  onReact,
  onAction,
  onClose,
}) => {
  const panelRef = useRef<HTMLDivElement>(null);
  const [activeReaction, setActiveReaction] = useState(() => {
    const index = CHAT_QUICK_REACTIONS.findIndex((emoji) => emoji === myReaction);
    return index === -1 ? 0 : index;
  });

  useEscapeKey(true, onClose);
  useBackDismiss(true, onClose);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const first = panelRef.current?.querySelector<HTMLElement>('[data-autofocus="true"]');
    first?.focus({ preventScroll: true });
    const panel = panelRef.current;
    return () => {
      // Give focus back unless an action already moved it on purpose (e.g. Reply → composer)
      const active = document.activeElement;
      const focusWasInMenu = !active || active === document.body || !!panel?.contains(active);
      if (focusWasInMenu && previouslyFocused?.isConnected) {
        previouslyFocused.focus({ preventScroll: true });
      }
    };
  }, []);

  const handleActionKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const delta = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    const items = panelRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]');
    if (!items || items.length === 0) return;
    if (delta !== 0) {
      event.preventDefault();
      items[(index + delta + items.length) % items.length]?.focus();
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      items[event.key === 'Home' ? 0 : items.length - 1]?.focus();
    }
  };

  const position = getMenuPosition(anchor, isMine, {
    width: window.innerWidth,
    height: window.innerHeight,
  });

  return createPortal(
    <div
      className={styles.backdrop}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Message actions"
        className={`${styles.panel} ${position ? '' : styles.centered} ${
          isMine ? styles.alignEnd : ''
        }`}
        style={position}
      >
        {canReact && (
          <div className={styles.reactions} role="group" aria-label="React">
            {CHAT_QUICK_REACTIONS.map((emoji, index) => {
              const selected = myReaction === emoji;
              return (
                <button
                  key={emoji}
                  type="button"
                  className={`${styles.reaction} ${selected ? styles.reactionSelected : ''}`}
                  aria-label={selected ? `Remove ${emoji} reaction` : `React ${emoji}`}
                  aria-pressed={selected}
                  tabIndex={index === activeReaction ? 0 : -1}
                  data-autofocus={index === activeReaction ? 'true' : undefined}
                  onKeyDown={(event) => handleRovingKeyDown(event, index, setActiveReaction)}
                  onClick={() => onReact(selected ? null : emoji)}
                >
                  {emoji}
                </button>
              );
            })}
          </div>
        )}

        {actions.length > 0 && (
          <div className={styles.actions} role="menu" aria-label="Actions">
            {actions.map((action, index) => (
              <button
                key={action}
                type="button"
                role="menuitem"
                className={`${styles.action} ${
                  action === 'unsend' || action === 'discard' ? styles.danger : ''
                }`}
                data-autofocus={!canReact && index === 0 ? 'true' : undefined}
                onKeyDown={(event) => handleActionKeyDown(event, index)}
                onClick={() => onAction(action)}
              >
                <span>{ACTION_META[action].label}</span>
                <span className={styles.actionIcon} aria-hidden="true">
                  {ACTION_META[action].icon}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
};

export default MessageActionsMenu;
