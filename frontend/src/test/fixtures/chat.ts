/**
 * Builders and an API mock for the direct-message (chat) suites.
 */
import { vi } from 'vitest';

import type {
  ChatConversation,
  ChatMessage,
  ChatReaction,
  ChatThreadMessage,
  ChatUser,
} from '../../types/chat';

export const ME = { id: 1, username: 'alice' };
export const PEER: ChatUser = { id: 2, username: 'bob', profile_pic: null, is_verified: false };

/** A fixed local "now": Sunday 8 Nov 2026, 15:00 in the machine's time zone */
export const CHAT_NOW = new Date(2026, 10, 8, 15, 0, 0);

/** ISO timestamp of a local wall-clock time on CHAT_NOW's day, or `daysAgo` days before it */
export const at = (hours: number, minutes = 0, daysAgo = 0): string =>
  new Date(2026, 10, 8 - daysAgo, hours, minutes).toISOString();

export function makeChatMessage(overrides: Partial<ChatThreadMessage> = {}): ChatThreadMessage {
  const id = overrides.id ?? 1;
  return {
    id,
    conversation_id: 10,
    sender_id: PEER.id,
    body: `Message ${id}`,
    client_message_id: null,
    reply_to: null,
    reactions: [],
    is_deleted: false,
    created_at: at(10, id),
    ...overrides,
  };
}

export const mine = (overrides: Partial<ChatThreadMessage> = {}) =>
  makeChatMessage({ sender_id: ME.id, ...overrides });

export function makeConversation(overrides: Partial<ChatConversation> = {}): ChatConversation {
  return {
    id: 10,
    peer: PEER,
    last_message: makeChatMessage({ id: 5 }),
    unread_count: 0,
    my_last_read_message_id: 5,
    peer_last_read_message_id: 0,
    peer_last_delivered_message_id: 0,
    can_message: true,
    created_at: at(9),
    updated_at: at(10, 5),
    ...overrides,
  };
}

export const reaction = (user_id: number, emoji: string): ChatReaction => ({ user_id, emoji });

export const messagesPage = (messages: ChatMessage[], has_more = false) => ({
  success: true,
  messages,
  has_more,
});

export const inboxPage = (
  conversations: ChatConversation[],
  next_cursor: string | null = null
) => ({
  success: true,
  conversations,
  next_cursor,
  has_more: next_cursor !== null,
});

/** A `chatApi` whose every method is a mock answering like an empty, healthy server */
export function createChatApiMock() {
  return {
    list: vi.fn(async () => inboxPage([])),
    unreadCount: vi.fn(async () => ({
      success: true,
      unread_conversations: 0,
      unread_messages: 0,
    })),
    start: vi.fn(),
    get: vi.fn(),
    messages: vi.fn(async () => messagesPage([])),
    send: vi.fn(),
    unsend: vi.fn(),
    react: vi.fn(),
    unreact: vi.fn(),
    markRead: vi.fn(async () => ({ success: true, last_read_message_id: 0 })),
    markDelivered: vi.fn(async () => ({ success: true, last_delivered_message_id: 0 })),
    typing: vi.fn(async () => ({ success: true })),
  };
}
