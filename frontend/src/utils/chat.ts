/**
 * Direct message helpers
 *
 * Pure functions behind the chat store and screens: merging/deduping message lists, applying
 * real-time events (receipts, reactions, deletions), tick status, grouping a thread by day and
 * sender, date labels and error messages. Nothing here touches the network, stores or the DOM.
 */

import type {
  ChatConversation,
  ChatMessage,
  ChatReaction,
  ChatReceiptEventPayload,
  ChatReplyPreview,
  ChatThreadMessage,
  ChatTickStatus,
} from '../types/chat';
import { CHAT_ERROR_CODES } from '../types/chat';
import { getErrorCode, getErrorStatus } from './challenges';

// ==================== Limits & timings ====================

/** Longest message body the server accepts */
export const CHAT_MAX_LENGTH = 4000;
/** The composer shows a character counter from this length on */
export const CHAT_COUNTER_FROM = CHAT_MAX_LENGTH - 200;
/** Quick reactions offered on a message */
export const CHAT_QUICK_REACTIONS = ['❤️', '😂', '😮', '😢', '🙏', '👍'] as const;
/** Double-tapping a peer's message reacts with this */
export const CHAT_DOUBLE_TAP_REACTION = '❤️';
/** "Typing" is re-sent at most this often while the user keeps typing */
export const TYPING_SEND_INTERVAL_MS = 3000;
/** A peer's "typing" expires after this long without a refresh */
export const TYPING_EXPIRY_MS = 6000;
/** Consecutive messages from one sender closer than this are grouped */
export const GROUP_WINDOW_MS = 5 * 60 * 1000;

const DELETED_TEXT = 'This message was deleted';
export const CHAT_DELETED_TEXT = DELETED_TEXT;

// ==================== Identity & ordering ====================

/** Not confirmed by the server yet (sending or failed) */
export const isPendingMessage = (message: Pick<ChatThreadMessage, 'id' | 'send_status'>) =>
  message.id < 0 || message.send_status !== undefined;

/** Stable React key: the client id survives the swap from pending to confirmed */
export const getMessageKey = (message: ChatThreadMessage): string =>
  message.client_message_id ? `c:${message.client_message_id}` : `m:${message.id}`;

/**
 * Thread order: confirmed messages by id (the server's order), then pending ones in the order
 * they were written (pending ids are -1, -2, … so a larger magnitude is newer).
 */
export const compareMessages = (a: ChatThreadMessage, b: ChatThreadMessage): number => {
  const aPending = isPendingMessage(a);
  const bPending = isPendingMessage(b);
  if (aPending !== bPending) return aPending ? 1 : -1;
  return aPending ? b.id - a.id : a.id - b.id;
};

/** The newest message the server has confirmed, or null */
export const getNewestConfirmedId = (messages: ChatThreadMessage[]): number | null => {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (!isPendingMessage(messages[index])) return messages[index].id;
  }
  return null;
};

/** The oldest confirmed message, used as the `before` cursor */
export const getOldestConfirmedId = (messages: ChatThreadMessage[]): number | null => {
  const first = messages.find((message) => !isPendingMessage(message));
  return first ? first.id : null;
};

/** Deletion is final: a stale copy must never bring a deleted message back */
const pickNewer = (
  existing: ChatThreadMessage | undefined,
  incoming: ChatThreadMessage
): ChatThreadMessage => (existing?.is_deleted && !incoming.is_deleted ? existing : incoming);

const deletedPreview = (preview: ChatReplyPreview): ChatReplyPreview => ({
  ...preview,
  body: '',
  is_deleted: true,
});

/**
 * Merges messages into a thread: dedupes by id, replaces a pending message once the server's
 * copy (same client_message_id) arrives, keeps deletions final, marks quotes of deleted
 * messages as deleted and sorts the result.
 */
