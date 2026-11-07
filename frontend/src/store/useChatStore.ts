/**
 * Chat Store
 *
 * Direct messages: the inbox, each open thread, peer typing, and the unread totals shown on
 * the header's chat button.
 *
 * - Conversations are normalized by id; the inbox is every conversation with a message,
 *   newest activity first. Threads keep messages sorted by id, with messages that are still
 *   sending (negative ids) after the confirmed ones.
 * - Sending is optimistic and idempotent: a message gets a `client_message_id`, shows as
 *   pending, and is swapped for the server's copy (from the response or the WebSocket echo,
 *   whichever comes first). A failed send can be retried with the same id.
 * - Real-time events (see `handleSocketEvent`) are best-effort; `onSocketConnected` and the
 *   screens' focus handlers refetch so nothing is missed.
 * - Every request checks the store's epoch before applying its response, so a reset (sign-out)
 *   discards everything still in flight.
 *
 * The current user's id is passed in by the screens: like every store reset by
 * resetUserStores(), this one must never import the auth store.
 */

import { create } from 'zustand';

import { chatApi } from '../services/api';
import { chatLog } from '../services/chatLog';
import type {
  ChatConversation,
  ChatMessage,
  ChatReaction,
  ChatThreadMessage,
  ChatWSEventType,
} from '../types/chat';
import { CHAT_ERROR_CODES } from '../types/chat';
import { getErrorCode } from '../utils/challenges';
import {
  applyDeletedMessage,
  applyIncomingMessage,
  applyLocalRead,
  applyReactions,
  applyReceipt,
  generateClientMessageId,
  getChatErrorMessage,
  getNewestConfirmedId,
  getOldestConfirmedId,
  isChatId,
  isChatReactionList,
  isConversationNotFound,
  isPendingMessage,
  isRetryableError,
  isValidReceipt,
  mergeConversation,
  mergeMessages,
  parseChatMessage,
  TYPING_EXPIRY_MS,
  withMyReaction,
} from '../utils/chat';

export type ChatLoadStatus = 'idle' | 'loading' | 'ready' | 'error' | 'not_found';

export const INBOX_PAGE_SIZE = 20;
export const MESSAGES_PAGE_SIZE = 30;
export const GAP_FILL_PAGE_SIZE = 100;
/** Gap fill stops after this many pages; the thread then reloads its newest page instead */
export const GAP_FILL_MAX_PAGES = 5;
/** A send without an answer after this long shows as failed (and can be retried) */
export const SEND_TIMEOUT_MS = 15_000;

export interface ChatThreadState {
  messages: ChatThreadMessage[];
  /** Loading of the newest page */
  status: ChatLoadStatus;
  /** Older messages exist on the server */
  hasOlder: boolean;
  loadingOlder: boolean;
  olderError: boolean;
}

interface ChatData {
  conversations: Record<number, ChatConversation>;
  /** Loading of a conversation's details (peer, pointers, can_message) */
  conversationStatus: Record<number, ChatLoadStatus>;
  threads: Record<number, ChatThreadState>;
  inboxStatus: 'idle' | 'loading' | 'ready' | 'error';
  inboxCursor: string | null;
  inboxHasMore: boolean;
  inboxLoadingMore: boolean;
  inboxMoreError: boolean;
  /** Conversations whose peer is typing right now */
  typing: Record<number, true>;
  unreadConversations: number;
  unreadMessages: number;
  /** The conversation on screen; its new messages don't count as unread while visible */
  activeConversationId: number | null;
}

export interface SendMessageOptions {
  /** The current user's id (the sender) */
  meId: number;
  /** The message being replied to */
  replyTo?: ChatThreadMessage | null;
  /** Fail at once (the send can be retried when back online) */
  offline?: boolean;
}

