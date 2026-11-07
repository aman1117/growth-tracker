/**
 * ChatHeaderButton
 *
 * The header's entry to direct messages, next to the notification bell and styled like it:
 * a chat icon with the number of unread conversations. It keeps the count fresh on mount
 * and whenever the app regains focus (real-time events update it in between).
 */

import { MessageCircle } from 'lucide-react';
import React, { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

import { APP_ROUTES } from '../../constants/routes';
import { useOverlayAwareNavigate } from '../../hooks/useOverlayAwareNavigate';
import { useRefreshOnFocus } from '../../hooks/useRefreshOnFocus';
import { chatLog } from '../../services/chatLog';
import { useChatStore } from '../../store/useChatStore';
import bellStyles from '../ui/Notification/Notification.module.css';

export const ChatHeaderButton: React.FC = () => {
  const navigate = useOverlayAwareNavigate();
  const { pathname } = useLocation();
  const unread = useChatStore((state) => state.unreadConversations);
  const fetchUnreadCount = useChatStore((state) => state.fetchUnreadCount);
  const isOnInbox = pathname === APP_ROUTES.CHATS;

  useEffect(() => {
    void fetchUnreadCount();
  }, [fetchUnreadCount]);

  useRefreshOnFocus(() => void fetchUnreadCount());

  const label = `Messages${unread > 0 ? ` (${unread} unread)` : ''}`;

  return (
    <button
      type="button"
      className={`${bellStyles.bellButton} ${isOnInbox ? bellStyles.bellActive : ''}`}
      onClick={() => {
        chatLog.debug('inbox_opened', { source: 'header', unread });
        navigate(APP_ROUTES.CHATS);
      }}
      aria-label={label}
      aria-current={isOnInbox ? 'page' : undefined}
    >
      <MessageCircle size={20} strokeWidth={2} aria-hidden="true" />
      {unread > 0 && (
        <span className={bellStyles.badge} aria-hidden="true">
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </button>
  );
};

export default ChatHeaderButton;
