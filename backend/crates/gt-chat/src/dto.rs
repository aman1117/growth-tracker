//! Request and response bodies of the chat endpoints and the payloads of its WebSocket events.
//! The contract is documented in `backend/docs/chat.md`.

use serde::{Deserialize, Serialize};

// ==================== Shared shapes ====================

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ChatUserDto {
    pub id: i64,
    pub username: String,
    /// The thumbnail when there is one, else the full picture.
    pub profile_pic: Option<String>,
    pub is_verified: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReactionDto {
    pub user_id: i64,
    pub emoji: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReplyPreviewDto {
    pub id: i64,
    pub sender_id: i64,
    /// `""` when unsent; at most 200 characters.
    pub body: String,
    pub is_deleted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MessageDto {
    pub id: i64,
    pub conversation_id: i64,
    pub sender_id: i64,
    pub body: String,
    pub client_message_id: Option<String>,
    pub reply_to: Option<ReplyPreviewDto>,
    pub reactions: Vec<ReactionDto>,
    pub is_deleted: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ConversationDto {
    pub id: i64,
    pub peer: ChatUserDto,
    pub last_message: Option<MessageDto>,
    pub unread_count: i64,
    pub my_last_read_message_id: i64,
    pub peer_last_read_message_id: i64,
    pub peer_last_delivered_message_id: i64,
    pub can_message: bool,
    pub created_at: String,
    pub updated_at: String,
}

// ==================== Requests ====================

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct OpenConversationRequest {
    pub user_id: i64,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct SendMessageRequest {
    pub body: String,
    pub client_message_id: Option<String>,
    pub reply_to_message_id: Option<i64>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct ReactionRequest {
    pub emoji: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct PointerRequest {
    pub message_id: i64,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct TypingRequest {
    pub is_typing: bool,
}

// ==================== Responses ====================

#[derive(Debug, Serialize)]
pub struct ConversationListResponse {
    pub success: bool,
    pub conversations: Vec<ConversationDto>,
    pub next_cursor: Option<String>,
    pub has_more: bool,
}

#[derive(Debug, Serialize)]
pub struct ConversationResponse {
    pub success: bool,
    pub conversation: ConversationDto,
}

#[derive(Debug, Serialize)]
pub struct OpenConversationResponse {
    pub success: bool,
    pub conversation: ConversationDto,
    pub created: bool,
}

#[derive(Debug, Serialize)]
pub struct MessageListResponse {
    pub success: bool,
    pub messages: Vec<MessageDto>,
    pub has_more: bool,
}

#[derive(Debug, Serialize)]
pub struct MessageResponse {
    pub success: bool,
    pub message: MessageDto,
}

#[derive(Debug, Serialize)]
pub struct ReactionsResponse {
    pub success: bool,
    pub message_id: i64,
    pub reactions: Vec<ReactionDto>,
}

#[derive(Debug, Serialize)]
pub struct ReadResponse {
    pub success: bool,
    pub last_read_message_id: i64,
}

#[derive(Debug, Serialize)]
pub struct DeliveredResponse {
    pub success: bool,
    pub last_delivered_message_id: i64,
}

#[derive(Debug, Serialize)]
pub struct UnreadCountResponse {
    pub success: bool,
    pub unread_conversations: i64,
    pub unread_messages: i64,
}

// ==================== WebSocket events ====================

/// Event types sent over the notifications WebSocket.
pub const EVENT_MESSAGE: &str = "chat_message";
pub const EVENT_MESSAGE_DELETED: &str = "chat_message_deleted";
pub const EVENT_REACTION: &str = "chat_reaction";
pub const EVENT_RECEIPT: &str = "chat_receipt";
pub const EVENT_TYPING: &str = "chat_typing";

/// Payload of `chat_message` and `chat_message_deleted`.
#[derive(Debug, Clone, Serialize)]
pub struct MessageEvent<'a> {
    pub conversation_id: i64,
    pub message: &'a MessageDto,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReactionEvent<'a> {
    pub conversation_id: i64,
    pub message_id: i64,
    pub reactions: &'a [ReactionDto],
}

#[derive(Debug, Clone, Serialize)]
pub struct ReceiptEvent {
    pub conversation_id: i64,
    pub user_id: i64,
    pub last_read_message_id: i64,
    pub last_delivered_message_id: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct TypingEvent {
    pub conversation_id: i64,
    pub user_id: i64,
    pub is_typing: bool,
}