export function mergeMessages(
  current: ChatThreadMessage[],
  incoming: ChatThreadMessage[]
): ChatThreadMessage[] {
  const confirmed = new Map<number, ChatThreadMessage>();
  const pending = new Map<string, ChatThreadMessage>();

  const add = (message: ChatThreadMessage) => {
    if (isPendingMessage(message)) {
      pending.set(message.client_message_id ?? `local:${message.id}`, message);
      return;
    }
    confirmed.set(message.id, pickNewer(confirmed.get(message.id), message));
  };
  current.forEach(add);
  incoming.forEach(add);

  const confirmedClientIds = new Set<string>();
  const deletedIds = new Set<number>();
  confirmed.forEach((message) => {
    if (message.client_message_id) confirmedClientIds.add(message.client_message_id);
    if (message.is_deleted) deletedIds.add(message.id);
  });

  const result: ChatThreadMessage[] = [];
  confirmed.forEach((message) => {
    const quote = message.reply_to;
    result.push(
      quote && !quote.is_deleted && deletedIds.has(quote.id)
        ? { ...message, reply_to: deletedPreview(quote) }
        : message
    );
  });
  pending.forEach((message, clientId) => {
    if (!confirmedClientIds.has(clientId)) result.push(message);
  });
  return result.sort(compareMessages);
}

/** Replaces the reactions of one message */
export const applyReactions = (
  messages: ChatThreadMessage[],
  messageId: number,
  reactions: ChatReaction[]
): ChatThreadMessage[] =>
  messages.map((message) => (message.id === messageId ? { ...message, reactions } : message));

/** My reaction set (or removed when `emoji` is null), keeping everyone else's */
export const withMyReaction = (
  reactions: ChatReaction[],
  meId: number,
  emoji: string | null
): ChatReaction[] => {
  const others = reactions.filter((reaction) => reaction.user_id !== meId);
  return emoji ? [...others, { user_id: meId, emoji }] : others;
};

export const getMyReaction = (reactions: ChatReaction[], meId: number): string | null =>
  reactions.find((reaction) => reaction.user_id === meId)?.emoji ?? null;

export interface ReactionSummary {
  emoji: string;
  count: number;
  userIds: number[];
  mine: boolean;
}

/** Reactions grouped by emoji, in the order each emoji was first used */
export const summarizeReactions = (reactions: ChatReaction[], meId: number): ReactionSummary[] => {
  const groups = new Map<string, ReactionSummary>();
  reactions.forEach(({ emoji, user_id }) => {
    const group = groups.get(emoji) ?? { emoji, count: 0, userIds: [], mine: false };
    group.count += 1;
    group.userIds.push(user_id);
    group.mine = group.mine || user_id === meId;
    groups.set(emoji, group);
  });
  return Array.from(groups.values());
};

// ==================== Receipts & conversation updates ====================

/** What the ticks on one of my messages show */
export const getTickStatus = (
  message: ChatThreadMessage,
  conversation: Pick<
    ChatConversation,
    'peer_last_read_message_id' | 'peer_last_delivered_message_id'
  > | null
): ChatTickStatus => {
  if (message.send_status) return message.send_status;
  if (message.id < 0) return 'pending';
  if (!conversation) return 'sent';
  if (message.id <= conversation.peer_last_read_message_id) return 'read';
  const delivered = Math.max(
    conversation.peer_last_delivered_message_id,
    conversation.peer_last_read_message_id
  );
  return message.id <= delivered ? 'delivered' : 'sent';
};

/** Whether a message was written by the conversation's peer (i.e. not by me) */
export const isPeerMessage = (message: ChatThreadMessage, peerId: number): boolean =>
  !isPendingMessage(message) && message.sender_id === peerId;

/**
 * Applies a read/delivered receipt. Pointers only move forward, so out-of-order receipts
 * are harmless. Returns the same object when nothing changed.
 */
