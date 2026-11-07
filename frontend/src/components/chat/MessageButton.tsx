/**
 * MessageButton
 *
 * "Message" on another user's profile, next to Follow: opens (or creates) the 1:1
 * conversation and navigates to it. People can message each other when either follows the
 * other; otherwise the server refuses and the button explains why.
 */

import { MessageCircle } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { APP_ROUTES } from '../../constants/routes';
import { useChatStore } from '../../store/useChatStore';
import { getChatErrorMessage } from '../../utils/chat';
import { SnapToast } from '../ui';
import styles from './MessageButton.module.css';

export interface MessageButtonProps {
  userId: number;
  username: string;
  className?: string;
}

export const MessageButton: React.FC<MessageButtonProps> = ({ userId, username, className }) => {
  const navigate = useNavigate();
  const startConversation = useChatStore((state) => state.startConversation);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const handleClick = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const conversation = await startConversation(userId);
      if (mountedRef.current) navigate(APP_ROUTES.CHAT(conversation.id));
    } catch (failure) {
      if (mountedRef.current) setError(getChatErrorMessage(failure, 'start'));
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className={`${styles.button} ${className ?? ''}`}
        onClick={handleClick}
        disabled={busy}
        aria-busy={busy || undefined}
        aria-label={`Message ${username}`}
      >
        {busy ? (
          <span className={styles.spinner} aria-hidden="true" />
        ) : (
          <MessageCircle size={16} strokeWidth={2.5} aria-hidden="true" />
        )}
        <span className={styles.label}>Message</span>
      </button>
      {error && <SnapToast message={error} type="error" onClose={() => setError(null)} />}
    </>
  );
};

export default MessageButton;
