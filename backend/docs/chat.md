# Direct messages (1:1 chat) — API

Implemented by the `gt-chat` crate (`crates/gt-chat`); tables `chat_conversations`,
`chat_members`, `chat_messages` and `chat_reactions` (`gt-core/src/schema.sql`).

All routes require `Authorization: Bearer <jwt>` and use the standard envelopes:
success `{"success": true, ...}`, error `{"success": false, "error": "<msg>", "error_code": "<CODE>"}`.
Timestamps are RFC 3339 UTC strings with milliseconds, e.g. `"2026-11-08T03:15:15.476Z"`.
All ids are integers.

## Who can message whom
A user may message another user when there is an ACTIVE follow edge in EITHER direction between them
(A follows B, or B follows A). This is re-checked on every send, so `can_message` can flip to false
(e.g. after both unfollow). Reading history is always allowed for members.
Conversations with no messages are not listed in the inbox.

## DTOs

```ts
interface ChatUser { id: number; username: string; profile_pic: string | null; is_verified: boolean }

interface ChatReaction { user_id: number; emoji: string }

interface ChatReplyPreview {
  id: number;
  sender_id: number;
  body: string;          // "" when is_deleted; truncated to 200 chars
  is_deleted: boolean;
}

interface ChatMessage {
  id: number;
  conversation_id: number;
  sender_id: number;
  body: string;                     // "" when is_deleted
  client_message_id: string | null; // echo of the client's idempotency key
  reply_to: ChatReplyPreview | null;
  reactions: ChatReaction[];        // at most one per user, oldest first
  is_deleted: boolean;
  created_at: string;
}

interface ChatConversation {
  id: number;
  peer: ChatUser;
  last_message: ChatMessage | null;
  unread_count: number;                     // peer messages with id > my_last_read_message_id, not deleted
  my_last_read_message_id: number;          // 0 when none
  peer_last_read_message_id: number;        // drives blue ticks on my messages (id <= this => read)
  peer_last_delivered_message_id: number;   // id <= this => delivered (double grey tick)
  can_message: boolean;
  created_at: string;
  updated_at: string;                       // = last activity
}
```

## Endpoints

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/chats?limit=20&cursor=<opaque>` | – | `{success, conversations: ChatConversation[], next_cursor: string \| null, has_more: boolean}` newest activity first; limit 1..50 (default 20). Side effect: marks every listed conversation delivered up to its last message (emits `chat_receipt`). |
| GET | `/api/chats/unread-count` | – | `{success, unread_conversations: number, unread_messages: number}` |
| POST | `/api/chats` | `{user_id: number}` | `{success, conversation: ChatConversation, created: boolean}` get-or-create the 1:1 conversation. Errors: 400 `CANNOT_MESSAGE_SELF`, 404 `USER_NOT_FOUND`, 403 `CHAT_NOT_ALLOWED`. |
| GET | `/api/chats/{id}` | – | `{success, conversation: ChatConversation}`; 404 `CONVERSATION_NOT_FOUND` (also for non-members). |
| GET | `/api/chats/{id}/messages?before=<msgId>&limit=30` | – | `{success, messages: ChatMessage[], has_more: boolean}` — the newest `limit` messages older than `before` (or newest overall without `before`), returned OLDEST FIRST. `has_more` = older messages exist. limit 1..100 (default 30). |
| GET | `/api/chats/{id}/messages?after=<msgId>&limit=100` | – | Same shape: messages with id > after, oldest first (gap fill after reconnect). `has_more` = more newer messages exist. `before` and `after` are mutually exclusive (400 `INVALID_REQUEST`). |
| POST | `/api/chats/{id}/messages` | `{body: string, client_message_id?: string (<=64 chars, e.g. uuid), reply_to_message_id?: number}` | 201 `{success, message: ChatMessage}`; when `client_message_id` was already used by this sender: 200 with the existing message (idempotent retry). Body is trimmed; errors 400 `MESSAGE_EMPTY`, 400 `MESSAGE_TOO_LONG` (> 4000 chars), 400 `REPLY_TARGET_NOT_FOUND` (missing, deleted or other conversation), 403 `CHAT_NOT_ALLOWED`, 404 `CONVERSATION_NOT_FOUND`. Rate limit 60/min (429 `RATE_LIMIT_EXCEEDED`). Sending also marks the conversation read for the sender. |
| DELETE | `/api/chats/{id}/messages/{messageId}` | – | `{success, message: ChatMessage}` (now `is_deleted: true`, body "", reactions []). Only the sender: 403 `MESSAGE_FORBIDDEN`; 404 `MESSAGE_NOT_FOUND`. Idempotent. |
| PUT | `/api/chats/{id}/messages/{messageId}/reaction` | `{emoji: string}` | `{success, message_id, reactions: ChatReaction[]}` sets/replaces my reaction. 400 `INVALID_REACTION` (empty, ASCII, > 16 chars), 404 `MESSAGE_NOT_FOUND` (also deleted). |
| DELETE | `/api/chats/{id}/messages/{messageId}/reaction` | – | `{success, message_id, reactions}` removes my reaction (idempotent). |
| POST | `/api/chats/{id}/read` | `{message_id: number}` | `{success, last_read_message_id: number}` monotonic (never decreases), clamped to the conversation's newest message; also marks delivered. |
| POST | `/api/chats/{id}/delivered` | `{message_id: number}` | `{success, last_delivered_message_id: number}` monotonic. |
| POST | `/api/chats/{id}/typing` | `{is_typing: boolean}` | `{success}`. Client should send `true` at most every 3 s while typing and `false` when the input clears / message sent / leaving. |

Error code for an invalid `{id}` / `{messageId}` path segment: 400 `INVALID_REQUEST`.

Rate limits (per user, per minute): reads use the general API limiter (200); sends and unsends
60; typing, read, delivered and reactions share 180. Unexpected failures answer 500 with
`FETCH_FAILED` / `CREATE_FAILED` / `UPDATE_FAILED` / `DELETE_FAILED`.

## Real-time events (existing WebSocket `GET /api/ws/notifications?token=<jwt>`)

Messages arrive as `{"type": "<type>", "payload": {...}}` alongside the existing
`connected` / `notification` / `pending_delivery` / `error` types. Events are best-effort (not queued
while offline) — clients must refetch on (re)connect / focus.

| type | payload | sent to |
|---|---|---|
| `chat_message` | `{conversation_id, message: ChatMessage}` | both members (all their connections, including the sender's own — dedupe by `id` / `client_message_id`) |
| `chat_message_deleted` | `{conversation_id, message: ChatMessage}` (deleted form) | both members |
| `chat_reaction` | `{conversation_id, message_id, reactions: ChatReaction[]}` | both members |
| `chat_receipt` | `{conversation_id, user_id, last_read_message_id, last_delivered_message_id}` | both members (`user_id` = whose pointers moved; if it is me, sync my unread state across devices) |
| `chat_typing` | `{conversation_id, user_id, is_typing}` | the other member only. Clients expire `is_typing: true` after 6 s without a refresh. |

## Web Push
When the recipient has no open WebSocket, a push is queued: `notification_type: "chat_message"`,
title = sender username, body = message text, deep link `/chats/{conversation_id}`,
data `{conversation_id, message_id, sender_id, sender_username}`.