export function applyReceipt(
  conversation: ChatConversation,
  receipt: ChatReceiptEventPayload
): ChatConversation {
  if (receipt.user_id === conversation.peer.id) {
    const read = Math.max(conversation.peer_last_read_message_id, receipt.last_read_message_id);
    const delivered = Math.max(
      conversation.peer_last_delivered_message_id,
      receipt.last_delivered_message_id,
      read
    );
    if (
      read === conversation.peer_last_read_message_id &&
      delivered === conversation.peer_last_delivered_message_id
    ) {
      return conversation;
    }
    return {
      ...conversation,
      peer_last_read_message_id: read,
      peer_last_delivered_message_id: delivered,
    };
  }

  // My own pointers moved (e.g. read on another device)
  const myRead = Math.max(conversation.my_last_read_message_id, receipt.last_read_message_id);
  if (myRead === conversation.my_last_read_message_id) return conversation;
  const newestId = conversation.last_message?.id ?? 0;
  return {
    ...conversation,
    my_last_read_message_id: myRead,
    unread_count: myRead >= newestId ? 0 : conversation.unread_count,
  };
}

/**
 * Applies a new (or re-delivered) message to its conversation: last message, activity time
 * and unread count. `countAsUnread` is false while the user is looking at the conversation.
 * My own message (sent from any device) marks the conversation read for me.
 */
export function applyIncomingMessage(
  conversation: ChatConversation,
  message: ChatMessage,
  countAsUnread: boolean
): ChatConversation {
  const lastId = conversation.last_message?.id ?? 0;
  const isNew = message.id > lastId;
  const isNewest = message.id >= lastId;
  const fromPeer = message.sender_id === conversation.peer.id;

  const next: ChatConversation = {
    ...conversation,
    last_message: isNewest ? message : conversation.last_message,
    updated_at:
      isNew && message.created_at > conversation.updated_at
        ? message.created_at
        : conversation.updated_at,
  };

  if (!fromPeer) {
    next.my_last_read_message_id = Math.max(conversation.my_last_read_message_id, message.id);
    next.unread_count = 0;
    return next;
  }

  if (
    isNew &&
    countAsUnread &&
    !message.is_deleted &&
    message.id > conversation.my_last_read_message_id
  ) {
    next.unread_count = conversation.unread_count + 1;
  }
  return next;
}

/** A message was unsent: refresh the preview and drop it from the unread count */
export function applyDeletedMessage(
  conversation: ChatConversation,
  message: ChatMessage
): ChatConversation {
  const wasUnread =
    message.sender_id === conversation.peer.id &&
    message.id > conversation.my_last_read_message_id &&
    conversation.unread_count > 0;
  const isLast = conversation.last_message?.id === message.id;
  if (!wasUnread && !isLast) return conversation;
  return {
    ...conversation,
    last_message: isLast ? message : conversation.last_message,
    unread_count: wasUnread ? conversation.unread_count - 1 : conversation.unread_count,
  };
}

/**
 * My read pointer after reading up to `messageId`, and how many messages stay unread.
 * Only peer messages the thread has loaded can be counted; when the pointer reaches the
 * newest message nothing is unread.
 */
export function applyLocalRead(
  conversation: ChatConversation,
  messageId: number,
  loaded: ChatThreadMessage[]
): ChatConversation {
  if (messageId <= conversation.my_last_read_message_id) return conversation;
  const newestId = conversation.last_message?.id ?? 0;
  const stillUnread =
    messageId >= newestId
      ? 0
      : Math.min(
          conversation.unread_count,
          loaded.filter(
            (message) =>
              isPeerMessage(message, conversation.peer.id) &&
              !message.is_deleted &&
              message.id > messageId
          ).length
        );
  return { ...conversation, my_last_read_message_id: messageId, unread_count: stillUnread };
}

/**
 * Combines a conversation loaded from the server with the copy already held, which real-time
 * events may have moved further: pointers only move forward, the newest last message wins
 * and deletions stay final.
 */
