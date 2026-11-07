/**
 * useTypingSignal
 *
 * Tells the peer the user is typing, without flooding the server: `true` at most every
 * few seconds while the text changes, `false` once the input is cleared, the message is
 * sent, the input loses focus or the screen goes away.
 */

import { useCallback, useEffect, useRef } from 'react';

import { TYPING_SEND_INTERVAL_MS } from '../../utils/chat';

export interface TypingSignal {
  /** Call with the composer's text after every change */
  onTextChange: (text: string) => void;
  /** The user stopped typing (sent, cleared, blurred) */
  stop: () => void;
}

export function useTypingSignal(send: (isTyping: boolean) => void): TypingSignal {
  const sendRef = useRef(send);
  /** When `true` was last sent; 0 while the peer thinks we are not typing */
  const lastSentAtRef = useRef(0);

  useEffect(() => {
    sendRef.current = send;
  }, [send]);

  const stop = useCallback(() => {
    if (lastSentAtRef.current === 0) return;
    lastSentAtRef.current = 0;
    sendRef.current(false);
  }, []);

  const onTextChange = useCallback(
    (text: string) => {
      if (!text.trim()) {
        stop();
        return;
      }
      const now = Date.now();
      if (lastSentAtRef.current !== 0 && now - lastSentAtRef.current < TYPING_SEND_INTERVAL_MS) {
        return;
      }
      lastSentAtRef.current = now;
      sendRef.current(true);
    },
    [stop]
  );

  useEffect(() => stop, [stop]);

  return { onTextChange, stop };
}