interface ChatActions {
  fetchInbox: (options?: { force?: boolean }) => Promise<void>;
  loadMoreInbox: () => Promise<void>;
  fetchUnreadCount: () => Promise<void>;
  /** Shows a conversation: loads it (or catches up when it is cached) and marks it active */
  openConversation: (id: number) => Promise<void>;
  closeConversation: (id: number) => void;
  /** Reloads the details and catches up on missed messages (focus, reconnect) */
  refreshConversation: (id: number) => Promise<void>;
  loadOlder: (id: number) => Promise<void>;
  /** Get-or-create the conversation with a user; throws on failure */
  startConversation: (userId: number) => Promise<ChatConversation>;
  sendMessage: (id: number, body: string, options: SendMessageOptions) => void;
  retryMessage: (id: number, clientMessageId: string, options?: { offline?: boolean }) => void;
  /** Drops a message that failed to send */
  discardMessage: (id: number, clientMessageId: string) => void;
  /** Unsends one of my messages; throws on failure */
  unsendMessage: (id: number, messageId: number) => Promise<void>;
  /** Sets (or with `null` removes) my reaction, optimistically; throws after rolling back */
  setReaction: (id: number, messageId: number, emoji: string | null, meId: number) => Promise<void>;
  markRead: (id: number, messageId: number) => void;
  markDelivered: (id: number, messageId: number) => void;
  sendTyping: (id: number, isTyping: boolean) => void;
  /** Applies a `chat_*` WebSocket event; returns false for other or malformed events */
  handleSocketEvent: (type: string, payload: unknown) => boolean;
  /** After the WebSocket (re)connects: catch up on what was missed */
  onSocketConnected: () => void;
  reset: () => void;
}

export type ChatStore = ChatData & ChatActions;

const initialData: ChatData = {
  conversations: {},
  conversationStatus: {},
  threads: {},
  inboxStatus: 'idle',
  inboxCursor: null,
  inboxHasMore: false,
  inboxLoadingMore: false,
  inboxMoreError: false,
  typing: {},
  unreadConversations: 0,
  unreadMessages: 0,
  activeConversationId: null,
};

const emptyThread = (): ChatThreadState => ({
  messages: [],
  status: 'idle',
  hasOlder: false,
  loadingOlder: false,
  olderError: false,
});

const CHAT_EVENT_TYPES: ReadonlySet<string> = new Set<ChatWSEventType>([
  'chat_message',
  'chat_message_deleted',
  'chat_reaction',
  'chat_receipt',
  'chat_typing',
]);

export const isChatEventType = (type: unknown): type is ChatWSEventType =>
  typeof type === 'string' && CHAT_EVENT_TYPES.has(type);

// ---- Request bookkeeping (module scope; cleared by reset) ----

/** Bumped by reset(): responses of older epochs are dropped */
let epoch = 0;
let pendingSeq = 0;
let inboxRequest: Promise<void> | null = null;
let unreadRequest: Promise<void> | null = null;
const threadLoads = new Map<number, Promise<void>>();
const sendsInFlight = new Set<string>();
/** Latest reaction request per message; older responses are ignored */
const reactionSeq = new Map<number, number>();
const readSent = new Map<number, number>();
const deliveredSent = new Map<number, number>();
const typingTimers = new Map<number, ReturnType<typeof setTimeout>>();

const isPageVisible = () =>
  typeof document === 'undefined' || document.visibilityState !== 'hidden';