export function mergeConversation(
  existing: ChatConversation | undefined,
  incoming: ChatConversation
): ChatConversation {
  if (!existing) return incoming;
  const existingLast = existing.last_message;
  const incomingLast = incoming.last_message;
  const keepExistingLast =
    !!existingLast &&
    (!incomingLast ||
      existingLast.id > incomingLast.id ||
      (existingLast.id === incomingLast.id && existingLast.is_deleted && !incomingLast.is_deleted));
  const lastMessage = keepExistingLast ? existingLast : incomingLast;
  const myRead = Math.max(existing.my_last_read_message_id, incoming.my_last_read_message_id);
  const peerRead = Math.max(existing.peer_last_read_message_id, incoming.peer_last_read_message_id);
  const fresher = keepExistingLast && existingLast?.id !== incomingLast?.id ? existing : incoming;
  return {
    ...incoming,
    last_message: lastMessage,
    updated_at:
      existing.updated_at > incoming.updated_at ? existing.updated_at : incoming.updated_at,
    my_last_read_message_id: myRead,
    peer_last_read_message_id: peerRead,
    peer_last_delivered_message_id: Math.max(
      existing.peer_last_delivered_message_id,
      incoming.peer_last_delivered_message_id,
      peerRead
    ),
    unread_count: myRead >= (lastMessage?.id ?? 0) ? 0 : fresher.unread_count,
  };
}
/** Inbox order: most recent activity first, ties by id (newest first) */
export const compareConversations = (a: ChatConversation, b: ChatConversation): number => {
  const byActivity = b.updated_at.localeCompare(a.updated_at);
  return byActivity !== 0 ? byActivity : b.id - a.id;
};

// ==================== Previews ====================

export interface ConversationPreview {
  text: string;
  isMine: boolean;
  isDeleted: boolean;
}

/** The inbox line for a conversation's last message */
export function getConversationPreview(conversation: ChatConversation): ConversationPreview {
  const last = conversation.last_message;
  if (!last) return { text: 'Say hi 👋', isMine: false, isDeleted: false };
  const isMine = last.sender_id !== conversation.peer.id;
  if (last.is_deleted) return { text: DELETED_TEXT, isMine, isDeleted: true };
  return { text: toSingleLine(last.body), isMine, isDeleted: false };
}

/** Collapses whitespace so multi-line messages preview on one line */
export const toSingleLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Snippet of a quoted message */
export const getQuoteText = (quote: ChatReplyPreview): string =>
  quote.is_deleted ? DELETED_TEXT : toSingleLine(quote.body);

// ==================== Dates ====================

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const startOfDay = (date: Date): number =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/** Whole calendar days between `date` and `now` (0 = today, 1 = yesterday) */
export const calendarDaysAgo = (date: Date, now: Date): number =>
  Math.round((startOfDay(now) - startOfDay(date)) / MS_PER_DAY);

/** Local calendar day of a timestamp, e.g. "2026-11-08" */
export const getDayKey = (iso: string): string => {
  const date = new Date(iso);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
};

/** Clock time in the user's locale, e.g. "9:41 AM" or "09:41" */
export const formatClockTime = (iso: string): string =>
  new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

const formatDate = (date: Date, now: Date): string =>
  date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  });

/** Inbox time: today → clock time, Yesterday, weekday within a week, else the date */
export function formatInboxTime(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const days = calendarDaysAgo(date, now);
  if (days <= 0) return formatClockTime(iso);
  if (days === 1) return 'Yesterday';
  if (days < 7) return date.toLocaleDateString('en-US', { weekday: 'long' });
  return formatDate(date, now);
}

/** Day separator label: Today, Yesterday, weekday within a week, else the full date */
export function formatDayLabel(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  const days = calendarDaysAgo(date, now);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return date.toLocaleDateString('en-US', { weekday: 'long' });
  return date.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  });
}

// ==================== Thread layout ====================

export type ThreadItem =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'unread'; key: string; count: number }
  | {
      kind: 'message';
      key: string;
      message: ChatThreadMessage;
      isMine: boolean;
      /** First of a run of messages from the same sender (gets the "tail") */
      isFirstInGroup: boolean;
      /** Last of the run (more space below it) */
      isLastInGroup: boolean;
    };

export interface BuildThreadOptions {
  peerId: number;
  /** Show the "N unread messages" divider before peer messages newer than this */
  unreadAfterId?: number | null;
  now?: Date;
}

/**
 * Lays out a thread: day separators, an optional unread divider and messages grouped like
 * WhatsApp (same sender, same day, a few minutes apart, nothing in between).
 */
