/**
 * Direct message (1:1 chat) types
 *
 * Mirrors the `/api/chats` contract. All ids are integers; timestamps are RFC 3339 UTC strings.
 */

export interface ChatUser {
  id: number;
  username: string;
  profile_pic: string | null;
  is_verified: boolean;
}

export interface ChatReaction {
  user_id: number;
  emoji: string;
}

/** The quoted message a reply points at */
export interface ChatReplyPreview {
  id: number;
  sender_id: number;
  /** "" when is_deleted; truncated to 200 chars by the server */
  body: string;
  is_deleted: boolean;
}

export interface ChatMessage {
  id: number;
  conversation_id: number;
  sender_id: number;
  /** "" when is_deleted */
  body: string;
  /** Echo of the client's idempotency key */
  client_message_id: string | null;
  reply_to: ChatReplyPreview | null;
  /** At most one per user, oldest first */
  reactions: ChatReaction[];
  is_deleted: boolean;
  created_at: string;
}

export interface ChatConversation {
  id: number;
  peer: ChatUser;
  last_message: ChatMessage | null;
  /** Peer messages newer than my read pointer that are not deleted */
  unread_count: number;
  /** 0 when none */
  my_last_read_message_id: number;
  /** My messages with id <= this are read */
  peer_last_read_message_id: number;
  /** My messages with id <= this are delivered */
  peer_last_delivered_message_id: number;
  can_message: boolean;
  created_at: string;
  /** Last activity */
  updated_at: string;
}

/** Local delivery state of a message the server has not confirmed yet */
export type ChatSendStatus = 'pending' | 'failed';

/**
 * A message as kept in a thread. Messages not confirmed by the server yet carry a negative,
 * client-only `id` and a `send_status`; they always have a `client_message_id`.
 */
export interface ChatThreadMessage extends ChatMessage {
  send_status?: ChatSendStatus;
  /** Why the last attempt failed (user-facing), when send_status is 'failed' */
  send_error?: string;
}

/** What the ticks on one of my messages show */
export type ChatTickStatus = 'pending' | 'failed' | 'sent' | 'delivered' | 'read';

// ==================== API ====================

export interface ChatInboxResponse {
  success: boolean;
  conversations: ChatConversation[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface ChatUnreadCountResponse {
  success: boolean;
  unread_conversations: number;
  unread_messages: number;
}

export interface ChatConversationResponse {
  success: boolean;
  conversation: ChatConversation;
}

export interface ChatStartResponse extends ChatConversationResponse {
  created: boolean;
}

export interface ChatMessagesResponse {
  success: boolean;
  messages: ChatMessage[];
  has_more: boolean;
}

export interface ChatMessageResponse {
  success: boolean;
  message: ChatMessage;
}

export interface ChatReactionsResponse {
  success: boolean;
  message_id: number;
  reactions: ChatReaction[];
}

export interface ChatReadResponse {
  success: boolean;
  last_read_message_id: number;
}

export interface ChatDeliveredResponse {
  success: boolean;
  last_delivered_message_id: number;
}

export interface SendChatMessageRequest {
  body: string;
  client_message_id?: string;
  reply_to_message_id?: number;
}

/** Messages page query: `before` and `after` are mutually exclusive */
export interface ChatMessagesQuery {
  before?: number;
  after?: number;
  limit?: number;
}

export const CHAT_ERROR_CODES = {
  NOT_ALLOWED: 'CHAT_NOT_ALLOWED',
  CANNOT_MESSAGE_SELF: 'CANNOT_MESSAGE_SELF',
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  CONVERSATION_NOT_FOUND: 'CONVERSATION_NOT_FOUND',
  MESSAGE_EMPTY: 'MESSAGE_EMPTY',
  MESSAGE_TOO_LONG: 'MESSAGE_TOO_LONG',
  REPLY_TARGET_NOT_FOUND: 'REPLY_TARGET_NOT_FOUND',
  MESSAGE_FORBIDDEN: 'MESSAGE_FORBIDDEN',
  MESSAGE_NOT_FOUND: 'MESSAGE_NOT_FOUND',
  INVALID_REACTION: 'INVALID_REACTION',
  RATE_LIMITED: 'RATE_LIMIT_EXCEEDED',
} as const;

// ==================== WebSocket ====================

export type ChatWSEventType =
  | 'chat_message'
  | 'chat_message_deleted'
  | 'chat_reaction'
  | 'chat_receipt'
  | 'chat_typing';

export interface ChatMessageEventPayload {
  conversation_id: number;
  message: ChatMessage;
}

export interface ChatReactionEventPayload {
  conversation_id: number;
  message_id: number;
  reactions: ChatReaction[];
}

export interface ChatReceiptEventPayload {
  conversation_id: number;
  /** Whose pointers moved */
  user_id: number;
  last_read_message_id: number;
  last_delivered_message_id: number;
}

export interface ChatTypingEventPayload {
  conversation_id: number;
  user_id: number;
  is_typing: boolean;
}
