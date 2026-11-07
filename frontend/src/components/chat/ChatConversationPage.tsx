/**
 * ChatConversationPage (/chats/:id)
 *
 * A 1:1 conversation: header with the peer (tap for their profile) and "typing…", the
 * message thread and the composer. The thread opens at the first unread message (with an
 * "N unread messages" divider) or at the bottom, loads history when scrolled to the top
 * without jumping, follows new messages while the user is at the bottom and otherwise offers
 * a "↓ N new" pill. Messages are marked read once the newest ones are on screen and the page
 * is visible.
 */

import { ArrowDown, ArrowLeft, MessageCircle, MessageCircleOff, RefreshCw } from 'lucide-react';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { APP_ROUTES } from '../../constants/routes';
import { useOfflineStatus } from '../../hooks/useOfflineStatus';
import { useRefreshOnFocus } from '../../hooks/useRefreshOnFocus';
import { useSmartBack } from '../../hooks/useSmartBack';
import { chatLog } from '../../services/chatLog';
import { useAuth } from '../../store';
import { useChatStore } from '../../store/useChatStore';
import type { ChatThreadMessage } from '../../types/chat';
import {
  buildThreadItems,
  CHAT_DOUBLE_TAP_REACTION,
  getChatErrorMessage,
  getMessageKey,
  getMyReaction,
  getTickStatus,
  isNearBottom,
  isPeerMessage,
  isPendingMessage,
} from '../../utils/chat';
import { copyText } from '../../utils/share';
import {
  Avatar,
  Button,
  ConfirmDialog,
  EmptyState,
  IconButton,
  Skeleton,
  SnapToast,
  type SnapToastType,
  VerifiedBadge,
} from '../ui';
import { ChatComposer } from './ChatComposer';
import styles from './ChatConversationPage.module.css';
import { getMessageElementId, parseConversationId } from './chatHelpers';
import { type MessageAction, MessageActionsMenu } from './MessageActionsMenu';
import { type MenuSource, MessageBubble } from './MessageBubble';
import { ReactionDetailsSheet } from './ReactionDetailsSheet';

/** Debounce before telling the server what was read */
export const READ_DEBOUNCE_MS = 400;
/** Scrolling this close to the top loads older messages */
const LOAD_OLDER_THRESHOLD_PX = 160;
/** Space kept above the unread divider when the thread opens there */
const DIVIDER_OFFSET_PX = 16;
/** How long a message stays highlighted after jumping to it */
export const HIGHLIGHT_MS = 1600;
/** Older pages loaded at most when jumping to a quoted message */
const MAX_JUMP_PAGES = 5;

const EMPTY_MESSAGES: ChatThreadMessage[] = [];
const chat = () => useChatStore.getState();

const prefersReducedMotion = () =>
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

interface ScrollState {
  initialized: boolean;
  firstKey: string | null;
  lastKey: string | null;
  scrollHeight: number;
  nearBottom: boolean;
}

interface ToastState {
  message: string;
  type: SnapToastType;
}

const NotFound: React.FC = () => (
  <div className={styles.statePage}>
    <section className={styles.stateCard} role="alert">
      <EmptyState
        icon={<MessageCircleOff size={26} />}
        title="Chat not found"
        description="This conversation doesn't exist or you're not part of it."
      />
      <Link to={APP_ROUTES.CHATS} className={styles.stateLink}>
        Back to messages
      </Link>
    </section>
  </div>
);

const ThreadSkeleton: React.FC = () => (
  <div className={styles.skeleton} aria-hidden="true">
    {[60, 40, 72, 52, 36].map((width, index) => (
      <div key={index} className={index % 2 ? styles.skeletonMine : styles.skeletonTheirs}>
        <Skeleton width={`${width}%`} height={38} radius="xl" />
      </div>
    ))}
  </div>
);