export function buildThreadItems(
  messages: ChatThreadMessage[],
  { peerId, unreadAfterId = null, now = new Date() }: BuildThreadOptions
): ThreadItem[] {
  const items: ThreadItem[] = [];
  const unreadCount =
    unreadAfterId === null
      ? 0
      : messages.filter((message) => isPeerMessage(message, peerId) && message.id > unreadAfterId)
          .length;
  let unreadPlaced = unreadCount === 0;
  let previous: { senderMine: boolean; time: number; day: string } | null = null;
  let lastMessageItem: Extract<ThreadItem, { kind: 'message' }> | null = null;

  const closeGroup = () => {
    if (lastMessageItem) lastMessageItem.isLastInGroup = true;
  };

  messages.forEach((message) => {
    const day = getDayKey(message.created_at);
    const isMine = !isPeerMessage(message, peerId);
    const time = new Date(message.created_at).getTime();
    let breaksGroup = false;

    if (!previous || previous.day !== day) {
      closeGroup();
      items.push({
        kind: 'day',
        key: `day:${day}`,
        label: formatDayLabel(message.created_at, now),
      });
      breaksGroup = true;
    }

    if (!unreadPlaced && !isMine && unreadAfterId !== null && message.id > unreadAfterId) {
      closeGroup();
      items.push({ kind: 'unread', key: 'unread', count: unreadCount });
      unreadPlaced = true;
      breaksGroup = true;
    }

    if (
      !breaksGroup &&
      previous &&
      (previous.senderMine !== isMine || time - previous.time > GROUP_WINDOW_MS)
    ) {
      closeGroup();
      breaksGroup = true;
    }

    const item: Extract<ThreadItem, { kind: 'message' }> = {
      kind: 'message',
      key: getMessageKey(message),
      message,
      isMine,
      isFirstInGroup: breaksGroup || !previous,
      isLastInGroup: false,
    };
    items.push(item);
    lastMessageItem = item;
    previous = { senderMine: isMine, time, day };
  });
  closeGroup();
  return items;
}

// ==================== Text ====================

const PICTOGRAPHIC = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
const ALPHANUMERIC = /[\p{L}\p{N}]/u;

let graphemeSegmenter: Intl.Segmenter | null = null;

const splitGraphemes = (text: string): string[] => {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    graphemeSegmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    return Array.from(graphemeSegmenter.segment(text), (part) => part.segment);
  }
  /* v8 ignore next */
  return Array.from(text);
};

/** 1–3 emoji and nothing else (shown larger, like WhatsApp) */
export function isEmojiOnly(text: string): boolean {
  const compact = text.replace(/\s+/g, '');
  if (!compact || ALPHANUMERIC.test(compact)) return false;
  const graphemes = splitGraphemes(compact);
  return graphemes.length <= 3 && graphemes.every((grapheme) => PICTOGRAPHIC.test(grapheme));
}

/** Idempotency key for a send (≤ 64 chars); retries reuse it */
export function generateClientMessageId(): string {
  const cryptoApi = (globalThis as { crypto?: Partial<Crypto> }).crypto;
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  const random = () => Math.random().toString(36).slice(2, 10).padEnd(8, '0');
  return `${Date.now().toString(36)}-${random()}-${random()}-${random()}`;
}

// ==================== Validation of real-time payloads ====================

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;

const isPointer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

export const isChatReactionList = (value: unknown): value is ChatReaction[] =>
  Array.isArray(value) &&
  value.every(
    (reaction) => isObject(reaction) && isId(reaction.user_id) && typeof reaction.emoji === 'string'
  );

