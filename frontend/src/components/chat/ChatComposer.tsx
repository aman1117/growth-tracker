/**
 * ChatComposer
 *
 * The message input: an auto-growing textarea (up to about five lines), a send button, a
 * reply preview above it and a character counter near the limit. Enter sends on devices
 * with a keyboard (Shift+Enter for a new line); on touch screens Enter adds a line and the
 * button sends. Focus stays in the input after sending so the keyboard stays open.
 */

import { SendHorizontal, X } from 'lucide-react';
import type { RefObject } from 'react';
import React, { useId, useLayoutEffect, useState } from 'react';

import type { ChatThreadMessage } from '../../types/chat';
import { CHAT_COUNTER_FROM, CHAT_MAX_LENGTH, getQuoteText } from '../../utils/chat';
import styles from './ChatComposer.module.css';
import { useTypingSignal } from './useTypingSignal';

/** Height cap of the input (about five lines); it scrolls beyond that */
export const COMPOSER_MAX_HEIGHT_PX = 132;

export interface ChatComposerProps {
  peerName: string;
  /** The message being replied to */
  replyTo: ChatThreadMessage | null;
  /** "You" or the peer's name */
  replyAuthor: string;
  onCancelReply: () => void;
  onSend: (text: string) => void;
  onTyping: (isTyping: boolean) => void;
  /** The textarea, so the screen can focus it (e.g. after choosing Reply) */
  inputRef: RefObject<HTMLTextAreaElement | null>;
}

const isTouchDevice = (): boolean =>
  typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;

export const ChatComposer: React.FC<ChatComposerProps> = ({
  peerName,
  replyTo,
  replyAuthor,
  onCancelReply,
  onSend,
  onTyping,
  inputRef,
}) => {
  const counterId = useId();
  const [text, setText] = useState('');
  const typing = useTypingSignal(onTyping);
  const trimmedLength = text.trim().length;
  const tooLong = text.length > CHAT_MAX_LENGTH;
  const canSend = trimmedLength > 0 && !tooLong;
  const showCounter = text.length >= CHAT_COUNTER_FROM;

  // Grow with the text up to the cap, then scroll
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = 'auto';
    const height = Math.min(input.scrollHeight, COMPOSER_MAX_HEIGHT_PX);
    if (height > 0) input.style.height = `${height}px`;
    input.style.overflowY = input.scrollHeight > COMPOSER_MAX_HEIGHT_PX ? 'auto' : 'hidden';
  }, [text, inputRef]);

  const submit = () => {
    if (!canSend) return;
    onSend(text.trim());
    setText('');
    typing.stop();
    inputRef.current?.focus();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape' && replyTo) {
      event.preventDefault();
      onCancelReply();
      return;
    }
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    if (isTouchDevice()) return;
    event.preventDefault();
    submit();
  };

  return (
    <form
      className={styles.composer}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {replyTo && (
        <div className={styles.replyBar}>
          <div className={styles.replyText}>
            <span className={styles.replyAuthor}>Replying to {replyAuthor}</span>
            <span className={styles.replySnippet}>{getQuoteText(replyTo)}</span>
          </div>
          <button
            type="button"
            className={styles.replyCancel}
            onClick={() => {
              onCancelReply();
              inputRef.current?.focus();
            }}
            aria-label="Cancel reply"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      )}

      <div className={styles.inputRow}>
        <textarea
          ref={inputRef}
          className={styles.input}
          rows={1}
          value={text}
          placeholder={`Message ${peerName}`}
          aria-label={`Message ${peerName}`}
          aria-describedby={showCounter ? counterId : undefined}
          aria-invalid={tooLong || undefined}
          onChange={(event) => {
            setText(event.target.value);
            typing.onTextChange(event.target.value);
          }}
          onKeyDown={handleKeyDown}
          onBlur={typing.stop}
          enterKeyHint="send"
          autoComplete="off"
        />
        <button
          type="submit"
          className={styles.send}
          disabled={!canSend}
          aria-label="Send message"
          // Keep focus (and the on-screen keyboard) in the input
          onMouseDown={(event) => event.preventDefault()}
        >
          <SendHorizontal size={20} aria-hidden="true" />
        </button>
      </div>

      {showCounter && (
        <p
          id={counterId}
          className={`${styles.counter} ${tooLong ? styles.counterOver : ''}`}
          aria-live="polite"
        >
          {text.length}/{CHAT_MAX_LENGTH}
        </p>
      )}
    </form>
  );
};

export default ChatComposer;