const ConversationScreen: React.FC<{ id: number }> = ({ id }) => {
  const { user } = useAuth();
  const meId = user?.id ?? 0;
  const goBack = useSmartBack(APP_ROUTES.CHATS);
  const isOffline = useOfflineStatus();

  const conversation = useChatStore((state) => state.conversations[id]);
  const conversationStatus = useChatStore((state) => state.conversationStatus[id] ?? 'idle');
  const thread = useChatStore((state) => state.threads[id]);
  const peerTyping = useChatStore((state) => !!state.typing[id]);

  const messages = thread?.messages ?? EMPTY_MESSAGES;
  const threadStatus = thread?.status ?? 'idle';
  const peerId = conversation?.peer.id ?? 0;
  const canMessage = conversation?.can_message !== false;

  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<ScrollState>({
    initialized: false,
    firstKey: null,
    lastKey: null,
    scrollHeight: 0,
    nearBottom: true,
  });
  const readTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [unreadAnchor, setUnreadAnchor] = useState<number | null | undefined>(undefined);
  const [replyTo, setReplyTo] = useState<ChatThreadMessage | null>(null);
  const [menu, setMenu] = useState<{ key: string; anchor: DOMRect | null } | null>(null);
  const [reactionsKey, setReactionsKey] = useState<string | null>(null);
  const [unsendId, setUnsendId] = useState<number | null>(null);
  const [unsending, setUnsending] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [highlightId, setHighlightId] = useState<number | null>(null);
  const [jumpTarget, setJumpTarget] = useState<number | null>(null);
  const [newCount, setNewCount] = useState(0);
  const [awayFromBottom, setAwayFromBottom] = useState(false);

  // ---------- Loading ----------

  useEffect(() => {
    void chat().openConversation(id);
    return () => chat().closeConversation(id);
  }, [id]);

  useRefreshOnFocus(() => void chat().refreshConversation(id), {
    enabled: threadStatus === 'ready',
  });

  // Back online: catch up on what was missed
  const wasOfflineRef = useRef(isOffline);
  useEffect(() => {
    if (wasOfflineRef.current && !isOffline) void chat().refreshConversation(id);
    wasOfflineRef.current = isOffline;
  }, [isOffline, id]);

  // Where the unread messages start: known on the first render with both the conversation and
  // its messages (so the thread opens there without a flash), then frozen before anything is
  // marked read
  const anchor =
    unreadAnchor !== undefined || !conversation || threadStatus !== 'ready'
      ? unreadAnchor
      : conversation.unread_count > 0
        ? conversation.my_last_read_message_id
        : null;
  useEffect(() => {
    if (unreadAnchor === undefined && anchor !== undefined) setUnreadAnchor(anchor);
  }, [unreadAnchor, anchor]);

  const items = useMemo(
    () => (peerId ? buildThreadItems(messages, { peerId, unreadAfterId: anchor ?? null }) : []),
    [messages, peerId, anchor]
  );

  // ---------- Read receipts ----------

  /** The newest peer message not marked read yet, when the newest messages are on screen */
  const getReadableId = useCallback((): number | null => {
    const list = listRef.current;
    const state = chat();
    const current = state.conversations[id];
    const loaded = state.threads[id]?.messages;
    if (!list || !current || !loaded || !scrollRef.current.initialized) return null;
    if (document.visibilityState === 'hidden' || !isNearBottom(list)) return null;
    for (let index = loaded.length - 1; index >= 0; index--) {
      const message = loaded[index];
      if (isPeerMessage(message, current.peer.id)) {
        return message.id > current.my_last_read_message_id ? message.id : null;
      }
    }
    return null;
  }, [id]);

  const tryMarkRead = useCallback(() => {
    if (readTimerRef.current || getReadableId() === null) return;
    readTimerRef.current = setTimeout(() => {
      readTimerRef.current = null;
      const readable = getReadableId();
      if (readable !== null) chat().markRead(id, readable);
    }, READ_DEBOUNCE_MS);
  }, [getReadableId, id]);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') tryMarkRead();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      if (readTimerRef.current) {
        // Leaving with a read pending: the messages were seen, so send it now
        clearTimeout(readTimerRef.current);
        readTimerRef.current = null;
        const readable = getReadableId();
        if (readable !== null) chat().markRead(id, readable);
      }
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    };
  }, [tryMarkRead, getReadableId, id]);

  // ---------- Scrolling ----------

  const scrollToBottom = useCallback((smooth: boolean) => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTo({
      top: list.scrollHeight,
      behavior: smooth && !prefersReducedMotion() ? 'smooth' : 'auto',
    });
    scrollRef.current.nearBottom = true;
    setNewCount(0);
    setAwayFromBottom(false);
  }, []);

  const loadOlderIfPossible = useCallback(() => {
    const current = chat().threads[id];
    if (current?.hasOlder && !current.loadingOlder && !current.olderError) {
      void chat().loadOlder(id);
    }
  }, [id]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || !peerId || threadStatus !== 'ready' || anchor === undefined) return;
    const scroll = scrollRef.current;
    const first = messages[0];
    const last = messages[messages.length - 1];
    const firstKey = first ? getMessageKey(first) : null;
    const lastKey = last ? getMessageKey(last) : null;

    if (!scroll.initialized) {
      scroll.initialized = true;
      const divider = list.querySelector<HTMLElement>('[data-unread-divider]');
      list.scrollTop = divider
        ? Math.max(0, divider.offsetTop - DIVIDER_OFFSET_PX)
        : list.scrollHeight;
    } else if (last && lastKey !== scroll.lastKey) {
      // New message(s) at the bottom
      if (!isPeerMessage(last, peerId) || scroll.nearBottom) {
        list.scrollTop = list.scrollHeight;
      } else {
        const previousIndex = messages.findIndex(
          (message) => getMessageKey(message) === scroll.lastKey
        );
        const added = messages
          .slice(previousIndex + 1)
          .filter((message) => isPeerMessage(message, peerId)).length;
        setNewCount((count) => count + Math.max(1, added));
      }
    } else if (firstKey !== scroll.firstKey) {
      // Older messages above: keep what the user was looking at in place
      list.scrollTop += list.scrollHeight - scroll.scrollHeight;
    } else if (scroll.nearBottom) {
      // Something grew at the bottom (reactions, typing): stay pinned
      list.scrollTop = list.scrollHeight;
    }

    scroll.firstKey = firstKey;
    scroll.lastKey = lastKey;
    scroll.scrollHeight = list.scrollHeight;
    scroll.nearBottom = isNearBottom(list);
    setAwayFromBottom(!scroll.nearBottom);
    if (list.scrollHeight <= list.clientHeight) loadOlderIfPossible();
    tryMarkRead();
  }, [items, messages, peerId, threadStatus, anchor, peerTyping, loadOlderIfPossible, tryMarkRead]);

  const handleScroll = () => {
    const list = listRef.current;
    if (!list) return;
    const scroll = scrollRef.current;
    scroll.nearBottom = isNearBottom(list);
    scroll.scrollHeight = list.scrollHeight;
    setAwayFromBottom(!scroll.nearBottom);
    if (scroll.nearBottom) setNewCount(0);
    if (scroll.initialized && list.scrollTop < LOAD_OLDER_THRESHOLD_PX) loadOlderIfPossible();
    tryMarkRead();
  };

  // ---------- Jump to a quoted message ----------

  useEffect(() => {
    if (jumpTarget === null) return;
    const node = document.getElementById(getMessageElementId(jumpTarget));
    if (!node) return;
    node.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    setHighlightId(jumpTarget);
    setJumpTarget(null);
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = setTimeout(() => setHighlightId(null), HIGHLIGHT_MS);
  }, [jumpTarget, items]);

  const jumpToMessage = useCallback(
    async (messageId: number) => {
      for (let page = 0; page <= MAX_JUMP_PAGES; page++) {
        const current = chat().threads[id];
        if (current?.messages.some((message) => message.id === messageId)) {
          chatLog.debug('quote_jump', { conversationId: id, found: true, pages: page });
          setJumpTarget(messageId);
          return;
        }
        if (!current?.hasOlder || current.olderError || page === MAX_JUMP_PAGES) break;
        await chat().loadOlder(id);
      }
      chatLog.debug('quote_jump', { conversationId: id, found: false });
      setToast({ message: "The original message isn't available", type: 'info' });
    },
    [id]
  );

  // ---------- Message actions ----------

  const findByKey = (key: string | null) =>
    key ? (messages.find((message) => getMessageKey(message) === key) ?? null) : null;
  const menuMessage = findByKey(menu?.key ?? null);
  const reactionsMessage = findByKey(reactionsKey);

  const react = useCallback(
    (message: ChatThreadMessage, emoji: string | null) => {
      chat()
        .setReaction(id, message.id, emoji, meId)
        .catch((error: unknown) =>
          setToast({ message: getChatErrorMessage(error, 'react'), type: 'error' })
        );
    },
    [id, meId]
  );

  const startReply = useCallback(
    (message: ChatThreadMessage) => {
      if (!canMessage || message.is_deleted || isPendingMessage(message)) return;
      chatLog.debug('reply_started', { conversationId: id });
      setReplyTo(message);
      inputRef.current?.focus();
    },
    [canMessage, id]
  );

  const openMenu = useCallback(
    (message: ChatThreadMessage, anchor: DOMRect | null, source: MenuSource) => {
      const key = getMessageKey(message);
      setMenu((current) => (current?.key === key ? current : { key, anchor }));
      chatLog.debug('menu_opened', { conversationId: id, source });
    },
    [id]
  );

  const retry = useCallback(
    (message: ChatThreadMessage) => {
      if (!message.client_message_id) return;
      const offline = isOffline || !navigator.onLine;
      if (offline)
        setToast({ message: "You're offline. Try again when you're back.", type: 'info' });
      chat().retryMessage(id, message.client_message_id, { offline });
    },
    [id, isOffline]
  );

  const handleDoubleTap = useCallback(
    (message: ChatThreadMessage) => {
      if (getMyReaction(message.reactions, meId) === CHAT_DOUBLE_TAP_REACTION) return;
      react(message, CHAT_DOUBLE_TAP_REACTION);
    },
    [meId, react]
  );

  const handleReactionsClick = useCallback(
    (message: ChatThreadMessage) => setReactionsKey(getMessageKey(message)),
    []
  );

  const getActions = (message: ChatThreadMessage, mine: boolean): MessageAction[] => {
    if (message.send_status === 'failed') return ['retry', 'copy', 'discard'];
    if (isPendingMessage(message)) return ['copy'];
    const actions: MessageAction[] = [];
    if (canMessage) actions.push('reply');
    if (message.body) actions.push('copy');
    if (mine) actions.push('unsend');
    return actions;
  };

  const handleAction = async (message: ChatThreadMessage, action: MessageAction) => {
    setMenu(null);
    switch (action) {
      case 'reply':
        startReply(message);
        break;
      case 'copy': {
        const copied = await copyText(message.body);
        if (copied) chatLog.debug('message_copied', { conversationId: id });
        setToast(
          copied
            ? { message: 'Copied', type: 'success' }
            : { message: "Couldn't copy the message", type: 'error' }
        );
        break;
      }
      case 'unsend':
        setUnsendId(message.id);
        break;
      case 'retry':
        retry(message);
        break;
      case 'discard':
        if (message.client_message_id) chat().discardMessage(id, message.client_message_id);
        break;
    }
  };

  const confirmUnsend = async () => {
    if (unsendId === null || unsending) return;
    setUnsending(true);
    try {
      await chat().unsendMessage(id, unsendId);
      if (replyTo?.id === unsendId) setReplyTo(null);
    } catch (error) {
      setToast({ message: getChatErrorMessage(error, 'unsend'), type: 'error' });
    } finally {
      setUnsending(false);
      setUnsendId(null);
    }
  };

  // The message being replied to was unsent meanwhile
  const replyTarget = replyTo
    ? (messages.find((message) => message.id === replyTo.id) ?? replyTo)
    : null;
  useEffect(() => {
    if (!replyTarget?.is_deleted) return;
    setReplyTo(null);
    setToast({ message: 'The message you were replying to was deleted', type: 'info' });
  }, [replyTarget?.is_deleted]);

  const handleSend = (text: string) => {
    chat().sendMessage(id, text, {
      meId,
      replyTo: replyTarget,
      offline: isOffline || !navigator.onLine,
    });
    setReplyTo(null);
    // Like WhatsApp: once you answer, the unread divider has served its purpose
    setUnreadAnchor(null);
  };

  const handleTyping = useCallback((isTyping: boolean) => chat().sendTyping(id, isTyping), [id]);

  // ---------- Render ----------

  if (conversationStatus === 'not_found' || threadStatus === 'not_found') return <NotFound />;

  if (!conversation) {
    if (conversationStatus === 'error') {
      return (
        <div className={styles.statePage}>
          <section className={styles.stateCard} role="alert">
            <EmptyState
              icon={<MessageCircle size={26} />}
              title="Couldn't open this chat"
              description="Check your connection and try again."
              action={{
                label: 'Try again',
                icon: <RefreshCw size={16} />,
                onClick: () => void chat().openConversation(id),
              }}
            />
          </section>
        </div>
      );
    }
    return (
      <div className={styles.screen} aria-busy="true">
        <div className={styles.header}>
          <IconButton
            variant="ghost"
            icon={<ArrowLeft size={20} />}
            aria-label="Back to messages"
            onClick={goBack}
          />
          <Skeleton width={40} height={40} radius="full" />
          <Skeleton width="35%" height={16} />
        </div>
        <ThreadSkeleton />
      </div>
    );
  }

  const { peer } = conversation;
  const replyAuthor = replyTarget
    ? replyTarget.sender_id === peer.id
      ? peer.username
      : 'You'
    : '';

  const renderThread = () => {
    if (threadStatus === 'error') {
      return (
        <div className={styles.threadState} role="alert">
          <p>Couldn&apos;t load messages.</p>
          <Button
            size="sm"
            variant="secondary"
            icon={<RefreshCw size={15} />}
            onClick={() => void chat().openConversation(id)}
          >
            Try again
          </Button>
        </div>
      );
    }
    if (threadStatus !== 'ready') return <ThreadSkeleton />;
    if (messages.length === 0) {
      return (
        <div className={styles.threadState}>
          <Avatar src={peer.profile_pic} name={peer.username} size="xl" />
          <p className={styles.sayHi}>
            {canMessage ? `Say hi to ${peer.username} 👋` : 'No messages yet'}
          </p>
        </div>
      );
    }
    return (
      <>
        {thread?.loadingOlder && (
          <div className={styles.older} role="status">
            <span className={styles.spinner} aria-hidden="true" />
            <span className="sr-only">Loading earlier messages</span>
          </div>
        )}
        {thread?.olderError && (
          <div className={styles.olderError}>
            <Button
              size="sm"
              variant="secondary"
              icon={<RefreshCw size={15} />}
              onClick={() => void chat().loadOlder(id)}
            >
              Load earlier messages
            </Button>
          </div>
        )}
        {!thread?.hasOlder && (
          <p className={styles.beginning}>This is the start of your chat with {peer.username}</p>
        )}
        {items.map((item) => {
          if (item.kind === 'day') {
            return (
              <div key={item.key} className={styles.day}>
                <span>{item.label}</span>
              </div>
            );
          }
          if (item.kind === 'unread') {
            return (
              <div key={item.key} className={styles.unreadDivider} data-unread-divider>
                <span>
                  {item.count} unread {item.count === 1 ? 'message' : 'messages'}
                </span>
              </div>
            );
          }
          const { message, isMine } = item;
          return (
            <MessageBubble
              key={item.key}
              message={message}
              isMine={isMine}
              isFirstInGroup={item.isFirstInGroup}
              isLastInGroup={item.isLastInGroup}
              meId={meId}
              peerName={peer.username}
              tickStatus={isMine ? getTickStatus(message, conversation) : null}
              highlighted={highlightId === message.id}
              canReply={canMessage && !message.is_deleted && !isPendingMessage(message)}
              onOpenMenu={openMenu}
              onReply={startReply}
              onQuoteClick={jumpToMessage}
              onReactionsClick={handleReactionsClick}
              onDoubleTap={handleDoubleTap}
              onRetry={retry}
            />
          );
        })}
        {peerTyping && (
          <div className={styles.typingBubble} aria-label={`${peer.username} is typing`}>
            <span />
            <span />
            <span />
          </div>
        )}
      </>
    );
  };

  const menuIsMine = menuMessage ? !isPeerMessage(menuMessage, peer.id) : false;

  return (
    <div className={styles.screen}>
      <header className={styles.header}>
        <IconButton
          variant="ghost"
          icon={<ArrowLeft size={20} />}
          aria-label="Back to messages"
          onClick={goBack}
        />
        <Link to={APP_ROUTES.USER_PROFILE(peer.username)} className={styles.peer}>
          <Avatar src={peer.profile_pic} name={peer.username} size="md" />
          <span className={styles.peerText}>
            <span className={styles.peerName}>
              <span className={styles.peerUsername}>{peer.username}</span>
              {peer.is_verified && <VerifiedBadge size={14} />}
            </span>
            <span className={styles.peerStatus} aria-live="polite">
              {peerTyping ? 'typing…' : ''}
            </span>
          </span>
        </Link>
      </header>

      <div className={styles.threadWrap}>
        <div
          ref={listRef}
          className={styles.thread}
          role="log"
          aria-live="polite"
          aria-label={`Messages with ${peer.username}`}
          aria-busy={threadStatus === 'loading' || undefined}
          onScroll={handleScroll}
        >
          {renderThread()}
        </div>

        {threadStatus === 'ready' && (newCount > 0 || awayFromBottom) && (
          <button
            type="button"
            className={`${styles.jump} ${newCount > 0 ? styles.jumpWithCount : ''}`}
            onClick={() => scrollToBottom(true)}
            aria-label={
              newCount > 0
                ? `${newCount} new ${newCount === 1 ? 'message' : 'messages'}, go to latest`
                : 'Go to latest message'
            }
          >
            <ArrowDown size={18} aria-hidden="true" />
            {newCount > 0 && <span aria-hidden="true">{newCount} new</span>}
          </button>
        )}
      </div>

      {canMessage ? (
        <ChatComposer
          peerName={peer.username}
          replyTo={replyTarget}
          replyAuthor={replyAuthor}
          onCancelReply={() => setReplyTo(null)}
          onSend={handleSend}
          onTyping={handleTyping}
          inputRef={inputRef}
        />
      ) : (
        <p className={styles.cannotReply} role="note">
          You can&apos;t reply to this conversation
        </p>
      )}

      {menu && menuMessage && (
        <MessageActionsMenu
          anchor={menu.anchor}
          isMine={menuIsMine}
          myReaction={getMyReaction(menuMessage.reactions, meId)}
          canReact={!menuMessage.is_deleted && !isPendingMessage(menuMessage)}
          actions={getActions(menuMessage, menuIsMine)}
          onReact={(emoji) => {
            setMenu(null);
            react(menuMessage, emoji);
          }}
          onAction={(action) => void handleAction(menuMessage, action)}
          onClose={() => setMenu(null)}
        />
      )}

      {reactionsMessage && (
        <ReactionDetailsSheet
          message={reactionsMessage}
          meId={meId}
          meName={user?.username ?? 'You'}
          meAvatar={user?.profilePicThumb || user?.profilePic}
          peer={peer}
          onRemoveMine={() => {
            setReactionsKey(null);
            react(reactionsMessage, null);
          }}
          onClose={() => setReactionsKey(null)}
        />
      )}

      <ConfirmDialog
        isOpen={unsendId !== null}
        title="Unsend message?"
        description="It will be removed for everyone in this chat."
        tone="danger"
        confirmLabel="Unsend"
        loading={unsending}
        onConfirm={() => void confirmUnsend()}
        onCancel={() => setUnsendId(null)}
      />

      {toast && (
        <SnapToast message={toast.message} type={toast.type} onClose={() => setToast(null)} />
      )}
    </div>
  );
};

export const ChatConversationPage: React.FC = () => {
  const { id: rawId } = useParams<{ id: string }>();
  const id = parseConversationId(rawId);
  if (id === null) return <NotFound />;
  // A new key per conversation: switching chats starts from a clean screen
  return <ConversationScreen key={id} id={id} />;
};

export default ChatConversationPage;
