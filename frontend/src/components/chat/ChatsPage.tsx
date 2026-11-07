/**
 * ChatsPage (/chats)
 *
 * The direct-messages inbox: one row per conversation, newest activity first, with live
 * previews, typing, unread counts and ticks. Loads more rows as the end comes into view,
 * refreshes on pull, on focus and when the WebSocket reconnects, and starts new chats.
 */

import { CircleAlert, MessageCircle, Plus, RefreshCw, SquarePen } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { APP_ROUTES } from '../../constants/routes';
import { useRefreshOnFocus } from '../../hooks/useRefreshOnFocus';
import { useSmartBack } from '../../hooks/useSmartBack';
import { chatLog } from '../../services/chatLog';
import { useAuth } from '../../store';
import { useChatStore } from '../../store/useChatStore';
import { compareConversations } from '../../utils/chat';
import {
  Button,
  EmptyState,
  IconButton,
  PageHeader,
  PullToRefreshWrapper,
  SkeletonCard,
} from '../ui';
import styles from './ChatsPage.module.css';
import { ConversationRow } from './ConversationRow';
import { NewChatSheet } from './NewChatSheet';

export const ChatsPage: React.FC = () => {
  const { user } = useAuth();
  const goBack = useSmartBack(APP_ROUTES.HOME);
  const conversations = useChatStore((state) => state.conversations);
  const typing = useChatStore((state) => state.typing);
  const status = useChatStore((state) => state.inboxStatus);
  const hasMore = useChatStore((state) => state.inboxHasMore);
  const loadingMore = useChatStore((state) => state.inboxLoadingMore);
  const moreError = useChatStore((state) => state.inboxMoreError);
  const fetchInbox = useChatStore((state) => state.fetchInbox);
  const loadMoreInbox = useChatStore((state) => state.loadMoreInbox);
  const fetchUnreadCount = useChatStore((state) => state.fetchUnreadCount);
  const [isNewOpen, setIsNewOpen] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);
  // Relative times ("Yesterday", weekday) are worked out against the last refresh
  const [now, setNow] = useState(() => new Date());

  const refresh = useCallback(async () => {
    setNow(new Date());
    await Promise.all([fetchInbox({ force: true }), fetchUnreadCount()]);
  }, [fetchInbox, fetchUnreadCount]);

  useEffect(() => {
    chatLog.debug('inbox_viewed');
    void fetchInbox({ force: true });
  }, [fetchInbox]);

  useRefreshOnFocus(() => void refresh(), { enabled: status === 'ready' });

  const inbox = useMemo(
    () =>
      Object.values(conversations)
        .filter((conversation) => conversation.last_message !== null)
        .sort(compareConversations),
    [conversations]
  );

  // Infinite scroll: load the next page once the end of the list is near
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore || moreError) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadMoreInbox();
      },
      { rootMargin: '200px 0px' }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, moreError, loadMoreInbox, inbox.length]);

  const openNewChat = (source: 'header' | 'empty_state') => {
    chatLog.debug('new_chat_opened', { source });
    setIsNewOpen(true);
  };

  const renderContent = () => {
    if (inbox.length === 0 && (status === 'idle' || status === 'loading')) {
      return (
        <div className={styles.skeletons} aria-hidden="true">
          <SkeletonCard lines={2} />
          <SkeletonCard lines={2} />
          <SkeletonCard lines={2} />
          <SkeletonCard lines={2} />
        </div>
      );
    }

    if (inbox.length === 0 && status === 'error') {
      return (
        <section className={styles.stateCard} role="alert">
          <EmptyState
            icon={<CircleAlert size={26} />}
            title="Couldn't load your messages"
            description="Check your connection and try again."
            action={{
              label: 'Try again',
              icon: <RefreshCw size={16} />,
              onClick: () => void refresh(),
            }}
          />
        </section>
      );
    }

    if (inbox.length === 0) {
      return (
        <section className={styles.stateCard}>
          <EmptyState
            icon={<MessageCircle size={26} />}
            title="No messages yet"
            description="Chat one-on-one with people you follow or who follow you."
            action={{
              label: 'Start a chat',
              icon: <Plus size={16} />,
              onClick: () => openNewChat('empty_state'),
            }}
          />
        </section>
      );
    }

    return (
      <section className={styles.listCard} aria-label="Conversations">
        <ul className={styles.list}>
          {inbox.map((conversation) => (
            <ConversationRow
              key={conversation.id}
              conversation={conversation}
              isTyping={!!typing[conversation.id]}
              now={now}
            />
          ))}
        </ul>
        {hasMore && <div ref={sentinelRef} className={styles.sentinel} aria-hidden="true" />}
        {loadingMore && (
          <div className={styles.more} role="status">
            <span className={styles.spinner} aria-hidden="true" />
            <span className="sr-only">Loading more conversations</span>
          </div>
        )}
        {moreError && (
          <div className={styles.more}>
            <Button
              size="sm"
              variant="secondary"
              icon={<RefreshCw size={15} />}
              onClick={() => void loadMoreInbox()}
            >
              Load more
            </Button>
          </div>
        )}
      </section>
    );
  };

  return (
    <div className={styles.page} aria-busy={status === 'loading'}>
      <PullToRefreshWrapper onRefresh={refresh} disabled={status !== 'ready' || isNewOpen}>
        <PageHeader
          title="Messages"
          onBack={goBack}
          actions={
            <IconButton
              variant="glass"
              size="lg"
              icon={<SquarePen size={20} />}
              aria-label="New message"
              onClick={() => openNewChat('header')}
            />
          }
        />
        {renderContent()}
      </PullToRefreshWrapper>

      {user && (
        <NewChatSheet isOpen={isNewOpen} onClose={() => setIsNewOpen(false)} meId={user.id} />
      )}
    </div>
  );
};

export default ChatsPage;
