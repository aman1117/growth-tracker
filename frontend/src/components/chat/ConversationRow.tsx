/**
 * ConversationRow
 *
 * One inbox entry: the peer's avatar and name, the last message (or "typing…" while they
 * type), when it was sent, ticks on my own last message and the unread count.
 */

import React from 'react';
import { Link } from 'react-router-dom';

import { APP_ROUTES } from '../../constants/routes';
import type { ChatConversation } from '../../types/chat';
import { formatInboxTime, getConversationPreview, getTickStatus } from '../../utils/chat';
import { Avatar, VerifiedBadge } from '../ui';
import styles from './ChatsPage.module.css';
import { MessageTicks } from './MessageTicks';

export interface ConversationRowProps {
  conversation: ChatConversation;
  isTyping: boolean;
  now: Date;
}

export const ConversationRow: React.FC<ConversationRowProps> = ({
  conversation,
  isTyping,
  now,
}) => {
  const { peer, last_message: last, unread_count: unread } = conversation;
  const preview = getConversationPreview(conversation);
  const hasUnread = unread > 0;
  const time = last?.created_at ?? conversation.updated_at;

  return (
    <li>
      <Link
        to={APP_ROUTES.CHAT(conversation.id)}
        className={`${styles.row} ${hasUnread ? styles.rowUnread : ''}`}
      >
        <Avatar src={peer.profile_pic} name={peer.username} size="lg" />
        <span className={styles.rowBody}>
          <span className={styles.rowTop}>
            <span className={styles.rowName}>
              <span className={styles.rowUsername}>{peer.username}</span>
              {peer.is_verified && <VerifiedBadge size={14} />}
            </span>
            <time className={styles.rowTime} dateTime={time}>
              {formatInboxTime(time, now)}
            </time>
          </span>
          <span className={styles.rowBottom}>
            {isTyping ? (
              <span className={`${styles.rowPreview} ${styles.rowTyping}`}>typing…</span>
            ) : (
              <span
                className={`${styles.rowPreview} ${preview.isDeleted ? styles.rowDeleted : ''}`}
              >
                {preview.isMine && last && !last.is_deleted && (
                  <MessageTicks
                    status={getTickStatus(last, conversation)}
                    size={14}
                    className={styles.rowTicks}
                  />
                )}
                {preview.isMine && <span className={styles.rowYou}>You: </span>}
                {preview.text}
              </span>
            )}
            {hasUnread && (
              <>
                <span className={styles.unreadPill} aria-hidden="true">
                  {unread > 99 ? '99+' : unread}
                </span>
                <span className="sr-only">, {unread} unread</span>
              </>
            )}
          </span>
        </span>
      </Link>
    </li>
  );
};

export default ConversationRow;