/** A well-formed ChatMessage, normalized (missing optional fields filled in); null otherwise */
export function parseChatMessage(value: unknown): ChatMessage | null {
  if (!isObject(value)) return null;
  const { id, conversation_id, sender_id, body, is_deleted, created_at } = value;
  if (!isId(id) || !isId(conversation_id) || !isId(sender_id)) return null;
  if (typeof body !== 'string' || typeof created_at !== 'string') return null;
  const replyTo = isObject(value.reply_to) && isId(value.reply_to.id) ? value.reply_to : null;
  return {
    id,
    conversation_id,
    sender_id,
    body,
    created_at,
    is_deleted: is_deleted === true,
    client_message_id: typeof value.client_message_id === 'string' ? value.client_message_id : null,
    reactions: isChatReactionList(value.reactions) ? value.reactions : [],
    reply_to: replyTo
      ? {
          id: replyTo.id as number,
          sender_id: isId(replyTo.sender_id) ? replyTo.sender_id : 0,
          body: typeof replyTo.body === 'string' ? replyTo.body : '',
          is_deleted: replyTo.is_deleted === true,
        }
      : null,
  };
}

export const isValidReceipt = (value: unknown): value is ChatReceiptEventPayload =>
  isObject(value) &&
  isId(value.conversation_id) &&
  isId(value.user_id) &&
  isPointer(value.last_read_message_id) &&
  isPointer(value.last_delivered_message_id);

export { isId as isChatId };

// ==================== Errors ====================

export type ChatAction = 'load' | 'send' | 'start' | 'unsend' | 'react';

export const CHAT_NOT_ALLOWED_MESSAGE = 'You can message people you follow or who follow you';

const CODE_MESSAGES: Record<string, string> = {
  [CHAT_ERROR_CODES.NOT_ALLOWED]: CHAT_NOT_ALLOWED_MESSAGE,
  [CHAT_ERROR_CODES.CANNOT_MESSAGE_SELF]: "You can't message yourself",
  [CHAT_ERROR_CODES.USER_NOT_FOUND]: 'This account no longer exists',
  [CHAT_ERROR_CODES.CONVERSATION_NOT_FOUND]: 'This conversation no longer exists',
  [CHAT_ERROR_CODES.MESSAGE_EMPTY]: 'Type a message first',
  [CHAT_ERROR_CODES.MESSAGE_TOO_LONG]: `Messages can be up to ${CHAT_MAX_LENGTH} characters`,
  [CHAT_ERROR_CODES.REPLY_TARGET_NOT_FOUND]: 'The message you replied to is no longer available',
  [CHAT_ERROR_CODES.MESSAGE_FORBIDDEN]: 'You can only unsend your own messages',
  [CHAT_ERROR_CODES.MESSAGE_NOT_FOUND]: 'This message is no longer available',
  [CHAT_ERROR_CODES.RATE_LIMITED]: "You're going too fast. Wait a moment and try again.",
};

const ACTION_FAILURES: Record<ChatAction, string> = {
  load: "Couldn't load messages",
  send: "Couldn't send the message",
  start: "Couldn't open the chat",
  unsend: "Couldn't unsend the message",
  react: "Couldn't react to the message",
};

/** A short, user-facing explanation of a failed chat request */
export function getChatErrorMessage(error: unknown, action: ChatAction): string {
  const code = getErrorCode(error);
  if (code && CODE_MESSAGES[code]) return CODE_MESSAGES[code];
  const hint =
    getErrorStatus(error) === undefined ? 'Check your connection and try again.' : 'Try again.';
  return `${ACTION_FAILURES[action]}. ${hint}`;
}

/** 404 / CONVERSATION_NOT_FOUND (also returned to non-members) */
export const isConversationNotFound = (error: unknown): boolean =>
  getErrorStatus(error) === 404 || getErrorCode(error) === CHAT_ERROR_CODES.CONVERSATION_NOT_FOUND;

/** Whether a failed request is worth retrying as is (network, timeout, 5xx, rate limit) */
export const isRetryableError = (error: unknown): boolean => {
  const status = getErrorStatus(error);
  return status === undefined || status >= 500 || status === 429 || status === 408;
};

// ==================== Scrolling ====================

/** Pixels from the bottom within which a thread counts as "at the bottom" */
export const NEAR_BOTTOM_PX = 120;

export const isNearBottom = (
  element: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>,
  threshold: number = NEAR_BOTTOM_PX
): boolean => element.scrollHeight - element.scrollTop - element.clientHeight <= threshold;