export const useChatStore = create<ChatStore>((set, get) => {
  /** Stores a conversation and moves the unread totals by how much its count changed */
  const putConversation = (next: ChatConversation) =>
    set((state) => {
      const previous = state.conversations[next.id];
      if (previous === next) return state;
      const messageDelta = previous ? next.unread_count - previous.unread_count : 0;
      const conversationDelta = previous
        ? Number(next.unread_count > 0) - Number(previous.unread_count > 0)
        : 0;
      return {
        conversations: { ...state.conversations, [next.id]: next },
        unreadMessages: Math.max(0, state.unreadMessages + messageDelta),
        unreadConversations: Math.max(0, state.unreadConversations + conversationDelta),
      };
    });

  const upsertFromServer = (incoming: ChatConversation) =>
    putConversation(mergeConversation(get().conversations[incoming.id], incoming));

  const updateThread = (id: number, update: (thread: ChatThreadState) => ChatThreadState) =>
    set((state) => ({
      threads: { ...state.threads, [id]: update(state.threads[id] ?? emptyThread()) },
    }));

  const mergeIntoThread = (id: number, messages: ChatThreadMessage[]) =>
    updateThread(id, (thread) => ({
      ...thread,
      messages: mergeMessages(thread.messages, messages),
    }));

  const findByClientId = (id: number, clientMessageId: string) =>
    get().threads[id]?.messages.find(
      (message) => message.client_message_id === clientMessageId && isPendingMessage(message)
    );

  const setSendState = (
    id: number,
    clientMessageId: string,
    patch: Pick<ChatThreadMessage, 'send_status' | 'send_error'>
  ) =>
    updateThread(id, (thread) => ({
      ...thread,
      messages: thread.messages.map((message) =>
        message.client_message_id === clientMessageId && isPendingMessage(message)
          ? { ...message, ...patch }
          : message
      ),
    }));

  const clearTyping = (id: number) => {
    const timer = typingTimers.get(id);
    if (timer) clearTimeout(timer);
    typingTimers.delete(id);
    if (!get().typing[id]) return;
    set((state) => {
      const typing = { ...state.typing };
      delete typing[id];
      return { typing };
    });
  };

  const setTyping = (id: number) => {
    const timer = typingTimers.get(id);
    if (timer) clearTimeout(timer);
    typingTimers.set(
      id,
      setTimeout(() => clearTyping(id), TYPING_EXPIRY_MS)
    );
    if (!get().typing[id]) set((state) => ({ typing: { ...state.typing, [id]: true } }));
  };

  /** Loads the newest page of a thread (shared while in flight) */
  const loadLatest = (id: number): Promise<void> => {
    const running = threadLoads.get(id);
    if (running) return running;
    const startedIn = epoch;
    updateThread(id, (thread) => ({
      ...thread,
      status: thread.status === 'ready' ? 'ready' : 'loading',
    }));

    const promise = chatApi
      .messages(id, { limit: MESSAGES_PAGE_SIZE })
      .then((res) => {
        if (startedIn !== epoch) return;
        const messages = Array.isArray(res.messages) ? res.messages : [];
        updateThread(id, (thread) => ({
          ...thread,
          messages: mergeMessages(thread.messages, messages),
          status: 'ready',
          // Keep a deeper history that was already loaded
          hasOlder: thread.status === 'ready' && thread.hasOlder ? true : !!res.has_more,
        }));
      })
      .catch((error: unknown) => {
        if (startedIn !== epoch) return;
        const notFound = isConversationNotFound(error);
        const keep = get().threads[id]?.status === 'ready' && !notFound;
        chatLog.failure('messages_load_failed', error, {
          conversationId: id,
          recovery: notFound ? 'show_not_found' : keep ? 'keep_loaded' : 'show_retry',
        });
        updateThread(id, (thread) => ({
          ...thread,
          status: notFound ? 'not_found' : keep ? 'ready' : 'error',
        }));
      })
      .finally(() => {
        if (threadLoads.get(id) === promise) threadLoads.delete(id);
      });
    threadLoads.set(id, promise);
    return promise;
  };

  /** Fetches messages newer than the newest one held (after a reconnect or focus) */
  const gapFill = async (id: number): Promise<void> => {
    const thread = get().threads[id];
    const after = thread ? getNewestConfirmedId(thread.messages) : null;
    if (!thread || thread.status !== 'ready' || after === null) {
      await loadLatest(id);
      return;
    }
    const startedIn = epoch;
    let cursor = after;
    try {
      for (let page = 0; page < GAP_FILL_MAX_PAGES; page++) {
        const res = await chatApi.messages(id, { after: cursor, limit: GAP_FILL_PAGE_SIZE });
        if (startedIn !== epoch) return;
        const messages = Array.isArray(res.messages) ? res.messages : [];
        mergeIntoThread(id, messages);
        const conversation = get().conversations[id];
        if (conversation) {
          let next = conversation;
          messages.forEach((message) => {
            next = applyIncomingMessage(next, message, false);
          });
          putConversation(next);
        }
        const newest = messages[messages.length - 1];
        if (!res.has_more || !newest) return;
        cursor = newest.id;
      }
      chatLog.debug('gap_fill_truncated', { conversationId: id, pages: GAP_FILL_MAX_PAGES });
    } catch (error) {
      if (startedIn !== epoch) return;
      chatLog.failure('gap_fill_failed', error, { conversationId: id, recovery: 'retry_on_focus' });
    }
  };

  const loadConversation = async (id: number): Promise<void> => {
    const startedIn = epoch;
    const current = get().conversationStatus[id];
    if (current !== 'ready') {
      set((state) => ({ conversationStatus: { ...state.conversationStatus, [id]: 'loading' } }));
    }
    try {
      const res = await chatApi.get(id);
      if (startedIn !== epoch) return;
      upsertFromServer(res.conversation);
      set((state) => ({ conversationStatus: { ...state.conversationStatus, [id]: 'ready' } }));
    } catch (error) {
      if (startedIn !== epoch) return;
      const notFound = isConversationNotFound(error);
      const keep = get().conversationStatus[id] === 'ready' && !notFound;
      chatLog.failure('conversation_load_failed', error, {
        conversationId: id,
        recovery: notFound ? 'show_not_found' : keep ? 'keep_loaded' : 'show_retry',
      });
      set((state) => ({
        conversationStatus: {
          ...state.conversationStatus,
          [id]: notFound ? 'not_found' : keep ? 'ready' : 'error',
        },
      }));
    }
  };

  /** Sends (or re-sends) a pending message; the server dedupes by client_message_id */
  const deliver = async (id: number, clientMessageId: string, isRetry: boolean) => {
    const key = `${id}:${clientMessageId}`;
    const message = findByClientId(id, clientMessageId);
    if (!message || sendsInFlight.has(key)) return;
    sendsInFlight.add(key);
    const startedIn = epoch;
    setSendState(id, clientMessageId, { send_status: 'pending', send_error: undefined });

    // A hung request becomes a failed message the user can retry (retries are idempotent). A
    // late success still replaces it, as the server copy carries the same client id.
    let timedOut = false;
    const timer = setTimeout(() => {
      if (startedIn !== epoch) return;
      timedOut = true;
      sendsInFlight.delete(key);
      chatLog.failure('message_send_timeout', new Error('Send timed out'), {
        conversationId: id,
        retry: isRetry,
        recovery: 'mark_failed',
      });
      setSendState(id, clientMessageId, { send_status: 'failed', send_error: undefined });
    }, SEND_TIMEOUT_MS);

    try {
      const res = await chatApi.send(id, {
        body: message.body,
        client_message_id: clientMessageId,
        ...(message.reply_to ? { reply_to_message_id: message.reply_to.id } : {}),
      });
      if (startedIn !== epoch) return;
      const confirmed = parseChatMessage(res.message);
      if (!confirmed) throw new Error('Malformed send response');
      mergeIntoThread(id, [confirmed]);
      const conversation = get().conversations[id];
      if (conversation) putConversation(applyIncomingMessage(conversation, confirmed, false));
      chatLog.info('message_sent', {
        conversationId: id,
        messageId: confirmed.id,
        retry: isRetry,
        isReply: !!confirmed.reply_to,
      });
    } catch (error) {
      // After a timeout the message already shows as failed (and may be retrying)
      if (startedIn !== epoch || timedOut) return;
      const code = getErrorCode(error);
      chatLog.failure('message_send_failed', error, {
        conversationId: id,
        retry: isRetry,
        recovery: 'mark_failed',
      });
      setSendState(id, clientMessageId, {
        send_status: 'failed',
        // Specific reasons (not allowed, too long…) are worth showing; network blips are not
        send_error: isRetryableError(error) ? undefined : getChatErrorMessage(error, 'send'),
      });
      const conversation = get().conversations[id];
      if (code === CHAT_ERROR_CODES.NOT_ALLOWED && conversation?.can_message) {
        putConversation({ ...conversation, can_message: false });
      }
    } finally {
      clearTimeout(timer);
      if (!timedOut) sendsInFlight.delete(key);
    }
  };

  const applySocketMessage = (payload: unknown) => {
    const raw = (payload as { message?: unknown } | null)?.message;
    const message = parseChatMessage(raw);
    if (!message) throw new Error('Malformed chat_message');
    const id = message.conversation_id;
    const conversation = get().conversations[id];

    if (get().threads[id]) mergeIntoThread(id, [message]);

    if (!conversation) {
      // A conversation this tab doesn't know yet (e.g. someone's first message)
      chatLog.debug('unknown_conversation_event', { conversationId: id });
      void loadConversation(id);
      void get().fetchUnreadCount();
      get().markDelivered(id, message.id);
      return;
    }

    const fromPeer = message.sender_id === conversation.peer.id;
    const viewing = get().activeConversationId === id && isPageVisible();
    putConversation(applyIncomingMessage(conversation, message, !viewing));
    if (fromPeer) {
      clearTyping(id);
      if (!viewing) get().markDelivered(id, message.id);
    }
  };

  const applySocketDeletion = (payload: unknown) => {
    const message = parseChatMessage((payload as { message?: unknown } | null)?.message);
    if (!message) throw new Error('Malformed chat_message_deleted');
    const deleted: ChatMessage = { ...message, is_deleted: true, body: '', reactions: [] };
    const id = deleted.conversation_id;
    if (get().threads[id]) mergeIntoThread(id, [deleted]);
    const conversation = get().conversations[id];
    if (conversation) putConversation(applyDeletedMessage(conversation, deleted));
  };

  const applySocketReaction = (payload: unknown) => {
    const data = payload as {
      conversation_id?: unknown;
      message_id?: unknown;
      reactions?: unknown;
    };
    if (
      !isChatId(data?.conversation_id) ||
      !isChatId(data.message_id) ||
      !isChatReactionList(data.reactions)
    ) {
      throw new Error('Malformed chat_reaction');
    }
    const id = data.conversation_id;
    const messageId = data.message_id;
    const reactions: ChatReaction[] = data.reactions;
    // A reaction of mine still on its way decides; its response brings the final list
    if (reactionSeq.has(messageId)) return;
    if (get().threads[id]) {
      updateThread(id, (thread) => ({
        ...thread,
        messages: applyReactions(thread.messages, messageId, reactions),
      }));
    }
  };

  const applySocketReceipt = (payload: unknown) => {
    if (!isValidReceipt(payload)) throw new Error('Malformed chat_receipt');
    const conversation = get().conversations[payload.conversation_id];
    if (conversation) putConversation(applyReceipt(conversation, payload));
    // Not loaded here: only the totals can be out of date
    else void get().fetchUnreadCount();
  };

  const applySocketTyping = (payload: unknown) => {
    const data = payload as { conversation_id?: unknown; is_typing?: unknown };
    if (!isChatId(data?.conversation_id) || typeof data.is_typing !== 'boolean') {
      throw new Error('Malformed chat_typing');
    }
    if (data.is_typing) setTyping(data.conversation_id);
    else clearTyping(data.conversation_id);
  };

  return {
    ...initialData,

    fetchInbox: ({ force = false } = {}) => {
      if (inboxRequest && !force) return inboxRequest;
      const startedIn = epoch;
      set((state) => ({ inboxStatus: state.inboxStatus === 'ready' ? 'ready' : 'loading' }));
      const promise = chatApi
        .list({ limit: INBOX_PAGE_SIZE })
        .then((res) => {
          if (startedIn !== epoch || inboxRequest !== promise) return;
          (Array.isArray(res.conversations) ? res.conversations : []).forEach(upsertFromServer);
          set({
            inboxStatus: 'ready',
            inboxCursor: res.next_cursor ?? null,
            inboxHasMore: !!res.has_more && !!res.next_cursor,
            inboxMoreError: false,
          });
        })
        .catch((error: unknown) => {
          if (startedIn !== epoch || inboxRequest !== promise) return;
          const keep = get().inboxStatus === 'ready';
          chatLog.failure('inbox_load_failed', error, {
            recovery: keep ? 'keep_loaded' : 'show_retry',
          });
          set({ inboxStatus: keep ? 'ready' : 'error' });
        })
        .finally(() => {
          if (inboxRequest === promise) inboxRequest = null;
        });
      inboxRequest = promise;
      return promise;
    },

    loadMoreInbox: async () => {
      const { inboxCursor, inboxHasMore, inboxLoadingMore, inboxStatus } = get();
      if (!inboxHasMore || !inboxCursor || inboxLoadingMore || inboxStatus !== 'ready') return;
      const startedIn = epoch;
      set({ inboxLoadingMore: true, inboxMoreError: false });
      try {
        const res = await chatApi.list({ cursor: inboxCursor, limit: INBOX_PAGE_SIZE });
        if (startedIn !== epoch) return;
        (Array.isArray(res.conversations) ? res.conversations : []).forEach(upsertFromServer);
        set({
          inboxCursor: res.next_cursor ?? null,
          inboxHasMore: !!res.has_more && !!res.next_cursor,
          inboxLoadingMore: false,
        });
      } catch (error) {
        if (startedIn !== epoch) return;
        chatLog.failure('inbox_more_failed', error, { recovery: 'show_retry' });
        set({ inboxLoadingMore: false, inboxMoreError: true });
      }
    },

    fetchUnreadCount: () => {
      if (unreadRequest) return unreadRequest;
      const startedIn = epoch;
      const promise = chatApi
        .unreadCount()
        .then((res) => {
          if (startedIn !== epoch) return;
          set({
            unreadConversations: Math.max(0, Number(res.unread_conversations) || 0),
            unreadMessages: Math.max(0, Number(res.unread_messages) || 0),
          });
        })
        .catch((error: unknown) => {
          if (startedIn !== epoch) return;
          chatLog.failure('unread_count_failed', error, { recovery: 'keep_previous' });
        })
        .finally(() => {
          if (unreadRequest === promise) unreadRequest = null;
        });
      unreadRequest = promise;
      return promise;
    },

    openConversation: async (id) => {
      const cached = get().threads[id]?.status === 'ready';
      set({ activeConversationId: id });
      chatLog.info('conversation_opened', { conversationId: id, cached });
      await Promise.all([loadConversation(id), cached ? gapFill(id) : loadLatest(id)]);
    },

    closeConversation: (id) => {
      if (get().activeConversationId === id) set({ activeConversationId: null });
    },

    refreshConversation: async (id) => {
      await Promise.all([loadConversation(id), gapFill(id)]);
    },

    loadOlder: async (id) => {
      const thread = get().threads[id];
      if (!thread || thread.status !== 'ready' || !thread.hasOlder || thread.loadingOlder) return;
      const before = getOldestConfirmedId(thread.messages);
      if (before === null) return;
      const startedIn = epoch;
      updateThread(id, (current) => ({ ...current, loadingOlder: true, olderError: false }));
      try {
        const res = await chatApi.messages(id, { before, limit: MESSAGES_PAGE_SIZE });
        if (startedIn !== epoch) return;
        const messages = Array.isArray(res.messages) ? res.messages : [];
        updateThread(id, (current) => ({
          ...current,
          messages: mergeMessages(current.messages, messages),
          hasOlder: !!res.has_more,
          loadingOlder: false,
        }));
      } catch (error) {
        if (startedIn !== epoch) return;
        chatLog.failure('older_load_failed', error, { conversationId: id, recovery: 'show_retry' });
        updateThread(id, (current) => ({ ...current, loadingOlder: false, olderError: true }));
      }
    },

    startConversation: async (userId) => {
      try {
        const res = await chatApi.start(userId);
        upsertFromServer(res.conversation);
        set((state) => ({
          conversationStatus: { ...state.conversationStatus, [res.conversation.id]: 'ready' },
        }));
        chatLog.info('conversation_started', {
          conversationId: res.conversation.id,
          created: !!res.created,
        });
        return get().conversations[res.conversation.id];
      } catch (error) {
        chatLog.failure('conversation_start_failed', error, { recovery: 'show_message' });
        throw error;
      }
    },

    sendMessage: (id, body, { meId, replyTo = null, offline = false }) => {
      const text = body.trim();
      if (!text) return;
      const clientMessageId = generateClientMessageId();
      pendingSeq += 1;
      const message: ChatThreadMessage = {
        id: -pendingSeq,
        conversation_id: id,
        sender_id: meId,
        body: text,
        client_message_id: clientMessageId,
        reply_to: replyTo
          ? {
              id: replyTo.id,
              sender_id: replyTo.sender_id,
              body: replyTo.is_deleted ? '' : replyTo.body.slice(0, 200),
              is_deleted: replyTo.is_deleted,
            }
          : null,
        reactions: [],
        is_deleted: false,
        created_at: new Date().toISOString(),
        send_status: offline ? 'failed' : 'pending',
        send_error: offline ? "You're offline." : undefined,
      };
      mergeIntoThread(id, [message]);
      if (offline) {
        chatLog.info('message_queued_offline', { conversationId: id });
        return;
      }
      void deliver(id, clientMessageId, false);
    },

    retryMessage: (id, clientMessageId, { offline = false } = {}) => {
      if (offline) {
        chatLog.debug('message_retry_offline', { conversationId: id });
        return;
      }
      chatLog.info('message_retry', { conversationId: id });
      void deliver(id, clientMessageId, true);
    },

    discardMessage: (id, clientMessageId) => {
      updateThread(id, (thread) => ({
        ...thread,
        messages: thread.messages.filter(
          (message) =>
            !(message.client_message_id === clientMessageId && message.send_status === 'failed')
        ),
      }));
      chatLog.info('message_discarded', { conversationId: id });
    },

    unsendMessage: async (id, messageId) => {
      const startedIn = epoch;
      try {
        const res = await chatApi.unsend(id, messageId);
        if (startedIn !== epoch) return;
        const base =
          parseChatMessage(res.message) ??
          get().threads[id]?.messages.find((message) => message.id === messageId);
        if (base) {
          const deleted: ChatMessage = { ...base, is_deleted: true, body: '', reactions: [] };
          mergeIntoThread(id, [deleted]);
          const conversation = get().conversations[id];
          if (conversation) putConversation(applyDeletedMessage(conversation, deleted));
        }
        chatLog.info('message_unsent', { conversationId: id, messageId });
      } catch (error) {
        chatLog.failure('message_unsend_failed', error, {
          conversationId: id,
          messageId,
          recovery: 'show_message',
        });
        throw error;
      }
    },

    setReaction: async (id, messageId, emoji, meId) => {
      const thread = get().threads[id];
      const target = thread?.messages.find((message) => message.id === messageId);
      if (!target || target.is_deleted || isPendingMessage(target)) return;
      const previous = target.reactions;
      const seq = (reactionSeq.get(messageId) ?? 0) + 1;
      reactionSeq.set(messageId, seq);
      const startedIn = epoch;
      const apply = (reactions: ChatReaction[]) =>
        updateThread(id, (current) => ({
          ...current,
          messages: applyReactions(current.messages, messageId, reactions),
        }));
      apply(withMyReaction(previous, meId, emoji));

      try {
        const res = emoji
          ? await chatApi.react(id, messageId, emoji)
          : await chatApi.unreact(id, messageId);
        if (startedIn !== epoch || reactionSeq.get(messageId) !== seq) return;
        reactionSeq.delete(messageId);
        if (isChatReactionList(res.reactions)) apply(res.reactions);
        chatLog.info(emoji ? 'reaction_set' : 'reaction_removed', {
          conversationId: id,
          messageId,
        });
      } catch (error) {
        if (startedIn !== epoch) return;
        const isLatest = reactionSeq.get(messageId) === seq;
        chatLog.failure('reaction_failed', error, {
          conversationId: id,
          messageId,
          recovery: isLatest ? 'rollback' : 'superseded',
        });
        if (!isLatest) return;
        reactionSeq.delete(messageId);
        apply(previous);
        throw error;
      }
    },

    markRead: (id, messageId) => {
      if (messageId <= (readSent.get(id) ?? 0)) return;
      const before = get().conversations[id];
      if (before) {
        putConversation(applyLocalRead(before, messageId, get().threads[id]?.messages ?? []));
      }
      readSent.set(id, messageId);
      const startedIn = epoch;
      chatApi.markRead(id, messageId).catch((error: unknown) => {
        if (startedIn !== epoch) return;
        chatLog.failure('mark_read_failed', error, { conversationId: id, recovery: 'retry_later' });
        if (readSent.get(id) !== messageId) return;
        // Undo, so the screen asks again (the server still counts these as unread)
        readSent.delete(id);
        const current = get().conversations[id];
        if (before && current?.my_last_read_message_id === messageId) {
          putConversation({
            ...current,
            my_last_read_message_id: before.my_last_read_message_id,
            unread_count: before.unread_count,
          });
        }
      });
    },

    markDelivered: (id, messageId) => {
      if (messageId <= (deliveredSent.get(id) ?? 0)) return;
      deliveredSent.set(id, messageId);
      chatApi.markDelivered(id, messageId).catch((error: unknown) => {
        if (deliveredSent.get(id) === messageId) deliveredSent.delete(id);
        chatLog.failure('mark_delivered_failed', error, {
          conversationId: id,
          recovery: 'ignore',
        });
      });
    },

    sendTyping: (id, isTyping) => {
      chatApi.typing(id, isTyping).catch((error: unknown) => {
        chatLog.debug('typing_failed', {
          conversationId: id,
          errorCode: getErrorCode(error),
        });
      });
    },

    handleSocketEvent: (type, payload) => {
      if (!isChatEventType(type)) return false;
      try {
        switch (type) {
          case 'chat_message':
            applySocketMessage(payload);
            break;
          case 'chat_message_deleted':
            applySocketDeletion(payload);
            break;
          case 'chat_reaction':
            applySocketReaction(payload);
            break;
          case 'chat_receipt':
            applySocketReceipt(payload);
            break;
          case 'chat_typing':
            applySocketTyping(payload);
            break;
        }
        return true;
      } catch (error) {
        chatLog.failure('ws_event_failed', error, { type, recovery: 'ignore_event' });
        return false;
      }
    },

    onSocketConnected: () => {
      void get().fetchUnreadCount();
      const active = get().activeConversationId;
      if (active !== null) void get().refreshConversation(active);
      if (get().inboxStatus === 'ready') void get().fetchInbox({ force: true });
    },

    reset: () => {
      epoch += 1;
      inboxRequest = null;
      unreadRequest = null;
      threadLoads.clear();
      sendsInFlight.clear();
      reactionSeq.clear();
      readSent.clear();
      deliveredSent.clear();
      typingTimers.forEach((timer) => clearTimeout(timer));
      typingTimers.clear();
      set({ ...initialData });
    },
  };
});

// ==================== Selectors ====================

/** Conversations for the header badge */
export const useChatUnreadConversations = () => useChatStore((state) => state.unreadConversations);
